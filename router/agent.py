"""Router de emulación de red del testbed.

Reenvía a nivel IP (DNAT, sin terminar conexiones) los puertos que usa el navegador hacia los servidores
finales y degrada ese tráfico con tc en los dos sentidos:

    navegador -> :8443/tcp -> nginx-dash:443     (LL-DASH directo, con TLS)
    navegador -> :8080/tcp -> nginx-dash:80      (LL-DASH directo, sin TLS: sin DASH_HOST, desde páginas HTTP)
    navegador -> :4433/udp -> moq-relay:4433     (MoQ sobre QUIC)
    navegador -> :8189/udp -> sfu o mediamtx:8189 (WebRTC: ICE, DTLS y SRTP; el servidor lo elige RTC_SERVER)
    navegador -> :8189/tcp -> sfu:8189           (señalización WebSocket de mediasoup; va en la cola de WebRTC)

La ingesta (orquestador -> nginx / relay) va por la red interna sin pasar por aquí, así que la emulación
solo afecta al tramo servidor-cliente y lo hace igual para las dos ramas.

Expone un agente HTTP en :9000 para que el orquestador aplique perfiles y lea contadores.

Colas por cliente (desde el 6-11-2026): dentro de la cola de cada protocolo y sentido hay una plaza por cliente
(hasta MAX_CLIENTS, por IP) además de la general. Un cliente con plaza tiene su propio limitador y su netem, con su
perfil; el resto del tráfico va a la general, con el perfil de siempre. Así varios trabajadores de una campaña miden
a la vez, cada uno con su red, sin repartirse un enlace (README 4.8, pruebas en paralelo).
"""
import json
import math
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NGINX_IP = os.environ["NGINX_IP"]
RELAY_IP = os.environ["RELAY_IP"]
SFU_IP = os.environ["SFU_IP"]
RTC_IP = os.environ["MEDIAMTX_IP"] if os.environ.get("RTC_SERVER", "mediasoup").strip().lower() == "mediamtx" else os.environ["SFU_IP"]
DASH_PORT, DASH_TLS_PORT, MOQ_PORT, RTC_PORT = 8080, 8443, 4433, 8189

# Cada protocolo tiene su propia cola por sentido, con el mismo perfil: los dos ven un enlace idéntico
# en vez de competir entre sí por uno compartido. Número de la cola: su banda en la qdisc raíz (1:n) y la
# primera cifra de los handles de debajo (prio n00:, limitador n<plaza>0: y netem n<plaza>1:).
QUEUES = {"dash_down": 1, "moq_down": 2, "dash_up": 3, "moq_up": 4, "rtc_down": 5, "rtc_up": 6}
# Plazas de cada cola: 1..MAX_CLIENTS para los clientes con perfil propio y GENERAL para el resto. El cliente de la
# plaza s lleva la marca s (iptables, en FORWARD: ahí se ve su IP en los dos sentidos, antes del MASQUERADE de subida
# y después de deshacerlo en la bajada) y un filtro u32 por marca lo manda a su banda.
MAX_CLIENTS = 8
GENERAL = MAX_CLIENTS + 1
DIRECTIONS = ("down", "up")
EMPTY = {"rate_kbit": None, "delay_ms": 0, "jitter_ms": 0, "loss_pct": 0, "queue_ms": 300}
MTU_BITS = 1500 * 8

profile = {name: dict(EMPTY) for name in DIRECTIONS}
# Por (cola, plaza): si tiene limitador y netem puestos
shaped: dict[tuple[str, int], bool] = {}
# Clientes con perfil propio: IP -> {"slot": plaza, "profile": {"down": ..., "up": ...}}
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


# Reglas de FORWARD que cuentan el tráfico de cada cola: del servidor (bajada) o hacia él (subida)
COUNTED = [
    ("dash_down", f"-s {NGINX_IP} -p tcp --sport 80"),
    ("dash_up", f"-d {NGINX_IP} -p tcp --dport 80"),
    ("dash_down", f"-s {NGINX_IP} -p tcp --sport 443"),
    ("dash_up", f"-d {NGINX_IP} -p tcp --dport 443"),
    ("moq_down", f"-s {RELAY_IP} -p udp --sport {MOQ_PORT}"),
    ("moq_up", f"-d {RELAY_IP} -p udp --dport {MOQ_PORT}"),
    ("rtc_down", f"-s {RTC_IP} -p udp --sport {RTC_PORT}"),
    ("rtc_up", f"-d {RTC_IP} -p udp --dport {RTC_PORT}"),
    ("rtc_down", f"-s {SFU_IP} -p tcp --sport {RTC_PORT}"),
    ("rtc_up", f"-d {SFU_IP} -p tcp --dport {RTC_PORT}"),
]


