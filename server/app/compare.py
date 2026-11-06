"""Comparación en texto de dos pruebas de campaña, de la misma o de campañas distintas (README 4.8, «Comparar dos pruebas»).

Cada lado es una prueba con uno de sus reproductores (campaña/prueba/protocolo). La comparación sale del resumen de
cada prueba (el de runs.csv) y de sus filas de cada segundo, con reglas fijas: las mismas cifras dan el mismo texto, y
lo que no se midió no se rellena. Tiene cuatro partes:

1. Lo que cambia entre las dos: emisión, red, objetivo, ajustes de los reproductores, versiones, trabajador... Entre
   campañas distintas casi siempre cambia algo más de lo que se quería comparar (variables de confusión).
2. Una frase por aspecto (latencia, paradas, calidad, bitrate...), con las dos cifras y la diferencia.
3. Cada diferencia frente a la variación entre las repeticiones válidas de la misma condición (emisión, red y
   objetivo) en la campaña de cada lado: si no la supera, se dice que no es concluyente. Es una regla práctica, no un
   contraste estadístico, y con pocas repeticiones el recorrido infravalora la variación.
4. Avisos de lo que no se debe mezclar (medidas de épocas distintas, contenidos con otra cadencia...).
"""
import json
import time
from typing import Optional

PLAYERS = ("dash", "moq", "rtc")
PLAYER_LABEL = {"dash": "LL-DASH", "moq": "MoQ", "rtc": "WebRTC"}
SOURCE_LABEL = {"file": "Big Buck Bunny", "tos": "Tears of Steel", "camera": "cámara"}

# Épocas de la medida (CLAUDE.md, principios de medida): antes, el lector de timecode degradaba MoQ (medidas
# invalidadas); el tiempo parado no contaba los tramos sin imagen; no había lecturas del router ni retraso de la fuente
INVALID_BEFORE = "2026-10-09"
STALL_FIX = "2026-10-28"
# Retraso máximo de la fuente en la medida a partir del cual se avisa: 6 frames a 60 fps. Por debajo, lo habitual (el
# umbral de source_late_share, 50 ms, salta con cualquier atasco suelto de FFmpeg)
SOURCE_LATE_MS = 100


def local_day(ms: Optional[int]) -> Optional[str]:
    return time.strftime("%Y-%m-%d", time.localtime(ms / 1000)) if ms else None


def num(value, digits: int = 0) -> str:
    """Número a la española: coma decimal y espacio de miles; -- sin dato."""
    if value is None:
        return "--"
    text = f"{value:,.{digits}f}".replace(",", " ").replace(".", ",")
    return "0" if text in ("-0", "-0,0", "-0,00") else text


def pct_text(fraction: Optional[float], digits: int = 1) -> str:
    return "--" if fraction is None else f"{num(fraction * 100, digits)} %"


def relative(a: Optional[float], b: Optional[float]) -> Optional[float]:
    """Cuánto más (positivo) o menos es a que b, en tanto por uno."""
    if a is None or b is None or b == 0:
        return None
    return (a - b) / b


def hp(height: Optional[float]) -> str:
    """Una altura: 1080p, sin separador de miles."""
    return "--" if height is None else f"{round(height)}p"


def plural(n: Optional[float], one: str, many: str) -> str:
    return f"{num(n)} {one if n == 1 else many}"


def ref_text(ref: tuple[str, str, str]) -> str:
    return "/".join(ref)


def parse_ref(text: str) -> tuple[str, str, str]:
    parts = text.strip().split("/")
    if len(parts) != 3 or parts[2] not in PLAYERS:
        raise ValueError(f"Referencia no válida: {text!r} (campaña/prueba/protocolo, p. ej. 20261029-105628/r0069/moq)")
    return parts[0], parts[1], parts[2]


# --- lo que se sabe de cada lado ---

