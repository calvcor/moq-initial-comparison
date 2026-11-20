"""Router de emulación de red del testbed.

Reenvía a nivel IP (DNAT, sin terminar conexiones) los puertos que usa el navegador hacia los servidores
finales y degrada ese tráfico con tc en los dos sentidos:

    navegador -> :8443/tcp -> nginx-dash:443     (LL-DASH directo, con TLS)
    navegador -> :8080/tcp -> nginx-dash:80      (LL-DASH directo, sin TLS: sin DASH_HOST, desde páginas HTTP)
    navegador -> :4433/udp -> moq-relay:4433     (MoQ sobre QUIC)
    navegador -> :8189/udp -> sfu o mediamtx:8189 (WebRTC: ICE, DTLS y SRTP; el servidor lo elige RTC_SERVER)
    navegador -> :8189/tcp -> sfu o mediamtx:8189 (señalización WebSocket de mediasoup; va en la cola de WebRTC)

La ingesta (orquestador -> nginx / relay) va por la red interna sin pasar por aquí, así que la emulación
solo afecta al tramo servidor-cliente y lo hace igual para las dos ramas.

Este módulo monta el reenvío y el árbol de tc y aplica los perfiles; el agente HTTP en :9000, con el que el orquestador
aplica perfiles y lee contadores, y la lectura de esos contadores están en api.py, que es el que se ejecuta.

Colas por cliente: dentro de la cola de cada protocolo y sentido hay una plaza por cliente
(hasta MAX_CLIENTS, por IP) además de la general. Un cliente con plaza tiene su propio limitador y su netem, con su
perfil; el resto del tráfico va a la general, con su propio perfil. Así varios trabajadores de una campaña miden
a la vez, cada uno con su red, sin repartirse un enlace (docs/campaigns.md, pruebas en paralelo).
"""
import math
import os
import re
import subprocess

NGINX_IP = os.environ["NGINX_IP"]
RELAY_IP = os.environ["RELAY_IP"]
# Servidor de WebRTC (RTC_SERVER): el SFU de mediasoup o MediaMTX. Recibe el 8189 en UDP (ICE, DTLS y SRTP) y en TCP (la
# señalización WebSocket, que solo usa mediasoup: MediaMTX negocia por WHEP a través del punto de entrada)
RTC_IP = os.environ["MEDIAMTX_IP"] if os.environ.get("RTC_SERVER", "mediasoup").strip().lower() == "mediamtx" else os.environ["SFU_IP"]
DASH_PORT, DASH_TLS_PORT, MOQ_PORT, RTC_PORT = 8080, 8443, 4433, 8189

