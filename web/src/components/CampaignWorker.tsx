import React, { useEffect, useRef, useState } from 'react';
import { DashPlayer } from './DashPlayer';
import { MoqPlayer } from './MoqPlayer';
import { RtcPlayer } from './RtcPlayer';
import { rtcSignalUrl } from '../lib/rtcSession';
import { gridCols } from '../lib/layout';
import { syncClock, serverNowMs } from '../lib/clock';
import { PLAYER_IDS, INITIAL_METRICS, IpRates, buildSampleRow } from '../lib/samples';
import { dashManifestUrl } from '../lib/dashUrl';
import { t } from '../lib/i18n';
import type { CampaignAssignment, WorkerBrowser, PlayerId, PlayerMetrics, PlayerPreset, SampleRow, ServerStatus, VersionReport } from '../types';

// Trabajador de las campañas (docs/campaigns.md). El servidor decide qué prueba toca; esta pestaña monta los
// reproductores con sus ajustes, avisa al tenerlos y sube las filas de cada segundo, las mismas del CSV del
// dashboard más la hora del servidor. Los reproductores son siempre nuevos en cada prueba.
//
// Con nombre (/campaign?worker=1&name=lxc-moq) es un trabajador independiente (docs/campaigns.md, trabajadores independientes): se anuncia, monta
// solo los reproductores que le asigna una campaña que lo haya elegido y los pinta a toda la ventana, del tamaño
// que pide el servidor (la calidad más alta de la emisión). La ventana la ajusta quien lanza el navegador
// (scripts/campaign-worker.mjs, leyendo window.__workerViewport); hasta que encaja, la pestaña no monta. Lo mismo
// con el modo de Chrome (headless o ventana en quiosco, window.__workerBrowser): el script lo relanza en el que
// pida la campaña, y la pestaña no monta en otro. El script dice en la URL en qué modo lo abrió (browser) y si
// la máquina tiene pantalla (display), y la pestaña lo anuncia en cada latido.

const WORKER_KEY = 'testbed.campaignWorker';
const BEAT_MS = 1000;
const UPLOAD_MS = 5000;
const MAX_PENDING_ROWS = 600; // lo que admite el servidor por lote
// Fases en las que la prueba debe tener los reproductores montados
const MOUNTED_PHASES = new Set(['mounting', 'warmup', 'measuring', 'closing']);
// Lo que un trabajador independiente espera a que su ventana tenga el tamaño pedido antes de montar igualmente
const VIEWPORT_WAIT_MS = 10000;
// Construcción de la web que se sirve ahora (/build.json, sin caché): si no es la de esta pestaña, la pestaña recarga
// en cuanto no tenga prueba montada, y mientras tanto el servidor no le da ninguna (docs/campaigns.md). Sin esto, un
// trabajador seguiría con el código que cargó al arrancar y podría medir días con un bundle viejo.
const RELOAD_KEY = 'testbed.workerReload';
// Recargas seguidas hacia la misma construcción sin conseguirla (una caché que devuelve la página vieja): se deja de
// intentar y queda a la vista como desactualizado
const MAX_RELOADS = 3;

async function servedBuild(): Promise<string | null> {
  try {
    const res = await fetch('/build.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.build === 'string' ? body.build : null;
  } catch (_) {
    return null;
  }
}

/** Recarga para coger la construcción servida, salvo si ya se intentó MAX_RELOADS veces sin conseguirla. */
function reloadTo(build: string): boolean {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? 'null') as { build: string; n: number } | null;
    const n = saved?.build === build ? saved.n + 1 : 1;
    if (n > MAX_RELOADS) return false;
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ build, n }));
  } catch (_) {
    // Sin sessionStorage no se pueden contar los intentos: se recarga igual
  }
  window.location.reload();
  return true;
}

declare global {
  interface Window {
    // Tamaño de ventana que pide el servidor a un trabajador independiente (lo aplica scripts/campaign-worker.mjs)
    __workerViewport?: { width: number; height: number } | null;
    __workerBrowser?: WorkerBrowser | null;
  }
}