def scan_samples(path: str, wanted: dict[str, int], player: str) -> dict[str, dict]:
    """Por prueba pedida (id -> started_ms de su último intento), las alturas de las filas de su medida que tienen ese
    reproductor y la primera de esas filas (versiones, servidor WebRTC, sonido...)."""
    out = {rid: {"heights": [], "first": None} for rid in wanted}
    keys = {rid: f'"run_id": "{rid}"' for rid in wanted}
    try:
        with open(path) as f:
            for line in f:
                hit = next((rid for rid, key in keys.items() if key in line), None)
                if hit is None:
                    continue
                row = json.loads(line)
                if row.get("run_id") != hit or row.get("run_started_ms") != wanted[hit] or row.get("phase") != "measuring":
                    continue
                if player not in (row.get("players") or "").split("|"):
                    continue
                entry = out[hit]
                if entry["first"] is None:
                    entry["first"] = row
                h = row.get(f"{player}_height")
                if isinstance(h, (int, float)) and not isinstance(h, bool):
                    entry["heights"].append(h)
    except OSError:
        pass
    return out


def height_stats(heights: list[float], ladder_top: int) -> dict:
    """La altura más alta y más baja reproducidas y la fracción del tiempo en la más alta de la escalera."""
    if not heights:
        return {"height_max": None, "height_min": None, "ladder_top_share": None}
    return {"height_max": max(heights), "height_min": min(heights),
            "ladder_top_share": round(sum(1 for h in heights if h >= ladder_top) / len(heights), 3)}


def load_side(store, ref: tuple[str, str, str], campaign: Optional[dict]) -> dict:
    """campaign: una copia de la campaña, tomada con el cerrojo (aquí se leen sus filas sin él)."""
    cid, rid, player = ref
    if campaign is None:
        raise KeyError(f"No existe la campaña {cid}")
    run = next((r for r in campaign["runs"] if r["id"] == rid), None)
    if run is None:
        raise KeyError(f"No existe la prueba {rid} en la campaña {cid}")
    if player not in run["players"]:
        raise ValueError(f"La prueba {rid} de {cid} no tiene {PLAYER_LABEL[player]}")
    summary = ((run.get("summary") or {}).get("players") or {}).get(player)
    if not summary:
        raise ValueError(f"La prueba {rid} de {cid} no tiene resumen: no ha terminado")
    plan = campaign["plan"]
    stream = plan["streams"][run["stream"]]
    ladder = sorted((r["height"] for r in stream["renditions"]), reverse=True)
    # Repeticiones válidas de la misma condición en su campaña, para la variación entre repeticiones
    reps = [r for r in campaign["runs"] if r["state"] == "done" and r["kind"] == run["kind"] and player in r["players"]
            and (r["stream"], r["network"], r["target"]) == (run["stream"], run["network"], run["target"])
            and ((r.get("summary") or {}).get("players") or {}).get(player)]
    if run not in reps:
        reps.append(run)
    scanned = scan_samples(store.path(cid, "samples.jsonl"), {r["id"]: r["started_ms"] for r in reps}, player)
    top = plan["quality"] if plan.get("quality") else ladder[0]

    def full(r: dict) -> dict:
        # El resumen y, de las filas, la altura máxima y el tiempo en la más alta (no están en los resúmenes antiguos)
        return {**r["summary"]["players"][player], **height_stats(scanned[r["id"]]["heights"], top)}

    return {"ref": ref, "campaign": campaign, "plan": plan, "run": run, "player": player, "stream": stream,
            "ladder": ladder, "top": top, "s": full(run), "reps": [full(r) for r in reps],
            "row": scanned[run["id"]]["first"] or {}}


# --- 1. lo que cambia ---

def net_text(profile: dict) -> str:
    def one(d: dict) -> str:
        parts = [f"{num(d['rate_kbit'])} kbit/s" if d.get("rate_kbit") else "sin límite"]
        if d.get("delay_ms"):
            parts.append(f"{num(d['delay_ms'])} ms" + (f" ± {num(d['jitter_ms'])}" if d.get("jitter_ms") else ""))
        if d.get("loss_pct"):
            parts.append(f"{num(d['loss_pct'], 2).rstrip('0').rstrip(',')} % de pérdida")
        if d.get("rate_kbit"):
            parts.append(f"cola {num(d.get('queue_ms'))} ms")
        return ", ".join(parts)
    down, up = one(profile["down"]), one(profile["up"])
    return down if up == "sin límite" else f"bajada {down}; subida {up}"


