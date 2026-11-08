"""Análisis en texto de una campaña (README 4.8, «Análisis de la campaña»): diferencias entre protocolos y entre
emisiones, tendencias con la red y con la latencia objetivo, deriva en las pruebas de control y casos a mirar.

Como la comparación de dos pruebas (compare.py), con reglas fijas a partir de los resúmenes de las pruebas válidas y de
sus filas: las mismas medidas dan el mismo texto, y lo que no se midió no se rellena. La unidad es la condición
(emisión × red × objetivo): de cada una, la mediana de sus repeticiones válidas, y su recorrido como medida de la
variación entre repeticiones.

- Entre dos protocolos (o dos emisiones), se emparejan las condiciones que tienen los dos y se cuenta en cuántas va uno
  por delante con una diferencia mayor que la variación entre repeticiones de esa condición (la mayor de los dos), en
  cuántas al revés y en cuántas no se puede decir. La cifra de conjunto es la media de las medianas de las condiciones
  emparejadas.
- Las tendencias con la red se buscan en las series de redes que solo cambian en un parámetro (la pérdida, el límite de
  caudal, el retardo, el jitter o la cola), ordenadas de menos a más restrictiva; y con el objetivo, ordenándolos de menor
  a mayor. Cada valor de la serie es la mediana, entre las demás condiciones, de las medianas de cada condición.
- Es una lectura descriptiva, no un contraste estadístico: con dos o tres repeticiones el recorrido se queda corto.
"""
import json
import os
import re
import statistics
from typing import Optional

from .compare import INVALID_BEFORE, PLAYER_LABEL, SOURCE_LABEL, STALL_FIX, hp, local_day, num, relative

PLAYERS = ("dash", "moq", "rtc")
RUN_ID = re.compile(r'"run_id": "([^"]+)"')

# Métricas del análisis: etiqueta, unidad, escala de presentación, decimales, diferencia por debajo de la cual se
# consideran iguales (en unidades del resumen; "frame": un frame de la emisión; "1%": el 1 % del valor), por debajo de
# qué media no se da porcentaje relativo (sobre valores tan pequeños exagera) y cómo se dice que uno va por debajo o por
# encima del otro
METRICS = {
    "g2g_p50_ms": dict(label="latencia mediana", unit="ms", scale=1, digits=0, same="frame", small=None,
                       lower="tiene menos latencia", higher="tiene más latencia"),
    "g2g_p95_ms": dict(label="latencia p95", unit="ms", scale=1, digits=0, same="frame", small=None,
                       lower="tiene menos latencia en el p95", higher="tiene más latencia en el p95"),
    "stall_ratio": dict(label="tiempo parado", unit="%", scale=100, digits=1, same=0.0005, small=0.005,
                        lower="se ha parado menos", higher="se ha parado más"),
    "height_mean": dict(label="altura media reproducida", unit="p", scale=1, digits=0, same=1, small=None,
                        lower="ha reproducido a menos altura", higher="ha reproducido a más altura"),
    "ladder_top_share": dict(label="tiempo en la calidad más alta de la emisión", unit="%", scale=100, digits=0, same=0.01, small=0.05,
                             lower="ha pasado menos tiempo en la calidad más alta", higher="ha pasado más tiempo en la calidad más alta"),
    "kbps_mean": dict(label="bitrate de vídeo recibido", unit="kbit/s", scale=1, digits=0, same="1%", small=None,
                      lower="ha recibido menos bitrate", higher="ha recibido más bitrate"),
    "quality_switches": dict(label="cambios de calidad", unit="", scale=1, digits=1, same=1, small=1,
                             lower="ha cambiado menos de calidad", higher="ha cambiado más de calidad"),
    "content_skipped_share": dict(label="contenido no reproducido", unit="%", scale=100, digits=1, same=0.0005, small=0.005,
                                  lower="ha dejado sin reproducir menos contenido", higher="ha dejado sin reproducir más contenido"),
}
# Las de las tendencias (la p95 y el tiempo en la más alta harían el texto el doble de largo sin decir mucho más)
TREND_METRICS = ("g2g_p50_ms", "stall_ratio", "height_mean", "kbps_mean", "quality_switches", "content_skipped_share")

# Familias de parámetros de red: los que cambian juntos en una serie, cómo se ordena de menos a más restrictiva y cómo
# se dice al recorrerla
FAMILIES = {
    "loss": (("loss_pct",), lambda v: max(x or 0 for x in v), "al subir la pérdida"),
    "rate": (("rate_kbit",), lambda v: -min((x if x else float("inf")) for x in v), "al bajar el límite de caudal"),
    "delay": (("delay_ms",), lambda v: sum(x or 0 for x in v), "al subir el retardo"),
    "jitter": (("jitter_ms",), lambda v: sum(x or 0 for x in v), "al subir el jitter"),
    "queue": (("queue_ms",), lambda v: -sum(x or 0 for x in v), "al acortar la cola del router"),
}

