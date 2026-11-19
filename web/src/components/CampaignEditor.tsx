import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CLEAR, PRESETS } from './NetworkPanel';
import { PLAYER_IDS } from '../lib/samples';
import { LOOP_VIDEOS, gopAt, isLoopVideo } from '../lib/sources';
import type { RtcServer, CampaignNetwork, CampaignPlan, CampaignTarget, DashAbr, LinkProfile, MoqAbr, MoqSwitching, PlayerId, PlayerOptions, PoolWorker, StreamConfig } from '../types';
import { SettingsModal } from './SettingsModal';
import { lang, t } from '../lib/i18n';

// Editor de campañas (README, 4.8): emisiones, condiciones de red, latencias objetivo y diseño. El servidor
// sortea las pruebas al crearla; aquí solo se estima cuántas salen y cuánto tardan.

type Stream = CampaignPlan['streams'][number];

const PLAYER_LABEL: Record<PlayerId, string> = { dash: 'LL-DASH', moq: 'MoQ', rtc: 'WebRTC' };
// Los del dashboard al abrirse (DashPlayer y MoqPlayer); los mismos que pone el servidor si faltan
export const DEFAULT_PLAYER_OPTIONS: PlayerOptions = {
  dash_abr: 'default',
  dash_max_drift_s: 1.5,
  dash_playback_buffer_min_s: 0,
  moq_abr: 'watch',
  moq_switching: 'seamless',
};
// Lo que añade el servidor a cada prueba además del calentamiento y la medida (campaign.py: OVERHEAD_S y
// UPLOAD_GRACE_S)
const RUN_OVERHEAD_S = 18;

const ladderText = (s: Stream) => s.renditions.map((r) => `${r.height}@${r.bitrate_kbps}`).join(', ');
function parseLadder(text: string): Stream['renditions'] | null {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const out = parts.map((p) => {
    const m = p.match(/^(\d+)\s*[@:x]\s*(\d+)$/);
    return m ? { height: Number(m[1]), bitrate_kbps: Number(m[2]) } : null;
  });
  return out.length && out.every(Boolean) ? (out as Stream['renditions']) : null;
}

const describe = (l: LinkProfile) =>
  [
    l.rate_kbit ? `${l.rate_kbit} kbit/s` : null,
    l.delay_ms ? `${l.delay_ms} ms` : null,
    l.jitter_ms ? `±${l.jitter_ms} ms` : null,
    l.loss_pct ? `${l.loss_pct} %` : null,
  ]
    .filter(Boolean)
    .join(', ') || t('sin límite', 'no limit');

// Barridos de un parámetro sobre una base común. RTT y jitter van repartidos por igual en los dos sentidos;
// la pérdida, en los dos; el ancho de banda, solo en la bajada (la subida apenas lleva tráfico)
type SweepParam = 'rtt' | 'loss' | 'rate' | 'jitter';
const SWEEPS: Record<SweepParam, { label: string; unit: string; example: string }> = {
  rtt: { label: 'RTT', unit: 'ms', example: '0, 50, 100, 200' },
  loss: { label: t('Pérdida', 'Loss'), unit: '%', example: '0, 0.5, 1, 2' },
  rate: { label: t('Ancho de banda de bajada', 'Downlink bandwidth'), unit: 'kbit/s', example: '10000, 6000, 4000, 2000' },
  jitter: { label: 'Jitter', unit: 'ms', example: '0, 5, 10, 20' },
};

function sweep(param: SweepParam, values: number[], baseRttMs: number, queueMs: number): CampaignNetwork[] {
  return values.map((v) => {
    const base = { ...CLEAR, delay_ms: baseRttMs / 2 };
    let down: LinkProfile = { ...base };
    let up: LinkProfile = { ...base };
    let label = '';
    if (param === 'rtt') {
      down = { ...down, delay_ms: v / 2 };
      up = { ...up, delay_ms: v / 2 };
      label = `RTT ${v} ms`;
    } else if (param === 'loss') {
      down = { ...down, loss_pct: v };
      up = { ...up, loss_pct: v };
      label = `pérdida ${v} %`;
    } else if (param === 'rate') {
      down = { ...down, rate_kbit: v || null, queue_ms: queueMs };
      label = v ? `${v} kbit/s` : 'sin límite';
    } else {
      // El jitter no puede superar el retardo: el router lo rechaza
      down = { ...down, jitter_ms: v, delay_ms: Math.max(down.delay_ms, v) };
      up = { ...up, jitter_ms: v, delay_ms: Math.max(up.delay_ms, v) };
      label = `jitter ${v} ms`;
    }
    if (baseRttMs && param !== 'rtt') label += ` (RTT ${baseRttMs} ms)`;
    return { label, profile: { down, up } };
  });
}

// Columnas de la tabla de condiciones, en el orden de cada sentido
const LINK_COLUMNS: { key: keyof LinkProfile; label: string; unit: string; hint: string }[] = [
  { key: 'rate_kbit', label: t('Ancho de banda', 'Bandwidth'), unit: 'kbit/s', hint: t('Vacío = sin límite', 'Empty = no limit') },
  { key: 'delay_ms', label: t('Retardo', 'Delay'), unit: 'ms', hint: t('En este sentido; el RTT es la suma de los dos', 'In this direction; the RTT is the sum of both') },
  { key: 'jitter_ms', label: 'Jitter', unit: 'ms', hint: t('Variación del retardo; no puede superarlo y desordena paquetes', 'Delay variation; it cannot exceed the delay and reorders packets') },
  { key: 'loss_pct', label: t('Pérdida', 'Loss'), unit: '%', hint: t('Aleatoria e independiente por paquete', 'Random and independent per packet') },
  { key: 'queue_ms', label: t('Cola', 'Queue'), unit: 'ms', hint: t('Búfer del cuello de botella; solo actúa con ancho de banda limitado', 'Bottleneck buffer; only acts with a bandwidth limit') },
];
const DIRECTION_LABEL = { down: t('Bajada (servidor → navegador)', 'Downlink (server → browser)'), up: t('Subida (navegador → servidor)', 'Uplink (browser → server)') };

const numbers = (text: string) =>
  text
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);