def network_of(x: dict) -> tuple[str, str]:
    if x["run"]["network"] is None:
        return "control (sin restricción)", "sin límite"
    net = x["plan"]["networks"][x["run"]["network"]]
    return net["label"], net_text(net["profile"])


def target_of(x: dict) -> str:
    target = x["plan"]["targets"][x["run"]["target"]]
    ms = target.get(f"{x['player']}_ms")
    return target["label"] if ms is None or target["label"] == f"{ms} ms" else f"{target['label']} ({ms} ms en {PLAYER_LABEL[x['player']]})"


def versions_of(x: dict) -> dict:
    """Las versiones de la fila (servidor y librerías del navegador) o, sin ella, las de la campaña."""
    text = x["row"].get("versions")
    if isinstance(text, str) and "=" in text:
        return dict(part.split("=", 1) for part in text.split(";") if "=" in part)
    return dict(x["campaign"].get("versions") or {})


def worker_of(x: dict) -> dict:
    run = x["run"]
    name = (run.get("workers") or {}).get(x["player"]) or next(iter(run.get("worker_info") or {}), None)
    info = (run.get("worker_info") or {}).get(name) or {}
    agent = info.get("user_agent") or ""
    chrome = next((part.split("/")[1] for part in agent.split() if part.startswith(("Chrome/", "HeadlessChrome/"))), None)
    return {"name": name, "build": info.get("build"), "chrome": chrome, "headless": "HeadlessChrome" in agent if agent else None,
            "decode": info.get("decode")}