# Alturas por prueba y reproductor, de las filas: (campaña, tamaño y fecha de samples.jsonl) -> {(prueba, inicio): ...}
_heights_cache: dict = {}


def scan_heights(path: str, wanted: dict[str, int]) -> dict[tuple[str, str], list[float]]:
    """Alturas reproducidas en la medida de cada prueba pedida (id -> started_ms de su último intento) y reproductor,
    en una sola pasada por samples.jsonl."""
    try:
        st = os.stat(path)
    except OSError:
        return {}
    key = (path, st.st_size, st.st_mtime)
    cached = _heights_cache.get(key)
    if cached is not None and all(rid in cached["runs"] for rid in wanted):
        return cached["heights"]
    out: dict[tuple[str, str], list[float]] = {}
    with open(path) as f:
        for line in f:
            m = RUN_ID.search(line)
            if not m or m.group(1) not in wanted or '"measuring"' not in line:
                continue
            row = json.loads(line)
            if row.get("run_started_ms") != wanted[m.group(1)] or row.get("phase") != "measuring":
                continue
            for p in (row.get("players") or "").split("|"):
                h = row.get(f"{p}_height")
                if p in PLAYERS and isinstance(h, (int, float)) and not isinstance(h, bool):
                    out.setdefault((m.group(1), p), []).append(h)
    _heights_cache.clear()
    _heights_cache[key] = {"runs": set(wanted), "heights": out}
    return out


def median(values: list[float]) -> Optional[float]:
    return statistics.median(values) if values else None


def mean(values: list[float]) -> Optional[float]:
    return statistics.fmean(values) if values else None


class Data:
    """Las pruebas válidas de la campaña agrupadas por condición y reproductor, con la mediana y el recorrido de cada
    métrica."""

    def __init__(self, store, campaign: dict):
        self.campaign = campaign
        self.plan = plan = campaign["plan"]
        self.valid = [r for r in campaign["runs"] if r["state"] == "done" and (r.get("summary") or {}).get("players")]
        heights = scan_heights(store.path(campaign["id"], "samples.jsonl"), {r["id"]: r["started_ms"] for r in self.valid})
        self.tops = [plan.get("quality") or max(x["height"] for x in s["renditions"]) for s in plan["streams"]]
        self.fps = [s.get("fps") or 60 for s in plan["streams"]]
        # (emisión, red, objetivo) -> reproductor -> lista de resúmenes (uno por repetición), con las métricas de las filas
        self.cells: dict[tuple, dict[str, list[dict]]] = {}
        self.controls: list[tuple[dict, str, dict]] = []
        for run in self.valid:
            for p, s in run["summary"]["players"].items():
                hs = heights.get((run["id"], p)) or []
                top = self.tops[run["stream"]]
                full = {**s, "height_max": s.get("height_max") if s.get("height_max") is not None else (max(hs) if hs else None)}
                if full.get("ladder_top_share") is None and hs:
                    full["ladder_top_share"] = sum(1 for h in hs if h >= top) / len(hs)
                if run["kind"] == "control":
                    self.controls.append((run, p, full))
                else:
                    self.cells.setdefault((run["stream"], run["network"], run["target"]), {}).setdefault(p, []).append(full)
        self.players = [p for p in PLAYERS if p in plan["players"]]
        # Con una sola calidad en todas las emisiones (o la calidad fija) no hay adaptación: altura, tiempo en la más alta
        # y cambios de calidad no dicen nada y no se comentan
        adaptive = any(len(s["renditions"]) > 1 for s in plan["streams"]) and not plan.get("quality")
        self.keys = tuple(k for k in METRICS if adaptive or k not in ("height_mean", "ladder_top_share", "quality_switches"))

    def value(self, cell: tuple, player: str, key: str) -> Optional[float]:
        values = [s[key] for s in self.cells.get(cell, {}).get(player, []) if isinstance(s.get(key), (int, float))]
        return median(values)

    def spread(self, cell: tuple, player: str, key: str) -> Optional[float]:
        values = [s[key] for s in self.cells.get(cell, {}).get(player, []) if isinstance(s.get(key), (int, float))]
        return max(values) - min(values) if len(values) > 1 else None

    def tolerance(self, key: str, stream: int, reference: Optional[float]) -> float:
        same = METRICS[key]["same"]
        if same == "frame":
            return 1000 / self.fps[stream]
        if same == "1%":
            return abs(reference or 0) * 0.01
        return same

    def cell_label(self, cell: tuple) -> str:
        stream, network, target = cell
        parts = [f"emisión {stream + 1}"] if len(self.plan["streams"]) > 1 else []
        parts.append("control" if network is None else self.plan["networks"][network]["label"])
        parts.append(self.plan["targets"][target]["label"])
        return " · ".join(parts)


