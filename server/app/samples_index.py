"""Índice de las filas de una campaña (samples.jsonl) para el análisis y la comparación de pruebas (docs/campaigns.md).

Leer samples.jsonl entero es casi todo el tiempo de un análisis (medido: 1,2-1,3 s de 1,5-1,6 s con las campañas de
208 pruebas, unos 100 MB). El índice guarda, por intento de prueba (id y run_started_ms) y reproductor, lo único que
se necesita de las filas de su medida: cuántos segundos pasó en cada altura y unos campos de la primera fila
(versiones, servidor WebRTC, sonido, cadencia). Va en disco junto a la campaña (samples_index.json), con hasta dónde
se ha leído el fichero: como samples.jsonl solo crece, la siguiente vez se lee solo lo nuevo. Si el fichero encoge o
es otro (las medidas se borraron), se rehace desde el principio.

Guarda además dónde están en el fichero las filas de cada intento (spans: el primer y el último byte), y lo mismo para
ip.jsonl en ip_index.json, para que la gráfica segundo a segundo lea solo esos tramos: leerlo entero en cada petición
cuesta 11 s con los 1,5 GB de la campaña más grande medida.
"""
import json
import os
import re
import threading
from typing import Optional

PLAYERS = ("dash", "moq", "rtc")
# Si cambia lo que se guarda, se sube y los índices anteriores se rehacen
VERSION = 2
# De la primera fila de la medida de cada reproductor
CONTEXT_FIELDS = ("versions", "rtc_server", "audio", "fps", "worker")

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
# Último índice de cada campaña en memoria, para no releer el JSON en cada petición
_memory: dict[str, dict] = {}
RUN_ID = re.compile(rb'"run_id": "([^"]*)"')
RUN_STARTED = re.compile(rb'"run_started_ms": (-?\d+|null)')


def _lock(cid: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(cid, threading.Lock())


def run_key(run_id: str, started_ms) -> str:
    return f"{run_id}@{started_ms}"


def _empty(st: Optional[os.stat_result]) -> dict:
    return {"version": VERSION, "inode": st.st_ino if st else None, "offset": 0, "runs": {}, "spans": {}}


def _updated(cid: str, source: str, path: str, memory_key: str, read) -> dict:
    """El índice de un fichero de la campaña, al día: del disco o de memoria, leyendo solo lo nuevo, o rehecho si el
    fichero encogió o es otro."""
    with _lock(memory_key):
        try:
            st = os.stat(source)
        except OSError:
            return _empty(None)
        idx = _memory.get(memory_key)
        if idx is None:
            try:
                with open(path) as f:
                    idx = json.load(f)
            except (OSError, ValueError):
                idx = None
        if not idx or idx.get("version") != VERSION or idx.get("inode") != st.st_ino or idx.get("offset", 0) > st.st_size:
            idx = _empty(st)
        if idx["offset"] < st.st_size:
            read(source, idx)
            tmp = path + ".part"
            with open(tmp, "w") as f:
                json.dump(idx, f)
            os.replace(tmp, path)
        _memory[memory_key] = idx
        return idx


def index(store, cid: str) -> dict:
    """El índice de la campaña, al día con su samples.jsonl. runs: {"r0001@<inicio>": {"moq": {"heights": {"1080": 57,
    ...}, "context": {...}}}}; spans: {"r0001@<inicio>": [primer byte, fin]}."""
    return _updated(cid, store.path(cid, "samples.jsonl"), store.path(cid, "samples_index.json"), cid, _read)


def ip_index(store, cid: str) -> dict:
    """Lo mismo para ip.jsonl, solo con spans."""
    return _updated(cid, store.path(cid, "ip.jsonl"), store.path(cid, "ip_index.json"), f"{cid}:ip", _read_spans)


def _span(spans: dict, raw: bytes, start: int, end: int) -> Optional[str]:
    """Amplía el tramo del intento de la fila y devuelve su clave (None si la fila no la dice)."""
    rid, started = RUN_ID.search(raw), RUN_STARTED.search(raw)
    if not rid:
        return None
    key = run_key(rid.group(1).decode(), None if not started or started.group(1) == b"null" else int(started.group(1)))
    span = spans.get(key)
    if span is None:
        spans[key] = [start, end]
    else:
        span[0], span[1] = min(span[0], start), max(span[1], end)
    return key


def _read_spans(source: str, idx: dict):
    spans = idx.setdefault("spans", {})
    with open(source, "rb") as f:
        f.seek(idx["offset"])
        offset = idx["offset"]
        for raw in f:
            if not raw.endswith(b"\n"):
                break
            _span(spans, raw, offset, offset + len(raw))
            offset += len(raw)
    idx["offset"] = offset


def _read(samples: str, idx: dict):
    """Añade al índice las filas desde idx["offset"]: el tramo de todas y, de las de medida, alturas y contexto. Una
    última línea a medio escribir se deja para la próxima."""
    runs = idx["runs"]
    spans = idx.setdefault("spans", {})
    with open(samples, "rb") as f:
        f.seek(idx["offset"])
        offset = idx["offset"]
        for raw in f:
            if not raw.endswith(b"\n"):
                break
            _span(spans, raw, offset, offset + len(raw))
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
    for key in (cid, f"{cid}:ip"):
        with _lock(key):
            _memory.pop(key, None)


def read_runs(source: str, idx: dict, keys: list[str]):
    """Las filas (como bytes) de los intentos pedidos: solo los tramos del fichero donde están, en orden de fichero. Pueden
    venir filas de otros intentos que caían en medio; quien las lee las filtra."""
    ranges = sorted(tuple(idx.get("spans", {})[k]) for k in keys if k in idx.get("spans", {}))
    merged: list[list[int]] = []
    for start, end in ranges:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    try:
        with open(source, "rb") as f:
            for start, end in merged:
                f.seek(start)
                for raw in f.read(end - start).splitlines():
                    if raw.strip():
                        yield raw
    except OSError:
        return


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