def conditions(A: dict, B: dict) -> list[dict]:
    """Lo que cambia entre las dos pruebas, en el orden en que más pesa."""
    out = []

    def add(key: str, label: str, a, b):
        if a != b:
            out.append({"key": key, "label": label, "a": "--" if a is None else str(a), "b": "--" if b is None else str(b)})

    add("player", "Protocolo", PLAYER_LABEL[A["player"]], PLAYER_LABEL[B["player"]])
    sa, sb = A["stream"], B["stream"]
    add("source", "Contenido", SOURCE_LABEL.get(sa.get("source", "file")), SOURCE_LABEL.get(sb.get("source", "file")))
    add("fps", "Cadencia", f"{sa.get('fps', 60)} fps", f"{sb.get('fps', 60)} fps")
    ladder = lambda s: ", ".join(f"{r['height']}p {r['bitrate_kbps']}" for r in s["renditions"]) + " kbit/s"
    add("ladder", "Escalera", ladder(sa), ladder(sb))
    add("quality", "Calidad fija", A["plan"].get("quality") and f"{A['plan']['quality']}p", B["plan"].get("quality") and f"{B['plan']['quality']}p")
    add("gop", "GOP", sa.get("gop_size"), sb.get("gop_size"))
    if "dash" in (A["player"], B["player"]):
        frag = lambda s: "1 frame" if s.get("frag_duration") == 0 else f"{num(s.get('frag_duration'), 1)} s"
        add("segment", "Segmento de LL-DASH", f"{num(sa.get('seg_duration'), 1)} s", f"{num(sb.get('seg_duration'), 1)} s")
        add("fragment", "Fragmento CMAF", frag(sa), frag(sb))
    if "rtc" in (A["player"], B["player"]):
        add("rtc_audio", "Audio de WebRTC", "sí" if sa.get("rtc_audio") else "no", "sí" if sb.get("rtc_audio") else "no")
        add("rtc_pacing", "Pacer de la ingesta de WebRTC", "sí" if sa.get("rtc_pacing") else "no", "sí" if sb.get("rtc_pacing") else "no")
        add("rtc_server", "Servidor WebRTC", A["row"].get("rtc_server"), B["row"].get("rtc_server"))
    add("content", "Contenido entre pruebas", A["plan"].get("content", "continuous"), B["plan"].get("content", "continuous"))
    (la, pa), (lb, pb) = network_of(A), network_of(B)
    add("network", "Red", la, lb)
    if la == lb or pa != pb:
        add("network_profile", "Perfil de red", pa, pb)
    add("target", "Latencia objetivo", target_of(A), target_of(B))
    oa, ob = A["plan"].get("player_options") or {}, B["plan"].get("player_options") or {}
    mine = lambda k: not k.startswith(PLAYERS) or k.startswith((f"{A['player']}_", f"{B['player']}_"))
    for k in sorted(k for k in set(oa) | set(ob) if mine(k)):
        add(f"option:{k}", k, oa.get(k), ob.get(k))
    add("audio", "Reproductor con sonido", A["row"].get("audio") or "ninguno", B["row"].get("audio") or "ninguno")
    add("players_run", "Reproductores en la prueba", " + ".join(PLAYER_LABEL[p] for p in A["run"]["players"]),
        " + ".join(PLAYER_LABEL[p] for p in B["run"]["players"]))
    va, vb = versions_of(A), versions_of(B)
    for k in sorted(set(va) | set(vb)):
        add(f"version:{k}", k, va.get(k), vb.get(k))
    wa, wb = worker_of(A), worker_of(B)
    add("worker", "Trabajador", wa["name"], wb["name"])
    add("chrome", "Chrome", wa["chrome"] and f"{wa['chrome']}{' headless' if wa['headless'] else ''}",
        wb["chrome"] and f"{wb['chrome']}{' headless' if wb['headless'] else ''}")
    add("decode", "Decodificación", wa["decode"], wb["decode"])
    add("web_build", "Construcción de la web", wa["build"], wb["build"])
    concurrent = lambda x: " + ".join(x["run"].get("concurrent") or []) or "sola"
    add("parallel", "Medida a la vez que", concurrent(A), concurrent(B))
    add("measure_s", "Duración de la medida", f"{num(A['plan']['measure_s'])} s", f"{num(B['plan']['measure_s'])} s")
    add("warmup_s", "Calentamiento", f"{num(A['plan']['warmup_s'])} s", f"{num(B['plan']['warmup_s'])} s")
    return out


# --- 2 y 3. las métricas y su veredicto ---

# Métricas de la tabla: clave del resumen, etiqueta, unidad, escala de presentación, decimales y la diferencia por debajo
# de la cual se consideran iguales (en unidades del resumen; None: cualquiera cuenta). fps: un frame de la emisión
METRICS = [
    ("g2g_p50_ms", "Glass-to-glass p50", "ms", 1, 0, "frame"),
    ("g2g_p95_ms", "Glass-to-glass p95", "ms", 1, 0, "frame"),
    ("stall_ratio", "Tiempo parado", "%", 100, 2, 0.0005),
    ("stalls", "Paradas", "", 1, 0, None),
    ("height_mean", "Altura media reproducida", "p", 1, 0, 1),
    ("height_max", "Altura más alta reproducida", "p", 1, 0, None),
    ("ladder_top_share", "Tiempo en la calidad más alta de la emisión", "%", 100, 1, 0.01),
    ("quality_switches", "Cambios de calidad", "", 1, 0, None),
    ("kbps_mean", "Bitrate de vídeo recibido", "kbit/s", 1, 0, "1%"),
    ("coverage", "Segundos con latencia medida", "%", 100, 1, 0.01),
    ("content_skipped_share", "Contenido no reproducido", "%", 100, 2, 0.0005),
    ("fps_mean", "Frames por segundo", "fps", 1, 1, 1),
    ("first_g2g_s", "Arranque hasta la primera latencia", "s", 1, 0, 1),
    ("player_restarts", "Recreaciones del reproductor", "", 1, 0, None),
    ("ip_down_kbps", "Tráfico IP de bajada en el router", "kbit/s", 1, 0, "1%"),
    ("ip_down_drop_pct", "Descartes en la cola de bajada", "%", 1, 2, 0.01),
    ("source_lag_max_ms", "Retraso máximo de la fuente", "ms", 1, 0, None),
    ("main_long_frame_share", "Tiempo en frames largos del hilo principal", "%", 100, 1, 0.005),
]