# Colas: nombre ("<protocolo>_<sentido>") -> número (1-6).
# Cada protocolo tiene su propia cola por sentido, con el mismo perfil: los dos ven un enlace idéntico
# en vez de competir entre sí por uno compartido. Número de la cola: su banda en la qdisc raíz (1:n) y la
# primera cifra de los handles de debajo (prio n00:, limitador n<plaza>0: y netem n<plaza>1:).
# Por protocolo, bajada y subida seguidas (docs/network-emulation.md)
QUEUES = {"dash_down": 1, "dash_up": 2, "moq_down": 3, "moq_up": 4, "rtc_down": 5, "rtc_up": 6}
# Plazas de cada cola: 1..MAX_CLIENTS para los clientes con perfil propio y GENERAL para el resto. El cliente de la
# plaza s lleva la marca s (iptables, en FORWARD: ahí se ve su IP en los dos sentidos, antes del MASQUERADE de subida
# y después de deshacerlo en la bajada) y un filtro u32 por marca lo manda a su banda.
# Filtros u32 de la raíz: (cola, protocolo, IP de destino o None, campo del puerto, puerto). En la subida se mira el
# destino ya traducido por el DNAT (contenedor y puerto interno); en la bajada, el puerto de origen público, ya restaurado.
# Generan los comandos de tc (setup) y la descripción del árbol (tree).
FILTERS = [
    ("dash_down", "tcp", None, "sport", DASH_PORT),
    ("dash_down", "tcp", None, "sport", DASH_TLS_PORT),
    ("dash_up", "tcp", NGINX_IP, "dport", 80),
    ("dash_up", "tcp", NGINX_IP, "dport", 443),
    ("moq_down", "udp", None, "sport", MOQ_PORT),
    ("moq_up", "udp", RELAY_IP, "dport", MOQ_PORT),
    ("rtc_down", "udp", None, "sport", RTC_PORT),
    ("rtc_up", "udp", RTC_IP, "dport", RTC_PORT),
    ("rtc_down", "tcp", None, "sport", RTC_PORT),
    ("rtc_up", "tcp", RTC_IP, "dport", RTC_PORT),
]
# Protocolo -> número del campo protocol de la cabecera IP (para el match de u32)
PROTO_NUMBER = {"tcp": 6, "udp": 17}
MAX_CLIENTS = 8
GENERAL = MAX_CLIENTS + 1
DIRECTIONS = ("down", "up")
# Perfil de un enlace (un sentido de una plaza), con sus valores por defecto, que dejan pasar sin restricciones:
#   {"rate_kbit": int | None,  caudal en kbit/s; None = sin límite
#    "delay_ms": float,        retardo
#    "jitter_ms": float,       variación del retardo (±)
#    "loss_pct": float,        pérdida aleatoria, en %
#    "queue_ms": int,          cola del cuello de botella; solo cuenta con rate_kbit
#    "shaper": str}            cómo se limita el caudal; solo cuenta con rate_kbit (docs/network-emulation.md). "tbf" (por defecto):
#                              un tbf con ráfaga de un paquete fija el ritmo; tras un rato ocioso deja pasar un
#                              paquete suelto sin esperar. "netem" (experimento declarado): el tbf va a
#                              10 Gbit/s solo para trocear los superpaquetes GSO y el ritmo lo pone netem rate, que retrasa cada
#                              paquete lo que tarda en salir a esa velocidad, como un enlace serie
#                              (docs/limitations.md)
# Perfil de red: un perfil de enlace por sentido, {"down": perfil de enlace, "up": perfil de enlace}.
EMPTY = {"rate_kbit": None, "delay_ms": 0, "jitter_ms": 0, "loss_pct": 0, "queue_ms": 300, "shaper": "tbf"}
SHAPERS = ("tbf", "netem")
MTU_BITS = 1500 * 8

# Perfil de red de la plaza general (el último POST /): {"down": perfil de enlace, "up": perfil de enlace}
profile = {name: dict(EMPTY) for name in DIRECTIONS}
# (cola, plaza) -> si tiene limitador y netem puestos, p. ej. {("moq_down", 9): True}. Decide entre "tc qdisc add" y "change"
shaped: dict[tuple[str, int], bool] = {}
# (cola, plaza) -> perfil de enlace aplicado más "limit" (el de netem, en paquetes), solo las que tienen limitador y
# netem, p. ej. {("moq_down", 9): {"rate_kbit": 3000, "delay_ms": 20, ..., "queue_ms": 300, "limit": 80}}. Para el árbol (tree)
applied: dict[tuple[str, int], dict] = {}
# Clientes con plaza propia: IP -> {"slot": plaza (1-MAX_CLIENTS), "profile": perfil de red}, p. ej.
# {"10.0.0.5": {"slot": 1, "profile": {"down": {"rate_kbit": 2000, ...}, "up": {"rate_kbit": None, ...}}}}
clients: dict[str, dict] = {}
# None si la emulación funciona; si no, el motivo (p. ej. faltan módulos sch_* en el kernel del anfitrión)
emulation_error = None


def run(cmd: str, check: bool = True) -> str:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{cmd}: {result.stderr.strip()}")
    return result.stdout


def interfaces() -> list[str]:
    return sorted(dev for dev in os.listdir("/sys/class/net") if dev.startswith("eth"))