def fmt(key: str, value: Optional[float]) -> str:
    m = METRICS[key]
    if value is None:
        return "--"
    if key == "height_mean":
        return hp(value)
    return f"{num(value * m['scale'], m['digits'])}{(' ' + m['unit']) if m['unit'] else ''}"


def seq(key: str, values: list[Optional[float]]) -> str:
    """Una serie de valores: 0,2 → 0,4 → 31 %."""
    m = METRICS[key]
    if key == "height_mean":
        return " → ".join(hp(v) for v in values)
    return " → ".join("--" if v is None else num(v * m["scale"], m["digits"]) for v in values) + (f" {m['unit']}" if m["unit"] else "")


def listing(items: list[str], limit: int = 6) -> str:
    shown = items[:limit]
    text = ", ".join(shown[:-1]) + (f" y {shown[-1]}" if len(shown) > 1 else shown[0] if shown else "")
    return text + (f" (y {len(items) - limit} más)" if len(items) > limit else "")


# --- comparación emparejada (dos protocolos o dos emisiones) ---

def paired(data: Data, key: str, pairs: list[tuple[tuple, str, tuple, str]]) -> Optional[dict]:
    """pairs: (condición de X, protocolo de X, condición de Y, protocolo de Y). Cuenta en cuántas X va por debajo o por
    encima de Y más allá de la variación entre repeticiones."""
    lower = higher = unclear = norep = 0
    xs, ys = [], []
    for cx, px, cy, py in pairs:
        x, y = data.value(cx, px, key), data.value(cy, py, key)
        if x is None or y is None:
            continue
        xs.append(x)
        ys.append(y)
        noises = [n for n in (data.spread(cx, px, key), data.spread(cy, py, key)) if n is not None]
        threshold = max([data.tolerance(key, cx[0], y)] + noises)
        if abs(x - y) <= threshold:
            unclear += 1
            if not noises:
                norep += 1
        elif x < y:
            lower += 1
        else:
            higher += 1
    if not xs:
        return None
    return {"n": len(xs), "lower": lower, "higher": higher, "unclear": unclear, "norep": norep, "x": mean(xs), "y": mean(ys)}


def paired_sentence(key: str, X: str, Y: str, r: dict) -> Optional[str]:
    """None si no hay ninguna condición con una diferencia clara."""
    m = METRICS[key]
    if not r["lower"] and not r["higher"]:
        return None
    first, second = ("lower", "higher") if r["lower"] >= r["higher"] else ("higher", "lower")
    text = f"{X} {m[first]} que {Y} en {r[first]} de {r['n']} {'condición' if r['n'] == 1 else 'condiciones'}"
    if r[second]:
        text += f", y al revés en {r[second]}"
    if r["unclear"]:
        text += f"; en {r['unclear']} la diferencia no supera la variación entre repeticiones" if r["unclear"] > r["norep"] else f"; en {r['unclear']} no hay diferencia clara"
    # Si la media de conjunto va al revés que el recuento (unas pocas condiciones con diferencias grandes), se dice
    against = (r["x"] > r["y"]) if first == "lower" else (r["x"] < r["y"])
    text += f". En conjunto, {'en cambio, ' if against else ''}{fmt(key, r['x'])} frente a {fmt(key, r['y'])}"
    rel = relative(r["x"], r["y"])
    if rel is not None and (m["small"] is None or min(r["x"], r["y"]) >= m["small"]) and abs(rel) >= 0.01:
        text += f", {num(rel + 1, 1)} veces más" if rel >= 1 else f", un {num(abs(rel) * 100)} % {'menos' if rel < 0 else 'más'}"
    return text + "."


def compare_levels(data: Data, X: str, Y: str, pairs: list, keys: tuple) -> list[str]:
    out, quiet = [], []
    for key in keys:
        r = paired(data, key, pairs)
        if r is None:
            continue
        sentence = paired_sentence(key, X, Y, r)
        if sentence:
            out.append(sentence)
        else:
            quiet.append(METRICS[key]["label"])
    if quiet:
        out.append(f"Sin diferencias claras en {listing(quiet, 10)}.")
    return out


