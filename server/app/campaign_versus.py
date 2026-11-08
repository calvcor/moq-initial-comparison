"""Comparación en texto de dos campañas enteras (README 4.8, «Comparar dos campañas»).

Con las mismas reglas que el análisis de una campaña (analysis.py), pero emparejando condiciones de las dos. Una
condición de A se empareja con una de B si coinciden el perfil de red (no el nombre), la latencia objetivo del protocolo
en ms y la emisión: si cada campaña tiene una sola, se emparejan aunque difieran (la diferencia se declara arriba); si
tienen varias, solo las idénticas. Lo que no tiene pareja se lista aparte.

- Qué cambia entre las dos campañas: emisión, ajustes, versiones, trabajadores, diseño y fechas.
- Por protocolo y métrica, en cuántas condiciones emparejadas B va por delante o por detrás de A más allá de la variación
  entre repeticiones (la mayor de las dos condiciones), y la media de conjunto.
- Las tendencias con la red y con el objetivo de las dos, una junto a otra.
- Las pruebas de control de las dos, frente a frente: si ya difieren sin restricción de red, el sistema cambió entre una
  campaña y otra además de lo que se quería comparar.
"""
import hashlib
import json
import os
from collections import Counter
from typing import Optional

from . import samples_index
from .analysis import (CODE, METRICS, TREND_METRICS, Data, compare_levels, describe, fmt, grouped, listing, median,
                       network_series, seq, series_values, trend_tolerance)
from .compare import INVALID_BEFORE, PLAYER_LABEL, SOURCE_LABEL, STALL_FIX, local_day, net_text, num

PLAYERS = ("dash", "moq", "rtc")
VERSUS_CODE = hashlib.sha1((CODE + open(__file__, "rb").read().decode()).encode()).hexdigest()


def net_signature(profile: dict) -> str:
    return json.dumps({d: {k: (None if v is None else round(float(v), 3)) for k, v in sorted(profile[d].items())} for d in ("down", "up")},
                      sort_keys=True)


def stream_map(A: Data, B: Data) -> dict[int, int]:
    sa, sb = A.plan["streams"], B.plan["streams"]
    if len(sa) == 1 and len(sb) == 1:
        return {0: 0}
    sig = lambda s: json.dumps(s, sort_keys=True)
    out: dict[int, int] = {}
    for i, s in enumerate(sa):
        j = next((j for j, t in enumerate(sb) if sig(t) == sig(s) and j not in out.values()), None)
        if j is not None:
            out[i] = j
    return out


def network_map(A: Data, B: Data) -> dict[int, int]:
    bsig = {}
    for j, n in enumerate(B.plan["networks"]):
        bsig.setdefault(net_signature(n["profile"]), j)
    return {i: bsig[net_signature(n["profile"])] for i, n in enumerate(A.plan["networks"]) if net_signature(n["profile"]) in bsig}


def target_index(plan: dict, player: str, ms) -> Optional[int]:
    return next((t for t, target in enumerate(plan["targets"]) if target.get(f"{player}_ms") == ms), None)


def matched(A: Data, B: Data, smap: dict, nmap: dict, player: str) -> list[tuple[tuple, tuple]]:
    """Pares (condición de A, condición de B) de un protocolo."""
    out = []
    for cell in A.cells:
        s, n, t = cell
        if player not in A.cells[cell] or s not in smap or n not in nmap:
            continue
        tb = target_index(B.plan, player, A.plan["targets"][t].get(f"{player}_ms"))
        other = (smap[s], nmap[n], tb)
        if tb is not None and player in B.cells.get(other, {}):
            out.append((cell, other))
    return out


# --- qué cambia ---

def most_common(values: list) -> Optional[str]:
    values = [v for v in values if v not in (None, "")]
    return Counter(values).most_common(1)[0][0] if values else None


def contexts(idx: dict, field: str) -> list:
    return [entry.get("context", {}).get(field) for run in idx["runs"].values() for entry in run.values()]


def versions(campaign: dict, idx: dict) -> dict:
    text = most_common(contexts(idx, "versions"))
    if isinstance(text, str) and "=" in text:
        return dict(part.split("=", 1) for part in text.split(";") if "=" in part)
    return dict(campaign.get("versions") or {})


def workers(data: Data) -> str:
    names = set()
    for run in data.valid:
        names.update((run.get("workers") or {}).values() or (run.get("worker_info") or {}).keys())
    return ", ".join(sorted(n for n in names if n)) or None