# Reglas de FORWARD que cuentan el tráfico de cada cola: del servidor (bajada) o hacia él (subida). Lista de (cola,
# condiciones de iptables); la cola va en el comentario de la regla, que es como stats (api.py) sabe qué cuenta cada una
COUNTED = [
    ("dash_down", f"-s {NGINX_IP} -p tcp --sport 80"),
    ("dash_up", f"-d {NGINX_IP} -p tcp --dport 80"),
    ("dash_down", f"-s {NGINX_IP} -p tcp --sport 443"),
    ("dash_up", f"-d {NGINX_IP} -p tcp --dport 443"),
    ("moq_down", f"-s {RELAY_IP} -p udp --sport {MOQ_PORT}"),
    ("moq_up", f"-d {RELAY_IP} -p udp --dport {MOQ_PORT}"),
    ("rtc_down", f"-s {RTC_IP} -p udp --sport {RTC_PORT}"),
    ("rtc_up", f"-d {RTC_IP} -p udp --dport {RTC_PORT}"),
    ("rtc_down", f"-s {RTC_IP} -p tcp --sport {RTC_PORT}"),
    ("rtc_up", f"-d {RTC_IP} -p tcp --dport {RTC_PORT}"),
]


def setup():
    # Reenvío de los puertos del cliente a los servidores finales, con contadores por protocolo y sentido
    # Se especifican reglas de NAT de subida, pero no de bajada: el MASQUERADE de subida hace que la bajada vuelva al cliente correcto
    # En la bajada, las reglas no hacen DNAT, pero sí cuentan el tráfico de cada cola (FORWARD) y lo marcan para que vaya a la banda de su cola
    for proto, port, dest_ip, dest_port in (
        ("tcp", DASH_PORT, NGINX_IP, 80),
        ("tcp", DASH_TLS_PORT, NGINX_IP, 443),
        ("udp", MOQ_PORT, RELAY_IP, MOQ_PORT),
        ("udp", RTC_PORT, RTC_IP, RTC_PORT),
        ("tcp", RTC_PORT, RTC_IP, RTC_PORT),
    ):
        run(f"iptables -t nat -A PREROUTING -p {proto} --dport {port} -j DNAT --to-destination {dest_ip}:{dest_port}")
    run("iptables -t nat -A POSTROUTING -m conntrack --ctstate DNAT -j MASQUERADE")
    for name, rule in COUNTED:
        # Contadores por cola y sentido, con comentario para identificarlos en iptables-save
        # Solo se usarán para medir el tráfico en colas de clientes comunes (dashboard y campañas sin pruebas en paralelo)
        run(f"iptables -A FORWARD {rule} -m comment --comment {name}")

    # La emulación necesita en el kernel sch_prio, sch_tbf, sch_netem y cls_u32. Si faltan (p. ej. en un
    # contenedor LXC cuyo anfitrión no los tiene cargados) el reenvío sigue funcionando, sin emulación.
    global emulation_error
    try:
        # Clasificación en todas las interfaces, sin depender de por cuál publique Docker los puertos.
        # Bajada = servidor -> cliente, subida = cliente -> servidor; 1:7 es el resto del tráfico, sin tocar.
        for dev in interfaces():
            # Qdisc raíz de prioridad: una banda por cola, y la última para el resto del tráfico (priomap)
            run(f"tc qdisc replace dev {dev} root handle 1: prio bands 7 priomap 6 6 6 6 6 6 6 6 6 6 6 6 6 6 6 6")
            # Filtros u32 que miran el protocolo y el puerto de origen o destino, y la marca del cliente si la tiene.
            u32 = f"tc filter add dev {dev} parent 1: protocol ip u32"
            for queue, proto, dst, field, port in FILTERS:
                ip = f"match ip dst {dst}/32 " if dst else ""
                run(f"{u32} match ip protocol {PROTO_NUMBER[proto]} 0xff {ip}match ip {field} {port} 0xffff flowid 1:{QUEUES[queue]}")
            # Dentro de cada cola, una banda por plaza: la marca del cliente elige la suya; sin marca, la general
            # (la última: priomap la manda ahí cuando ningún filtro coincide)
            for n in QUEUES.values():
                run(f"tc qdisc replace dev {dev} parent 1:{n} handle {n}00: prio bands {GENERAL} priomap " + " ".join([str(GENERAL - 1)] * 16))
                for slot in range(1, MAX_CLIENTS + 1):
                    run(f"tc filter add dev {dev} parent {n}00: protocol ip prio 1 u32 match mark {slot} 0xffff flowid {n}00:{slot}")
    except RuntimeError as e:
        emulation_error = str(e)
        for dev in interfaces():
            run(f"tc qdisc del dev {dev} root", check=False)
        print(f"Emulación de red no disponible: {e}", flush=True)


