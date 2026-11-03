"""Vídeos fuente del testbed, de la Blender Foundation (CC BY 3.0):

- Big Buck Bunny 1080p60 ("file", la fuente por defecto).
- Tears of Steel 1080p ("tos"): 1920x800 a 24 fps, imagen real con efectos por ordenador.

No se distribuyen con el repositorio. Si faltan, se descargan de la web de Blender al arrancar.
"""
import logging
import os
import shutil
import threading
import zipfile

import requests

logger = logging.getLogger("orchestrator")

VIDEO_FILE = os.getenv("VIDEO_FILE", "/data/bbb_sunflower_1080p_60fps_normal.mp4")
DATA_DIR = os.path.dirname(VIDEO_FILE)

# Cada vídeo, por su clave en StreamConfig.source. fps es la cadencia del fichero, que es la de la emisión:
# no se convierte, para no duplicar frames y para que el frame n emitido sea el n del original (VMAF).
# prepare lo lleva a 1920x1080 antes del timecode, como en la emisión; qoe.py lo aplica también al
# original para compararlo. width y height son los de después de prepare.
VIDEOS = {
    "file": {
        "label": "Big Buck Bunny",
        "url": os.getenv(
            "VIDEO_URL", "https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_60fps_normal.mp4.zip"
        ),
        "path": VIDEO_FILE,
        "fps": 60,
        "prepare": "",
        "width": 1920,
        "height": 1080,
    },
    # El MKV de la página de descargas (mango.blender.org) ya no está en sus espejos: el de Italia no resuelve
    # y los demás dan 404 (comprobado el 3-11-2026). Este es el MOV 1080p de la web de Blender, el mismo
    # vídeo (H.264 1920x800 a 24 fps, MP3 estéreo a 44,1 kHz, 734 s).
    "tos": {
        "label": "Tears of Steel",
        "url": os.getenv(
            "TOS_VIDEO_URL", "https://download.blender.org/demo/movies/ToS/tears_of_steel_1080p.mov.zip"
        ),
        "path": os.getenv("TOS_VIDEO_FILE", os.path.join(DATA_DIR, "tears_of_steel_1080p.mov")),
        "fps": 24,
        # 2,4:1 en un cuadro 16:9: bandas negras arriba y abajo, sin escalar
        "prepare": "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1",
        "width": 1920,
        "height": 1080,
    },
}

# Lo que ve el dashboard mientras se preparan: ready | downloading | extracting | error
states = {kind: {"state": "downloading", "progress_pct": 0, "error": None} for kind in VIDEOS}
# Compatibilidad: el estado de Big Buck Bunny, que es el que hace falta para arrancar
state = states["file"]

_fetching: set[str] = set()
_lock = threading.Lock()


def path(kind: str) -> str:
    return VIDEOS[kind]["path"]


def fetch_video(kind: str = "file"):
    """Deja el vídeo en su sitio, descargándolo y descomprimiéndolo si no está. Lanza excepción si falla."""
    video, st = VIDEOS[kind], states[kind]
    dest = video["path"]
    if os.path.exists(dest):
        st.update(state="ready", progress_pct=100, error=None)
        return

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    archive = dest + ".zip.part"
    logger.info(f"Vídeo fuente {video['label']} no encontrado; descargando {video['url']}")
    st.update(state="downloading", progress_pct=0, error=None)
    with requests.get(video["url"], stream=True, timeout=30) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length", 0))
        done = 0
        with open(archive, "wb") as out:
            for chunk in response.iter_content(chunk_size=1 << 20):
                out.write(chunk)
                done += len(chunk)
                if total:
                    st["progress_pct"] = int(done * 100 / total)

    # El .zip trae un único vídeo; se escribe con otro nombre y se renombra al final para no dejar
    # un fichero a medias que parezca válido si el proceso se interrumpe.
    st.update(state="extracting")
    extension = os.path.splitext(dest)[1].lower()
    with zipfile.ZipFile(archive) as bundle:
        member = next(name for name in bundle.namelist() if name.lower().endswith(extension))
        with bundle.open(member) as src, open(dest + ".part", "wb") as out:
            shutil.copyfileobj(src, out, 1 << 20)
    os.replace(dest + ".part", dest)
    os.remove(archive)
    logger.info(f"Vídeo fuente {video['label']} listo en {dest}")
    st.update(state="ready", progress_pct=100, error=None)


def fetch_in_background(kind: str):
    """Descarga un vídeo en otro hilo si no está ya en curso. Un fallo queda en su estado y no se reintenta solo."""
    with _lock:
        if kind in _fetching or states[kind]["state"] == "ready":
            return
        _fetching.add(kind)

    def run():
        try:
            fetch_video(kind)
        except Exception as e:
            logger.error(f"No se pudo obtener el vídeo fuente {VIDEOS[kind]['label']}: {e}")
            states[kind].update(state="error", error=str(e))
        finally:
            with _lock:
                _fetching.discard(kind)

    threading.Thread(target=run, daemon=True).start()