def chrome(data: Data) -> Optional[str]:
    agents = [info.get("user_agent") or "" for run in data.valid for info in (run.get("worker_info") or {}).values()]
    found = [part.split("/")[1] + (" headless" if part.startswith("Headless") else "") for agent in agents for part in agent.split()
             if part.startswith(("Chrome/", "HeadlessChrome/"))]
    return most_common(found)


def dates(data: Data) -> Optional[str]:
    days = sorted(d for d in (local_day(r.get("started_ms")) for r in data.valid) if d)
    if not days:
        return None
    return days[0] if days[0] == days[-1] else f"{days[0]} a {days[-1]}"


def conditions(A: Data, B: Data, ia: dict, ib: dict) -> list[dict]:
    out = []

    def add(key: str, label: str, a, b, always: bool = False):
        if a != b or always:
            out.append({"key": key, "label": label, "a": "--" if a is None else str(a), "b": "--" if b is None else str(b)})

    pa, pb = A.plan, B.plan
    add("dates", "Fechas", dates(A), dates(B), always=True)
    add("players", "Protocolos", " + ".join(PLAYER_LABEL[p] for p in A.players), " + ".join(PLAYER_LABEL[p] for p in B.players))
    if len(pa["streams"]) == 1 and len(pb["streams"]) == 1:
        sa, sb = pa["streams"][0], pb["streams"][0]
        frag = lambda s: "1 frame" if s.get("frag_duration") == 0 else f"{num(s.get('frag_duration'), 1)} s"
        ladder = lambda s: ", ".join(f"{r['height']}p {r['bitrate_kbps']}" for r in s["renditions"]) + " kbit/s"
        add("source", "Contenido", SOURCE_LABEL.get(sa.get("source", "file")), SOURCE_LABEL.get(sb.get("source", "file")))
        add("fps", "Cadencia", f"{sa.get('fps', 60)} fps", f"{sb.get('fps', 60)} fps")
        add("ladder", "Escalera", ladder(sa), ladder(sb))
        add("gop", "GOP", sa.get("gop_size"), sb.get("gop_size"))
        add("segment", "Segmento de LL-DASH", f"{num(sa.get('seg_duration'), 1)} s", f"{num(sb.get('seg_duration'), 1)} s")
        add("fragment", "Fragmento CMAF", frag(sa), frag(sb))
        add("rtc_audio", "Audio de WebRTC", "sí" if sa.get("rtc_audio") else "no", "sí" if sb.get("rtc_audio") else "no")
        add("rtc_pacing", "Pacer de la ingesta de WebRTC", "sí" if sa.get("rtc_pacing") else "no", "sí" if sb.get("rtc_pacing") else "no")
    else:
        add("streams", "Emisiones", f"{len(pa['streams'])}", f"{len(pb['streams'])}", always=True)
    add("quality", "Calidad fija", pa.get("quality") and f"{pa['quality']}p", pb.get("quality") and f"{pb['quality']}p")
    oa, ob = pa.get("player_options") or {}, pb.get("player_options") or {}
    for k in sorted(set(oa) | set(ob)):
        add(f"option:{k}", k, oa.get(k), ob.get(k))
    add("rtc_server", "Servidor WebRTC", most_common(contexts(ia, "rtc_server")), most_common(contexts(ib, "rtc_server")))
    add("audio", "Reproductor con sonido", most_common(contexts(ia, "audio")) or "ninguno", most_common(contexts(ib, "audio")) or "ninguno")
    va, vb = versions(A.campaign, ia), versions(B.campaign, ib)
    for k in sorted(set(va) | set(vb)):
        add(f"version:{k}", k, va.get(k), vb.get(k))
    add("workers", "Trabajadores", workers(A), workers(B))
    add("chrome", "Chrome", chrome(A), chrome(B))
    add("parallel", "Pruebas en paralelo", "sí" if pa.get("parallel") else "no", "sí" if pb.get("parallel") else "no")
    add("player_mode", "Reproductores", "a la vez" if pa.get("player_mode", "together") == "together" else "de uno en uno",
        "a la vez" if pb.get("player_mode", "together") == "together" else "de uno en uno")
    add("content", "Contenido entre pruebas", pa.get("content", "continuous"), pb.get("content", "continuous"))
    add("repetitions", "Repeticiones", pa.get("repetitions"), pb.get("repetitions"))
    add("measure_s", "Medida", f"{num(pa['measure_s'])} s", f"{num(pb['measure_s'])} s")
    add("warmup_s", "Calentamiento", f"{num(pa['warmup_s'])} s", f"{num(pb['warmup_s'])} s")
    return out


# --- secciones ---