def handles(queue: str, slot: int) -> tuple[str, str, str]:
    """Banda de la plaza en la cola, y handles de su limitador y de su netem."""
    n = QUEUES[queue]
    return f"{n}00:{slot}", f"{n}{slot}0", f"{n}{slot}1"


def apply_queue(queue: str, link: dict, slot: int = GENERAL):
    """Aplica un perfil de enlace (link, completo: con todos los campos de EMPTY) a una plaza de una cola."""
    # "queue" es la cola (dash_down, dash_up, moq_down, moq_up, rtc_down o rtc_up)
    # "link" es el perfil de enlace a aplicar (rate_kbit, delay_ms, jitter_ms, loss_pct y queue_ms)
    # "slot" es la plaza (1..MAX_CLIENTS para clientes con perfil propio, GENERAL para el resto)
    parent, limiter, netem = handles(queue, slot)
    if link["shaper"] not in SHAPERS:
        raise ValueError(f"Limitador desconocido: {link['shaper']} (tbf o netem)")
    active = bool(link["rate_kbit"] or link["delay_ms"] or link["jitter_ms"] or link["loss_pct"])
    # netem conserva su rate en un "change" que no lo nombra: al pasar de netem a tbf (o al revés) se recrea la plaza
    shaper = link["shaper"] if link["rate_kbit"] else "tbf"
    if shaped.get((queue, slot)) and (applied.get((queue, slot)) or {}).get("applied_shaper", "tbf") != shaper:
        for dev in interfaces():
            run(f"tc qdisc del dev {dev} parent {parent} handle {limiter}:", check=False)
        shaped[queue, slot] = False
    for dev in interfaces():
        if not active:
            # Sin restricciones se retira todo: paso directo real, no un limitador muy alto
            run(f"tc qdisc del dev {dev} parent {parent} handle {limiter}:", check=False)
            applied.pop((queue, slot), None) # None sirve para que no falle si no existía, p. ej. al arrancar
            continue

        # Limitador delante con ráfaga de un paquete: además de fijar el ancho de banda, trocea los
        # superpaquetes GSO/TSO, que netem descartaría enteros falseando la tasa de pérdida.
        rate_bps = (link["rate_kbit"] or 1_000_000) * 1000
        verb = "change" if shaped.get((queue, slot)) else "add"
        # Con el limitador "netem", el tbf solo trocea (10 Gbit/s) y el ritmo va en netem, más abajo
        tbf_bps = 10_000_000_000 if shaper == "netem" else rate_bps
        run(f"tc qdisc {verb} dev {dev} parent {parent} handle {limiter}: tbf rate {tbf_bps}bit burst 1600 latency 1s")

        # netem aplica retardo y pérdida, y su límite hace de cola del cuello de botella. El límite va en
        # paquetes: los que caben en tránsito durante el retardo más los de la cola pedida.
        hold_ms = link["delay_ms"] + link["jitter_ms"] + (link["queue_ms"] if link["rate_kbit"] else 1000)
        limit = max(20, math.ceil(rate_bps * hold_ms / 1000 / MTU_BITS))
        spec = f"limit {min(limit, 100000)}"
        if shaper == "netem":
            spec += f" rate {rate_bps}bit"
        if link["delay_ms"] or link["jitter_ms"]:
            spec += f" delay {link['delay_ms']}ms"
            if link["jitter_ms"]:
                spec += f" {link['jitter_ms']}ms 25%"
        if link["loss_pct"]:
            spec += f" loss {link['loss_pct']}%"
        run(f"tc qdisc {verb} dev {dev} parent {limiter}:1 handle {netem}: netem {spec}")
        applied[queue, slot] = {**link, "limit": min(limit, 100000), "applied_shaper": shaper}
    shaped[queue, slot] = active


