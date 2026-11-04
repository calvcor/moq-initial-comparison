"""Relay RTP de la rama WebRTC con mediasoup: junta varios flujos UDP en un solo socket, sin tocar los datagramas.

El muxer RTP de FFmpeg saca una pista por salida, cada una con su socket, y su RTCP por otro. El PlainTransport de
mediasoup escucha en un solo puerto y solo acepta el origen del primer paquete que le llega (comedia), así que las
calidades de un simulcast y sus Sender Reports tienen que salir todas del mismo socket. Sin los Sender Reports,
mediasoup no puede cambiar de capa. Por defecto es todo lo que hace: no mira el contenido, no reordena y no retiene
nada.

Con --pace F (opción rtc_pacing de la emisión, un experimento declarado: README, 3.4c) además reparte en el tiempo
el RTP de cada calidad, como el pacer de libwebrtc en un publicador WebRTC: cada puerto marcado con su bitrate
(PUERTO:KBPS) sale a F veces ese bitrate, y lo que no cabe espera en su cola, en orden. Sin él, FFmpeg suelta cada
frame de golpe y mediasoup lo reenvía igual (una keyframe de 1080p, más de 100 paquetes en menos de 1 ms). El RTCP y
los puertos sin bitrate (el audio) pasan sin esperar.

Lo que mediasoup envía de vuelta (RTCP con peticiones de keyframe) se lee y se descarta: el codificador no las atiende.

Termina si mediasoup deja de escuchar en ese puerto (reinicio del contenedor): el transporte se ha perdido y hay que
pedir otro, así que acaba con la tubería y el supervisor del orquestador la relanza.
"""
import collections
import select
import socket
import sys
import time

# Tras un rato sin enviar, lo que un flujo puede soltar seguido: 5 ms a su ritmo, la ventana del pacer de libwebrtc
BURST_S = 0.005
# Cabeceras IP y UDP, que cuentan en el ritmo como en el enlace
OVERHEAD = 28


class Pacer:
    """Cola de un flujo RTP que sale a un ritmo fijo (bytes/s)."""

    def __init__(self, rate: float):
        self.rate = rate
        self.queue = collections.deque()
        self.free_at = 0.0  # cuándo puede salir el siguiente paquete

    def drain(self, out: socket.socket, now: float):
        """Envía lo que toca; devuelve cuándo hay que volver, o None si la cola está vacía."""
        while self.queue:
            start = max(self.free_at, now - BURST_S)
            if start > now:
                return start
            data = self.queue.popleft()
            send(out, data)
            self.free_at = start + (len(data) + OVERHEAD) / self.rate
        return None


def send(out: socket.socket, data: bytes):
    try:
        out.send(data)
    except BlockingIOError:
        pass


def main(target: tuple, ports: list[tuple[int, int]], factor: float):
    out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    out.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4 << 20)
    out.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    out.connect(target)
    poll = select.epoll()
    inputs = {out.fileno(): out}
    pacers = {}
    for port, kbps in ports:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
        sock.setblocking(False)
        sock.bind(("127.0.0.1", port))
        inputs[sock.fileno()] = sock
        if factor and kbps:
            pacers[sock.fileno()] = Pacer(factor * kbps * 1000 / 8)
    out.setblocking(False)
    for fd in inputs:
        poll.register(fd, select.EPOLLIN)
    wake = None
    while True:
        timeout = -1 if wake is None else max(0.0, wake - time.monotonic())
        for fd, _ in poll.poll(timeout):
            sock = inputs[fd]
            pacer = pacers.get(fd)
            while True:
                try:
                    data = sock.recv(65536)
                except BlockingIOError:
                    break
                if pacer is not None:
                    pacer.queue.append(data)
                elif sock is not out:
                    send(out, data)
        now = time.monotonic()
        wake = min((t for t in (p.drain(out, now) for p in pacers.values()) if t is not None), default=None)


if __name__ == "__main__":
    args = sys.argv[1:]
    factor = 0.0
    if args[0] == "--pace":
        factor = float(args[1])
        args = args[2:]
    host, _, port = args[0].rpartition(":")
    ports = [(int(p), int(k or 0)) for p, _, k in (a.partition(":") for a in args[1:])]
    try:
        main((host, int(port)), ports, factor)
    except ConnectionRefusedError:
        sys.exit("mediasoup ya no escucha en el puerto de ingesta")
    except KeyboardInterrupt:
        pass
