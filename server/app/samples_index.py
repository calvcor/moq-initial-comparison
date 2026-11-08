"""Índice de las filas de una campaña (samples.jsonl) para el análisis y la comparación de pruebas (README 4.8).

Leer samples.jsonl entero era casi todo el tiempo de un análisis (medido el 8-11-2026 en el servidor: 1,2-1,3 s de
1,5-1,6 s con las campañas de 208 pruebas, unos 100 MB). El índice guarda, por intento de prueba (id y run_started_ms) y
reproductor, lo único que se necesita de las filas de su medida: cuántos segundos pasó en cada altura y unos campos de la
primera fila (versiones, servidor WebRTC, sonido, cadencia). Va en disco junto a la campaña (samples_index.json), con
hasta dónde se ha leído el fichero: como samples.jsonl solo crece, la siguiente vez se lee solo lo nuevo. Si el fichero
encoge o es otro (las medidas se borraron), se rehace desde el principio.
"""
import json
import os
import threading
from typing import Optional

PLAYERS = ("dash", "moq", "rtc")
# Si cambia lo que se guarda, se sube y los índices anteriores se rehacen
VERSION = 1
# De la primera fila de la medida de cada reproductor
CONTEXT_FIELDS = ("versions", "rtc_server", "audio", "fps", "worker")

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
# Último índice de cada campaña en memoria, para no releer el JSON en cada petición
_memory: dict[str, dict] = {}


def _lock(cid: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(cid, threading.Lock())


def run_key(run_id: str, started_ms) -> str:
    return f"{run_id}@{started_ms}"


def _empty(st: Optional[os.stat_result]) -> dict:
    return {"version": VERSION, "inode": st.st_ino if st else None, "offset": 0, "runs": {}}


def index(store, cid: str) -> dict:
    """El índice de la campaña, al día con su samples.jsonl. runs: {"r0001@<inicio>": {"moq": {"heights": {"1080": 57,
    ...}, "context": {...}}}}."""
    samples = store.path(cid, "samples.jsonl")
    path = store.path(cid, "samples_index.json")
    with _lock(cid):
        try:
            st = os.stat(samples)
        except OSError:
            return _empty(None)
        idx = _memory.get(cid)
        if idx is None:
            try:
                with open(path) as f:
                    idx = json.load(f)
            except (OSError, ValueError):
                idx = None
        if not idx or idx.get("version") != VERSION or idx.get("inode") != st.st_ino or idx.get("offset", 0) > st.st_size:
            idx = _empty(st)
        if idx["offset"] < st.st_size:
            _read(samples, idx)
            tmp = path + ".part"
            with open(tmp, "w") as f:
                json.dump(idx, f)
            os.replace(tmp, path)
        _memory[cid] = idx
        return idx


def _read(samples: str, idx: dict):
    """Añade al índice las filas de medida desde idx["offset"]; una última línea a medio escribir se deja para la próxima."""
    runs = idx["runs"]
    with open(samples, "rb") as f:
        f.seek(idx["offset"])
        offset = idx["offset"]
        for raw in f:
            if not raw.endswith(b"\n"):
                break
            offset += len(raw)
            if b'"measuring"' not in raw:
                continue
            row = json.loads(raw)
            if row.get("phase") != "measuring":
                continue
            entry = runs.setdefault(run_key(row.get("run_id"), row.get("run_started_ms")), {})
            for p in (row.get("players") or "").split("|"):
                if p not in PLAYERS:
                    continue
                player = entry.get(p)
                if player is None:
                    player = entry[p] = {"heights": {}, "context": {k: row.get(k) for k in CONTEXT_FIELDS}}
                h = row.get(f"{p}_height")
                if isinstance(h, (int, float)) and not isinstance(h, bool):
                    key = str(int(h)) if float(h).is_integer() else str(h)
                    player["heights"][key] = player["heights"].get(key, 0) + 1
    idx["offset"] = offset


def forget(cid: str):
    """Al borrar las medidas o la campaña: el índice en memoria ya no vale (el del disco se borra con los ficheros)."""
    with _lock(cid):
        _memory.pop(cid, None)


def player_entry(idx: dict, run: dict, player: str) -> dict:
    return (idx["runs"].get(run_key(run["id"], run.get("started_ms"))) or {}).get(player) or {}


def height_stats(entry: dict, top: int) -> dict:
    """De los segundos en cada altura: la más alta y la más baja reproducidas y la fracción en la más alta de la emisión."""
    hist = {(int(float(h)) if float(h).is_integer() else float(h)): n for h, n in (entry.get("heights") or {}).items()}
    total = sum(hist.values())
    if not total:
        return {"height_max": None, "height_min": None, "ladder_top_share": None}
    # Sin redondear: el análisis compara la diferencia con la variación entre repeticiones y un redondeo la movería
    return {"height_max": max(hist), "height_min": min(hist),
            "ladder_top_share": sum(n for h, n in hist.items() if h >= top) / total}