def spread(x: dict, key: str) -> Optional[float]:
    values = [r.get(key) for r in x["reps"] if isinstance(r.get(key), (int, float))]
    return max(values) - min(values) if len(values) > 1 else None


def frame_ms(x: dict) -> float:
    return 1000 / (x["row"].get("fps") or x["stream"].get("fps") or 60)


def metric_rows(A: dict, B: dict) -> list[dict]:
    rows = []
    for key, label, unit, scale, digits, same in METRICS:
        a, b = A["s"].get(key), B["s"].get(key)
        if a is None and b is None:
            continue
        noises = [n for n in (spread(A, key), spread(B, key)) if n is not None]
        noise = max(noises) if noises else None
        threshold = max(frame_ms(A), frame_ms(B)) if same == "frame" else (abs(b) * 0.01 if b else 0) if same == "1%" else same or 0
        if a is None or b is None:
            verdict = "sin_dato"
        elif abs(a - b) <= threshold or a == b:
            verdict = "igual"
        elif noise is not None and abs(a - b) <= noise:
            verdict = "no_concluyente"
        elif noise is None:
            verdict = "sin_repeticiones"
        else:
            verdict = "a_mayor" if a > b else "b_mayor"
        rows.append({"key": key, "label": label, "unit": unit, "scale": scale, "digits": digits, "a": a, "b": b,
                     "diff": None if a is None or b is None else a - b, "relative": relative(a, b),
                     "noise": noise, "noise_reps": [len(A["reps"]), len(B["reps"])], "verdict": verdict})
    return rows


def caveat(row: dict) -> str:
    """Lo que se añade a la frase de una métrica según su veredicto."""
    if row["verdict"] == "no_concluyente":
        return (f" No es concluyente: las repeticiones de la misma condición difieren hasta "
                f"{num(row['noise'] * row['scale'], row['digits'])}{' ' + row['unit'] if row['unit'] else ''}.")
    return ""