def keys_for(A: Data, B: Data) -> tuple:
    """Las métricas: con adaptación en alguna de las dos, también altura, tiempo en la más alta y cambios de calidad."""
    return tuple(k for k in METRICS if k in A.keys or k in B.keys)


def players_section(A: Data, B: Data, smap: dict, nmap: dict) -> list[dict]:
    blocks = []
    keys = keys_for(A, B)
    for p in (p for p in PLAYERS if p in A.players and p in B.players):
        pairs = matched(A, B, smap, nmap, p)
        if not pairs:
            continue
        sentences = [f"{len(pairs)} {'condición emparejada' if len(pairs) == 1 else 'condiciones emparejadas'}."]
        sentences += compare_levels(B, f"En B, {PLAYER_LABEL[p]}", "en A", [(cb, p, ca, p) for ca, cb in pairs], keys, other=A)
        blocks.append({"title": PLAYER_LABEL[p], "sentences": sentences})
    return blocks


def side_by_side(A: Data, B: Data, verb: str, labels: list[str], levels: dict[str, tuple[list, list]], which: str) -> list[str]:
    """Por métrica, la serie de cada protocolo en A y en B, con cómo cambia en cada una."""
    out, flat = [], []
    for key in (k for k in TREND_METRICS if k in keys_for(A, B)):
        parts = []
        for p, (la, lb) in levels.items():
            va, vb = series_values(A, p, key, la, which), series_values(B, p, key, lb, which)
            if all(v is None for v in va) or all(v is None for v in vb):
                continue
            ha = describe(va, labels, trend_tolerance(A, p, key, la, which, va))
            hb = describe(vb, labels, trend_tolerance(B, p, key, lb, which, vb))
            if ha is None and hb is None:
                ma, mb = median([v for v in va if v is not None]), median([v for v in vb if v is not None])
                flat.append(f"{METRICS[key]['label']} de {PLAYER_LABEL[p]} ({fmt(key, ma)} en A, {fmt(key, mb)} en B)")
                continue
            # Sin cambio, solo su valor; con la misma forma en las dos, se dice una vez
            show = lambda how, v: seq(key, v) if how else fmt(key, median([x for x in v if x is not None]))
            if ha == hb:
                parts.append(f"{PLAYER_LABEL[p]}, en las dos {ha} (A: {seq(key, va)}; B: {seq(key, vb)})")
            else:
                parts.append(f"{PLAYER_LABEL[p]}, en A {ha or 'no cambia'} ({show(ha, va)}) y en B {hb or 'no cambia'} ({show(hb, vb)})")
        if parts:
            label = METRICS[key]["label"]
            out.append(f"{label[0].upper()}{label[1:]} {verb}: " + "; ".join(parts) + ".")
    if flat:
        out.append(f"No cambian {verb} en ninguna de las dos: {'; '.join(flat)}.")
    return out


def trends_section(A: Data, B: Data, smap: dict, nmap: dict) -> list[dict]:
    blocks = []
    common = [p for p in PLAYERS if p in A.players and p in B.players]
    for verb, members in network_series(A.plan):
        both = [i for i in members if i in nmap]
        if len(both) < 2:
            continue
        labels = [A.plan["networks"][i]["label"] for i in both]
        levels = {p: (both, [nmap[i] for i in both]) for p in common}
        sentences = side_by_side(A, B, verb, labels, levels, "network")
        if sentences:
            blocks.append({"title": f"Red: {' → '.join(labels)}", "sentences": sentences})
    # Objetivos: los valores en ms de cada protocolo que tienen las dos
    for p in common:
        ms_a = {A.plan["targets"][t].get(f"{p}_ms") for t in range(len(A.plan["targets"]))} - {None}
        ms_b = {B.plan["targets"][t].get(f"{p}_ms") for t in range(len(B.plan["targets"]))} - {None}
        values = sorted(ms_a & ms_b)
        if len(values) < 2:
            continue
        levels = {p: ([target_index(A.plan, p, ms) for ms in values], [target_index(B.plan, p, ms) for ms in values])}
        sentences = side_by_side(A, B, "al subir la latencia objetivo", [f"{num(ms)} ms" for ms in values], levels, "target")
        if sentences:
            blocks.append({"title": f"Latencia objetivo de {PLAYER_LABEL[p]}: {' → '.join(f'{num(ms)} ms' for ms in values)}", "sentences": sentences})
    return blocks