def setup():
    # Reenvío de los puertos del cliente a los servidores finales, con contadores por protocolo y sentido
    for proto, port, dest_ip, dest_port in (
        ("tcp", DASH_PORT, NGINX_IP, 80),
        ("tcp", DASH_TLS_PORT, NGINX_IP, 443),
        ("udp", MOQ_PORT, RELAY_IP, MOQ_PORT),
        ("udp", RTC_PORT, RTC_IP, RTC_PORT),
        ("tcp", RTC_PORT, SFU_IP, RTC_PORT),
    ):
        run(f"iptables -t nat -A PREROUTING -p {proto} --dport {port} -j DNAT --to-destination {dest_ip}:{dest_port}")
    run("iptables -t nat -A POSTROUTING -m conntrack --ctstate DNAT -j MASQUERADE")
    for name, rule in COUNTED:
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
            run(f"{u32} match ip protocol 6 0xff match ip sport {DASH_PORT} 0xffff flowid 1:{QUEUES['dash_down']}")
            run(f"{u32} match ip protocol 17 0xff match ip sport {MOQ_PORT} 0xffff flowid 1:{QUEUES['moq_down']}")
            run(f"{u32} match ip protocol 6 0xff match ip dst {NGINX_IP}/32 match ip dport 80 0xffff flowid 1:{QUEUES['dash_up']}")
            run(f"{u32} match ip protocol 6 0xff match ip sport {DASH_TLS_PORT} 0xffff flowid 1:{QUEUES['dash_down']}")
            run(f"{u32} match ip protocol 6 0xff match ip dst {NGINX_IP}/32 match ip dport 443 0xffff flowid 1:{QUEUES['dash_up']}")
            run(f"{u32} match ip protocol 17 0xff match ip dst {RELAY_IP}/32 match ip dport {MOQ_PORT} 0xffff flowid 1:{QUEUES['moq_up']}")
            run(f"{u32} match ip protocol 17 0xff match ip sport {RTC_PORT} 0xffff flowid 1:{QUEUES['rtc_down']}")
            run(f"{u32} match ip protocol 17 0xff match ip dst {RTC_IP}/32 match ip dport {RTC_PORT} 0xffff flowid 1:{QUEUES['rtc_up']}")
            run(f"{u32} match ip protocol 6 0xff match ip sport {RTC_PORT} 0xffff flowid 1:{QUEUES['rtc_down']}")
            run(f"{u32} match ip protocol 6 0xff match ip dst {SFU_IP}/32 match ip dport {RTC_PORT} 0xffff flowid 1:{QUEUES['rtc_up']}")
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
    parent, limiter, netem = handles(queue, slot)
    active = bool(link["rate_kbit"] or link["delay_ms"] or link["jitter_ms"] or link["loss_pct"])
    for dev in interfaces():
        if not active:
            # Sin restricciones se retira todo: paso directo real, no un limitador muy alto
            run(f"tc qdisc del dev {dev} parent {parent} handle {limiter}:", check=False)
            continue

        # Limitador delante con ráfaga de un paquete: además de fijar el ancho de banda, trocea los
        # superpaquetes GSO/TSO, que netem descartaría enteros falseando la tasa de pérdida.
        rate_bps = (link["rate_kbit"] or 1_000_000) * 1000
        verb = "change" if shaped.get((queue, slot)) else "add"
        run(f"tc qdisc {verb} dev {dev} parent {parent} handle {limiter}: tbf rate {rate_bps}bit burst 1600 latency 1s")

        # netem aplica retardo y pérdida, y su límite hace de cola del cuello de botella. El límite va en
        # paquetes: los que caben en tránsito durante el retardo más los de la cola pedida.
        hold_ms = link["delay_ms"] + link["jitter_ms"] + (link["queue_ms"] if link["rate_kbit"] else 1000)
        limit = max(20, math.ceil(rate_bps * hold_ms / 1000 / MTU_BITS))
        spec = f"limit {min(limit, 100000)}"
        if link["delay_ms"] or link["jitter_ms"]:
            spec += f" delay {link['delay_ms']}ms"
            if link["jitter_ms"]:
                spec += f" {link['jitter_ms']}ms 25%"
        if link["loss_pct"]:
            spec += f" loss {link['loss_pct']}%"
        run(f"tc qdisc {verb} dev {dev} parent {limiter}:1 handle {netem}: netem {spec}")
    shaped[queue, slot] = active


def client_rules(ip: str, slot: int) -> list[tuple[str, str]]:
    """Reglas de iptables de un cliente con plaza (tabla, regla de FORWARD): su marca, en los dos sentidos, y sus
    contadores por cola."""
    rules = [("mangle", f"-s {ip}/32 -j MARK --set-mark {slot}"), ("mangle", f"-d {ip}/32 -j MARK --set-mark {slot}")]
    for name, rule in COUNTED:
        side = "-d" if name.endswith("_down") else "-s"
        rules.append(("filter", f"{side} {ip}/32 {rule} -m comment --comment {name}@{ip}"))
    return rules