def sentences(A: dict, B: dict, rows: dict[str, dict]) -> list[str]:
    a, b = A["s"], B["s"]
    out = []
    # Latencia
    p50 = rows.get("g2g_p50_ms")
    if p50 and p50["verdict"] == "sin_dato":
        who = "A" if a.get("g2g_p50_ms") is not None else "B"
        out.append(f"Latencia: solo hay medida de {who}.")
    elif p50:
        if p50["verdict"] == "igual":
            text = f"Latencia: prácticamente la misma ({num(a['g2g_p50_ms'])} ms de mediana en A y {num(b['g2g_p50_ms'])} en B, menos de un frame de diferencia)."
        else:
            d = p50["diff"]
            text = (f"Latencia: A tiene {num(abs(d))} ms {'más' if d > 0 else 'menos'} que B ({num(a['g2g_p50_ms'])} frente a "
                    f"{num(b['g2g_p50_ms'])} ms de mediana, un {num(abs(p50['relative']) * 100)} % {'más' if d > 0 else 'menos'}).")
        p95 = rows.get("g2g_p95_ms")
        if p95 and p95["verdict"] not in ("sin_dato",):
            rel = p95["relative"]
            tail = "" if p95["verdict"] == "igual" or rel is None else f", un {num(abs(rel) * 100)} % {'más' if rel > 0 else 'menos'}"
            text += f" En el p95, {num(a['g2g_p95_ms'])} frente a {num(b['g2g_p95_ms'])} ms{tail}."
        out.append(text + caveat(p50))
    # Paradas
    st = rows.get("stall_ratio")
    if st and st["verdict"] != "sin_dato":
        ra, rb = a["stall_ratio"], b["stall_ratio"]
        detail = lambda s: f"{plural(s.get('stalls'), 'parada', 'paradas')}, {num((s.get('stall_ms') or 0) / 1000, 1)} s"
        if ra == 0 and rb == 0:
            text = "Paradas: ninguno se ha parado."
        elif max(ra, rb) < 0.001:
            text = f"Paradas: ninguno ha estado parado ni un 0,1 % del tiempo ({pct_text(ra, 2)} en A y {pct_text(rb, 2)} en B)."
        elif min(ra, rb) == 0:
            who, x = ("A", a) if ra > 0 else ("B", b)
            text = f"Paradas: {'B' if who == 'A' else 'A'} no se ha parado; {who} estuvo parado el {pct_text(x['stall_ratio'], 2)} del tiempo ({detail(x)})."
        elif min(ra, rb) < 0.005:
            # Sobre valores tan pequeños, un porcentaje relativo exagera: solo las dos cifras
            text = f"Paradas: A estuvo parado el {pct_text(ra, 2)} del tiempo ({detail(a)}) y B el {pct_text(rb, 2)} ({detail(b)})."
        else:
            rel = st["relative"]
            text = (f"Paradas: A se ha parado un {num(abs(rel) * 100)} % {'más' if rel > 0 else 'menos'} que B "
                    f"({pct_text(ra, 1)} frente a {pct_text(rb, 1)} del tiempo; A {detail(a)}, B {detail(b)}).")
        out.append(text + caveat(st))
    # Calidad: frente a la más alta de la emisión de cada uno
    single = len(A["ladder"]) == 1 and len(B["ladder"]) == 1 or (A["plan"].get("quality") and B["plan"].get("quality"))
    hm = rows.get("height_mean")
    if hm and hm["verdict"] != "sin_dato":
        ha, hb = a["height_mean"], b["height_mean"]
        if hm["verdict"] == "igual":
            text = f"Calidad: la misma altura media ({hp(ha)})."
        else:
            rel = hm["relative"]
            text = f"Calidad: A ha reproducido de media {hp(ha)} y B {hp(hb)}, una altura un {num(abs(rel) * 100)} % {'mayor' if rel > 0 else 'menor'}."
        text += caveat(hm)
        if not single:
            ta, tb = A["top"], B["top"]
            top = f"{ta}p" if ta == tb else f"{ta}p en A, {tb}p en B"
            sa, sb = a.get("ladder_top_share"), b.get("ladder_top_share")
            ma, mb = a.get("height_max"), b.get("height_max")
            if ma is not None and mb is not None:
                if ma < ta and mb < tb:
                    text += f" Ninguno ha llegado a la calidad más alta ({top}): A no ha pasado de {hp(ma)} y B de {hp(mb)}."
                elif ma < ta or mb < tb:
                    miss, mx, other, share = ("A", ma, "B", sb) if ma < ta else ("B", mb, "A", sa)
                    text += f" {miss} no ha llegado a la calidad más alta ({top}; no ha pasado de {hp(mx)}); {other} ha estado en ella el {pct_text(share, 0)} del tiempo."
                elif sa == 1 and sb == 1:
                    text += f" Los dos han estado todo el tiempo en la calidad más alta ({top})."
                else:
                    text += f" En la calidad más alta ({top}), A ha estado el {pct_text(sa, 0)} del tiempo y B el {pct_text(sb, 0)}."
            qa, qb = a.get("quality_switches"), b.get("quality_switches")
            if qa is not None and qb is not None and (qa or qb):
                text += f" Cambios de calidad: {num(qa) if qa else 'ninguno'} en A y {num(qb) if qb else 'ninguno'} en B."
        out.append(text)
    # Bitrate
    kb = rows.get("kbps_mean")
    if kb and kb["verdict"] != "sin_dato":
        if kb["verdict"] == "igual":
            out.append(f"Bitrate de vídeo recibido: el mismo ({num(a['kbps_mean'])} kbit/s).")
        else:
            rel = kb["relative"]
            out.append(f"Bitrate de vídeo recibido: {num(a['kbps_mean'])} kbit/s en A y {num(b['kbps_mean'])} en B, un {num(abs(rel) * 100)} % {'más' if rel > 0 else 'menos'}."
                       + caveat(kb))
    # Lo demás, solo si hay algo que contar
    cov = rows.get("coverage")
    if cov and cov["verdict"] not in ("sin_dato", "igual") and min(a["coverage"], b["coverage"]) < 0.95:
        out.append(f"Latencia medida en el {pct_text(a['coverage'], 0)} de los segundos de A y en el {pct_text(b['coverage'], 0)} de B.")
    sk = rows.get("content_skipped_share")
    if sk and sk["verdict"] not in ("sin_dato", "igual") and max(a["content_skipped_share"], b["content_skipped_share"]) >= 0.005:
        out.append(f"Contenido no reproducido: el {pct_text(a['content_skipped_share'], 1)} en A y el {pct_text(b['content_skipped_share'], 1)} en B." + caveat(sk))
    fps = rows.get("fps_mean")
    if fps and fps["verdict"] not in ("sin_dato", "igual"):
        out.append(f"Frames por segundo: {num(a['fps_mean'], 1)} en A y {num(b['fps_mean'], 1)} en B." + caveat(fps))
    first = rows.get("first_g2g_s")
    if first and first["verdict"] not in ("sin_dato", "igual"):
        out.append(f"Arranque: A tardó {num(a['first_g2g_s'])} s en dar la primera latencia y B {num(b['first_g2g_s'])} s (con resolución de 1 s)." + caveat(first))
    rs = rows.get("player_restarts")
    if rs and rs["verdict"] != "sin_dato" and (a["player_restarts"] or b["player_restarts"]):
        out.append(f"Recreaciones del reproductor: {num(a['player_restarts']) if a['player_restarts'] else 'ninguna'} en A y {num(b['player_restarts']) if b['player_restarts'] else 'ninguna'} en B.")
    dr = rows.get("ip_down_drop_pct")
    if dr and dr["verdict"] != "sin_dato" and (a["ip_down_drop_pct"] or b["ip_down_drop_pct"]):
        out.append(f"La cola de bajada del router descartó el {num(a['ip_down_drop_pct'], 2)} % de los paquetes de A y el {num(b['ip_down_drop_pct'], 2)} % de los de B (pérdida del perfil y desbordamiento juntos).")
    return out