def protocols_section(data: Data) -> list[dict]:
    blocks = []
    keys = data.keys
    for i, px in enumerate(data.players):
        for py in data.players[i + 1:]:
            pairs = [(c, px, c, py) for c in data.cells if px in data.cells[c] and py in data.cells[c]]
            if not pairs:
                continue
            blocks.append({"title": f"{PLAYER_LABEL[px]} frente a {PLAYER_LABEL[py]}",
                           "sentences": compare_levels(data, PLAYER_LABEL[px], PLAYER_LABEL[py], pairs, keys)})
    return blocks


def stream_differences(plan: dict) -> list[str]:
    """Lo que distingue a cada emisión, como en la página (lib/campaignStreams.ts)."""
    def parts(s: dict) -> list[str]:
        frag = "1 frame" if s.get("frag_duration") == 0 else f"{num(s.get('frag_duration'), 1)} s"
        return [SOURCE_LABEL.get(s.get("source", "file"), s.get("source")), f"GOP {s.get('gop_size')}", f"seg {num(s.get('seg_duration'), 1)} s",
                f"frag {frag}", ", ".join(f"{r['height']}p {r['bitrate_kbps']}" for r in s["renditions"]),
                "audio WebRTC" if s.get("rtc_audio") else "sin audio", "pacer WebRTC" if s.get("rtc_pacing") else "sin pacer"]
    all_parts = [parts(s) for s in plan["streams"]]
    differs = [k for k in range(len(all_parts[0])) if len({p[k] for p in all_parts}) > 1]
    return [" · ".join(p[k] for k in differs) for p in all_parts]


def streams_section(data: Data) -> list[dict]:
    streams = data.plan["streams"]
    if len(streams) < 2:
        return []
    names = stream_differences(data.plan)
    label = lambda s: f"Emisión {s + 1}" + (f" ({names[s]})" if names[s] else "")
    blocks = []
    for sx in range(len(streams)):
        for sy in range(sx + 1, len(streams)):
            sentences = []
            for p in data.players:
                pairs = [((sx, n, t), p, (sy, n, t), p) for (s, n, t) in data.cells if s == sx and (sy, n, t) in data.cells
                         and p in data.cells[(s, n, t)] and p in data.cells[(sy, n, t)]]
                if not pairs:
                    continue
                X, Y = f"Con la emisión {sx + 1}, {PLAYER_LABEL[p]}", f"con la {sy + 1}"
                for sentence in compare_levels(data, X, Y, pairs, data.keys):
                    sentences.append(sentence if not sentence.startswith("Sin diferencias") else f"{PLAYER_LABEL[p]}: {sentence[0].lower()}{sentence[1:]}")
            blocks.append({"title": f"{label(sx)} frente a {label(sy)[0].lower()}{label(sy)[1:]}", "sentences": sentences})
    return blocks


# --- tendencias ---

def describe(values: list[Optional[float]], labels: list[str], tol: float) -> Optional[str]:
    """Cómo cambia una serie: None si no cambia (todo dentro de 2 × tol). Un paso cuenta si pasa de tol y del 10 % del
    recorrido; un tramo inicial (o final) que apenas cambia frente al resto se dice como tal."""
    points = [(labels[i], x) for i, x in enumerate(values) if x is not None]
    if len(points) < 2:
        return None
    v = [x for _, x in points]
    lab = [l for l, _ in points]
    span = max(v) - min(v)
    if span <= 2 * tol:
        return None
    step_tol = max(tol, 0.1 * span)
    steps = [b - a for a, b in zip(v, v[1:])]
    ups, downs = sum(x > step_tol for x in steps), sum(x < -step_tol for x in steps)
    big = lambda part: statistics.fmean(abs(x) for x in part) if part else 0
    # Meseta al principio: al menos tres puntos casi iguales y después un cambio en un solo sentido, mucho mayor
    for k in range(len(v) - 1, 2, -1):
        head, tail = steps[:k - 1], steps[k - 1:]
        if max(v[:k]) - min(v[:k]) <= max(tol, 0.1 * span) and tail and big(head) <= 0.25 * big(tail):
            if all(x >= -step_tol for x in tail) or all(x <= step_tol for x in tail):
                return f"apenas cambia hasta {lab[k - 1]} y {'sube' if v[-1] > v[k - 1] else 'baja'} a partir de {lab[k]}"
    # Meseta al final
    for k in range(len(v) - 1, 2, -1):
        head, tail = steps[:len(v) - k], steps[len(v) - k:]
        if max(v[-k:]) - min(v[-k:]) <= max(tol, 0.1 * span) and head and big(tail) <= 0.25 * big(head):
            if all(x >= -step_tol for x in head) or all(x <= step_tol for x in head):
                return f"{'sube' if v[-k] > v[0] else 'baja'} hasta {lab[-k]} y luego apenas cambia"
    # Un valle o un pico interior claro (más que el umbral de paso a los dos lados), con tramos sin retrocesos grandes
    peak, low = v.index(max(v)), v.index(min(v))
    if 0 < low < len(v) - 1 and min(v[0], v[-1]) - v[low] > max(2 * tol, step_tol) \
            and all(x <= step_tol for x in steps[:low]) and all(x >= -step_tol for x in steps[low:]):
        return f"baja hasta {lab[low]} y luego sube"
    if 0 < peak < len(v) - 1 and v[peak] - max(v[0], v[-1]) > max(2 * tol, step_tol) \
            and all(x >= -step_tol for x in steps[:peak]) and all(x <= step_tol for x in steps[peak:]):
        return f"sube hasta {lab[peak]} y luego baja"
    if ups and not downs:
        return "sube en cada paso" if ups == len(steps) > 1 else "sube"
    if downs and not ups:
        return "baja en cada paso" if downs == len(steps) > 1 else "baja"
    if not ups and not downs:
        return "tiende a subir" if v[-1] - v[0] > 2 * tol else "tiende a bajar" if v[0] - v[-1] > 2 * tol else "varía sin tendencia clara"
    net = v[-1] - v[0]
    if abs(net) > span / 2:
        return "tiende a subir" if net > 0 else "tiende a bajar"
    return "varía sin tendencia clara"