def set_clients(wanted: dict[str, dict]):
    """Deja exactamente esos clientes con perfil propio (IP -> {"down", "up"}); los demás vuelven a la cola general."""
    if len(wanted) > MAX_CLIENTS:
        raise ValueError(f"Como mucho {MAX_CLIENTS} clientes con perfil propio")
    for ip in wanted:
        if not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip):
            raise ValueError(f"IP de cliente no válida: {ip}")
    for ip in [ip for ip in clients if ip not in wanted]:
        # Se quita la plaza y sus reglas de FORWARD, y se deja el tráfico en la cola general, para los clientes que no tengan perfil propio
        slot = clients.pop(ip)["slot"]
        for table, rule in client_rules(ip, slot):
            run(f"iptables -t {table} -D FORWARD {rule}", check=False)
        for queue in QUEUES:
            apply_queue(queue, EMPTY, slot)
    for ip, body in wanted.items():
        # Se actualiza el perfil del cliente (si no existía, se le asigna la plaza más baja libre y se ponen sus reglas de FORWARD)
        link = {d: {**EMPTY, **(body.get(d) or {})} for d in DIRECTIONS}
        if ip not in clients:
            # Se le asigna la plaza más baja libre y se ponen sus reglas de FORWARD
            slot = min(set(range(1, MAX_CLIENTS + 1)) - {c["slot"] for c in clients.values()})
            for table, rule in client_rules(ip, slot):
                run(f"iptables -t {table} -A FORWARD {rule}")
            clients[ip] = {"slot": slot, "profile": link}
        clients[ip]["profile"] = link
        for queue in QUEUES:
            apply_queue(queue, link[queue.rsplit("_", 1)[1]], clients[ip]["slot"])


def stats() -> dict:
    """Contadores por cola (todo el tráfico, como siempre) y, en "clients", los de cada cliente con plaza."""
    out = {queue: {"packets": 0, "bytes": 0} for queue in QUEUES}
    per_client = {ip: {queue: {"packets": 0, "bytes": 0} for queue in QUEUES} for ip in clients}
    # Bytes IP reenviados por protocolo y sentido (cabeceras y retransmisiones incluidas), antes de la emulación
    for line in run("iptables-save -c -t filter").splitlines():
        if "--comment" in line and line.startswith("["):
            packets, size = line[1 : line.index("]")].split(":")
            name = line.split("--comment")[1].split()[0].strip('"')
            queue, _, ip = name.partition("@")
            # DASH tiene dos reglas por sentido (camino directo y a través del proxy): se suman
            entry = (per_client.get(ip) or {}).get(queue) if ip else out.get(queue)
            if entry is not None:
                entry["packets"] += int(packets)
                entry["bytes"] += int(size)
    # Descartes de la emulación por cola y plaza: pérdida aleatoria de netem y desbordamiento de la cola
    slots = {c["slot"]: ip for ip, c in clients.items()}
    netems = {}
    for dev in interfaces():
        for qdisc in json.loads(run(f"tc -s -j qdisc show dev {dev}")):
            # Solo netem: el limitador padre vuelve a contar los mismos descartes
            if qdisc.get("kind") == "netem":
                acc = netems.setdefault(qdisc.get("handle"), [0, 0])
                acc[0] += qdisc.get("drops", 0)
                acc[1] += qdisc.get("qlen", 0)
    for queue in QUEUES:
        out[queue].update(dropped=0, queued=0)
        for slot in range(1, GENERAL + 1):
            dropped, backlog = netems.get(handles(queue, slot)[2] + ":", (0, 0))
            out[queue]["dropped"] += dropped
            out[queue]["queued"] += backlog
            if slot in slots:
                per_client[slots[slot]][queue].update(dropped=dropped, queued=backlog)
    out["clients"] = per_client
    return out


class Agent(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def state(self) -> dict:
        return {"profile": profile, "clients": {ip: c["profile"] for ip, c in clients.items()}, "stats": stats(), "emulation_error": emulation_error}

    def do_GET(self):
        self.reply(200, self.state())

    def do_POST(self):
        try:
            if emulation_error:
                raise RuntimeError(f"Emulación de red no disponible en este servidor: {emulation_error}")
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if self.path.rstrip("/") == "/clients":
                # Los clientes con perfil propio, todos de una vez (un {} los quita)
                set_clients(body)
            else:
                for direction in DIRECTIONS:
                    link = {**EMPTY, **(body.get(direction) or {})}
                    for queue in QUEUES:
                        if queue.endswith(direction):
                            apply_queue(queue, link)
                    profile[direction] = link
            self.reply(200, self.state())
        except Exception as e:
            self.reply(400, {"error": str(e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    setup()
    print(f"Router listo: interfaces {interfaces()}, nginx {NGINX_IP}, relay {RELAY_IP}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 9000), Agent).serve_forever()