def overview(rows: list[dict]) -> Optional[str]:
    """Primera frase: qué diferencias superan la variación entre repeticiones y cuáles no."""
    shown = {"g2g_p50_ms", "g2g_p95_ms", "stall_ratio", "height_mean", "ladder_top_share", "quality_switches", "kbps_mean",
             "coverage", "content_skipped_share", "fps_mean"}
    clear = [r for r in rows if r["key"] in shown and r["verdict"] in ("a_mayor", "b_mayor")]
    unclear = [r for r in rows if r["key"] in shown and r["verdict"] == "no_concluyente"]
    if not clear and not unclear:
        return None
    def item(r: dict) -> str:
        rel = r["relative"]
        if rel is None:
            # Sobre cero no hay porcentaje: las dos cifras
            return f"{r['label'].lower()} ({num(r['a'] * r['scale'], r['digits'])} frente a {num(r['b'] * r['scale'], r['digits'])})"
        return f"{r['label'].lower()} (A {'+' if rel > 0 else '−'}{num(abs(rel) * 100)} %)"
    parts = []
    if clear:
        parts.append("superan la variación entre repeticiones: " + ", ".join(item(r) for r in clear))
    if unclear:
        parts.append("no concluyentes: " + ", ".join(r["label"].lower() for r in unclear))
    text = "; ".join(parts)
    return text[0].upper() + text[1:] + "."


# --- 4. avisos ---