def series_values(data: Data, player: str, key: str, levels: list, which: str) -> list[Optional[float]]:
    """Por nivel de la serie (redes u objetivos), la mediana de las medianas de sus condiciones. Solo entran las
    combinaciones de los demás factores medidas en todos los niveles que tienen datos: si no, cada nivel saldría de
    condiciones distintas (en una campaña a medias, p. ej., de otros objetivos) y la serie mezclaría los dos efectos."""
    level_of = (lambda c: c[1]) if which == "network" else (lambda c: c[2])
    rest_of = (lambda c: (c[0], c[2])) if which == "network" else (lambda c: (c[0], c[1]))
    by_level = {level: {rest_of(c): c for c in data.cells if level_of(c) == level and data.value(c, player, key) is not None}
                for level in levels}
    present = [level for level in levels if by_level[level]]
    common = set.intersection(*(set(by_level[level]) for level in present)) if len(present) >= 2 else set()
    if not common:
        return [None] * len(levels)
    return [median([data.value(by_level[level][r], player, key) for r in common]) if level in present else None for level in levels]


def trend_block(data: Data, title: str, verb: str, labels: list[str], levels_of: dict[str, list], which: str) -> dict:
    """labels: los nombres de los niveles en el orden de la serie (los mismos para todos los reproductores)."""
    sentences, flat = [], []
    short = labels
    for key in (k for k in TREND_METRICS if k in data.keys):
        parts = []
        unchanged = []
        for p in data.players:
            levels = levels_of.get(p)
            if not levels:
                continue
            values = series_values(data, p, key, levels, which)
            if all(v is None for v in values):
                continue
            ref = median([v for v in values if v is not None])
            names = [short[i] for i in range(len(levels))]
            # El umbral, además del de la métrica, la variación típica entre repeticiones de las condiciones de la serie:
            # un cambio menor que ella no es una tendencia
            level_of = (lambda c: c[1]) if which == "network" else (lambda c: c[2])
            spreads = [x for x in (data.spread(c, p, key) for c in data.cells if level_of(c) in levels and p in data.cells[c]) if x is not None]
            # Cada punto es la mediana de varias condiciones: su variación es menor que la de una sola (≈ 1/√n)
            per_level = max(1, len(spreads) / max(1, sum(v is not None for v in values)))
            how = describe(values, names, max(data.tolerance(key, 0, ref), (median(spreads) or 0) / per_level ** 0.5))
            if how is None:
                unchanged.append(f"{PLAYER_LABEL[p]} ({fmt(key, ref)})")
            else:
                parts.append(f"{PLAYER_LABEL[p]} {how}: {seq(key, values)}")
        label = METRICS[key]["label"]
        if parts:
            text = f"{label[0].upper()}{label[1:]} {verb}: " + "; ".join(parts)
            if unchanged:
                text += f"; no cambia en {listing(unchanged)}"
            sentences.append(text + ".")
        elif unchanged:
            flat.append(f"{label} de {listing(unchanged)}")
    if flat:
        sentences.append(f"No cambian {verb}: {'; '.join(flat)}.")
    return {"title": title, "levels": labels, "sentences": sentences}