/** Latencias objetivo de un texto: "auto, 100, 300" (auto = la de fábrica de cada reproductor). */
function parseTargets(text: string): CampaignTarget[] | null {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  const out = parts.map((p) => {
    if (/^auto$/i.test(p)) return { label: 'auto', dash_ms: null, moq_ms: null, rtc_ms: null };
    const ms = Number(p);
    return Number.isInteger(ms) && ms > 0 ? { label: `${ms} ms`, dash_ms: ms, moq_ms: ms, rtc_ms: ms } : null;
  });
  return out.length && out.every(Boolean) ? (out as CampaignTarget[]) : null;
}

export const formatDuration = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

const input = 'bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500';
const label = 'text-[11px] text-slate-400';

const uniformTarget = (t: CampaignTarget) => t.dash_ms === t.moq_ms && t.moq_ms === t.rtc_ms;
const targetsToText = (targets: CampaignTarget[]) => targets.map((t) => (t.dash_ms === null ? 'auto' : String(t.dash_ms))).join(', ');

interface Props {
  rtcServer?: RtcServer; // servidor de la rama WebRTC, para describirla
  defaultStream: Stream;
  // Plan del que partir: el de la campaña que se duplica o se edita. Sin él, una campaña nueva
  initial?: CampaignPlan;
  // Campaña que se edita (aún sin empezar): al guardar se sustituye su plan en vez de crear otra
  editId?: string;
  onCreated: (id: string) => void;
}

