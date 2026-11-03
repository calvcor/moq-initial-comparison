"""Relay RTP de la rama WebRTC con mediasoup: junta varios flujos UDP en un solo socket, sin tocar los datagramas.

El muxer RTP de FFmpeg saca una pista por salida, cada una con su socket, y su RTCP por otro. El PlainTransport de
mediasoup escucha en un solo puerto y solo acepta el origen del primer paquete que le llega (comedia), así que las
calidades de un simulcast y sus Sender Reports tienen que salir todas del mismo socket. Eso es todo lo que hace esto:
no mira el contenido, no reordena y no retiene nada. Sin los Sender Reports, mediasoup no puede cambiar de capa.

Lo que mediasoup envía de vuelta (RTCP con peticiones de keyframe) se lee y se descarta: el codificador no las atiende.

Termina si mediasoup deja de escuchar en ese puerto (reinicio del contenedor): el transporte se ha perdido y hay que
pedir otro, así que acaba con la tubería y el supervisor del orquestador la relanza.
"""
import select
import socket
import sys


def main(target: tuple, ports: list[int]):
    out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    out.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4 << 20)
    out.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    out.connect(target)
    poll = select.epoll()
    inputs = {out.fileno(): out}
    for port in ports:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
        sock.setblocking(False)
        sock.bind(("127.0.0.1", port))
        inputs[sock.fileno()] = sock
    out.setblocking(False)
    for fd in inputs:
        poll.register(fd, select.EPOLLIN)
    while True:
        for fd, _ in poll.poll():
            sock = inputs[fd]
            while True:
                try:
                    data = sock.recv(65536)
                except BlockingIOError:
                    break
                if sock is not out:
                    try:
                        out.send(data)
                    except BlockingIOError:
                        pass


if __name__ == "__main__":
    host, _, port = sys.argv[1].rpartition(":")
    try:
        main((host, int(port)), [int(p) for p in sys.argv[2:]])
    except ConnectionRefusedError:
        sys.exit("mediasoup ya no escucha en el puerto de ingesta")
    except KeyboardInterrupt:
        pass