def warnings(A: dict, B: dict, rows: list[dict]) -> list[str]:
    out = []
    for name, x in (("A", A), ("B", B)):
        day = local_day(x["run"].get("started_ms"))
        if x["run"]["state"] != "done":
            out.append(f"{name} no es una prueba válida vigente ({x['run']['state']}).")
        if day and day < INVALID_BEFORE:
            out.append(f"{name} es anterior al 9-10-2026: el lector de timecode de entonces degradaba MoQ y esas medidas están invalidadas.")
        elif day and day < STALL_FIX:
            out.append(f"{name} es anterior al 28-10-2026: su tiempo parado no cuenta los tramos sin imagen (infravalora mucho a DASH con pérdidas) y no se compara con el posterior.")
        if x["stream"].get("source") == "camera":
            out.append(f"{name} es con la cámara: el contenido no se repite y la latencia no incluye el tramo cámara → servidor.")
        lag = x["s"].get("source_lag_max_ms")
        if lag is not None and lag > SOURCE_LATE_MS:
            out.append(f"En {name} la fuente llegó a ir {num(lag)} ms por detrás del tiempo real: los reproductores lo ven como esa latencia de menos.")
        if x["run"].get("concurrent"):
            out.append(f"{name} se midió en paralelo con {', '.join(x['run']['concurrent'])}: compartían servidor (relay, SFU, publicador y CPU).")
    fa, fb = frame_ms(A), frame_ms(B)
    if abs(fa - fb) > 0.5:
        out.append(f"La cadencia es distinta (frames de {num(fa, 1)} y {num(fb, 1)} ms): cambian a la vez el contenido y la granularidad de la latencia.")
    if A["player"] != B["player"]:
        out.append("Son protocolos distintos: la latencia objetivo no significa lo mismo en cada reproductor, ni el búfer, ni la estimación de ancho de banda.")
    if A["ladder"] != B["ladder"]:
        out.append("Las escaleras son distintas: la altura y la calidad más alta se comparan en píxeles, no en la posición de cada una en su escalera.")
    no_reps = [n for n, x in (("A", A), ("B", B)) if len(x["reps"]) < 2]
    if no_reps:
        out.append(f"Sin otras repeticiones válidas de la misma condición en {' ni en '.join(no_reps)}: no se puede saber si las diferencias superan la variación entre repeticiones.")
    elif min(len(A["reps"]), len(B["reps"])) < 3:
        out.append("Con dos repeticiones, la variación entre ellas es una cota pobre: el veredicto de cada métrica es orientativo.")
    only = [r["label"] for r in rows if r["verdict"] == "sin_dato"]
    if only:
        out.append(f"Solo una de las dos tiene dato de: {', '.join(only)} (en la otra no se midió: sin imagen, medida posterior a su fecha o que no aplica a su protocolo).")
    return out


def side_view(x: dict) -> dict:
    label, profile = network_of(x)
    return {"ref": ref_text(x["ref"]), "campaign": x["campaign"]["id"], "campaign_name": x["campaign"]["name"],
            "run": x["run"]["id"], "player": x["player"], "state": x["run"]["state"], "rep": x["run"]["rep"],
            "kind": x["run"]["kind"], "started_ms": x["run"].get("started_ms"), "network": label, "network_profile": profile,
            "target": target_of(x), "ladder": x["ladder"], "reps": len(x["reps"])}


def compare(store, a: str, b: str) -> dict:
    ra, rb = parse_ref(a), parse_ref(b)
    if ra == rb:
        raise ValueError("Las dos referencias son la misma prueba")
    # Copia de las dos campañas con el cerrojo; las filas se leen sin él, para no frenar al planificador ni la subida
    # de filas de una campaña en marcha
    with store.lock:
        copies = {cid: json.loads(json.dumps(store.campaigns[cid])) if cid in store.campaigns else None for cid in {ra[0], rb[0]}}
    A, B = load_side(store, ra, copies[ra[0]]), load_side(store, rb, copies[rb[0]])
    rows = metric_rows(A, B)
    by_key = {r["key"]: r for r in rows}
    head = overview(rows)
    return {"a": side_view(A), "b": side_view(B), "conditions": conditions(A, B), "metrics": rows,
            "sentences": ([head] if head else []) + sentences(A, B, by_key), "warnings": warnings(A, B, rows)}
