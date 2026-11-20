"""Autorización del relay de MoQ: cualquiera puede suscribirse a anon/**, y solo el publicador puede publicar.

El relay no verifica tokens por sí mismo: pregunta a un servidor de autorización en cada sesión (--auth-url). Aquí corre
el de referencia, `moq auth serve`, con el moq-cli del publicador, y escucha en un socket unix compartido con el
contenedor del relay. Las sesiones sin token reciben la regla pública (solo suscribirse a anon/**); el publicador
presenta en ?jwt= un token firmado con una clave que solo existe en este contenedor, con permiso para publicar
anon/live.hang.

La clave se genera en cada arranque del orquestador y no se guarda: un reinicio solo invalida el token del publicador,
que se vuelve a lanzar con el nuevo. Las sesiones ya admitidas siguen (sin --revalidate, el relay no vuelve a preguntar).
Mientras este servidor no responde, el relay rechaza las sesiones nuevas: nunca admite a nadie por estar caído.
"""
import logging
import os
import subprocess
import threading
import time
from typing import Optional

logger = logging.getLogger("orchestrator")

# Directorio compartido con el relay (volumen moq-auth en docker-compose.yml): solo el socket
SOCKET = "/run/moq-auth/auth.sock"
# La clave, fuera del volumen compartido: el relay no la necesita
KEY = "/tmp/moq-auth/key.jwk"
# Lo que pueden hacer las sesiones anónimas (los espectadores) y lo que el token deja publicar al publicador, relativo a
# la ruta /anon a la que se conecta
PUBLIC_SUBSCRIBE = "anon/**"
ROOT = "anon"
PUBLISH = "live.hang"

_token: Optional[str] = None
_proc: Optional[subprocess.Popen] = None
_ready = threading.Event()


def _env() -> dict:
    # moq-cli de main se niega a arrancar con variables MOQ_* que no lee (las del orquestador)
    return {k: v for k, v in os.environ.items() if not k.startswith("MOQ_")}


def _moq(*args: str) -> str:
    return subprocess.run(["moq", *args], env=_env(), check=True, capture_output=True, text=True).stdout


def _sign() -> str:
    args = ["auth", "sign", "--key", KEY, "--root", ROOT, "--publish", PUBLISH]
    # Sin caducidad: las versiones recientes caducan el token a la hora salvo --unbounded; las anteriores no tienen
    # esa opción y sin --expires no caducan
    if "--unbounded" in _moq("auth", "sign", "--help"):
        args.append("--unbounded")
    return _moq(*args).strip()


def _serve() -> subprocess.Popen:
    try:
        os.unlink(SOCKET)  # el de un arranque anterior
    except FileNotFoundError:
        pass
    cmd = ["moq", "auth", "serve", "--listen", f"unix:{SOCKET}", "--key", KEY, "--public-subscribe", PUBLIC_SUBSCRIBE]
    return subprocess.Popen(cmd, env=_env(), stdout=subprocess.DEVNULL, stderr=open("/tmp/moq_auth.log", "w"))


def start() -> None:
    """Genera la clave y el token y deja el servidor de autorización en marcha, relanzándolo si cae."""
    global _token, _proc
    os.makedirs(os.path.dirname(KEY), exist_ok=True)
    os.makedirs(os.path.dirname(SOCKET), exist_ok=True)
    if os.path.exists(KEY):
        os.unlink(KEY)
    # HMAC: quien firma y quien verifica son el mismo contenedor
    _moq("auth", "generate", "--algorithm", "HS256", "--out", KEY)
    os.chmod(KEY, 0o600)
    _token = _sign()
    _proc = _serve()
    _ready.set()
    logger.info("Autorización de MoQ: lectura anónima en anon/**; publicar, solo con el token del publicador")

    def supervise():
        global _proc
        while True:
            time.sleep(1)
            if _proc.poll() is not None:
                logger.warning("Autorización de MoQ: el servidor ha caído; se relanza")
                time.sleep(2)
                _proc = _serve()

    threading.Thread(target=supervise, daemon=True).start()


def token(timeout: float = 30) -> str:
    """El token del publicador. Espera a que start() lo haya firmado."""
    if not _ready.wait(timeout):
        raise RuntimeError("el servidor de autorización de MoQ no ha arrancado")
    return _token