def network_series(plan: dict) -> list[tuple[str, list[int]]]:
    """Series de redes que solo cambian en una familia de parámetros, de menos a más restrictiva (al menos dos)."""
    def flat(profile: dict) -> dict:
        return {(d, k): profile[d].get(k) for d in ("down", "up") for k in ("rate_kbit", "delay_ms", "jitter_ms", "loss_pct", "queue_ms")}
    nets = [flat(n["profile"]) for n in plan["networks"]]
    out = []
    for family, (keys, order, verb) in FAMILIES.items():
        groups: dict[str, list[int]] = {}
        for i, f in enumerate(nets):
            rest = json.dumps(sorted((str(k), v) for k, v in f.items() if k[1] not in keys))
            groups.setdefault(rest, []).append(i)
        for members in groups.values():
            values = {i: tuple(nets[i][(d, k)] for d in ("down", "up") for k in keys) for i in members}
            distinct = {}
            for i in members:
                distinct.setdefault(values[i], i)
            if len(distinct) >= 2:
                ordered = sorted(distinct.values(), key=lambda i: order(values[i]))
                out.append((verb, ordered))
    return out


def network_section(data: Data) -> list[dict]:
    blocks = []
    for verb, members in network_series(data.plan):
        labels = [data.plan["networks"][i]["label"] for i in members]
        title = f"Red: {' → '.join(labels)}"
        blocks.append(trend_block(data, title, verb, labels, {p: members for p in data.players}, "network"))
    return blocks


def target_section(data: Data) -> list[dict]:
    targets = data.plan["targets"]
    if len(targets) < 2:
        return []
    levels = {}
    for p in data.players:
        known = [i for i, t in enumerate(targets) if t.get(f"{p}_ms") is not None]
        levels[p] = sorted(known, key=lambda i: targets[i][f"{p}_ms"])
    order = levels[data.players[0]] if data.players else []
    labels = [targets[i]["label"] for i in order]
    block = trend_block(data, f"Latencia objetivo: {' → '.join(labels)}", "al subir la latencia objetivo", labels, levels, "target")
    # Si la latencia sigue al objetivo o se queda por encima de los más bajos
    for p in data.players:
        values = series_values(data, p, "g2g_p50_ms", levels[p], "target")
        pairs = [(targets[i][f"{p}_ms"], v) for i, v in zip(levels[p], values) if v is not None]
        if len(pairs) < 2:
            continue
        frame = 1000 / data.fps[0]
        above = [t for t, v in pairs if v > t + 2 * frame]
        floor = min(v for _, v in pairs)
        if not above:
            (t0, v0), (t1, v1) = pairs[0], pairs[-1]
            block["sentences"].append(f"{PLAYER_LABEL[p]} sigue al objetivo: su latencia mediana no lo pasa en más de 2 frames en ninguno (de {num(v0)} ms con {num(t0)} ms a {num(v1)} ms con {num(t1)} ms).")
        elif above == [t for t, _ in pairs][:len(above)]:
            if len(above) == len(pairs):
                block["sentences"].append(f"{PLAYER_LABEL[p]} queda por encima del objetivo en todos (no baja de {num(floor)} ms de mediana).")
            else:
                block["sentences"].append(f"{PLAYER_LABEL[p]} queda por encima del objetivo con los de hasta {num(above[-1])} ms (no baja de {num(floor)} ms de mediana); a partir de ahí, en el objetivo o por debajo.")
        else:
            block["sentences"].append(f"{PLAYER_LABEL[p]} queda por encima del objetivo en {len(above)} de {len(pairs)} objetivos ({', '.join(f'{num(t)} ms' for t in above)}).")
    if block["sentences"] and len(data.players) > 1:
        block["sentences"].append("La latencia objetivo es el mando de cada reproductor tal como lo entiende su implementación: no significa lo mismo en los tres.")
    return [block]


# --- control, casos a mirar y avisos ---

def controls_section(data: Data) -> list[dict]:
    if len({r["id"] for r, _, _ in data.controls}) < 4:
        return []
    sentences, stable = [], []
    for p in data.players:
        rows = sorted(((r["started_ms"] or 0, s) for r, q, s in data.controls if q == p), key=lambda x: x[0])
        if len(rows) < 4:
            continue
        half = len(rows) // 2
        changes = []
        for key, rel_tol, abs_tol in (("g2g_p50_ms", 0.1, 2 * 1000 / data.fps[0]), ("stall_ratio", 0.25, 0.005), ("height_mean", 0.05, 1)):
            all_values = [s[key] for _, s in rows if s.get(key) is not None]
            a = median([s[key] for _, s in rows[:half] if s.get(key) is not None])
            b = median([s[key] for _, s in rows[half:] if s.get(key) is not None])
            if a is None or b is None:
                continue
            # Además del umbral, un cuarto del recorrido de todas las de control: con mucha dispersión, una diferencia
            # de medianas pequeña es ruido
            if abs(b - a) > max(abs_tol, rel_tol * abs(a), (max(all_values) - min(all_values)) / 4):
                changes.append(f"{METRICS[key]['label']} de {fmt(key, a)} a {fmt(key, b)}")
        if changes:
            sentences.append(f"{PLAYER_LABEL[p]}, de la primera a la segunda mitad de la campaña: {'; '.join(changes)}.")
        else:
            stable.append(PLAYER_LABEL[p])
    n = len({r["id"] for r, _, _ in data.controls})
    head = f"{n} pruebas de control (sin restricción de red), en el orden en que se midieron."
    if stable:
        sentences.append(f"Sin deriva apreciable en {listing(stable)}: latencia, tiempo parado y altura parecidos en las dos mitades.")
    return [{"title": "", "sentences": [head] + sentences}]