def controls_section(A: Data, B: Data) -> list[dict]:
    sentences, differs = [], []
    for p in (p for p in PLAYERS if p in A.players and p in B.players):
        ca = [s for _, q, s in A.controls if q == p]
        cb = [s for _, q, s in B.controls if q == p]
        if len(ca) < 2 or len(cb) < 2:
            continue
        parts = []
        for key in ("g2g_p50_ms", "stall_ratio", "height_mean", "kbps_mean"):
            if key not in keys_for(A, B):
                continue
            xa, xb = [s[key] for s in ca if s.get(key) is not None], [s[key] for s in cb if s.get(key) is not None]
            if len(xa) < 2 or len(xb) < 2:
                continue
            ma, mb = median(xa), median(xb)
            # Es una comprobación de que el sistema no cambió: además de la variación entre las de control, 2 frames de
            # latencia, medio punto de tiempo parado o un 5 % de altura o bitrate
            noise = max(max(xa) - min(xa), max(xb) - min(xb))
            floor = {"g2g_p50_ms": 2 * 1000 / A.fps[0], "stall_ratio": 0.005}.get(key, 0.05 * abs(ma))
            beyond = abs(mb - ma) > max(noise, A.tolerance(key, 0, ma), floor)
            parts.append(f"{METRICS[key]['label']} {fmt(key, ma)} en A y {fmt(key, mb)} en B" + (" (más que la variación entre las de control)" if beyond else ""))
            if beyond:
                differs.append(f"{METRICS[key]['label']} de {PLAYER_LABEL[p]}")
        if parts:
            sentences.append(f"{PLAYER_LABEL[p]} ({len(ca)} y {len(cb)} pruebas): {'; '.join(parts)}.")
    if not sentences:
        return []
    ta = A.plan["targets"][0]["label"]
    tb = B.plan["targets"][0]["label"]
    head = "Pruebas de control (sin restricción de red), mediana de cada campaña" + (f"; objetivo {ta} en A y {tb} en B" if ta != tb else "") + "."
    if differs:
        tail = (f"Las de control ya difieren en {listing(differs)}: sin restricción de red, algo cambió entre las dos campañas (versiones, "
                "máquina, carga o lo que se quería comparar) y pesa sobre todas las condiciones.")
    else:
        tail = "Las de control son parecidas en las dos: sin restricción de red no hay señal de que el sistema cambiara entre campañas."
    return [{"title": "", "sentences": [head] + sentences + [tail]}]


def unmatched_section(A: Data, B: Data, smap: dict, nmap: dict) -> list[dict]:
    paired_a, paired_b = set(), set()
    for p in (p for p in PLAYERS if p in A.players and p in B.players):
        for ca, cb in matched(A, B, smap, nmap, p):
            paired_a.add(ca)
            paired_b.add(cb)
    only_a = [c for c in A.cells if c not in paired_a]
    only_b = [c for c in B.cells if c not in paired_b]
    sentences = []
    if only_a:
        sentences.append(f"Solo en A ({len(only_a)}): {grouped(A, only_a)}.")
    if only_b:
        sentences.append(f"Solo en B ({len(only_b)}): {grouped(B, only_b)}.")
    # Redes con el mismo nombre en las dos y distinto perfil: no se emparejan, y conviene saber por qué
    same_name = sorted({n["label"] for i, n in enumerate(A.plan["networks"]) if i not in nmap}
                       & {n["label"] for j, n in enumerate(B.plan["networks"]) if j not in nmap.values()})
    for label in same_name:
        na = next(n for n in A.plan["networks"] if n["label"] == label)
        nb = next(n for n in B.plan["networks"] if n["label"] == label)
        sentences.append(f"«{label}» está en las dos con distinto perfil, así que no se empareja (A: {net_text(na['profile'])}. B: {net_text(nb['profile'])}).")
    return [{"title": "", "sentences": sentences}] if sentences else []


