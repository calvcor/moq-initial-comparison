"""Campañas de medida: baterías de pruebas desatendidas sobre condiciones de red y latencias objetivo.

El orquestador guarda el plan y marca el ritmo; el navegador (página /campaign en modo trabajador) solo
monta los reproductores con los ajustes de la prueba en curso y sube sus filas de cada segundo, las mismas
del CSV del dashboard. Así una recarga o un cuelgue de la pestaña no pierde la campaña: el trabajador se
vuelve a enganchar y la prueba interrumpida se repite.

Cada prueba (run) es una terna condición de red x latencia objetivo x repetición, con una configuración de
la emisión y unos reproductores:

1. preparing: el trabajador desmonta los reproductores; se aplica la emisión (solo si cambia, con un
   margen para que las ramas arranquen) y el perfil de red, y se deja un respiro para vaciar las colas.
2. mounting: el trabajador crea reproductores nuevos con los ajustes de la prueba y avisa al tenerlos. Son
   siempre nuevos: MoQ en auto calcula su objetivo del RTT solo al conectar (PROTOCOLOS, 4.11), y de paso
   se mide el arranque.
3. warmup: las filas se guardan, marcadas, pero no entran en el resumen.
4. measuring: las filas que entran en el resumen.
5. done o invalid. Una prueba inválida (pestaña oculta, reinicios del supervisor, anomalías de ingesta,
   trabajador desconectado, filas que faltan) se repite al final de su bloque, hasta max_attempts veces.

El orden se aleatoriza dentro de cada bloque (configuración de la emisión x repetición), para que la deriva
del sistema en una campaña larga no se confunda con la condición y sin reiniciar la fuente en cada prueba.
Cada control_every pruebas se intercala una de control, sin restricción de red, que detecta esa deriva.

La latencia objetivo de cada prueba se pasa a cada reproductor tal como lo entiende su implementación
(liveDelay de dash.js, delay de @moq/watch, jitterBufferTarget de WebRTC): no significan lo mismo y se
declara así. None es el valor de fábrica de la implementación (en DASH, sin liveDelay: unos 8 s, README 4.8).

El trabajador es uno solo (la pestaña, o el script sin nombre) o, si el plan lo dice (workers), uno por
reproductor: navegadores independientes que se anuncian por su nombre y montan cada uno los reproductores que
la campaña le asigna, en una ventana del tamaño de la calidad más alta de la emisión (README 4.8, trabajadores independientes). La prueba
espera entonces a todos, y cada uno sube sus filas: los resúmenes de un reproductor salen de las de su navegador.

Al terminar (o al cancelar) la red vuelve a quedar sin restricción y la emisión como estaba al empezar.
Si el orquestador se reinicia con una campaña en marcha, al arrancar la retoma: la prueba en curso se repite.
"""
import csv
import io
import json
import logging
import os
import random
import re
import statistics
import threading
import time
from typing import Callable, Optional

from .source import VIDEO_FILE

logger = logging.getLogger("orchestrator")

PLAYERS = ("dash", "moq", "rtc")
CAMPAIGN_ID = re.compile(r"^\d{8}-\d{6}$")
# Sin noticias del trabajador durante este tiempo, la prueba en curso se da por perdida
WORKER_TIMEOUT_S = 15
# Nombre de un trabajador independiente (un navegador por reproductor, README 4.8, trabajadores independientes), p. ej. lxc-moq
WORKER_NAME = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$"
# Modos de Chrome de un trabajador independiente: sin ventana, o una ventana en quiosco (necesita pantalla)
WORKER_BROWSERS = ("headless", "kiosk")
# Lo que se espera a que el trabajador desmonte los reproductores, o los monte, antes de seguir sin él
UNMOUNT_WAIT_S = 10
MOUNT_WAIT_S = 60
# Tras cambiar el perfil de red, para que se vacíen las colas del anterior
NETWORK_SETTLE_S = 2
# Tras la medida, para recibir las últimas filas (el trabajador las sube por lotes)
UPLOAD_GRACE_S = 8
# Por debajo de esta fracción de las filas esperadas (una por segundo), la prueba no vale: el trabajador no
# estuvo midiendo. Los segundos sin latencia de un reproductor no cuentan aquí: un vídeo parado o que no
# arranca es un resultado del protocolo (coverage en el resumen), y repetir esas pruebas sesgaría la campaña
MIN_ROWS = 0.8
# Duración aproximada de la preparación y el montaje, para la estimación de la campaña
OVERHEAD_S = 10

UNRESTRICTED = {
    direction: {"rate_kbit": None, "delay_ms": 0, "jitter_ms": 0, "loss_pct": 0, "queue_ms": 300}
    for direction in ("down", "up")
}

# Tráfico IP en el router por protocolo y sentido: el orquestador lee sus contadores cada IP_PERIOD_S durante
# el calentamiento y la medida, con su propio reloj, y guarda lo exacto de cada intervalo en ip.jsonl
IP_KEYS = tuple(f"{p}_{d}" for p in PLAYERS for d in ("down", "up"))
IP_PERIOD_S = 1
# Retraso de la fuente a partir del cual un segundo cuenta como "fuente retrasada" en el resumen: 3 frames a 60 fps
SOURCE_LATE_MS = 50

# Columna del búfer de cada reproductor en las filas del dashboard
BUFFER_COLUMN = {"dash": "dash_buffer_s", "moq": "moq_jitter_buffer_s", "rtc": "rtc_jitter_buffer_s"}