def client_rules(ip: str, slot: int) -> list[tuple[str, str]]:
    """Reglas de iptables de un cliente con plaza: su marca, en los dos sentidos, y sus contadores por cola. Lista de
    (tabla, regla de FORWARD), p. ej. ("mangle", "-s 10.0.0.5/32 -j MARK --set-mark 1")."""
    rules = [("mangle", f"-s {ip}/32 -j MARK --set-mark {slot}"), ("mangle", f"-d {ip}/32 -j MARK --set-mark {slot}")]
    for name, rule in COUNTED:
        side = "-d" if name.endswith("_down") else "-s"
        rules.append(("filter", f"{side} {ip}/32 {rule} -m comment --comment {name}@{ip}"))
    return rules


def set_clients(wanted: dict[str, dict]):
    """Deja exactamente esos clientes con perfil propio; los demás vuelven a la cola general. wanted: IP -> perfil de red,
    cada sentido y cada campo opcionales (lo que falta toma el valor de EMPTY), p. ej. {"10.0.0.5": {"down": {"rate_kbit": 2000}}}."""
    if len(wanted) > MAX_CLIENTS:
        raise ValueError(f"Como mucho {MAX_CLIENTS} clientes con perfil propio")
    for ip in wanted:
        if not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip):
            raise ValueError(f"IP de cliente no válida: {ip}")
    for ip in [ip for ip in clients if ip not in wanted]:
        # Se quita la plaza y sus reglas de FORWARD, y se deja el tráfico en la cola general, para los clientes que no tengan perfil propio
        slot = clients.pop(ip)["slot"]
        for table, rule in client_rules(ip, slot):
            run(f"iptables -t {table} -D FORWARD {rule}", check=False) # Borrar las reglas (-D) del cliente que se va
        for queue in QUEUES:
            apply_queue(queue, EMPTY, slot)
    for ip, body in wanted.items():
        # Se actualiza el perfil del cliente (si no existía, se le asigna la plaza más baja libre y se ponen sus reglas de FORWARD)
        link = {d: {**EMPTY, **(body.get(d) or {})} for d in DIRECTIONS}
        if ip not in clients:
            # Se le asigna la plaza más baja libre y se ponen sus reglas de FORWARD
            slot = min(set(range(1, MAX_CLIENTS + 1)) - {c["slot"] for c in clients.values()})
            for table, rule in client_rules(ip, slot):
                run(f"iptables -t {table} -A FORWARD {rule}") # Añadir las reglas (-A) del cliente que se queda
            clients[ip] = {"slot": slot, "profile": link}
        clients[ip]["profile"] = link
        for queue in QUEUES:
            apply_queue(queue, link[queue.rsplit("_", 1)[1]], clients[ip]["slot"])


def set_profile(body: dict):
    """Perfil de la plaza general de cada cola: el de las pruebas que no tienen plaza propia. body: perfil de red, cada
    sentido y cada campo opcionales (lo que falta toma el valor de EMPTY), p. ej. {"down": {"rate_kbit": 3000, "delay_ms": 20}}."""
    for direction in DIRECTIONS:
        link = {**EMPTY, **(body.get(direction) or {})}
        for queue in QUEUES:
            if queue.endswith(direction):
                apply_queue(queue, link)
        profile[direction] = link