def warnings(A: Data, B: Data, smap: dict) -> list[str]:
    out = []
    first = lambda d: min((local_day(r.get("started_ms")) for r in d.valid if r.get("started_ms")), default=None)
    fa, fb = first(A), first(B)
    if any(f and f < INVALID_BEFORE for f in (fa, fb)):
        out.append("Una de las dos tiene pruebas anteriores al 9-10-2026: el lector de timecode de entonces degradaba MoQ y esas medidas están invalidadas.")
    if fa and fb and (fa < STALL_FIX) != (fb < STALL_FIX):
        out.append("Una campaña es anterior al 28-10-2026 y la otra no: el tiempo parado se medía distinto (antes no contaba los tramos sin imagen) y no se compara.")
    elif fa and fb and fa < STALL_FIX:
        out.append("Las dos son anteriores al 28-10-2026: su tiempo parado no cuenta los tramos sin imagen (infravalora mucho a DASH con pérdidas).")
    if len(A.plan["streams"]) == 1 and len(B.plan["streams"]) == 1 and json.dumps(A.plan["streams"][0], sort_keys=True) != json.dumps(B.plan["streams"][0], sort_keys=True):
        out.append("Las emisiones son distintas: se emparejan igualmente, así que cada diferencia mezcla ese cambio con los demás de la tabla.")
    if not smap:
        out.append("No hay emisiones equivalentes en las dos campañas: no se ha emparejado ninguna condición.")
    reps = [len(v) for d in (A, B) for cell in d.cells.values() for v in cell.values()]
    if reps and min(reps) < 3:
        out.append("Hay condiciones con menos de tres repeticiones válidas: la variación entre repeticiones se queda corta y el recuento es orientativo.")
    for name, d in (("A", A), ("B", B)):
        lagged = {r["id"] for r in d.valid for s in r["summary"]["players"].values() if (s.get("source_lag_max_ms") or 0) > 100}
        if lagged:
            out.append(f"En {name}, la fuente fue más de 100 ms por detrás del tiempo real en {len(lagged)} de {len(d.valid)} pruebas.")
        if d.plan.get("parallel"):
            out.append(f"{name} se midió con pruebas en paralelo: las de una tanda compartían servidor.")
    o = lambda d: [f"{k}={v}" for k, v in (d.plan.get("player_options") or {}).items()
                   if (k == "moq_abr" and v != "watch") or (k == "moq_switching" and v != "seamless") or (k == "dash_abr" and v == "l2afix")]
    for name, d in (("A", A), ("B", B)):
        if o(d):
            out.append(f"{name} tiene experimentos declarados ({', '.join(o(d))}): no es el comportamiento de fábrica.")
    return out


def compute(ca: dict, ia: dict, cb: dict, ib: dict) -> dict:
    A, B = Data(ca, ia), Data(cb, ib)
    smap, nmap = stream_map(A, B), network_map(A, B)
    npairs = len({(c1, c2) for p in PLAYERS if p in A.players and p in B.players for c1, c2 in matched(A, B, smap, nmap, p)})
    overview = [f"A: «{ca['name']}» ({dates(A) or 'sin pruebas'}, {len(A.valid)} pruebas válidas). B: «{cb['name']}» ({dates(B) or 'sin pruebas'}, {len(B.valid)} pruebas válidas).",
                f"{npairs} {'condición emparejada' if npairs == 1 else 'condiciones emparejadas'} por perfil de red, latencia objetivo y emisión; "
                "cada frase dice cómo va B respecto a A."]
    sections = []
    for title, blocks in (("Por protocolo", players_section(A, B, smap, nmap)), ("Tendencias", trends_section(A, B, smap, nmap)),
                          ("Pruebas de control", controls_section(A, B)), ("Sin pareja", unmatched_section(A, B, smap, nmap))):
        blocks = [b for b in blocks if b["sentences"]]
        if blocks:
            sections.append({"title": title, "blocks": blocks})
    return {"a": {"id": ca["id"], "name": ca["name"]}, "b": {"id": cb["id"], "name": cb["name"]},
            "conditions": conditions(A, B, ia, ib), "overview": overview, "sections": sections, "warnings": warnings(A, B, smap)}


def versus(store, a: str, b: str) -> dict:
    if a == b:
        raise ValueError("Las dos campañas son la misma")
    with store.lock:
        copies = {}
        for cid in (a, b):
            if cid not in store.campaigns:
                raise KeyError(f"No existe la campaña {cid}")
            copies[cid] = json.loads(json.dumps(store.campaigns[cid]))
    ia, ib = samples_index.index(store, a), samples_index.index(store, b)
    # Guardada mientras no cambien el código, las filas, los planes ni el estado de las pruebas de las dos
    state = lambda c, i: [i["inode"], i["offset"], c["plan"], [(r["id"], r["state"], r.get("started_ms")) for r in c["runs"]]]
    key = hashlib.sha1(json.dumps([VERSUS_CODE, state(copies[a], ia), state(copies[b], ib)], sort_keys=True, default=str).encode()).hexdigest()
    folder = os.path.join(store.root, "comparisons")
    path = os.path.join(folder, f"{a}__{b}.json")
    try:
        with open(path) as f:
            saved = json.load(f)
        if saved.get("key") == key:
            return saved["result"]
    except (OSError, ValueError):
        pass
    result = compute(copies[a], ia, copies[b], ib)
    os.makedirs(folder, exist_ok=True)
    with open(path + ".part", "w") as f:
        json.dump({"key": key, "result": result}, f)
    os.replace(path + ".part", path)
    return result