const viewportMatches = (v: { width: number; height: number } | undefined) =>
  !v || (window.innerWidth === v.width && window.innerHeight === v.height);
// Lo que dice el script que lanzó este Chrome (sin él, una pestaña normal: con pantalla y no headless)
const launchParams = new URLSearchParams(window.location.search);
const BROWSER: WorkerBrowser | 'tab' = (launchParams.get('browser') as WorkerBrowser | null) ?? 'tab';
const HAS_DISPLAY = launchParams.get('display') !== '0';
// Cómo decodifica el vídeo ese Chrome: software si el script lo lanzó con --software-decode; si no, lo que elija
// (por hardware donde lo hay)
const DECODE: 'software' | 'auto' = launchParams.get('decode') === 'software' ? 'software' : 'auto';

const PHASE_LABEL: Record<string, string> = {
  idle: t('sin prueba', 'no run'),
  pending: t('en cola', 'queued'),
  preparing: t('preparando red y emisión', 'preparing network and stream'),
  mounting: t('montando reproductores', 'mounting players'),
  warmup: t('calentamiento', 'warm-up'),
  measuring: t('midiendo', 'measuring'),
  closing: t('cerrando', 'closing'),
};

/** Identificador de esta pestaña como trabajador; sobrevive a recargas, no a cerrarla. */
function workerId(): string {
  try {
    const saved = sessionStorage.getItem(WORKER_KEY);
    if (saved) return saved;
    const fresh = `w-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(WORKER_KEY, fresh);
    return fresh;
  } catch (_) {
    return `w-${Math.random().toString(36).slice(2, 10)}`;
  }
}

interface Mounted {
  campaign: string;
  run: string;
  players: PlayerId[];
  presets: Record<PlayerId, PlayerPreset>;
  atServerMs: number; // cuándo se crearon los reproductores, en reloj del servidor
  atPerf: number;
}

export const CampaignWorker: React.FC<{ name?: string | null }> = ({ name = null }) => {
  const idRef = useRef(workerId());
  // Desde cuándo espera esta prueba a que la ventana tenga el tamaño pedido
  const viewportWaitRef = useRef<{ run: string; since: number } | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const statusRef = useRef<ServerStatus | null>(null);
  const ipRef = useRef(new IpRates());
  const versionsRef = useRef<VersionReport | null>(null);
  const [assignment, setAssignment] = useState<CampaignAssignment | null>(null);
  const [busyBy, setBusyBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState<Mounted | null>(null);
  const mountedRef = useRef<Mounted | null>(null);
  mountedRef.current = mounted;
  const metricsRef = useRef<Record<PlayerId, PlayerMetrics>>({ ...INITIAL_METRICS });
  const pendingRef = useRef<{ campaign: string; run: string; rows: SampleRow[] }[]>([]);
  const [now, setNow] = useState(Date.now());
  const [lastG2g, setLastG2g] = useState<Partial<Record<PlayerId, number | null>>>({});
  const [latestBuild, setLatestBuild] = useState<string | null>(null);

  // Reloj del servidor, estado de la emisión y versiones, como el dashboard
  useEffect(() => {
    syncClock('');
    const clock = setInterval(() => syncClock(''), 10000);
    const load = () =>
      fetch('/api/status')
        .then((res) => (res.ok ? res.json() : null))
        .then((data: ServerStatus | null) => {
          if (!data) return;
          statusRef.current = data;
          ipRef.current.push(data);
          setStatus(data);
        })
        .catch(() => {});
    load();
    const poll = setInterval(load, 2000);
    fetch('/api/versions')
      .then((res) => (res.ok ? res.json() : null))
      .then((report) => (versionsRef.current = report))
      .catch(() => {});
    return () => {
      clearInterval(clock);
      clearInterval(poll);
    };
  }, []);

  // Pantalla encendida mientras trabaja: con la pestaña oculta el navegador pausa el vídeo y la prueba no vale
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = () => {
      if (document.visibilityState === 'visible' && 'wakeLock' in navigator) {
        (navigator as any).wakeLock.request('screen').then((l: typeof lock) => (lock = l)).catch(() => {});
      }
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      document.removeEventListener('visibilitychange', request);
      lock?.release().catch(() => {});
    };
  }, []);

  // Latido: dice qué tiene montado y recibe lo que debe tener
  useEffect(() => {
    let stopped = false;
    let reloading = false;
    const beat = async () => {
      // La construcción servida, antes de latir: si ha cambiado y no hay prueba montada, se recarga ya
      const latest = __WEB_BUILD__ === 'dev' ? null : await servedBuild();
      const stale = latest !== null && latest !== __WEB_BUILD__;
      if (!stopped) setLatestBuild(latest);
      // Sin prueba montada y con todas las filas subidas: recargar antes perdería las últimas de la prueba anterior
      const idle = !mountedRef.current && pendingRef.current.every((b) => !b.rows.length);
      if (stale && idle && !reloading) {
        reloading = reloadTo(latest);
        if (reloading) return;
      }
      const m = mountedRef.current;
      try {
        const res = await fetch('/api/campaigns-worker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            worker_id: idRef.current,
            ...(name ? { name } : {}),
            mounted: m?.run ?? null,
            mounted_at_ms: m?.atServerMs ?? null,
            info: {
              user_agent: navigator.userAgent,
              hidden: document.hidden,
              // El servidor no le da pruebas mientras no coincidan (o si no las dice)
              build: __WEB_BUILD__,
              latest_build: latest,
              ...(name ? { viewport: `${window.innerWidth}x${window.innerHeight}`, dpr: window.devicePixelRatio, browser: BROWSER, display: HAS_DISPLAY, decode: DECODE } : {}),
            },
          }),
        });
        if (!res.ok) throw new Error(t(`latido rechazado (${res.status})`, `heartbeat rejected (${res.status})`));
        const body = await res.json();
        if (stopped) return;
        setBusyBy(body.busy ? body.worker : null);
        setAssignment(body.busy ? null : body.assignment);
        if (name) {
          window.__workerViewport = body.busy ? null : (body.assignment?.viewport ?? null);
          window.__workerBrowser = body.busy ? null : (body.assignment?.browser ?? null);
        }
        setError(null);
      } catch (e) {
        if (!stopped) setError(String(e));
      }
      setNow(Date.now());
    };
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // Montar o desmontar según la fase de la prueba asignada
  useEffect(() => {
    const wanted = assignment && MOUNTED_PHASES.has(assignment.phase) ? assignment : null;
    if (!wanted) {
      if (mountedRef.current) setMounted(null);
      return;
    }
    const current = mountedRef.current;
    if (current && current.run === wanted.run && current.campaign === wanted.campaign) return;
    // Sin reloj sincronizado o sin estado de la emisión no se puede medir: se espera al siguiente latido
    const at = serverNowMs();
    if (at === null || !statusRef.current || !wanted.players || !wanted.run) return;
    // Un trabajador independiente monta con la ventana del tamaño pedido (o, si no llega a tenerlo, tras
    // VIEWPORT_WAIT_MS: la ventana real queda en cada fila, worker_viewport)
    // En otro modo de Chrome no se monta nunca: sería otra medida (el script lo relanza en el pedido)
    if (name && wanted.browser && wanted.browser !== BROWSER) return;
    if (name && !viewportMatches(wanted.viewport)) {
      const wait = viewportWaitRef.current;
      if (!wait || wait.run !== wanted.run) viewportWaitRef.current = { run: wanted.run, since: performance.now() };
      if (performance.now() - viewportWaitRef.current!.since < VIEWPORT_WAIT_MS) return;
    }
    const presets = Object.fromEntries(
      PLAYER_IDS.map((p) => [p, { targetMs: wanted.targets?.[p] ?? null, quality: wanted.quality ?? 'auto', options: wanted.options }]),
    ) as Record<PlayerId, PlayerPreset>;
    metricsRef.current = { ...INITIAL_METRICS };
    setLastG2g({});
    setMounted({ campaign: wanted.campaign, run: wanted.run, players: wanted.players, presets, atServerMs: at, atPerf: performance.now() });
  }, [assignment]);

  // Una fila por segundo mientras hay prueba montada
  useEffect(() => {
    if (!mounted) return;
    const batch = { campaign: mounted.campaign, run: mounted.run, rows: [] as SampleRow[] };
    pendingRef.current.push(batch);
    const active = Object.fromEntries(PLAYER_IDS.map((p) => [p, mounted.players.includes(p)])) as Record<PlayerId, boolean>;
    const timer = setInterval(() => {
      const t = serverNowMs();
      if (t === null) return;
      const row = buildSampleRow({
        epoch: 0,
        epochStartedAt: mounted.atPerf,
        active,
        metrics: metricsRef.current,
        status: statusRef.current,
        ip: ipRef.current.rates(),
        audioPlayer: null,
        versions: versionsRef.current,
      });
      batch.rows.push({
        ...row,
        t_server_ms: Math.round(t),
        // Trabajador independiente: el tamaño de su ventana, donde se pinta el reproductor
        ...(name ? { worker_viewport: `${window.innerWidth}x${window.innerHeight}`, worker_browser: BROWSER, worker_decode: DECODE } : {}),
      } as SampleRow);
      if (batch.rows.length > MAX_PENDING_ROWS) batch.rows.shift();
      setLastG2g(Object.fromEntries(mounted.players.map((p) => [p, metricsRef.current[p].latencyMs])));
    }, 1000);
    return () => clearInterval(timer);
  }, [mounted]);

  // Subida por lotes; lo que no se pueda subir se reintenta en la siguiente vuelta
  useEffect(() => {
    let busy = false;
    const upload = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const batch of [...pendingRef.current]) {
          if (batch.rows.length) {
            const rows = batch.rows.splice(0, batch.rows.length);
            try {
              const res = await fetch(`/api/campaigns/${batch.campaign}/samples`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ run_id: batch.run, rows, ...(name ? { worker: name } : {}) }),
              });
              // 404: la campaña ya no existe; las filas se descartan
              if (!res.ok && res.status !== 404) batch.rows.unshift(...rows);
            } catch (_) {
              batch.rows.unshift(...rows);
            }
          }
          // Los lotes de pruebas ya desmontadas se retiran cuando están vacíos
          if (!batch.rows.length && batch.run !== mountedRef.current?.run) {
            pendingRef.current = pendingRef.current.filter((b) => b !== batch);
          }
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(upload, UPLOAD_MS);
    return () => clearInterval(timer);
  }, []);

  const update = (player: PlayerId) => (m: Partial<PlayerMetrics>) => {
    metricsRef.current = { ...metricsRef.current, [player]: { ...metricsRef.current[player], ...m } };
  };

  const phase = assignment?.phase ?? 'idle';
  const remaining = assignment?.ends_ms ? Math.max(0, Math.round((assignment.ends_ms - (serverNowMs() ?? now)) / 1000)) : null;
  const isStreaming = status?.status === 'running';
  const active = Object.fromEntries(PLAYER_IDS.map((p) => [p, !!mounted?.players.includes(p)])) as Record<PlayerId, boolean>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5">
        <span className="font-semibold text-slate-200">
          {name ? (
            <>
              {t('Trabajador independiente', 'Independent worker')} {name} <span className="font-normal text-slate-500">({idRef.current})</span>
            </>
          ) : (
            <>
              {t('Trabajador', 'Worker')} {idRef.current}
            </>
          )}
        </span>
        {busyBy ? (
          <span className="text-amber-300">
            {name
              ? t(`Otro navegador usa ya el nombre ${name} (${busyBy}); esta pestaña espera`, `Another browser is already using the name ${name} (${busyBy}); this tab is waiting`)
              : t(`Ya hay otro trabajador conectado (${busyBy}); esta pestaña espera`, `Another worker is already connected (${busyBy}); this tab is waiting`)}
          </span>
        ) : (
          <>
            <span className="text-slate-400">
              {t('Fase', 'Phase')}: <span className="text-indigo-300 font-medium">{PHASE_LABEL[phase] ?? phase}</span>
              {remaining !== null && <span className="font-mono text-slate-300"> · {remaining} s</span>}
            </span>
            {assignment?.run && (
              <span className="text-slate-400">
                {t('Prueba', 'Run')} <span className="font-mono text-slate-200">{assignment.run}</span>
                {assignment.network_label && <> · {t('red', 'network')} <span className="text-slate-200">{assignment.network_label}</span></>}
                {assignment.target_label && <> · {t('objetivo', 'target')} <span className="text-slate-200">{assignment.target_label}</span></>}
                {assignment.rep !== undefined && <> · {t('repetición', 'repetition')} {assignment.rep + 1}</>}
              </span>
            )}
            {mounted && (
              <span className="font-mono text-slate-400">
                {mounted.players.map((p) => `${p} ${lastG2g[p] != null ? `${Math.round(lastG2g[p]!)} ms` : '--'}`).join(' · ')}
              </span>
            )}
          </>
        )}
        {latestBuild && latestBuild !== __WEB_BUILD__ && (
          <span className="text-amber-300">
            {t('Web desactualizada', 'Outdated web')} ({__WEB_BUILD__}; {t('se sirve', 'serving')} {latestBuild}):{' '}
            {mounted ? t('recargará al terminar la prueba', 'will reload when the run ends') : t('no recibe pruebas hasta recargar', 'receives no runs until it reloads')}
          </span>
        )}
        {error && <span className="text-rose-300">{t('Sin servidor', 'No server')}: {error}</span>}
        <span className="text-slate-500 ml-auto">{t('Deja esta pestaña visible: oculta, la prueba no vale.', 'Keep this tab visible: if hidden, the run is invalid.')}</span>
      </div>

      {mounted && status && (
        // Trabajador independiente con un reproductor: su imagen ocupa toda la ventana (index.css, .worker-bare)
        <div className={`grid gap-4 ${gridCols(active)} ${name && mounted.players.length === 1 ? 'worker-bare' : ''}`}>
          {active.dash && (
            <DashPlayer
              key={`dash-${mounted.run}`}
              url={dashManifestUrl(status)}
              timecodes={status.timecodes}
              renditions={status.config.renditions}
              isStreaming={isStreaming}
              audible={false}
              preset={mounted.presets.dash}
              onMetricsUpdate={update('dash')}
            />
          )}
          {active.moq && (
            <MoqPlayer
              key={`moq-${mounted.run}`}
              url={`https://${status.moq_host || window.location.hostname}:${status.moq_port ?? 4433}/anon`}
              timecodes={status.timecodes}
              renditions={status.config.renditions}
              isStreaming={isStreaming}
              audible={false}
              preset={mounted.presets.moq}
              onMetricsUpdate={update('moq')}
            />
          )}
          {active.rtc && (
            <RtcPlayer
              key={`rtc-${mounted.run}`}
              timecodes={status.timecodes}
              isStreaming={isStreaming}
              server={status.rtc_server ?? 'mediamtx'}
              renditions={status.config.renditions}
              signalUrl={rtcSignalUrl(status)}
              withAudio={status.config.rtc_audio}
              streamStartedMs={status.stream_ids?.rtc ?? 0}
              audible={false}
              preset={mounted.presets.rtc}
              onMetricsUpdate={update('rtc')}
            />
          )}
        </div>
      )}
    </div>
  );
};