def percentile(values: list[float], p: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def rounded(value: Optional[float], digits: int = 1) -> Optional[float]:
    return None if value is None else round(value, digits)


def column(rows: list[dict], key: str) -> list[float]:
    return [r[key] for r in rows if isinstance(r.get(key), (int, float)) and not isinstance(r.get(key), bool)]


def increase(rows: list[dict], key: str) -> Optional[float]:
    """Lo que ha subido un contador acumulado en las filas (paradas, cambios de calidad, descartes)."""
    values = column(rows, key)
    if len(values) < 2:
        return None
    # Si el contador vuelve a cero (reproductor recreado), se suman los tramos
    total = 0.0
    for before, after in zip(values, values[1:]):
        total += after - before if after >= before else after
    return total


def summarize_player(player: str, rows: list[dict], measure_s: float, target_ms: Optional[int]) -> dict:
    g2g = column(rows, f"{player}_g2g_ms")
    heights = column(rows, f"{player}_height")
    top = max(heights) if heights else None
    stall_ms = increase(rows, f"{player}_stall_ms")
    mean = lambda key: rounded(statistics.fmean(column(rows, key))) if column(rows, key) else None
    # Velocidad del <video> (solo DASH; en las demás ramas no hay columnas y queda vacío)
    rates, slow, fast = column(rows, f"{player}_playback_rate"), column(rows, f"{player}_playback_slow_ms"), column(rows, f"{player}_playback_fast_ms")
    median = lambda key: rounded(statistics.median(column(rows, key))) if column(rows, key) else None
    return {
        "samples": len(g2g),
        "coverage": rounded(len(g2g) / measure_s, 3) if measure_s else None,
        "target_ms": target_ms,
        "g2g_p50_ms": rounded(percentile(g2g, 50)),
        "g2g_p95_ms": rounded(percentile(g2g, 95)),
        "g2g_mean_ms": rounded(statistics.fmean(g2g)) if g2g else None,
        "g2g_sd_ms": rounded(statistics.stdev(g2g)) if len(g2g) > 1 else None,
        "g2g_min_ms": rounded(min(g2g)) if g2g else None,
        "g2g_max_ms": rounded(max(g2g)) if g2g else None,
        "stalls": increase(rows, f"{player}_stalls"),
        "stall_ms": rounded(stall_ms),
        "stall_ratio": rounded(stall_ms / (measure_s * 1000), 4) if stall_ms is not None and measure_s else None,
        "kbps_mean": mean(f"{player}_kbps"),
        "net_kbps_mean": mean(f"{player}_net_kbps"),
        "ip_down_kbps_mean": mean(f"{player}_ip_down_kbps"),
        "fps_mean": mean(f"{player}_fps"),
        "frametime_p95_ms_median": median(f"{player}_frametime_p95_ms"),
        "buffer_s_mean": rounded(statistics.fmean(column(rows, BUFFER_COLUMN[player])), 3) if column(rows, BUFFER_COLUMN[player]) else None,
        "height_mean": rounded(statistics.fmean(heights)) if heights else None,
        # Fracción del tiempo en la calidad más alta que llegó a reproducir en la prueba
        "top_height_share": rounded(sum(1 for h in heights if h == top) / len(heights), 3) if heights else None,
        "quality_switches": increase(rows, f"{player}_quality_switches"),
        "player_restarts": increase(rows, f"{player}_player_restarts"),
        "down_dropped": increase(rows, f"{player}_down_dropped"),
        "packets_lost": increase(rows, "rtc_packets_lost") if player == "rtc" else None,
        # Avance del contenido según el timecode (las tres ramas): media de cada segundo y lo que no se pintó
        "content_speed_mean": rounded(statistics.fmean(column(rows, f"{player}_content_speed")), 3) if column(rows, f"{player}_content_speed") else None,
        "content_skipped_ms": rounded(sum(column(rows, f"{player}_content_skipped_ms"))) if column(rows, f"{player}_content_skipped_ms") else None,
        "content_skipped_share": rounded(sum(column(rows, f"{player}_content_skipped_ms")) / (measure_s * 1000), 4) if column(rows, f"{player}_content_skipped_ms") and measure_s else None,
        "playback_rate_mean": rounded(statistics.fmean(rates), 3) if rates else None,
        "playback_rate_min": rounded(min(column(rows, f"{player}_playback_rate_min")), 3) if column(rows, f"{player}_playback_rate_min") else None,
        "playback_rate_max": rounded(max(column(rows, f"{player}_playback_rate_max")), 3) if column(rows, f"{player}_playback_rate_max") else None,
        # Fracción de la medida por debajo (frenando) y por encima (acelerando) de 1×
        "playback_slow_share": rounded(sum(slow) / (measure_s * 1000), 4) if slow and measure_s else None,
        "playback_fast_share": rounded(sum(fast) / (measure_s * 1000), 4) if fast and measure_s else None,
    }


def summarize_ip(player: str, samples: list[dict]) -> dict:
    """Tráfico IP en el router durante la medida, de las lecturas del orquestador: la media exacta (bytes
    entre duración) y el p95 de los intervalos de un segundo."""
    out = {}
    for d in ("down", "up"):
        valid = [s for s in samples if s.get(f"{player}_{d}_bytes") is not None]
        ms = sum(s["t_server_ms"] - s["from_ms"] for s in valid)
        out[f"ip_{d}_kbps"] = rounded(sum(s[f"{player}_{d}_bytes"] for s in valid) * 8 / ms) if ms else None
        out[f"ip_{d}_kbps_p95"] = rounded(percentile([s[f"{player}_{d}_kbps"] for s in valid], 95))
        # Descartes de la cola en la medida, en número y sobre los paquetes que entraron (lecturas sin contador
        # de descartes, anteriores al 3-11-2026, quedan fuera: vacío)
        counted = [s for s in samples if s.get(f"{player}_{d}_dropped") is not None and s.get(f"{player}_{d}_packets") is not None]
        dropped = sum(s[f"{player}_{d}_dropped"] for s in counted)
        packets = sum(s[f"{player}_{d}_packets"] for s in counted)
        out[f"ip_{d}_dropped"] = dropped if counted else None
        out[f"ip_{d}_drop_pct"] = rounded(100 * dropped / packets, 3) if counted and packets else None
    return out


def summarize_source(samples: list[dict]) -> dict:
    """Retraso de la fuente durante la medida, de las mismas lecturas: el máximo, el p95 de los segundos y la
    fracción de segundos en que pasó de SOURCE_LATE_MS. Es de la emisión, el mismo para los tres reproductores."""
    lags = [s["source_lag_ms"] for s in samples if s.get("source_lag_ms") is not None]
    return {
        "source_lag_max_ms": rounded(max(lags)) if lags else None,
        "source_lag_p95_ms": rounded(percentile(lags, 95)),
        "source_late_share": rounded(sum(lag > SOURCE_LATE_MS for lag in lags) / len(lags), 4) if lags else None,
    }


def summarize_main(rows: list[dict], measure_s: float) -> dict:
    """Carga del hilo principal de la página durante la medida (columnas main_* de las filas): refrescos perdidos
    por segundo, fracción del tiempo en frames de 50 ms o más y el más largo. Es de la página, la misma para los
    reproductores que tenía montados."""
    missed = column(rows, "main_refreshes_missed")
    long_ms = column(rows, "main_long_frame_ms")
    long_max = column(rows, "main_long_frame_max_ms")
    return {
        "main_refreshes_missed_per_s": rounded(sum(missed) / measure_s, 2) if missed and measure_s else None,
        "main_long_frame_share": rounded(sum(long_ms) / (measure_s * 1000), 4) if long_ms and measure_s else None,
        "main_long_frame_max_ms": rounded(max(long_max)) if long_max else None,
    }


class Campaigns:
    def __init__(self, root: str):
        self.root = root
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.campaigns: dict[str, dict] = {}
        self.active: Optional[str] = None
        # Filas de la prueba en curso, para su resumen (en disco van todas a samples.jsonl)
        self.rows: dict[str, list[dict]] = {}
        # Tráfico IP de la prueba en curso, intervalo a intervalo (en disco, ip.jsonl), y la última lectura
        self.ip: dict[str, list[dict]] = {}
        self.ip_last: Optional[dict] = None
        # mounted_at_ms: cuándo creó el trabajador los reproductores de la prueba montada, en reloj del servidor
        self.worker = {"id": None, "seen": 0.0, "mounted": None, "mounted_at_ms": None, "info": {}}
        # Trabajadores independientes, por nombre, con los mismos campos y su modo de Chrome (browser): se anuncian
        # aunque ninguna campaña los use, y quedan registrados (workers.json) hasta que se borran a mano
        self.pool: dict[str, dict] = {}
        # Vista previa de una prueba (preview): su red y su emisión aplicadas, y cómo estaba todo antes
        self.preview: Optional[dict] = None
        # Los pone main.py
        self.apply_stream: Callable[..., None] = lambda config, restart=False: None
        self.apply_network: Callable[[dict], None] = lambda profile: None
        self.stop_stream: Callable[[], None] = lambda: None
        self.snapshot: Callable[[], dict] = lambda: {}
        # Contadores acumulados del router por cola ({"dash_down": {"bytes": ...}, ...}); None si no responde
        self.read_counters: Callable[[], Optional[dict]] = lambda: None
        # Retraso de la fuente (ms) en un intervalo de reloj del servidor (trace.FrameLog.source_lag)
        self.read_source_lag: Callable[[int, int], Optional[float]] = lambda from_ms, to_ms: None

    # --- ficheros ---

    def path(self, cid: str, name: str = "") -> str:
        if not CAMPAIGN_ID.match(cid):
            raise KeyError(cid)
        return os.path.join(self.root, cid, name)

    def save(self, campaign: dict):
        tmp = self.path(campaign["id"], "campaign.json.part")
        with open(tmp, "w") as f:
            json.dump(campaign, f)
        os.replace(tmp, self.path(campaign["id"], "campaign.json"))

    def save_pool(self):
        """Los trabajadores independientes registrados y su modo de Chrome (no su estado, que es de cada latido)."""
        os.makedirs(self.root, exist_ok=True)
        tmp = os.path.join(self.root, "workers.json.part")
        with open(tmp, "w") as f:
            json.dump({name: {"browser": w["browser"]} for name, w in self.pool.items()}, f)
        os.replace(tmp, os.path.join(self.root, "workers.json"))

    @staticmethod
    def new_worker(browser: str = "headless") -> dict:
        return {"id": None, "seen": 0.0, "mounted": None, "mounted_at_ms": None, "info": {}, "browser": browser}

    def load(self):
        """Lee las campañas guardadas y retoma la que estuviera en marcha al reiniciarse el orquestador."""
        if not os.path.isdir(self.root):
            return
        try:
            with open(os.path.join(self.root, "workers.json")) as f:
                for name, settings in json.load(f).items():
                    browser = settings.get("browser")
                    self.pool[name] = self.new_worker(browser if browser in WORKER_BROWSERS else "headless")
        except (OSError, ValueError, AttributeError):
            pass
        for cid in sorted(os.listdir(self.root)):
            try:
                with open(self.path(cid, "campaign.json")) as f:
                    campaign = json.load(f)
            except (KeyError, OSError, ValueError):
                continue
            for run in campaign["runs"]:
                if run["state"] not in ("pending", "done", "invalid", "replaced", "skipped"):
                    run["state"] = "pending"
            self.campaigns[cid] = campaign
            if campaign["state"] == "running":
                self.log(campaign, "Orquestador reiniciado: se retoma la campaña y se repite la prueba en curso")
                self.save(campaign)
                self.active = cid

    def log(self, campaign: dict, message: str):
        logger.info(f"Campaña {campaign['id']}: {message}")
        campaign.setdefault("events", []).append({"t_ms": int(time.time() * 1000), "message": message})
        del campaign["events"][:-200]

    # --- plan ---

    def expand(self, plan: dict) -> list[dict]:
        rng = random.Random(plan["seed"])
        players = plan["players"]
        groups = [players] if plan["player_mode"] == "together" else [[p] for p in players]
        runs = []
        for s in range(len(plan["streams"])):
            for rep in range(plan["repetitions"]):
                block = [
                    {"stream": s, "network": n, "target": t, "players": group, "rep": rep, "kind": "test"}
                    for n in range(len(plan["networks"]))
                    for t in range(len(plan["targets"]))
                    for group in groups
                ]
                rng.shuffle(block)
                runs.extend(block)
        if plan["control_every"]:
            with_controls = []
            for i, run in enumerate(runs):
                # El control va con la emisión de la prueba que le sigue: no fuerza un reinicio de la fuente
                if i % plan["control_every"] == 0:
                    for group in groups:
                        with_controls.append({**run, "network": None, "target": 0, "players": group, "kind": "control"})
                with_controls.append(run)
            runs = with_controls
        return [self.new_run(i, run) for i, run in enumerate(runs)]

    @staticmethod
    def new_run(index: int, run: dict, attempt: int = 1) -> dict:
        return {**run, "id": f"r{index:04d}", "attempt": attempt, "state": "pending", "invalid_reasons": [],
                "started_ms": None, "mounted_ms": None, "warmup_start_ms": None, "measure_start_ms": None, "ended_ms": None, "summary": None}

    def estimate_s(self, campaign: dict) -> float:
        plan = campaign["plan"]
        pending = [r for r in campaign["runs"] if r["state"] == "pending"]
        per_run = plan["warmup_s"] + plan["measure_s"] + OVERHEAD_S + UPLOAD_GRACE_S
        restarts = len(pending) if self.restarts_each_run(plan) else len({r["stream"] for r in pending})
        return len(pending) * per_run + restarts * plan["stream_settle_s"]

    @staticmethod
    def restarts_each_run(plan: dict, stream: Optional[int] = None) -> bool:
        """Contenido igual en cada prueba: la fuente se reinicia antes de cada una. Con la cámara no aplica."""
        if plan.get("content", "continuous") != "restart":
            return False
        streams = plan["streams"] if stream is None else [plan["streams"][stream]]
        return any(s.get("source", "file") != "camera" for s in streams)

    def create(self, plan: dict) -> dict:
        with self.lock:
            cid = time.strftime("%Y%m%d-%H%M%S")
            while cid in self.campaigns:
                time.sleep(1)
                cid = time.strftime("%Y%m%d-%H%M%S")
            if plan.get("seed") is None:
                plan["seed"] = random.randrange(2 ** 31)
            campaign = {"id": cid, "name": plan["name"], "state": "ready", "created_ms": int(time.time() * 1000),
                        "plan": plan, "runs": self.expand(plan), "current": None, "restore": None, "events": []}
            os.makedirs(self.path(cid), exist_ok=True)
            self.campaigns[cid] = campaign
            self.save(campaign)
            return self.view(campaign)

    def replace_plan(self, cid: str, plan: dict) -> dict:
        """Cambia el plan de una campaña que no ha empezado y vuelve a sortear sus pruebas. Una que ya ha medido
        no se edita, para no mezclar en ella pruebas de dos planes: se duplica y se edita la copia."""
        with self.lock:
            campaign = self.campaigns[cid]
            if campaign["state"] != "ready" or campaign["restore"] is not None:
                raise RuntimeError("Solo se puede editar una campaña que no ha empezado: duplícala y edita la copia")
            if plan.get("seed") is None:
                plan["seed"] = random.randrange(2 ** 31)
            campaign.update(name=plan["name"], plan=plan, runs=self.expand(plan))
            self.log(campaign, "Plan editado: pruebas sorteadas de nuevo")
            self.save(campaign)
            return self.view(campaign)

    def view(self, campaign: dict, runs: bool = True) -> dict:
        counts = {}
        for run in campaign["runs"]:
            counts[run["state"]] = counts.get(run["state"], 0) + 1
        out = {k: v for k, v in campaign.items() if runs or k not in ("runs", "events")}
        out.update(counts=counts, total_runs=len(campaign["runs"]), eta_s=round(self.estimate_s(campaign)))
        if campaign["id"] == self.active:
            out["worker"] = self.worker_view()
        if campaign["plan"].get("workers"):
            # El estado de los trabajadores independientes de la campaña, esté en marcha o no
            names = set(campaign["plan"]["workers"].values())
            out["workers"] = [w for w in self.pool_view() if w["name"] in names]
        return out

    def worker_view(self) -> dict:
        connected = self.worker["id"] is not None and time.time() - self.worker["seen"] < WORKER_TIMEOUT_S
        return {"connected": connected, "id": self.worker["id"], "seen_ms": int(self.worker["seen"] * 1000),
                "mounted": self.worker["mounted"], "info": self.worker["info"]}

    def pool_view(self) -> list[dict]:
        """Los trabajadores independientes registrados. busy: los usa la campaña activa; locked: una campaña en marcha
        o en pausa (no se pueden borrar ni cambiar de modo); task: lo que tienen montado, con su campaña y fase."""
        with self.lock:
            now = time.time()
            used = set((self.campaigns[self.active]["plan"].get("workers") or {}).values()) if self.active else set()
            out = []
            for name, w in sorted(self.pool.items()):
                connected = w["id"] is not None and now - w["seen"] < WORKER_TIMEOUT_S
                task = None
                if connected and w["mounted"] and self.active:
                    campaign = self.campaigns[self.active]
                    run = self.find_run(campaign, w["mounted"])
                    if run:
                        task = {"campaign": campaign["id"], "campaign_name": campaign["name"], "run": run["id"],
                                "phase": run["state"], "players": (self.run_workers(campaign["plan"], run) or {}).get(name)}
                out.append({"name": name, "id": w["id"], "connected": connected, "seen_ms": int(w["seen"] * 1000) or None,
                            "mounted": w["mounted"] if connected else None, "info": w["info"], "browser": w["browser"],
                            "busy": self.active if name in used else None, "task": task, "locked": self.locked_by(name)})
            return out

    def locked_by(self, name: str) -> Optional[str]:
        """La campaña en marcha o en pausa que usa este trabajador independiente (None si ninguna)."""
        return next((c["id"] for c in self.campaigns.values()
                     if c["state"] in ("running", "paused") and name in (c["plan"].get("workers") or {}).values()), None)

    def set_worker_browser(self, name: str, browser: str) -> dict:
        """Cambia el modo de Chrome de un trabajador independiente. No con una campaña en marcha o en pausa que lo
        use (mezclaría modos en ella), ni a ventana si el trabajador dice que no tiene pantalla."""
        with self.lock:
            if name not in self.pool:
                raise KeyError(name)
            if browser not in WORKER_BROWSERS:
                raise ValueError(browser)
            locked = self.locked_by(name)
            if locked and browser != self.pool[name]["browser"]:
                raise RuntimeError(f"La campaña {locked} usa {name}: termínala o cancélala antes de cambiar su modo")
            if browser == "kiosk" and self.pool[name]["info"].get("display") is False:
                raise RuntimeError(f"{name} no tiene pantalla: solo puede ir en headless")
            self.pool[name]["browser"] = browser
            self.save_pool()
            return next(w for w in self.pool_view() if w["name"] == name)

    def forget_worker(self, name: str):
        """Borra un trabajador independiente del registro. No si está conectado (volvería a anunciarse en el siguiente
        latido) ni si lo usa una campaña en marcha o en pausa."""
        with self.lock:
            if name not in self.pool:
                raise KeyError(name)
            if self.pool_alive(name):
                raise RuntimeError(f"{name} está conectado: ciérralo antes, o se volverá a anunciar")
            locked = self.locked_by(name)
            if locked:
                raise RuntimeError(f"La campaña {locked} usa {name}")
            del self.pool[name]
            self.save_pool()
            logger.info(f"Campañas: trabajador {name} borrado del registro")

    @staticmethod
    def browser_of(campaign: dict, name: str) -> str:
        """Modo de Chrome de un trabajador en una campaña: el que tenía al empezarla."""
        return (campaign.get("worker_browsers") or {}).get(name) or campaign["plan"].get("worker_browser") or "headless"

    def all(self) -> list[dict]:
        with self.lock:
            return [self.view(c, runs=False) for c in sorted(self.campaigns.values(), key=lambda c: c["id"], reverse=True)]

    def get(self, cid: str) -> Optional[dict]:
        with self.lock:
            campaign = self.campaigns.get(cid)
            return self.view(campaign) if campaign else None

    def running(self) -> Optional[dict]:
        """Resumen de la campaña en marcha, para /api/status (None si no hay ninguna)."""
        with self.lock:
            if not self.active:
                return None
            campaign = self.campaigns[self.active]
            out = {"id": campaign["id"], "name": campaign["name"], "state": campaign["state"],
                   "current": campaign["current"], "worker": self.worker_view()}
            if campaign["plan"].get("workers"):
                names = set(campaign["plan"]["workers"].values())
                out["workers"] = [w for w in self.pool_view() if w["name"] in names]
            return out

    def rename(self, cid: str, name: str) -> dict:
        """Cambia el nombre, en cualquier estado: no toca el plan ni las medidas (el CSV lleva el id, no el nombre)."""
        with self.lock:
            campaign = self.campaigns[cid]
            if name != campaign["name"]:
                self.log(campaign, f"Renombrada: «{campaign['name']}» → «{name}»")
                campaign["name"] = campaign["plan"]["name"] = name
                self.save(campaign)
            return self.view(campaign)

    def delete(self, cid: str):
        with self.lock:
            if cid == self.active:
                raise RuntimeError("La campaña está en marcha: cancélala antes de borrarla")
            if cid not in self.campaigns:
                raise KeyError(cid)
            del self.campaigns[cid]
            for name in os.listdir(self.path(cid)):
                os.remove(self.path(cid, name))
            os.rmdir(self.path(cid))

    # --- control ---

    def start(self, cid: str):
        with self.lock:
            campaign = self.campaigns[cid]
            if self.active and self.active != cid:
                raise RuntimeError(f"Ya hay otra campaña en marcha ({self.active})")
            if campaign["state"] not in ("ready", "paused"):
                raise RuntimeError(f"La campaña está {campaign['state']}")
            # Antes de anotar lo que habrá que restaurar, se deshace la vista previa que hubiera
            self.stop_preview()
            # reopened: una campaña terminada o cancelada a la que se le ha pedido repetir una prueba; lo de
            # entonces ya se restauró y puede haber cambiado
            if campaign["restore"] is None or campaign.pop("reopened", False):
                # Cómo estaba todo al empezar, para dejarlo igual al terminar (sobrevive a reinicios)
                snap = self.snapshot()
                campaign["restore"] = {"running": snap.get("running"), "config": snap.get("config"),
                                       "network": snap.get("network")}
                campaign["versions"] = snap.get("versions")
            if campaign["plan"].get("workers") and "worker_browsers" not in campaign:
                # El modo de Chrome de cada trabajador queda fijado al empezar: toda la campaña con el mismo
                campaign["worker_browsers"] = {n: self.pool[n]["browser"] if n in self.pool else "headless"
                                               for n in set(campaign["plan"]["workers"].values())}
            campaign["state"] = "running"
            self.log(campaign, "Campaña en marcha")
            self.save(campaign)
            self.active = cid
            self.wake.set()

    def pause(self, cid: str):
        """Detiene la campaña sin restaurar nada; la prueba en curso se repetirá al reanudar."""
        with self.lock:
            campaign = self.campaigns[cid]
            if campaign["state"] != "running":
                raise RuntimeError(f"La campaña está {campaign['state']}")
            campaign["state"] = "paused"
            self.log(campaign, "Campaña en pausa")
            self.save(campaign)
            self.wake.set()

    def abort(self, cid: str):
        with self.lock:
            campaign = self.campaigns[cid]
            if campaign["state"] not in ("running", "paused", "ready"):
                raise RuntimeError(f"La campaña está {campaign['state']}")
            campaign["state"] = "aborted"
            self.log(campaign, "Campaña cancelada")
            self.save(campaign)
            self.wake.set()
            if cid != self.active and campaign["restore"] is not None:
                # En pausa no hay planificador que restaure: se hace aquí
                threading.Thread(target=self.restore, args=(campaign,), daemon=True).start()

    def restore(self, campaign: dict):
        restore = campaign.get("restore") or {}
        try:
            self.apply_network((restore.get("network") or UNRESTRICTED))
        except Exception as e:
            self.log(campaign, f"No se pudo restaurar la red: {e}")
        try:
            if restore.get("running") and restore.get("config"):
                self.apply_stream(restore["config"])
            elif restore.get("running") is False:
                self.stop_stream()
        except Exception as e:
            self.log(campaign, f"No se pudo restaurar la emisión: {e}")
        with self.lock:
            self.save(campaign)

    # --- trabajador ---

    def heartbeat(self, worker_id: str, mounted: Optional[str], mounted_at_ms: Optional[float], info: dict,
                  name: Optional[str] = None) -> dict:
        """El trabajador dice qué tiene montado y recibe lo que debe tener.

        Sin nombre es el trabajador único de siempre: el primero que late se queda con las campañas sin
        trabajadores independientes, y los demás esperan. Con nombre es un trabajador independiente: se anuncia,
        y solo monta lo que le asigna una campaña que lo haya elegido."""
        with self.lock:
            now = time.time()
            entry = self.pool.get(name) if name else self.worker
            if entry is not None and entry["id"] not in (None, worker_id) and now - entry["seen"] < WORKER_TIMEOUT_S:
                return {"busy": True, "worker": entry["id"], "assignment": None}
            if entry is None or entry["id"] != worker_id:
                logger.info(f"Campañas: trabajador {name or worker_id} conectado" + (f" ({worker_id})" if name else ""))
            if name and entry is None:
                entry = self.pool[name] = self.new_worker()
                self.save_pool()
            # Si no lo dice (o no es creíble), el primer latido que trae la prueba montada
            if mounted is None:
                mounted_at_ms = None
            elif mounted_at_ms is None or not now * 1000 - 60000 <= mounted_at_ms <= now * 1000 + 1000:
                same = entry["mounted"] == mounted and entry["mounted_at_ms"]
                mounted_at_ms = entry["mounted_at_ms"] if same else now * 1000
            entry.update(id=worker_id, seen=now, mounted=mounted, mounted_at_ms=mounted_at_ms, info=info)
            self.wake.set()
            return {"busy": False, "assignment": self.assignment(name)}

    def assignment(self, name: Optional[str] = None) -> Optional[dict]:
        """Lo que debe tener montado el trabajador único (name None) o el independiente de ese nombre."""
        if not self.active:
            return None
        campaign = self.campaigns[self.active]
        plan = campaign["plan"]
        idle = {"campaign": campaign["id"], "phase": "idle"}
        # Una campaña con trabajadores independientes no da nada al trabajador único, ni al revés; un trabajador
        # independiente que la campaña no ha elegido tampoco recibe nada (ni su resolución)
        if bool(plan.get("workers")) != bool(name) or (name and name not in plan["workers"].values()):
            return idle
        current = campaign["current"]
        run = self.find_run(campaign, current) if current else None
        if name:
            # La ventana del trabajador, antes de que monte: la de la emisión de la prueba (o la mayor del plan)
            streams = [plan["streams"][run["stream"]]] if run else plan["streams"]
            idle["viewport"] = max((self.viewport(s) for s in streams), key=lambda v: v["height"])
            idle["browser"] = self.browser_of(campaign, name)
        if campaign["state"] != "running" or run is None:
            return idle
        workers = self.run_workers(plan, run)
        if workers is not None and name not in workers:
            return idle  # la prueba no tiene reproductores en este trabajador (una por reproductor)
        phase = run["state"]
        out = {**idle, "run": run["id"], "phase": phase}
        if phase in ("mounting", "warmup", "measuring", "closing"):
            out.update(self.run_settings(plan, run), ends_ms=self.phase_end_ms(run, plan))
            if workers is not None:
                out["players"] = workers[name]
        return out

    @staticmethod
    def viewport(stream: dict) -> dict:
        """Ventana de un trabajador independiente: la calidad más alta de la emisión, en 16:9, para que el navegador
        componga la imagen a 1:1 (una calidad inferior la escala al tamaño de la ventana, como la vería un espectador)."""
        height = max(r["height"] for r in stream["renditions"])
        return {"width": 2 * round(height * 8 / 9), "height": height}

    @staticmethod
    def run_workers(plan: dict, run: dict) -> Optional[dict[str, list[str]]]:
        """Con trabajadores independientes, qué reproductores de la prueba monta cada uno; None con el trabajador único."""
        assigned = plan.get("workers")
        if not assigned:
            return None
        out: dict[str, list[str]] = {}
        for p in run["players"]:
            out.setdefault(assigned[p], []).append(p)
        return out

    def pool_alive(self, name: str) -> bool:
        entry = self.pool.get(name)
        return entry is not None and entry["id"] is not None and time.time() - entry["seen"] < WORKER_TIMEOUT_S

    def run_alive(self, plan: dict, run: dict) -> bool:
        """Están conectados los trabajadores que necesita la prueba."""
        workers = self.run_workers(plan, run)
        return self.worker_alive() if workers is None else all(self.pool_alive(n) for n in workers)

    def run_mounted(self, plan: dict, run: dict) -> bool:
        """Todos los trabajadores de la prueba la tienen montada."""
        workers = self.run_workers(plan, run)
        if workers is None:
            return self.worker["mounted"] == run["id"]
        return all(self.pool.get(n, {}).get("mounted") == run["id"] for n in workers)

    def unmounted(self, plan: dict) -> bool:
        """Ningún trabajador de la campaña tiene nada montado (los desconectados no cuentan)."""
        if not plan.get("workers"):
            return self.worker["mounted"] is None
        return all(not self.pool_alive(n) or self.pool[n]["mounted"] is None for n in set(plan["workers"].values()))

    def mounted_times(self, plan: dict, run: dict) -> tuple[int, dict[str, int]]:
        """Cuándo se montaron los reproductores: el último trabajador en hacerlo y, por reproductor, el suyo."""
        workers = self.run_workers(plan, run)
        fallback = int(time.time() * 1000)
        if workers is None:
            at = int(self.worker["mounted_at_ms"] or fallback)
            return at, {p: at for p in run["players"]}
        by = {p: int(self.pool[n]["mounted_at_ms"] or fallback) for n, players in workers.items() for p in players}
        return max(by.values()), by

    @staticmethod
    def run_settings(plan: dict, run: dict) -> dict:
        """Lo que necesitan los reproductores de una prueba (el trabajador y la vista previa)."""
        target = plan["targets"][run["target"]]
        return dict(
            players=run["players"],
            targets={p: target.get(f"{p}_ms") for p in PLAYERS},
            target_label=target["label"],
            network_label="control (sin restricción)" if run["network"] is None else plan["networks"][run["network"]]["label"],
            quality=plan["quality"],
            # Las campañas anteriores a estas opciones no las tienen: el trabajador usa entonces sus valores por defecto
            options=plan.get("player_options") or {},
            kind=run["kind"],
            rep=run["rep"],
        )

    # --- vista previa ---

    @staticmethod
    def same_stream(stream: Optional[dict], config: Optional[dict]) -> bool:
        """La emisión ya es esa (la cadencia no cuenta: con la cámara la fija el servidor)."""
        if not stream or not config:
            return False
        ladder = lambda c: [(r["height"], r["bitrate_kbps"]) for r in c.get("renditions") or []]
        return ladder(stream) == ladder(config) and all(
            config.get(k) == v for k, v in stream.items() if k not in ("fps", "renditions"))

    def start_preview(self, cid: str, run_id: str) -> dict:
        """Aplica la red y la emisión de una prueba para verla en directo, sin medir ni grabar nada.

        Lo que había antes se guarda (el de la primera vista previa si se encadenan) y stop_preview lo
        restaura. La emisión solo se toca si es distinta: reaplicarla reinicia los empaquetadores."""
        with self.lock:
            if self.active and self.campaigns[self.active]["state"] == "running":
                raise RuntimeError("Hay una campaña en marcha: la vista previa cambiaría su red y su emisión")
            campaign = self.campaigns[cid]
            run = self.find_run(campaign, run_id)
            if run is None:
                raise KeyError(run_id)
            plan = campaign["plan"]
            previous = self.preview
        snap = self.snapshot()
        restore = previous["restore"] if previous else {
            "running": snap.get("running"), "config": snap.get("config"), "network": snap.get("network")}
        stream = plan["streams"][run["stream"]]
        changed = not snap.get("running") or not self.same_stream(stream, snap.get("config"))
        if changed:
            self.apply_stream(stream)
        self.apply_network(UNRESTRICTED if run["network"] is None else plan["networks"][run["network"]]["profile"])
        with self.lock:
            self.preview = {"campaign": cid, "run": run_id, "started_ms": int(time.time() * 1000), "restore": restore}
        logger.info(f"Campañas: vista previa de {cid}/{run_id}")
        return {"campaign": cid, "run": run_id, "phase": "preview", "stream_changed": changed, **self.run_settings(plan, run)}

    def stop_preview(self) -> bool:
        """Deshace la vista previa: la red y la emisión vuelven a como estaban. False si no había."""
        with self.lock:
            preview, self.preview = self.preview, None
        if not preview:
            return False
        restore = preview["restore"]
        try:
            self.apply_network(restore.get("network") or UNRESTRICTED)
        except Exception as e:
            logger.warning(f"Campañas: no se pudo restaurar la red tras la vista previa: {e}")
        try:
            if restore.get("running") is False:
                self.stop_stream()
            elif restore.get("config") and not self.same_stream(restore["config"], self.snapshot().get("config")):
                self.apply_stream(restore["config"])
        except Exception as e:
            logger.warning(f"Campañas: no se pudo restaurar la emisión tras la vista previa: {e}")
        logger.info(f"Campañas: fin de la vista previa de {preview['campaign']}/{preview['run']}")
        return True

    def preview_view(self) -> Optional[dict]:
        with self.lock:
            return {k: v for k, v in self.preview.items() if k != "restore"} if self.preview else None

    @staticmethod
    def phase_end_ms(run: dict, plan: dict) -> Optional[int]:
        if run["state"] == "warmup":
            return run["warmup_start_ms"] + int(plan["warmup_s"] * 1000)
        if run["state"] == "measuring":
            return run["measure_start_ms"] + int(plan["measure_s"] * 1000)
        return None

    def add_rows(self, cid: str, run_id: str, rows: list[dict], worker: Optional[str] = None) -> int:
        """Guarda las filas que sube el trabajador, marcadas con la fase de la prueba a la que pertenecen (y, de un
        trabajador independiente, con su nombre: cada uno sube las de sus reproductores)."""
        with self.lock:
            campaign = self.campaigns.get(cid)
            if campaign is None:
                raise KeyError(cid)
            run = self.find_run(campaign, run_id)
            if run is None or run["mounted_ms"] is None:
                return 0
            end_ms = run["measure_start_ms"] + int(campaign["plan"]["measure_s"] * 1000) if run["measure_start_ms"] else None
            kept = []
            for row in rows:
                t = row.get("t_server_ms")
                if not isinstance(t, (int, float)):
                    continue
                if run["measure_start_ms"] is None or t < run["measure_start_ms"]:
                    phase = "warmup"
                elif t <= end_ms:
                    phase = "measuring"
                else:
                    continue  # ya fuera de la prueba
                # run_started_ms distingue la prueba repetida tras una pausa o un reinicio, que conserva su id
                kept.append({"campaign": cid, "run_id": run_id, "attempt": run["attempt"],
                             "run_started_ms": run["started_ms"], "phase": phase, **row, **({"worker": worker} if worker else {})})
            if not kept:
                return 0
            with open(self.path(cid, "samples.jsonl"), "a") as f:
                for row in kept:
                    f.write(json.dumps(row) + "\n")
            if run["state"] in ("warmup", "measuring", "closing"):
                self.rows.setdefault(run_id, []).extend(kept)
            return len(kept)

    @staticmethod
    def find_run(campaign: dict, run_id: str) -> Optional[dict]:
        return next((r for r in campaign["runs"] if r["id"] == run_id), None)

    # --- planificador ---

    def scheduler(self):
        """Hilo del planificador: lleva la campaña activa prueba a prueba."""
        while True:
            self.wake.wait(1)
            self.wake.clear()
            with self.lock:
                cid = self.active
            if not cid:
                continue
            try:
                self.drive(self.campaigns[cid])
            except Exception as e:
                logger.exception(f"Campañas: error en el planificador: {e}")
                time.sleep(5)

    def worker_alive(self) -> bool:
        return self.worker["id"] is not None and time.time() - self.worker["seen"] < WORKER_TIMEOUT_S

    def wait(self, seconds: float, campaign: dict, until: Optional[Callable[[], bool]] = None) -> bool:
        """Espera mientras la campaña siga en marcha. False si deja de estarlo."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            if campaign["state"] != "running":
                return False
            if until and until():
                return True
            time.sleep(0.25)
        return campaign["state"] == "running"

    def drive(self, campaign: dict):
        plan = campaign["plan"]
        applied_stream = None
        while True:
            with self.lock:
                if campaign["state"] != "running":
                    break
                run = next((r for r in campaign["runs"] if r["state"] == "pending"), None)
                if run is None:
                    campaign["state"] = "done"
                    campaign["current"] = None
                    self.log(campaign, "Campaña terminada")
                    self.save(campaign)
                    break
                campaign["current"] = run["id"]
                run.update(state="preparing", started_ms=int(time.time() * 1000), mounted_ms=None, warmup_start_ms=None,
                           measure_start_ms=None, ended_ms=None, invalid_reasons=[], summary=None)
                run.pop("mounted_by", None)
                self.rows.pop(run["id"], None)
                self.ip.pop(run["id"], None)
                self.save(campaign)

            # Sin trabajador no tiene sentido tocar nada: se espera a que se conecte (con trabajadores
            # independientes, todos los que necesita la prueba)
            alive = lambda: self.run_alive(plan, run)
            if not alive():
                with self.lock:
                    run["state"] = "pending"
                    campaign["current"] = None
                if not self.wait(3600 * 24, campaign, alive):
                    break
                continue

            # 1. Los trabajadores desmontan lo que tengan antes de cambiar la red o la emisión
            self.wait(UNMOUNT_WAIT_S, campaign, lambda: self.unmounted(plan))
            try:
                stream = plan["streams"][run["stream"]]
                snap = self.snapshot()
                restart = self.restarts_each_run(plan, run["stream"])
                if restart or applied_stream != run["stream"] or not snap.get("running"):
                    if applied_stream != run["stream"]:
                        self.log(campaign, f"Emisión {run['stream'] + 1} de {len(plan['streams'])}")
                    self.apply_stream(stream, restart=restart)
                    applied_stream = run["stream"]
                    if not self.wait(plan["stream_settle_s"], campaign):
                        self.requeue(campaign, run)
                        break
                network = UNRESTRICTED if run["network"] is None else plan["networks"][run["network"]]["profile"]
                self.apply_network(network)
            except Exception as e:
                self.log(campaign, f"No se pudo preparar {run['id']}: {e}; se reintenta en 30 s")
                applied_stream = None
                self.requeue(campaign, run)
                if not self.wait(30, campaign):
                    break
                continue
            if not self.wait(NETWORK_SETTLE_S, campaign):
                self.requeue(campaign, run)
                break
            before = self.snapshot()
            with self.lock:
                run["source_started_ms"] = before.get("source_started_ms")

            # 2. El trabajador monta reproductores nuevos y avisa
            with self.lock:
                run["state"] = "mounting"
                self.save(campaign)
            mounted = self.wait(MOUNT_WAIT_S, campaign, lambda: self.run_mounted(plan, run))
            if campaign["state"] != "running":
                self.requeue(campaign, run)
                break
            if not mounted:
                workers = self.run_workers(plan, run)
                late = [n for n in workers if self.pool.get(n, {}).get("mounted") != run["id"]] if workers else []
                reason = f"no montaron los reproductores: {', '.join(late)}" if late else "el trabajador no montó los reproductores"
                self.close(campaign, run, before, [reason])
                continue

            # 3. Calentamiento y 4. medida
            with self.lock:
                mounted_ms, mounted_by = self.mounted_times(plan, run)
                run.update(state="warmup", warmup_start_ms=int(time.time() * 1000), mounted_ms=mounted_ms)
                if plan.get("workers"):
                    run["mounted_by"] = mounted_by
                self.save(campaign)
            lost = lambda: not self.run_alive(plan, run) or not self.run_mounted(plan, run)
            if not self.wait(plan["warmup_s"], campaign, lost) or lost():
                if campaign["state"] != "running":
                    self.requeue(campaign, run)
                    break
                self.close(campaign, run, before, ["trabajador desconectado o reproductores desmontados"])
                continue
            with self.lock:
                run.update(state="measuring", measure_start_ms=int(time.time() * 1000))
                self.save(campaign)
            if not self.wait(plan["measure_s"], campaign, lost) or lost():
                if campaign["state"] != "running":
                    self.requeue(campaign, run)
                    break
                self.close(campaign, run, before, ["trabajador desconectado o reproductores desmontados"])
                continue

            # 5. Últimas filas y resumen
            with self.lock:
                run["state"] = "closing"
                self.save(campaign)
            time.sleep(UPLOAD_GRACE_S)
            self.close(campaign, run, before, [])

        with self.lock:
            if campaign["state"] in ("done", "aborted"):
                campaign["current"] = None
                self.active = None
            elif campaign["state"] == "paused":
                campaign["current"] = None
                self.active = None
            self.save(campaign)
        if campaign["state"] in ("done", "aborted"):
            self.restore(campaign)

    def requeue(self, campaign: dict, run: dict):
        with self.lock:
            run.update(state="pending", mounted_ms=None, measure_start_ms=None)
            campaign["current"] = None
            self.rows.pop(run["id"], None)
            self.ip.pop(run["id"], None)
            self.save(campaign)

    def close(self, campaign: dict, run: dict, before: dict, reasons: list[str]):
        plan = campaign["plan"]
        after = self.snapshot()
        with self.lock:
            kept = self.rows.pop(run["id"], [])
            rows = [r for r in kept if r["phase"] == "measuring"]
            warmup = sorted((r for r in kept if r["phase"] == "warmup"), key=lambda r: r["t_server_ms"])
            reasons = list(reasons)
            if not reasons:
                reasons += self.validity(run, rows, before, after, plan, campaign)
            target = plan["targets"][run["target"]]
            # Las filas de cada reproductor: con el trabajador único, todas; con trabajadores independientes, las del
            # navegador que lo tenía montado (la carga del hilo principal es entonces la de ese navegador)
            of = self.player_rows if plan.get("workers") else (lambda p, rs: rs)
            run["summary"] = {
                "rows": len(rows),
                "server": {
                    "restarts": self.delta(before.get("restarts"), after.get("restarts")),
                    "ingest_anomalies": self.delta(before.get("anomalies"), after.get("anomalies")),
                },
                "players": {p: summarize_player(p, of(p, rows), plan["measure_s"], target.get(f"{p}_ms")) for p in run["players"]},
            }
            ip = [s for s in self.ip.pop(run["id"], []) if s["phase"] == "measuring"]
            source = summarize_source(ip)
            for p in run["players"]:
                run["summary"]["players"][p].update(summarize_ip(p, ip), **source, **summarize_main(of(p, rows), plan["measure_s"]))
            # Del montaje a la primera fila con latencia medida, con la resolución de una fila por segundo
            for p in run["players"]:
                mounted = (run.get("mounted_by") or {}).get(p) or run["mounted_ms"]
                first = next((r["t_server_ms"] for r in of(p, warmup) if r.get(f"{p}_g2g_ms") is not None), None)
                run["summary"]["players"][p]["first_g2g_s"] = rounded((first - mounted) / 1000) if first and mounted else None
            run.update(ended_ms=int(time.time() * 1000), invalid_reasons=reasons, state="invalid" if reasons else "done")
            if reasons:
                self.log(campaign, f"{run['id']} inválida: {'; '.join(reasons)}")
                if run["attempt"] < plan["max_attempts"]:
                    self.retry(campaign, run)
            else:
                self.supersede(campaign, run)
            campaign["current"] = None
            self.save(campaign)
        self.append_summary(campaign, run)

    @staticmethod
    def delta(before: Optional[dict], after: Optional[dict]) -> Optional[int]:
        if not before or not after:
            return None
        return sum(after.get(k, 0) - before.get(k, 0) for k in after)

    def validity(self, run: dict, rows: list[dict], before: dict, after: dict, plan: dict, campaign: Optional[dict] = None) -> list[str]:
        reasons = []
        if any(r.get("tab_hidden") for r in rows):
            reasons.append("pestaña oculta")
        restarts = self.delta(before.get("restarts"), after.get("restarts"))
        if restarts:
            reasons.append(f"{restarts} reinicios del supervisor")
        anomalies = self.delta(before.get("anomalies"), after.get("anomalies"))
        if anomalies:
            reasons.append(f"{anomalies} anomalías de ingesta")
        workers = self.run_workers(plan, run)
        if workers is None:
            wanted = "|".join(p for p in PLAYERS if p in run["players"])
            if any(r.get("players") != wanted for r in rows):
                reasons.append("reproductores activos distintos de los de la prueba")
            if len(rows) < MIN_ROWS * plan["measure_s"]:
                reasons.append(f"faltan filas: {len(rows)} de {round(plan['measure_s'])} s")
            return reasons
        # Con trabajadores independientes, lo mismo en cada uno, con sus reproductores y sus filas
        if any(r.get("worker") not in workers for r in rows):
            reasons.append("filas de un trabajador que no es de la prueba")
        for name, players in workers.items():
            mine = [r for r in rows if r.get("worker") == name]
            wanted = "|".join(p for p in PLAYERS if p in players)
            if any(r.get("players") != wanted for r in mine):
                reasons.append(f"{name}: reproductores activos distintos de los de la prueba")
            if len(mine) < MIN_ROWS * plan["measure_s"]:
                reasons.append(f"{name}: faltan filas: {len(mine)} de {round(plan['measure_s'])} s")
            browser = self.browser_of(campaign, name) if campaign else plan.get("worker_browser", "headless")
            if any(r.get("worker_browser") != browser for r in mine):
                reasons.append(f"{name}: Chrome no estaba en modo {browser}")
        return reasons

    @staticmethod
    def player_rows(player: str, rows: list[dict]) -> list[dict]:
        """Las filas de un trabajador independiente que tenía montado ese reproductor."""
        return [r for r in rows if player in (r.get("players") or "").split("|")]

    def retry(self, campaign: dict, run: dict):
        """Repite la prueba al final de su bloque (misma emisión y repetición), para no reiniciar la fuente."""
        runs = campaign["runs"]
        position = max(i for i, r in enumerate(runs) if r["stream"] == run["stream"] and r["rep"] == run["rep"]) + 1
        fields = {k: run[k] for k in ("stream", "network", "target", "players", "rep", "kind")}
        copy = self.new_run(len(runs), fields, attempt=run["attempt"] + 1)
        copy["retry_of"] = run["id"]
        runs.insert(position, copy)

    def repeat(self, cid: str, run_id: str) -> dict:
        """Repetición pedida a mano de una prueba terminada, válida o no: una copia al final de la cola.

        Si la original era válida, sigue contando hasta que la copia termine válida (supersede): así no se
        pierde el resultado si la repetición falla. Una campaña terminada o cancelada queda en pausa, para
        reanudarla y medir lo pendiente."""
        with self.lock:
            campaign = self.campaigns[cid]
            runs = campaign["runs"]
            run = self.find_run(campaign, run_id)
            if run is None:
                raise KeyError(run_id)
            if run["state"] not in ("done", "invalid"):
                raise RuntimeError(f"{run_id} está {run['state']}: solo se repite una prueba terminada")
            child = next((r["id"] for r in runs if r.get("retry_of") == run_id), None)
            if child:
                raise RuntimeError(f"{run_id} ya se repite en {child}")
            fields = {k: run[k] for k in ("stream", "network", "target", "players", "rep", "kind")}
            copy = self.new_run(len(runs), fields, attempt=run["attempt"] + 1)
            copy.update(retry_of=run_id, manual=True)
            runs.append(copy)
            self.log(campaign, f"{run_id} se repite como {copy['id']}")
            if campaign["state"] in ("done", "aborted"):
                campaign.update(state="paused", reopened=True)
                self.log(campaign, "Campaña en pausa con pruebas por repetir: reanúdala para medirlas")
            self.save(campaign)
            self.wake.set()
            return self.view(campaign)

    def supersede(self, campaign: dict, run: dict):
        """Una prueba válida sustituye a la válida que repetía (la cadena de retry_of puede pasar por intentos
        inválidos). La sustituida deja de contar en los resultados y queda como replaced."""
        parent = self.find_run(campaign, run.get("retry_of")) if run.get("retry_of") else None
        while parent is not None:
            if parent["state"] == "done":
                parent.update(state="replaced", replaced_by=run["id"])
                self.log(campaign, f"{parent['id']} sustituida por {run['id']}")
            parent = self.find_run(campaign, parent["retry_of"]) if parent.get("retry_of") else None

    # --- exportación ---

    def run_columns(self, campaign: dict, run: dict) -> dict:
        plan = campaign["plan"]
        target = plan["targets"][run["target"]]
        network = {"label": "control", "profile": UNRESTRICTED} if run["network"] is None else plan["networks"][run["network"]]
        out = {
            "campaign": campaign["id"], "run_id": run["id"], "attempt": run["attempt"], "state": run["state"],
            "kind": run["kind"], "rep": run["rep"], "stream_idx": run["stream"],
            "network_label": network["label"], "target_label": target["label"],
            "players_run": "|".join(run["players"]),
            # Con trabajadores independientes, el de cada reproductor (sin la columna: el trabajador único)
            **({"workers": "|".join(f"{p}={plan['workers'][p]}" for p in run["players"]),
                "worker_browsers": "|".join(f"{n}={self.browser_of(campaign, n)}" for n in sorted(set(plan["workers"].values())))}
               if plan.get("workers") else {}),
            "quality": plan["quality"],
            "content": plan.get("content", "continuous"),
            # Ajustes de los reproductores de la campaña (también en cada fila de samples.csv)
            **(plan.get("player_options") or {}),
            "invalid_reasons": "; ".join(run["invalid_reasons"]),
            "retry_of": run.get("retry_of"), "manual_repeat": bool(run.get("manual")),
            "started_ms": run["started_ms"], "measure_start_ms": run["measure_start_ms"], "ended_ms": run["ended_ms"],
        }
        for direction in ("down", "up"):
            for key, value in network["profile"][direction].items():
                out[f"net_{direction}_{key}"] = value
        return out

    def append_summary(self, campaign: dict, run: dict):
        """Una fila por prueba y reproductor en runs.jsonl (los intentos inválidos también)."""
        base = self.run_columns(campaign, run)
        summary = run["summary"] or {}
        with open(self.path(campaign["id"], "runs.jsonl"), "a") as f:
            for player, values in (summary.get("players") or {}).items():
                row = {**base, "player": player, "server_restarts": summary["server"]["restarts"],
                       "ingest_anomalies": summary["server"]["ingest_anomalies"], **values}
                if campaign["plan"].get("workers"):
                    row["worker"] = campaign["plan"]["workers"][player]
                    row["worker_browser"] = self.browser_of(campaign, row["worker"])
                f.write(json.dumps(row) + "\n")

    # --- tráfico IP ---

    def ip_sampler(self):
        """Hilo: lee los contadores del router al empezar cada segundo mientras una prueba calienta o mide.

        Cada lectura con la anterior de la misma prueba da un intervalo exacto (bytes y su duración en reloj del
        servidor), sin pasar por el navegador: no carga al medidor y no depende de cuándo sube sus filas. El
        intervalo es de la fase en que termina."""
        while True:
            time.sleep(IP_PERIOD_S - time.time() % IP_PERIOD_S)
            with self.lock:
                campaign = self.campaigns.get(self.active) if self.active else None
                run = self.find_run(campaign, campaign["current"]) if campaign and campaign.get("current") else None
                if run is None or run["state"] not in ("warmup", "measuring"):
                    self.ip_last = None
                    continue
                key = (run["id"], run["started_ms"])
            t0 = time.time()
            try:
                counters = self.read_counters()
            except Exception:
                counters = None
            t = int((t0 + time.time()) / 2 * 1000)  # la lectura cae hacia la mitad de la petición
            if not counters:
                self.ip_last = None
                continue
            last, self.ip_last = self.ip_last, {"key": key, "t": t, "counters": counters}
            if last is None or last["key"] != key or t <= last["t"]:
                continue
            with self.lock:
                if run["state"] not in ("warmup", "measuring") or (run["id"], run["started_ms"]) != key:
                    continue
                end_ms = run["measure_start_ms"] + int(campaign["plan"]["measure_s"] * 1000) if run["measure_start_ms"] else None
                if run["measure_start_ms"] is None or t < run["measure_start_ms"]:
                    phase = "warmup"
                elif t <= end_ms:
                    phase = "measuring"
                else:
                    continue
                sample = {"campaign": campaign["id"], "run_id": run["id"], "attempt": run["attempt"], "run_started_ms": run["started_ms"],
                          "phase": phase, "from_ms": last["t"], "t_server_ms": t}
                dt = t - last["t"]
                for q in IP_KEYS:
                    a = (last["counters"].get(q) or {}).get("bytes")
                    b = (counters.get(q) or {}).get("bytes")
                    # Sin contador o con el contador reiniciado (router recreado), el intervalo queda vacío
                    size = b - a if isinstance(a, int) and isinstance(b, int) and b >= a else None
                    sample[f"{q}_bytes"] = size
                    sample[f"{q}_kbps"] = round(size * 8 / dt, 1) if size is not None else None
                    # Paquetes que entran en la cola (iptables cuenta antes de la emulación) y los que esta descarta,
                    # por desbordamiento o por la pérdida aleatoria del perfil (desde el 3-11-2026). Mismo criterio
                    # ante un contador reiniciado: el router los pone a cero al cambiar la red
                    for counter in ("packets", "dropped"):
                        a = (last["counters"].get(q) or {}).get(counter)
                        b = (counters.get(q) or {}).get(counter)
                        sample[f"{q}_{counter}"] = b - a if isinstance(a, int) and isinstance(b, int) and b >= a else None
                # Cuánto fue la fuente por detrás del tiempo real en el intervalo: común a las tres ramas
                try:
                    sample["source_lag_ms"] = self.read_source_lag(last["t"], t)
                except Exception:
                    sample["source_lag_ms"] = None
                self.ip.setdefault(run["id"], []).append(sample)
                with open(self.path(campaign["id"], "ip.jsonl"), "a") as f:
                    f.write(json.dumps(sample) + "\n")

    # Columnas de cada reproductor que se devuelven en las series (las mismas del CSV de muestras)
    # stall_spans y stall_open_since_ms: parones exactos, en reloj del servidor (desde el 28-10-2026)
    SERIES_FIELDS = ("g2g_ms", "kbps", "height", "stall_ms", "frametime_p95_ms", "stall_spans", "stall_open_since_ms", "playback_rate", "content_speed", "content_skipped_ms")
    # Columnas de la página, comunes a los reproductores: se repiten en cada uno para dibujarlas junto a sus métricas
    PAGE_SERIES_FIELDS = ("main_refreshes_missed", "main_long_frame_ms")

    def series(self, cid: str, ids: list[str]) -> dict:
        """Por prueba, sus filas del último intento (calentamiento y medida) con el tiempo relativo.

        t_s: segundos desde que arrancó la fuente si la prueba la reinició (el segundo del vídeo, el mismo en
        todas), o desde el inicio de la medida si no (en el calentamiento, negativo). zero_ms es ese instante en
        reloj del servidor, para situar en el mismo eje los parones exactos (stall_spans)."""
        campaign = self.campaigns[cid]
        runs = {r["id"]: r for r in campaign["runs"] if r["id"] in ids}
        out = {rid: {"aligned": "measure", "rows": [], "ip": []} for rid in runs}
        try:
            with open(self.path(cid, "samples.jsonl")) as f:
                for line in f:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    run = runs.get(row.get("run_id"))
                    if run is None or row.get("run_started_ms") != run["started_ms"]:
                        continue
                    restarted = self.restarts_each_run(campaign["plan"], run["stream"]) and run.get("source_started_ms")
                    zero = run["source_started_ms"] if restarted else run["measure_start_ms"]
                    if zero is None:
                        continue
                    out[run["id"]].update(aligned="source" if restarted else "measure", zero_ms=zero)
                    point = {"t_s": round((row["t_server_ms"] - zero) / 1000, 1), "phase": row["phase"]}
                    # Con trabajadores independientes cada fila es de un navegador: solo lleva sus reproductores (los
                    # demás, sin clave, no cortan sus líneas en la gráfica)
                    present = (row.get("players") or "").split("|") if campaign["plan"].get("workers") else run["players"]
                    for p in run["players"]:
                        if p not in present:
                            continue
                        for field in self.SERIES_FIELDS:
                            point[f"{p}_{field}"] = row.get(f"{p}_{field}")
                        # El búfer va en una columna distinta en cada reproductor (BUFFER_COLUMN): aquí, en ms
                        buffer = row.get(BUFFER_COLUMN[p])
                        point[f"{p}_buffer_ms"] = round(buffer * 1000) if isinstance(buffer, (int, float)) else None
                        for field in self.PAGE_SERIES_FIELDS:
                            point[f"{p}_{field}"] = row.get(field)
                    out[run["id"]]["rows"].append(point)
        except OSError:
            pass
        # Tráfico IP de cada intervalo, en el mismo eje (t_s: el final del intervalo)
        try:
            with open(self.path(cid, "ip.jsonl")) as f:
                for line in f:
                    if not line.strip():
                        continue
                    sample = json.loads(line)
                    run = runs.get(sample.get("run_id"))
                    if run is None or sample.get("run_started_ms") != run["started_ms"]:
                        continue
                    restarted = self.restarts_each_run(campaign["plan"], run["stream"]) and run.get("source_started_ms")
                    zero = run["source_started_ms"] if restarted else run["measure_start_ms"]
                    if zero is None:
                        continue
                    point = {"t_s": round((sample["t_server_ms"] - zero) / 1000, 2), "phase": sample["phase"]}
                    for p in run["players"]:
                        for d in ("down", "up"):
                            point[f"{p}_ip_{d}_kbps"] = sample.get(f"{p}_{d}_kbps")
                            point[f"{p}_ip_{d}_dropped"] = sample.get(f"{p}_{d}_dropped")
                        # Común a las tres ramas: se repite en cada una para dibujarlo junto a sus métricas
                        point[f"{p}_source_lag_ms"] = sample.get("source_lag_ms")
                    out[run["id"]]["ip"].append(point)
        except OSError:
            pass
        return out

    def export_csv(self, cid: str, name: str) -> str:
        """runs.jsonl o samples.jsonl en CSV, con la unión de todas las columnas en orden de aparición."""
        if cid not in self.campaigns:
            raise KeyError(cid)
        rows = []
        try:
            with open(self.path(cid, name)) as f:
                rows = [json.loads(line) for line in f if line.strip()]
        except OSError:
            pass
        if name == "runs.jsonl":
            # Una prueba válida que después se repitió y quedó sustituida: su fila se escribió como done
            runs = {r["id"]: r for r in self.campaigns[cid]["runs"]}
            for row in rows:
                run = runs.get(row.get("run_id"))
                if run and run["state"] == "replaced" and row.get("state") == "done":
                    row.update(state="replaced", replaced_by=run.get("replaced_by"))
        if name in ("samples.jsonl", "ip.jsonl"):
            # Las columnas de la condición, delante de las del dashboard
            campaign = self.campaigns[cid]
            runs = {r["id"]: r for r in campaign["runs"]}
            rows = [{**self.run_columns(campaign, runs[r["run_id"]]), **r,
                     # La fila entra en el resumen de una prueba válida (no de un intento interrumpido)
                     "in_summary": r["phase"] == "measuring" and runs[r["run_id"]]["state"] == "done"
                     and r.get("run_started_ms") == runs[r["run_id"]]["started_ms"]}
                    if r["run_id"] in runs else r for r in rows]
        keys = list(dict.fromkeys(k for row in rows for k in row))
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            # Booleanos como en el CSV del dashboard (true/false)
            writer.writerow({k: "" if v is None else str(v).lower() if isinstance(v, bool) else v for k, v in row.items()})
        return out.getvalue()


# Junto al vídeo fuente, en el volumen media/: sobreviven a reinicios del contenedor
campaigns = Campaigns(os.path.join(os.path.dirname(VIDEO_FILE), "campaigns"))