def grouped(data: Data, cells: list[tuple]) -> str:
    """Condiciones agrupadas por emisión y red, en el orden del plan: «pérdida 10 % (50, 100 y 150 ms); ...»."""
    groups: dict[tuple, list[str]] = {}
    for c in sorted(cells, key=lambda c: (c[0], -1 if c[1] is None else c[1], c[2])):
        groups.setdefault(c[:2], []).append(data.plan["targets"][c[2]]["label"])
    parts = []
    for (stream, network), targets in groups.items():
        name = ("control" if network is None else data.plan["networks"][network]["label"])
        if len(data.plan["streams"]) > 1:
            name = f"emisión {stream + 1} · {name}"
        everything = len(targets) == len(data.plan["targets"]) and len(targets) > 1
        parts.append(f"{name} ({'todos los objetivos' if everything else listing(targets, 20)})")
    return "; ".join(parts)


def cases_section(data: Data) -> list[dict]:
    sentences = []
    for p in data.players:
        cells = [c for c in data.cells if p in data.cells[c]]
        blind = [c for c in cells if (data.value(c, p, "coverage") or 0) < 0.5]
        if blind:
            sentences.append(f"{PLAYER_LABEL[p]} dio latencia medida en menos de la mitad de los segundos en {len(blind)} de {len(cells)} condiciones: {grouped(data, blind)}.")
        if len(data.plan["streams"][0]["renditions"]) > 1 and not data.plan.get("quality"):
            never = [c for c in cells if all(s.get("height_max") is not None and s["height_max"] < data.tops[c[0]] for s in data.cells[c][p])]
            if never and len(never) < len(cells):
                sentences.append(f"{PLAYER_LABEL[p]} no llegó a la calidad más alta en ninguna repetición de {len(never)} de {len(cells)} condiciones: {grouped(data, never)}.")
            elif never:
                sentences.append(f"{PLAYER_LABEL[p]} no llegó a la calidad más alta en ninguna prueba.")
        noisy = []
        for c in cells:
            mid, spread = data.value(c, p, "g2g_p50_ms"), data.spread(c, p, "g2g_p50_ms")
            if mid and spread is not None and spread > max(100, 0.5 * mid):
                values = [s["g2g_p50_ms"] for s in data.cells[c][p] if s.get("g2g_p50_ms") is not None]
                noisy.append((spread, f"{data.cell_label(c)} (de {num(min(values))} a {num(max(values))} ms)"))
        if noisy:
            noisy.sort(reverse=True)
            sentences.append(f"{PLAYER_LABEL[p]}, repeticiones con latencias medianas muy distintas: {listing([t for _, t in noisy], 4)}.")
    return [{"title": "", "sentences": sentences}] if sentences else []


def overview(data: Data) -> list[str]:
    c, plan = data.campaign, data.plan
    runs = c["runs"]
    count = lambda state: sum(1 for r in runs if r["state"] == state)
    tests = [r for r in data.valid if r["kind"] == "test"]
    reps = [len(v) for cell in data.cells.values() for v in cell.values()]
    many = lambda n, one, other: f"{n} {one if n == 1 else other}"
    out = [f"{many(len(tests), 'prueba válida', 'pruebas válidas')} en {many(len(data.cells), 'condición', 'condiciones')} ({many(len(plan['streams']), 'emisión', 'emisiones')} × "
           f"{many(len(plan['networks']), 'red', 'redes')} × {many(len(plan['targets']), 'objetivo', 'objetivos')}), con {listing([PLAYER_LABEL[p] for p in data.players])}"
           f"{' a la vez' if plan.get('player_mode', 'together') == 'together' and len(data.players) > 1 else ''}; "
           f"{(num(min(reps)) if min(reps) == max(reps) else f'de {num(min(reps))} a {num(max(reps))}') if reps else '--'} {'repetición válida' if reps and max(reps) == 1 else 'repeticiones válidas'} por condición."]
    invalid = [r for r in runs if r["state"] == "invalid"]
    if invalid:
        reasons: dict[str, int] = {}
        for r in invalid:
            for reason in r["invalid_reasons"] or ["sin motivo"]:
                reason = re.sub(r"\d+", "N", reason)
                reasons[reason] = reasons.get(reason, 0) + 1
        top = sorted(reasons.items(), key=lambda x: -x[1])[:3]
        out.append(f"{len(invalid)} intentos inválidos ({'; '.join(f'{n}: {t}' for t, n in top)}).")
    pending = sum(1 for r in runs if r["state"] in ("pending", "preparing", "mounting", "warmup", "measuring", "closing"))
    if pending:
        out.append(f"La campaña no ha terminado: quedan {pending} pruebas; las condiciones sin medir no entran.")
    if count("replaced"):
        n = count("replaced")
        out.append(f"{n} {'prueba válida sustituida' if n == 1 else 'pruebas válidas sustituidas'} por su repetición no {'cuenta' if n == 1 else 'cuentan'}.")
    return out