export const CampaignEditor: React.FC<Props> = ({ defaultStream, rtcServer, initial, editId, onCreated }) => {
  const [name, setName] = useState(initial ? (editId ? initial.name : `${initial.name} (copia)`) : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [streams, setStreams] = useState<Stream[]>(initial?.streams ?? [defaultStream]);
  const [ladders, setLadders] = useState<string[]>((initial?.streams ?? [defaultStream]).map(ladderText));
  const [networks, setNetworks] = useState<CampaignNetwork[]>(initial ? JSON.parse(JSON.stringify(initial.networks)) : []);
  const [sweepParam, setSweepParam] = useState<SweepParam>('rtt');
  const [sweepValues, setSweepValues] = useState(SWEEPS.rtt.example);
  const [sweepBaseRtt, setSweepBaseRtt] = useState(0);
  const [sweepQueue, setSweepQueue] = useState(300);
  const [targetsText, setTargetsText] = useState(initial ? targetsToText(initial.targets) : 'auto, 100, 300, 600, 1000');
  // Objetivos distintos por rama (solo se crean por la API): se conservan tal cual mientras no se edite el texto
  const [keptTargets, setKeptTargets] = useState<CampaignTarget[] | null>(
    initial && !initial.targets.every(uniformTarget) ? initial.targets : null,
  );
  const [players, setPlayers] = useState<PlayerId[]>(initial?.players ?? [...PLAYER_IDS]);
  const [playerMode, setPlayerMode] = useState<'together' | 'each'>(initial?.player_mode ?? 'together');
  // Quién monta los reproductores: la pestaña trabajador (un solo navegador, como hasta ahora) o un trabajador
  // independiente por reproductor, elegido entre los que se han anunciado (README 4.8, trabajadores independientes)
  const [workerMode, setWorkerMode] = useState<'tab' | 'pool'>(initial?.workers || initial?.worker_pool ? 'pool' : 'tab');
  // Pruebas en paralelo: cada prueba toma un trabajador libre del grupo elegido
  const [parallel, setParallel] = useState(!!initial?.parallel);
  const [groupPicked, setGroupPicked] = useState<string[] | null>(initial?.worker_pool ?? null);
  const [workerOf, setWorkerOf] = useState<Partial<Record<PlayerId, string>>>(initial?.workers ?? {});
  const [pool, setPool] = useState<PoolWorker[]>([]);
  const [managing, setManaging] = useState(false);
  useEffect(() => {
    if (workerMode !== 'pool') return;
    const load = () =>
      fetch('/api/campaigns-workers')
        .then((res) => (res.ok ? res.json() : []))
        .then(setPool)
        .catch(() => {});
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [workerMode]);
  // A cada reproductor sin trabajador, uno libre: el que lleve su nombre (p. ej. lxc-moq) o el primero que quede. Un
  // trabajador reproduce un solo protocolo a la vez: a la vez, uno distinto por reproductor; de uno en uno, si no
  // quedan libres, se repite el que haya (sus pruebas se hacen una tras otra en él)
  const together = playerMode === 'together';
  useEffect(() => {
    if (workerMode !== 'pool') return;
    setWorkerOf((current) => {
      const next = { ...current };
      const usable = pool.filter((w) => w.connected && !w.busy);
      const free = () => usable.filter((w) => !Object.values(next).includes(w.name));
      for (const p of PLAYER_IDS) {
        if (!players.includes(p) || next[p]) continue;
        const pick = free().find((w) => w.name.toLowerCase().includes(p)) ?? free()[0] ?? (together ? undefined : usable[0]);
        if (pick) next[p] = pick.name;
      }
      return next;
    });
  }, [pool, players, workerMode, together]);
  // A la vez, dos reproductores en el mismo trabajador no pueden ir
  // El grupo de las pruebas en paralelo: el elegido o, si no se ha tocado, los conectados y libres
  const group = groupPicked ?? pool.filter((w) => w.connected && !w.busy).map((w) => w.name);
  const sharedTogether =
    workerMode === 'pool' && together && players.some((p) => players.some((q) => q !== p && workerOf[p] && workerOf[p] === workerOf[q]));
  const [quality, setQuality] = useState<number | null>(initial?.quality ?? null);
  const [options, setOptions] = useState<PlayerOptions>({ ...DEFAULT_PLAYER_OPTIONS, ...(initial?.player_options ?? {}) });
  const setOption = <K extends keyof PlayerOptions>(key: K, value: PlayerOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));
  const moqExperiment = options.moq_abr !== 'watch' || options.moq_switching !== 'seamless';
  const dashExperiment = options.dash_abr === 'l2afix';
  const [repetitions, setRepetitions] = useState(initial?.repetitions ?? 3);
  const [warmup, setWarmup] = useState(initial?.warmup_s ?? 30);
  const [measure, setMeasure] = useState(initial?.measure_s ?? 120);
  const [controlEvery, setControlEvery] = useState(initial?.control_every ?? 10);
  const [maxAttempts, setMaxAttempts] = useState(initial?.max_attempts ?? 2);
  const [settle, setSettle] = useState(initial?.stream_settle_s ?? 15);
  const [content, setContent] = useState<'continuous' | 'restart'>(initial?.content ?? 'continuous');
  // Al duplicar, sorteo nuevo (la semilla vacía la elige el servidor); al editar, la misma
  const [seed, setSeed] = useState(editId && initial?.seed != null ? String(initial.seed) : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const targets = keptTargets ?? parseTargets(targetsText);
  const ladderOk = ladders.map((t) => parseLadder(t) !== null);

  // Misma cuenta que el servidor (campaign.py: expand y estimate_s)
  const groups = playerMode === 'together' ? 1 : players.length;
  const tests = streams.length * repetitions * networks.length * (targets?.length ?? 0) * groups;
  const controls = controlEvery ? Math.ceil(tests / controlEvery) * groups : 0;
  // Con la cámara no se reinicia por prueba: no hay contenido que repetir
  const restartEachRun = content === 'restart' && streams.some((s) => s.source === 'file');
  // Con pruebas en paralelo, por tandas de una emisión: tantas pruebas a la vez como quepan en los trabajadores del grupo
  const perBatch = workerMode === 'pool' && parallel ? Math.max(1, Math.floor(group.length / (playerMode === 'together' ? players.length : 1))) : 1;
  const batches = streams.length * Math.ceil((tests + controls) / Math.max(1, streams.length) / perBatch);
  const etaS = batches * (warmup + measure + RUN_OVERHEAD_S) + (restartEachRun ? batches : streams.length) * settle;

  const setStream = (i: number, patch: Partial<Stream>) => setStreams((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setLadder = (i: number, text: string) => {
    setLadders((all) => all.map((t, j) => (j === i ? text : t)));
    const parsed = parseLadder(text);
    if (parsed) setStream(i, { renditions: parsed });
  };
  const setLink = (i: number, dir: 'down' | 'up', key: keyof LinkProfile, raw: string) => {
    const value = raw === '' ? (key === 'rate_kbit' ? null : 0) : Number(raw);
    setNetworks((all) => all.map((n, j) => (j === i ? { ...n, profile: { ...n.profile, [dir]: { ...n.profile[dir], [key]: value } } } : n)));
  };

  const create = async () => {
    if (!targets) return setError(t('Latencias objetivo: números en ms separados por comas, o auto', 'Target latencies: numbers in ms separated by commas, or auto'));
    if (!ladderOk.every(Boolean)) return setError(t('Escalera: altura@kbps separadas por comas, p. ej. 1080@4000, 720@2000', 'Ladder: height@kbps separated by commas, e.g. 1080@4000, 720@2000'));
    if (!networks.length) return setError(t('Añade al menos una condición de red', 'Add at least one network condition'));
    if (!players.length) return setError(t('Elige al menos un reproductor', 'Choose at least one player'));
    const inParallel = workerMode === 'pool' && parallel;
    const workers = workerMode === 'pool' && !inParallel ? Object.fromEntries(players.map((p) => [p, workerOf[p] ?? ''])) : null;
    if (workers && Object.values(workers).some((w) => !w)) return setError(t('Navegadores independientes: elige el trabajador de cada reproductor', 'Independent browsers: choose the worker for each player'));
    if (workers && sharedTogether) return setError(t('Con «Todos a la vez», cada reproductor necesita su propio trabajador: elige otros, o haz las pruebas de uno en uno', 'With “All at once”, each player needs its own worker: choose others, or run the players one at a time'));
    if (inParallel && !group.length) return setError(t('Pruebas en paralelo: elige al menos un trabajador', 'Parallel runs: choose at least one worker'));
    if (inParallel && together && group.length < players.length) return setError(t('Con «Todos a la vez» hacen falta al menos tantos trabajadores como reproductores', 'With “All at once” at least as many workers as players are needed'));
    const plan: CampaignPlan = {
      name: name.trim() || `Campaña ${new Date().toLocaleString()}`,
      description: description.trim(),
      streams,
      networks,
      targets,
      players: PLAYER_IDS.filter((p) => players.includes(p)),
      player_mode: playerMode,
      workers,
      ...(inParallel ? { worker_pool: group, parallel: true } : {}),
      quality,
      player_options: options,
      repetitions,
      warmup_s: warmup,
      measure_s: measure,
      control_every: controlEvery,
      max_attempts: maxAttempts,
      content,
      stream_settle_s: settle,
      seed: seed.trim() === '' ? null : Number(seed),
    };
    setSaving(true);
    try {
      const res = await fetch(editId ? `/api/campaigns/${editId}` : '/api/campaigns', { method: editId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan) });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = body?.detail;
        setError(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: any) => d.msg).join('; ') : t(`Rechazada (${res.status})`, `Rejected (${res.status})`));
        return;
      }
      setError(null);
      onCreated(body.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-5 text-xs">
      {initial && (
        <p className="text-indigo-300 font-medium">
          {editId
            ? t(`Editando «${initial.name}», que aún no ha empezado`, `Editing “${initial.name}”, which has not started yet`)
            : t(`Copia de «${initial.name}»: se creará como una campaña nueva`, `Copy of “${initial.name}”: it will be created as a new campaign`)}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 flex-1 min-w-[16rem]">
          <span className={label}>{t('Nombre', 'Name')}</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('p. ej. Barrido de RTT con una calidad', 'e.g. RTT sweep with one rendition')} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={label}>{t('Descripción (opcional; se puede cambiar después, en cualquier estado)', 'Description (optional; it can be changed later, in any state)')}</span>
        <textarea
          className={`${input} min-h-[5rem] resize-y`}
          maxLength={20000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('Qué se quiere ver, hipótesis, qué cambia respecto a otras campañas…', 'What to look at, hypotheses, what differs from other campaigns…')}
        />
      </label>

      {/* Protocolos y ajustes de sus reproductores, fijos en toda la campaña */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">{t('Protocolos y reproductores', 'Protocols and players')}</h3>
        <div className="grid gap-3 md:grid-cols-3">
          {PLAYER_IDS.map((p) => {
            const on = players.includes(p);
            return (
              <div key={p} className={`rounded-lg border p-3 space-y-2 ${on ? 'border-indigo-600/60 bg-slate-950/60' : 'border-slate-800 opacity-60'}`}>
                <label className="flex items-center gap-2 font-semibold text-slate-100 cursor-pointer">
                  <input type="checkbox" checked={on} onChange={(e) => setPlayers((all) => (e.target.checked ? [...all, p] : all.filter((q) => q !== p)))} />
                  {PLAYER_LABEL[p]}
                </label>
                {p === 'dash' && (
                  <div className="flex flex-wrap gap-3">
                    <label className="flex flex-col gap-1" title={t('Reglas de adaptación de dash.js en Auto. Por defecto: las de fábrica (caudal y BOLA, búfer insuficiente, historial de cambios, abandono de peticiones). L2A y LoL+: sus reglas para baja latencia, cada una en solitario. L2A (bugfix): experimento, L2A con su fallo de unidades de dash.js 5 corregido (README 6).', 'dash.js adaptation rules in Auto. Default: the stock ones (throughput and BOLA, insufficient buffer, switch history, request abandonment). L2A and LoL+: their low-latency rules, each on its own. L2A (bugfix): experiment, L2A with its dash.js 5 unit bug fixed (README 6).')}>
                      <span className={label}>ABR</span>
                      <select className={input} disabled={!on} value={options.dash_abr} onChange={(e) => setOption('dash_abr', e.target.value as DashAbr)}>
                        <option value="default">{t('Por defecto', 'Default')}</option>
                        <option value="l2a">L2A</option>
                        <option value="l2afix">{t('L2A (bugfix, experimento)', 'L2A (bugfix, experiment)')}</option>
                        <option value="lolp">LoL+</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 w-28" title={t('liveCatchup.maxDrift: si la latencia se desvía del objetivo más que esto, dash.js salta al directo en vez de corregir con la velocidad. 0 = no saltar nunca.', 'liveCatchup.maxDrift: if the latency drifts from the target by more than this, dash.js seeks to the live edge instead of correcting with the playback rate. 0 = never seek.')}>
                      <span className={label}>{t('Salto al directo (s)', 'Seek to live (s)')}</span>
                      <input className={input} disabled={!on} type="number" min={0} max={10} step={0.5} value={options.dash_max_drift_s} onChange={(e) => setOption('dash_max_drift_s', Number(e.target.value))} />
                    </label>
                    <label className="flex flex-col gap-1 w-28" title={t('liveCatchup.playbackBufferMin (LoL+): por debajo de este búfer dash.js frena para rellenarlo; hace de suelo de la latencia. 0 = no frenar nunca; 0,5 s es el de fábrica.', 'liveCatchup.playbackBufferMin (LoL+): below this buffer dash.js slows down to refill it; it acts as a latency floor. 0 = never slow down; 0.5 s is the stock value.')}>
                      <span className={label}>{t('Búfer mínimo (s)', 'Minimum buffer (s)')}</span>
                      <input className={input} disabled={!on} type="number" min={0} max={2} step={0.05} value={options.dash_playback_buffer_min_s} onChange={(e) => setOption('dash_playback_buffer_min_s', Number(e.target.value))} />
                    </label>
                    {dashExperiment && <p className="text-amber-300 w-full">{t('No es dash.js tal como viene: L2A con su fallo de unidades corregido, un experimento declarado (README 6).', 'Not stock dash.js: L2A with its unit bug fixed, a declared experiment (README 6).')}</p>}
                  </div>
                )}
                {p === 'moq' && (
                  <>
                    <div className="flex flex-wrap gap-3">
                      <label className="flex flex-col gap-1" title={t('Librería: decide @moq/watch (lo que se mide). Sondeo: el controlador propio con sondeo por prioridad de README 6.3, un experimento. Sondeo v2: su versión corregida (atraso acotado y subida si la siguiente llega a su ritmo).', 'Library: @moq/watch decides (what is measured). Probe: the custom controller with priority probing from README 6.3, an experiment. Probe v2: its corrected version (bounded lag, and switching up if the next rendition arrives at its rate).')}>
                        <span className={label}>{t('Adaptación', 'Adaptation')}</span>
                        <select className={input} disabled={!on} value={options.moq_abr} onChange={(e) => setOption('moq_abr', e.target.value as MoqAbr)}>
                          <option value="watch">{t('Librería', 'Library')}</option>
                          <option value="probe">{t('Sondeo (experimento)', 'Probing (experiment)')}</option>
                          <option value="probe2">{t('Sondeo v2 (experimento)', 'Probing v2 (experiment)')}</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1" title={t('Qué hacer al bajar de calidad (opción switching del parche de web/patches, README 6.1). Sin corte: el original de @moq/watch. Cancelar y Prioridad son el experimento. Sin el parche no tiene efecto.', 'What to do when switching down (switching option of the patch in web/patches, README 6.1). Seamless: the original @moq/watch behaviour. Cancel and Priority are the experiment. Without the patch it has no effect.')}>
                        <span className={label}>{t('Cambio', 'Switching')}</span>
                        <select className={input} disabled={!on} value={options.moq_switching} onChange={(e) => setOption('moq_switching', e.target.value as MoqSwitching)}>
                          <option value="seamless">{t('Sin corte', 'Seamless')}</option>
                          <option value="cancel">{t('Cancelar (experimento)', 'Cancel (experiment)')}</option>
                          <option value="priority">{t('Prioridad (experimento)', 'Priority (experiment)')}</option>
                        </select>
                      </label>
                    </div>
                    {moqExperiment && <p className="text-amber-300">{t('No es el comportamiento de @moq/watch: la campaña es un experimento declarado (README 6.1 y 6.3).', 'Not the @moq/watch behaviour: the campaign is a declared experiment (README 6.1 and 6.3).')}</p>}
                  </>
                )}
                {p === 'rtc' && (
                  <p className="text-slate-500">
                    {rtcServer === 'mediasoup'
                      ? t('Sin ajustes: mediasoup elige la capa de cada espectador, con la escalera de la emisión.', 'No settings: mediasoup chooses each viewer\'s layer, with the stream ladder.')
                      : t('Sin ajustes: una calidad, sin adaptación (MediaMTX).', 'No settings: one rendition, no adaptation (MediaMTX).')}{' '}
                    {t('La latencia objetivo va a jitterBufferTarget. El servidor es de todo el banco (RTC_SERVER), no de la campaña.', 'The target latency goes to jitterBufferTarget. The server belongs to the whole testbed (RTC_SERVER), not to the campaign.')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1" title={t('De uno en uno mide cuánto se estorban los reproductores en el navegador', 'One at a time measures how much the players interfere with each other in the browser')}>
            <span className={label}>{t('En cada prueba', 'In each run')}</span>
            <select className={input} value={playerMode} onChange={(e) => setPlayerMode(e.target.value as 'together' | 'each')}>
              <option value="together">{t('Todos a la vez', 'All at once')}</option>
              <option value="each">{t('De uno en uno', 'One at a time')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>{t('Calidad', 'Rendition')}</span>
            <select className={input} value={quality ?? ''} onChange={(e) => setQuality(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">{t('Auto (adaptación de cada reproductor)', 'Auto (each player\'s adaptation)')}</option>
              {[...new Set(streams.flatMap((s) => s.renditions.map((r) => r.height)))].map((h) => (
                <option key={h} value={h}>
                  {t(`Fija en ${h}p`, `Fixed at ${h}p`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="space-y-2">
          <label className="flex flex-col gap-1 w-fit" title={t('Una pestaña: un solo navegador monta todos los reproductores (la casilla «Esta pestaña es el trabajador» o el script sin --name). Navegadores independientes: trabajadores que se anuncian por su nombre (scripts/campaign-worker.mjs --name) y reproducen un solo protocolo a la vez, a toda su ventana (la calidad más alta de la emisión). Con «Todos a la vez», uno distinto por reproductor; «De uno en uno», varios reproductores pueden compartir trabajador y sus pruebas se hacen una tras otra en él.', 'One tab: a single browser mounts all the players (the “This tab is the worker” checkbox or the script without --name). Independent browsers: workers that announce themselves by name (scripts/campaign-worker.mjs --name) and play a single protocol at a time, filling their window (the top rendition of the stream). With “All at once”, a different one per player; with “One at a time”, several players can share a worker and their runs are done one after another on it.')}>
            <span className={label}>{t('Trabajador', 'Worker')}</span>
            <select className={input} value={workerMode} onChange={(e) => setWorkerMode(e.target.value as 'tab' | 'pool')}>
              <option value="tab">{t('Una pestaña (todos los reproductores en el mismo navegador)', 'One tab (all players in the same browser)')}</option>
              <option value="pool">{t('Navegadores independientes (un reproductor en cada uno)', 'Independent browsers (one player in each)')}</option>
            </select>
          </label>
          {workerMode === 'pool' && (
            <label
              className="flex items-center gap-2 text-slate-300 w-fit"
              title={t('Cada prueba toma un trabajador libre cualquiera del grupo, y se ejecutan a la vez las pruebas pendientes de la misma emisión, de cualquier red, objetivo o protocolo, mientras haya trabajadores libres. Cada trabajador tiene en el router su propia cola con la red de su prueba, distinguido por su IP: dos trabajadores con la misma IP (misma máquina o detrás del mismo NAT) no miden a la vez. Acaba antes, pero un mismo protocolo puede medirse en máquinas distintas, y las pruebas medidas a la vez comparten servidor (relay, SFU, publicador y CPU): cada una anota en qué trabajador se midió, con qué IP y con qué otras (concurrent).', 'Each run takes any free worker from the group, and the pending runs of the same stream, of any network, target or protocol, are executed at the same time while there are free workers. Each worker has its own queue at the router with the network of its run, identified by its IP: two workers with the same IP (same machine or behind the same NAT) do not measure at the same time. It finishes sooner, but the same protocol may be measured on different machines, and runs measured at the same time share the server (relay, SFU, publisher and CPU): each one records which worker measured it, with which IP and alongside which others (concurrent).')}
            >
              <input type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} />
              {t('Pruebas en paralelo con los trabajadores libres (cada uno con su red)', 'Parallel runs on the free workers (each with its own network)')}
            </label>
          )}
          {workerMode === 'pool' && parallel && (
            <div className="flex flex-wrap items-center gap-3">
              <span className={label}>{t('Trabajadores del grupo', 'Workers in the group')}</span>
              {[...new Set([...pool.map((w) => w.name), ...group])].sort().map((name) => {
                const w = pool.find((x) => x.name === name);
                return (
                  <label key={name} className="flex items-center gap-1.5 text-slate-300">
                    <input
                      type="checkbox"
                      checked={group.includes(name)}
                      onChange={(e) => setGroupPicked(e.target.checked ? [...group, name] : group.filter((n) => n !== name))}
                    />
                    <span className="font-mono">{name}</span>
                    <span className="text-slate-500">
                      {w ? `${w.browser === 'kiosk' ? t('quiosco', 'kiosk') : 'headless'}${w.connected && w.info.ip ? `, ${String(w.info.ip)}` : ''}${!w.connected ? t(', sin conexión', ', not connected') : w.busy ? t(`, en uso: ${w.busy}`, `, in use: ${w.busy}`) : ''}` : t('sin conexión', 'not connected')}
                    </span>
                  </label>
                );
              })}
              <button
                type="button"
                className="px-2 py-1.5 rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500"
                onClick={() => setManaging(true)}
              >
                {t('Gestionar trabajadores', 'Manage workers')}
              </button>
              {!pool.length && <p className="text-amber-300">{t('Ningún trabajador independiente se ha anunciado: lánzalos con scripts/campaign-worker.mjs --name.', 'No independent worker has announced itself: launch them with scripts/campaign-worker.mjs --name.')}</p>}
            </div>
          )}
          {workerMode === 'pool' && !parallel && (
            <div className="flex flex-wrap items-end gap-3">
              {PLAYER_IDS.filter((p) => players.includes(p)).map((p) => {
                const chosen = workerOf[p];
                const others = PLAYER_IDS.filter((q) => q !== p && players.includes(q) && workerOf[q] && workerOf[q] === chosen);
                return (
                  <label key={p} className="flex flex-col gap-1">
                    <span className={label}>{PLAYER_LABEL[p]}</span>
                    <select className={input} value={chosen ?? ''} onChange={(e) => setWorkerOf((all) => ({ ...all, [p]: e.target.value || undefined }))}>
                      <option value="">{t('Elige un trabajador', 'Choose a worker')}</option>
                      {/* El elegido aparece aunque ya no se anuncie, para no perderlo al editar */}
                      {chosen && !pool.some((w) => w.name === chosen) && <option value={chosen}>{chosen} {t('(sin conexión)', '(not connected)')}</option>}
                      {pool.map((w) => (
                        <option key={w.name} value={w.name}>
                          {w.name}
                          {' · '}
                          {w.browser === 'kiosk' ? t('quiosco', 'kiosk') : 'headless'}
                          {!w.connected ? t(' (sin conexión)', ' (not connected)') : w.busy ? t(` (en uso: ${w.busy})`, ` (in use: ${w.busy})`) : ''}
                        </option>
                      ))}
                    </select>
                    {others.length > 0 &&
                      (together ? (
                        <span className="text-rose-300">
                          {t(
                            `También lo tiene ${others.map((q) => PLAYER_LABEL[q]).join(', ')}: a la vez, uno por reproductor`,
                            `Also assigned to ${others.map((q) => PLAYER_LABEL[q]).join(', ')}: all at once needs one per player`,
                          )}
                        </span>
                      ) : (
                        <span className="text-slate-500">
                          {t(
                            `Compartido con ${others.map((q) => PLAYER_LABEL[q]).join(', ')}: una prueba tras otra`,
                            `Shared with ${others.map((q) => PLAYER_LABEL[q]).join(', ')}: one run after another`,
                          )}
                        </span>
                      ))}
                  </label>
                );
              })}
              <button
                type="button"
                className="px-2 py-1.5 rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500"
                onClick={() => setManaging(true)}
                title={t('Estado de cada trabajador, lo que está midiendo, su modo de Chrome (headless o ventana en quiosco) y borrar los que ya no existen. Cada campaña fija el modo de cada trabajador al empezar.', 'Status of each worker, what it is measuring, its Chrome mode (headless or kiosk window) and deleting those that no longer exist. Each campaign sets the mode of each worker when it starts.')}
              >
                {t('Gestionar trabajadores', 'Manage workers')}
              </button>
              {!pool.length && <p className="text-amber-300">{t('Ningún trabajador independiente se ha anunciado: lánzalos con scripts/campaign-worker.mjs --name.', 'No independent worker has announced itself: launch them with scripts/campaign-worker.mjs --name.')}</p>}
            </div>
          )}
          {managing && <SettingsModal initial="workers" onClose={() => setManaging(false)} />}
        </div>
      </section>

      {/* Emisiones */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">{t('Emisión', 'Stream')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className={label}>{t('Contenido', 'Content')}</span>
            <select className={input} value={content} onChange={(e) => setContent(e.target.value as 'continuous' | 'restart')}>
              <option value="continuous">{t('Continuo: cada prueba sigue donde acabó la anterior', 'Continuous: each run continues where the previous one ended')}</option>
              <option value="restart">{t('El mismo en cada prueba: la fuente se reinicia antes de cada una', 'The same in every run: the source restarts before each one')}</option>
            </select>
          </label>
        </div>
        <p className="text-slate-500">
          {content === 'restart'
            ? t(
                `Cada prueba ve el vídeo desde el principio, con el margen tras reiniciar (${settle} s) más en cada una. El instante exacto en que empieza a medir varía unos segundos con lo que tarde el montaje. Con la cámara no hay contenido que repetir y se emite de continuo.`,
                `Each run sees the video from the beginning, with the post-restart margin (${settle} s) added to each one. The exact moment it starts measuring varies by a few seconds with how long mounting takes. With the camera there is no content to repeat and it streams continuously.`,
              )
            : t('Cada emisión es un bloque: la fuente solo se reinicia al pasar de una a otra, y cada prueba ve el tramo del bucle que le toque.', 'Each stream is a block: the source only restarts when moving from one to the next, and each run sees whichever part of the loop it gets.')}
        </p>
        {streams.map((s, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className={label}>{t('Fuente', 'Source')}</span>
              <select
                className={input}
                value={s.source}
                onChange={(e) => {
                  // Entre vídeos del bucle, el GOP conserva su duración en segundos; con la cámara la cadencia no se sabe aquí
                  const next = e.target.value as StreamConfig['source'];
                  const gop = isLoopVideo(s.source) && isLoopVideo(next) ? gopAt(s.gop_size, LOOP_VIDEOS[s.source].fps, LOOP_VIDEOS[next].fps) : s.gop_size;
                  setStream(i, { source: next, gop_size: gop });
                }}
              >
                <option value="file">{t('Big Buck Bunny en bucle', 'Big Buck Bunny in a loop')}</option>
                <option value="tos">{t('Tears of Steel en bucle (24 fps)', 'Tears of Steel in a loop (24 fps)')}</option>
                <option value="camera">{t('Cámara RTSP', 'RTSP camera')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 min-w-[14rem]">
              <span className={label}>{t('Escalera (altura@kbps)', 'Ladder (height@kbps)')}</span>
              <input className={`${input} ${ladderOk[i] ? '' : 'border-rose-500'}`} value={ladders[i]} onChange={(e) => setLadder(i, e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 w-20">
              <span className={label}>GOP (frames)</span>
              <input className={input} type="number" min={1} value={s.gop_size} onChange={(e) => setStream(i, { gop_size: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-1 w-20">
              <span className={label}>{t('Segmento (s)', 'Segment (s)')}</span>
              <input className={input} type="number" step={0.5} min={0.25} value={s.seg_duration} onChange={(e) => setStream(i, { seg_duration: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-1" title={t('Fragmento CMAF de LL-DASH. 1 frame es frag_duration = 0 en la API y en el CSV (-frag_type every_frame)', 'LL-DASH CMAF fragment. 1 frame is frag_duration = 0 in the API and the CSV (-frag_type every_frame)')}>
              <span className={label}>{t('Fragmento CMAF', 'CMAF fragment')}</span>
              <select className={input} value={s.frag_duration} onChange={(e) => setStream(i, { frag_duration: Number(e.target.value) })}>
                {/* Las mismas opciones que el panel de control; una duración distinta (de la configuración en curso) también se conserva */}
                {[...new Set([0, 0.1, 0.2, 0.5, 1, s.frag_duration])].map((f) => (
                  <option key={f} value={f}>
                    {f === 0 ? `1 frame (${s.source === 'camera' ? t('el de la cámara', "the camera's") : s.source === 'tos' ? t('41,7 ms a 24 fps', '41.7 ms at 24 fps') : t('16,7 ms a 60 fps', '16.7 ms at 60 fps')})` : `${Math.round(f * 1000)} ms`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-1">
              <input type="checkbox" checked={s.rtc_audio} onChange={(e) => setStream(i, { rtc_audio: e.target.checked })} />
              <span className="text-slate-300">{t('Audio en WebRTC', 'Audio in WebRTC')}</span>
            </label>
            <label className="flex items-center gap-1.5 pb-1" title={t('Pacer en la ingesta de mediasoup: el relay reparte el RTP de cada calidad a 2,5 veces su bitrate (README, 3.4c). Con MediaMTX no hace nada', 'Pacer in the mediasoup ingest: the relay sends the RTP of each rendition at 2.5 times its bitrate (README, 3.4c). With MediaMTX it does nothing')}>
              <input type="checkbox" checked={Boolean(s.rtc_pacing)} onChange={(e) => setStream(i, { rtc_pacing: e.target.checked })} />
              <span className="text-slate-300">{t('Pacer en WebRTC', 'Pacer in WebRTC')}</span>
            </label>
            {streams.length > 1 && (
              <button
                className="text-slate-500 hover:text-rose-400 pb-1"
                title={t('Quitar esta emisión', 'Remove this stream')}
                onClick={() => {
                  setStreams((all) => all.filter((_, j) => j !== i));
                  setLadders((all) => all.filter((_, j) => j !== i));
                }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
        <button
          className="flex items-center gap-1 text-indigo-300 hover:text-indigo-200"
          onClick={() => {
            setStreams((all) => [...all, { ...all[all.length - 1] }]);
            setLadders((all) => [...all, all[all.length - 1]]);
          }}
        >
          <Plus className="w-3.5 h-3.5" /> {t('Otra emisión', 'Another stream')}
        </button>
      </section>

      {/* Condiciones de red */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">{t('Condiciones de red', 'Network conditions')}</h3>
        <div className="flex flex-wrap items-end gap-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
          <label className="flex flex-col gap-1">
            <span className={label}>{t('Barrido de', 'Sweep of')}</span>
            <select
              className={input}
              value={sweepParam}
              onChange={(e) => {
                const p = e.target.value as SweepParam;
                setSweepParam(p);
                setSweepValues(SWEEPS[p].example);
              }}
            >
              {(Object.keys(SWEEPS) as SweepParam[]).map((p) => (
                <option key={p} value={p}>
                  {SWEEPS[p].label} ({SWEEPS[p].unit})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 min-w-[12rem]">
            <span className={label}>{t('Valores', 'Values')} ({SWEEPS[sweepParam].unit})</span>
            <input className={input} value={sweepValues} onChange={(e) => setSweepValues(e.target.value)} />
          </label>
          {sweepParam !== 'rtt' && (
            <label className="flex flex-col gap-1 w-24" title={t('RTT común a todas las condiciones del barrido, repartido entre los dos sentidos', 'RTT common to all conditions of the sweep, split between both directions')}>
              <span className={label}>{t('con RTT (ms)', 'with RTT (ms)')}</span>
              <input className={input} type="number" min={0} value={sweepBaseRtt} onChange={(e) => setSweepBaseRtt(Number(e.target.value))} />
            </label>
          )}
          {sweepParam === 'rate' && (
            <label className="flex flex-col gap-1 w-24" title={t('Búfer del cuello de botella', 'Bottleneck buffer')}>
              <span className={label}>{t('Cola (ms)', 'Queue (ms)')}</span>
              <input className={input} type="number" min={10} value={sweepQueue} onChange={(e) => setSweepQueue(Number(e.target.value))} />
            </label>
          )}
          <button
            className="px-3 py-1 rounded bg-indigo-700 hover:bg-indigo-600 text-white"
            onClick={() => setNetworks((all) => [...all, ...sweep(sweepParam, numbers(sweepValues), sweepBaseRtt, sweepQueue)])}
          >
            {t('Añadir barrido', 'Add sweep')}
          </button>
          <span className="text-slate-500">{t('o un perfil:', 'or a profile:')}</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
              onClick={() => setNetworks((all) => [...all, { label: p.label, profile: JSON.parse(JSON.stringify(p.profile)) }])}
            >
              {p.label}
            </button>
          ))}
        </div>

        {networks.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-[11px] text-slate-400">
                <tr>
                  <th rowSpan={2} className="py-1 pr-2 font-medium align-bottom">{t('Nombre', 'Name')}</th>
                  {(['down', 'up'] as const).map((d) => (
                    <th key={d} colSpan={LINK_COLUMNS.length} className={`py-1 px-2 font-semibold text-slate-300 text-center border-b border-slate-700 ${d === 'up' ? 'border-l' : ''}`}>
                      {DIRECTION_LABEL[d]}
                    </th>
                  ))}
                  <th rowSpan={2} />
                </tr>
                <tr>
                  {(['down', 'up'] as const).map((d) =>
                    LINK_COLUMNS.map((c, j) => (
                      <th
                        key={`${d}-${c.key}`}
                        title={c.hint}
                        className={`pt-1 pb-1.5 font-medium whitespace-nowrap ${d === 'up' && j === 0 ? 'border-l border-slate-700 pl-2' : 'pl-0'} pr-1`}
                      >
                        {c.label} <span className="text-slate-500 font-normal">({c.unit})</span>
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {networks.map((n, i) => (
                  <tr key={i} className="border-t border-slate-800/60">
                    <td className="py-1 pr-2">
                      <input
                        className={`${input} w-48`}
                        value={n.label}
                        onChange={(e) => setNetworks((all) => all.map((m, j) => (j === i ? { ...m, label: e.target.value } : m)))}
                      />
                    </td>
                    {(['down', 'up'] as const).map((d) =>
                      LINK_COLUMNS.map(({ key: k }, j) => (
                        <td key={`${d}-${k}`} className={`py-1 pr-1 ${d === 'up' && j === 0 ? 'border-l border-slate-700 pl-2' : ''}`}>
                          <input
                            className={`${input} w-24`}
                            type="number"
                            min={0}
                            step={k === 'loss_pct' ? 0.1 : 1}
                            placeholder={k === 'rate_kbit' ? '∞' : ''}
                            value={n.profile[d][k] ?? ''}
                            onChange={(e) => setLink(i, d, k, e.target.value)}
                          />
                        </td>
                      )),
                    )}
                    <td>
                      <button className="text-slate-500 hover:text-rose-400" title={t('Quitar', 'Remove')} onClick={() => setNetworks((all) => all.filter((_, j) => j !== i))}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-slate-500 mt-1">
              {networks.map((n) => `${n.label}: ↓ ${describe(n.profile.down)} / ↑ ${describe(n.profile.up)}`).join(' · ')}
            </p>
          </div>
        )}
        <p className="text-slate-500">{t('Las pruebas de control, sin restricción, se añaden solas (abajo). El jitter de netem desordena paquetes y castiga casi solo a QUIC (README, sección 5).', 'Unrestricted control runs are added automatically (below). netem jitter reorders packets and penalises almost only QUIC (README, section 5).')}</p>
      </section>

      {/* Latencias objetivo */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">{t('Latencias objetivo', 'Target latencies')}</h3>
        <input
          className={`${input} w-full max-w-xl ${targets ? '' : 'border-rose-500'}`}
          value={targetsText}
          onChange={(e) => {
            setTargetsText(e.target.value);
            setKeptTargets(null);
          }}
        />
        {keptTargets && (
          <p className="text-amber-300">
            {t('Esta campaña tiene objetivos distintos por rama', 'This campaign has different targets per branch')} ({keptTargets.map((tg) => `${tg.label}: DASH ${tg.dash_ms ?? 'auto'}, MoQ ${tg.moq_ms ?? 'auto'}, WebRTC ${tg.rtc_ms ?? 'auto'}`).join(' · ')}).{' '}
            {t('Se conservan; si editas el texto, se sustituyen por el mismo valor en los tres.', 'They are kept; if you edit the text, they are replaced by the same value in all three.')}
          </p>
        )}
        {lang === 'en' ? (
          <p className="text-slate-500">
            In ms, separated by commas; <span className="font-mono">auto</span> is each player's stock value. Each value goes to each player's control as its implementation understands it, which does not mean the same thing: dash.js <span className="font-mono">liveDelay</span> (end to end), @moq/watch <span className="font-mono">delay</span> (buffer, plus the catalog jitter) and WebRTC <span className="font-mono">jitterBufferTarget</span> (buffer only). The first one is also used by the control runs.
          </p>
        ) : (
          <p className="text-slate-500">
            En ms, separadas por comas; <span className="font-mono">auto</span> es la de fábrica de cada reproductor. Cada valor va al mando de cada reproductor tal como lo entiende su implementación, que no significa lo mismo: <span className="font-mono">liveDelay</span> de dash.js (de extremo a extremo), <span className="font-mono">delay</span> de @moq/watch (búfer, más el jitter del catálogo) y <span className="font-mono">jitterBufferTarget</span> de WebRTC (solo el búfer). El primero es también el de las pruebas de control.
          </p>
        )}
      </section>

      {/* Diseño */}
      <section className="space-y-2">
        <h3 className="font-semibold text-slate-200">{t('Diseño', 'Design')}</h3>
        <div className="flex flex-wrap items-end gap-4">
          {(
            [
              [t('Repeticiones', 'Repetitions'), repetitions, setRepetitions, 1],
              [t('Calentamiento (s)', 'Warm-up (s)'), warmup, setWarmup, 5],
              [t('Medida (s)', 'Measurement (s)'), measure, setMeasure, 10],
              [t('Control cada (pruebas, 0 = no)', 'Control every (runs, 0 = none)'), controlEvery, setControlEvery, 0],
              [t('Intentos por prueba', 'Attempts per run'), maxAttempts, setMaxAttempts, 1],
              [t('Margen tras reiniciar la emisión (s)', 'Margin after restarting the stream (s)'), settle, setSettle, 0],
            ] as [string, number, (n: number) => void, number][]
          ).map(([text, value, set, min]) => (
            <label key={text} className="flex flex-col gap-1 w-28">
              <span className={label}>{text}</span>
              <input className={input} type="number" min={min} value={value} onChange={(e) => set(Number(e.target.value))} />
            </label>
          ))}
          <label className="flex flex-col gap-1 w-28" title={t('Semilla del sorteo; vacía, la elige el servidor y queda guardada', 'Seed of the randomisation; if empty, the server picks it and it is saved')}>
            <span className={label}>{t('Semilla', 'Seed')}</span>
            <input className={input} value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))} placeholder={t('al azar', 'random')} />
          </label>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-slate-800">
        <span className="text-slate-300">
          {tests} {t('pruebas', 'runs')}{controls ? t(` + ${controls} de control`, ` + ${controls} control`) : ''} · {t('unas', 'about')} <span className="font-semibold text-white">{formatDuration(etaS)}</span>
          {perBatch > 1 ? t(` (${perBatch} a la vez, con ${group.length} trabajadores)`, ` (${perBatch} at a time, with ${group.length} workers)`) : ''}
        </span>
        <button disabled={saving} className="px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-medium disabled:opacity-50" onClick={create}>
          {editId ? t('Guardar cambios', 'Save changes') : t('Crear campaña', 'Create campaign')}
        </button>
        <span className="text-slate-500">
          {editId
            ? t('Las pruebas se vuelven a sortear con el plan nuevo.', 'The runs are randomised again with the new plan.')
            : t('Se crea sin arrancar: revisa las pruebas sorteadas y arráncala desde el monitor.', 'It is created without starting: review the randomised runs and start it from the monitor.')}
          {initial && !editId && t(' La semilla se deja vacía para un sorteo nuevo; escribe la de la original para repetir el mismo orden.', ' The seed is left empty for a new randomisation; enter the original one to repeat the same order.')}
        </span>
        {error && <span className="text-rose-300 w-full">{error}</span>}
      </div>
    </div>
  );
};
