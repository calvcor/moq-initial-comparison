"""Agente HTTP del router de emulación (:9000) y lectura de sus contadores.

El orquestador aplica aquí los perfiles de red (POST /, la plaza general; POST /clients, los clientes con plaza propia) y
lee el estado (GET /): perfiles, contadores por cola y por cliente, y el árbol de tc para el esquema de la página. El
reenvío, el árbol de tc y la aplicación de los perfiles están en agent.py; este módulo solo los llama y lee lo que hay.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import agent as router


def netem_counters() -> dict:
    """Por handle de netem ("211:"), [descartes, paquetes en cola], sumados en todas las interfaces."""
    netems = {}
    for dev in router.interfaces():
        for qdisc in json.loads(router.run(f"tc -s -j qdisc show dev {dev}")):
            # Solo netem: el limitador padre vuelve a contar los mismos descartes
            if qdisc.get("kind") == "netem":
                acc = netems.setdefault(qdisc.get("handle"), [0, 0])
                acc[0] += qdisc.get("drops", 0)
                acc[1] += qdisc.get("qlen", 0)
    return netems


def stats(netems: dict) -> dict:
    """Contadores por cola (todo el tráfico, como siempre) y, en "clients", los de cada cliente con plaza."""
    out = {queue: {"packets": 0, "bytes": 0} for queue in router.QUEUES}
    per_client = {ip: {queue: {"packets": 0, "bytes": 0} for queue in router.QUEUES} for ip in router.clients}
    # Bytes IP reenviados por protocolo y sentido (cabeceras y retransmisiones incluidas), antes de la emulación
    for line in router.run("iptables-save -c -t filter").splitlines():
        if "--comment" in line and line.startswith("["):
            packets, size = line[1 : line.index("]")].split(":")
            name = line.split("--comment")[1].split()[0].strip('"')
            queue, _, ip = name.partition("@")
            # DASH tiene dos reglas por sentido (HTTP y HTTPS) y WebRTC otras dos (UDP y TCP): se suman
            entry = (per_client.get(ip) or {}).get(queue) if ip else out.get(queue)
            if entry is not None:
                entry["packets"] += int(packets)
                entry["bytes"] += int(size)
    # Descartes de la emulación por cola y plaza: pérdida aleatoria de netem y desbordamiento de la cola
    slots = {c["slot"]: ip for ip, c in router.clients.items()}
    for queue in router.QUEUES:
        out[queue].update(dropped=0, queued=0)
        for slot in range(1, router.GENERAL + 1):
            dropped, backlog = netems.get(router.handles(queue, slot)[2] + ":", (0, 0))
            out[queue]["dropped"] += dropped
            out[queue]["queued"] += backlog
            if slot in slots:
                per_client[slots[slot]][queue].update(dropped=dropped, queued=backlog)
    out["clients"] = per_client
    return out


def describe(queue: str) -> str:
    """Qué tráfico manda la raíz a esta cola, leído de FILTERS (agent.py)."""
    parts = []
    for q, proto, dst, field, port in router.FILTERS:
        if q == queue:
            parts.append(f"{proto} {'origen' if field == 'sport' else 'destino'} {f'{dst}:' if dst else ':'}{port}")
    return " · ".join(parts)


def tree(st: dict, netems: dict) -> dict:
    """El árbol de tc tal como lo ha montado el agente (el mismo en cada interfaz), con los contadores de cada plaza: raíz
    1:, una banda por cola y, dentro de cada una, su prio con las plazas de los clientes y la general. Para el esquema de
    la página (README, sección 5); los bytes son los de iptables, antes de la emulación."""
    slots = {c["slot"]: ip for ip, c in router.clients.items()}
    bands = []
    for queue, n in router.QUEUES.items():
        children = []
        for slot in range(1, router.GENERAL + 1):
            band, limiter, netem = router.handles(queue, slot)
            ip = slots.get(slot)
            if slot == router.GENERAL:
                # La general se lleva lo que no es de ningún cliente con plaza
                packets = st[queue]["packets"] - sum(c[queue]["packets"] for c in st["clients"].values())
                size = st[queue]["bytes"] - sum(c[queue]["bytes"] for c in st["clients"].values())
            elif ip:
                packets, size = st["clients"][ip][queue]["packets"], st["clients"][ip][queue]["bytes"]
            else:
                packets = size = 0
            dropped, queued = netems.get(netem + ":", (0, 0))
            link = router.applied.get((queue, slot))
            children.append({
                "slot": slot,
                "band": band,
                "general": slot == router.GENERAL,
                "client": ip,
                # Sin restricciones no hay limitador ni netem: la banda deja pasar tal cual
                "limiter": f"{limiter}:" if link else None,
                "netem": f"{netem}:" if link else None,
                "link": link,
                "packets": packets,
                "bytes": size,
                "dropped": dropped,
                "queued": queued,
            })
        bands.append({"band": f"1:{n}", "queue": queue, "handle": f"{n}00:", "match": describe(queue), "slots": children})
    bands.sort(key=lambda b: b["band"])
    bands.append({"band": f"1:{len(router.QUEUES) + 1}", "queue": None, "handle": None, "match": "el resto del tráfico, sin emulación", "slots": []})
    return {"root": "1:", "interfaces": router.interfaces(), "bands": bands}


class Agent(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def state(self) -> dict:
        netems = netem_counters()
        st = stats(netems)
        return {
            "profile": router.profile,
            "clients": {ip: c["profile"] for ip, c in router.clients.items()},
            "stats": st,
            # Sin emulación (faltan módulos del kernel) no hay árbol de tc que mostrar
            "tree": None if router.emulation_error else tree(st, netems),
            "emulation_error": router.emulation_error,
        }

    def do_GET(self):
        self.reply(200, self.state())

    def do_POST(self):
        try:
            if router.emulation_error:
                raise RuntimeError(f"Emulación de red no disponible en este servidor: {router.emulation_error}")
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if self.path.rstrip("/") == "/clients":
                # Los clientes con perfil propio, todos de una vez (un {} los quita)
                router.set_clients(body)
            else:
                router.set_profile(body)
            self.reply(200, self.state())
        except Exception as e:
            self.reply(400, {"error": str(e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    router.setup()
    print(f"Router listo: interfaces {router.interfaces()}, nginx {router.NGINX_IP}, relay {router.RELAY_IP}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 9000), Agent).serve_forever()