def warnings(data: Data) -> list[str]:
    out = []
    days = sorted(d for d in (local_day(r.get("started_ms")) for r in data.valid) if d)
    if days and days[0] < INVALID_BEFORE:
        out.append("Hay pruebas anteriores al 9-10-2026: el lector de timecode de entonces degradaba MoQ y esas medidas están invalidadas.")
    elif days and days[0] < STALL_FIX:
        out.append("Hay pruebas anteriores al 28-10-2026: su tiempo parado no cuenta los tramos sin imagen (infravalora mucho a DASH con pérdidas).")
    reps = [len(v) for cell in data.cells.values() for v in cell.values()]
    if reps and min(reps) < 3:
        out.append("Hay condiciones con menos de tres repeticiones válidas: la variación entre repeticiones se queda corta y el recuento de condiciones a favor de uno u otro es orientativo.")
    lagged = {r["id"] for r in data.valid for s in r["summary"]["players"].values() if (s.get("source_lag_max_ms") or 0) > 100}
    if lagged:
        out.append(f"En {len(lagged)} de {len(data.valid)} pruebas la fuente fue más de 100 ms por detrás del tiempo real: en ellas los reproductores ven menos latencia.")
    # Sin estar parado: un parón ya baja los fps
    slow = {r["id"] for r in data.valid for p, s in r["summary"]["players"].items()
            if s.get("fps_mean") is not None and s["fps_mean"] < 0.9 * data.fps[r["stream"]] and (s.get("stall_ratio") or 0) < 0.01}
    if slow:
        out.append(f"En {len(slow)} de {len(data.valid)} pruebas algún reproductor pintó menos del 90 % de los frames sin estar parado: puede ser el trabajador, que no daba abasto (revisa los frames largos del hilo principal), o el protocolo, que descartaba frames.")
    if data.plan.get("parallel"):
        out.append("Pruebas en paralelo: las de una tanda compartían servidor (relay, SFU, publicador y CPU).")
    if any(s.get("source") == "camera" for s in data.plan["streams"]):
        out.append("Con la cámara el contenido no se repite y la latencia no incluye el tramo cámara → servidor.")
    o = data.plan.get("player_options") or {}
    experiments = [f"{k}={v}" for k, v in o.items() if (k == "moq_abr" and v != "watch") or (k == "moq_switching" and v != "seamless") or (k == "dash_abr" and v == "l2afix")]
    if experiments:
        out.append(f"Campaña con experimentos declarados ({', '.join(experiments)}): no es el comportamiento de fábrica.")
    if len(data.players) > 1:
        out.append("Entre protocolos, el búfer, la estimación de ancho de banda y el objetivo no significan lo mismo; el sonido, solo si se puso.")
    return out


def analyze(store, cid: str) -> dict:
    # Copia con el cerrojo; las filas se leen sin él, para no frenar al planificador de una campaña en marcha
    with store.lock:
        campaign = store.campaigns.get(cid)
        if campaign is None:
            raise KeyError(f"No existe la campaña {cid}")
        campaign = json.loads(json.dumps(campaign))
    data = Data(store, campaign)
    if not data.valid:
        return {"overview": ["La campaña no tiene pruebas válidas todavía."], "sections": [], "warnings": []}
    sections = []
    for title, blocks in (("Entre protocolos", protocols_section(data)), ("Entre emisiones", streams_section(data)),
                          ("Con la red", network_section(data)), ("Con la latencia objetivo", target_section(data)),
                          ("Deriva", controls_section(data)), ("Casos a mirar", cases_section(data))):
        blocks = [b for b in blocks if b["sentences"]]
        if blocks:
            sections.append({"title": title, "blocks": blocks})
    return {"overview": overview(data), "sections": sections, "warnings": warnings(data)}
