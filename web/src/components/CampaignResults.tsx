import React, { useMemo, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  type ChartDataset,
  type ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import type { Campaign, CampaignRun, PlayerId } from '../types';
import { CampaignSeries } from './CampaignSeries';
import { multiStream, streamDifferences, streamName, streamText } from '../lib/campaignStreams';
import { t } from '../lib/i18n';

ChartJS.register(CategoryScale, LinearScale, LogarithmicScale, PointElement, LineElement, Tooltip, Legend);

// Resultados de una campaña (README, 4.8): una gráfica por condición de red o por latencia objetivo, con un
// punto por prueba válida (cada repetición) y una línea por la mediana de las repeticiones. Solo pruebas
// terminadas y válidas; las de control van aparte, en orden de ejecución, para ver la deriva del sistema. Con varias
// emisiones, cada gráfica es de una sola (sus pruebas no se mezclan), salvo con las emisiones en el eje: entonces hay
// una gráfica por red y objetivo y cada emisión es un punto del eje.

// Los colores de cada protocolo en todo el dashboard (el color sigue a la entidad); la forma del punto es la
// segunda codificación, para no depender solo del color
const STYLE: Record<PlayerId, { label: string; color: string; point: 'circle' | 'triangle' | 'rect' }> = {
  dash: { label: 'LL-DASH', color: '#3b82f6', point: 'circle' },
  moq: { label: 'MoQ', color: '#10b981', point: 'triangle' },
  rtc: { label: 'WebRTC', color: '#f59e0b', point: 'rect' },
};

interface Metric {
  label: string;
  unit: string;
  get: (s: Record<string, number | null>) => number | null;
  latency?: boolean; // se compara con la latencia objetivo
  note?: string; // aclaración que se muestra con la métrica elegida
}

const METRICS: Record<string, Metric> = {
  g2g_p50: { label: 'Glass-to-glass p50', unit: 'ms', get: (s) => s.g2g_p50_ms, latency: true },
  g2g_p95: { label: 'Glass-to-glass p95', unit: 'ms', get: (s) => s.g2g_p95_ms, latency: true },
  stall: { label: t('Tiempo parado', 'Stall time'), unit: '%', get: (s) => (s.stall_ratio == null ? null : s.stall_ratio * 100) },
  coverage: { label: t('Segundos con latencia medida', 'Seconds with measured latency'), unit: '%', get: (s) => (s.coverage == null ? null : s.coverage * 100) },
  kbps: { label: t('Bitrate de vídeo recibido', 'Received video bitrate'), unit: 'kbit/s', get: (s) => s.kbps_mean },
  // Leído por el servidor en el router: cabeceras y retransmisiones incluidas (desde el 28-10-2026)
  ip_down: { label: t('Tráfico IP de bajada en el router', 'Downlink IP traffic at the router'), unit: 'kbit/s', get: (s) => s.ip_down_kbps },
  ip_up: { label: t('Tráfico IP de subida en el router', 'Uplink IP traffic at the router'), unit: 'kbit/s', get: (s) => s.ip_up_kbps },
  // Leídos por el servidor en el router (desde el 3-11-2026)
  drops_down: { label: t('Descartes en la cola de bajada', 'Drops in the downlink queue'), unit: t('paquetes', 'packets'), get: (s) => s.ip_down_dropped, note: t('Paquetes que descartó la cola de este protocolo en el router, de las lecturas del orquestador (desde el 3-11-2026). Junta el desbordamiento de la cola y la pérdida aleatoria del perfil de red: solo son desbordamiento en redes con límite de caudal y sin pérdida. La cola se mide en paquetes de 1500 bytes, así que su duración real es aproximada.', 'Packets dropped by this protocol\'s queue at the router, from the orchestrator\'s readings (since 3-11-2026). It combines queue overflow and the random loss of the network profile: they are only overflow in networks with a bandwidth limit and no loss. The queue is sized in 1500-byte packets, so its real duration is approximate.') },
  drop_pct_down: { label: t('Descartes en la cola de bajada, sobre lo que entró', 'Drops in the downlink queue, over what entered'), unit: '%', get: (s) => s.ip_down_drop_pct, note: t('Paquetes que descartó la cola de este protocolo en el router, sobre los que entraron en ella, de las lecturas del orquestador (desde el 3-11-2026). Desde el 18-11-2026, los que entraron según tc, ya troceados como los descartes; en las pruebas anteriores, según iptables, que cuenta cada superpaquete TCP como uno: en DASH esas salen entre 2 y 4 veces el real (ip_down_drop_base en runs.csv dice cuál). Junta el desbordamiento de la cola y la pérdida aleatoria del perfil de red: solo son desbordamiento en redes con límite de caudal y sin pérdida. La cola se mide en paquetes de 1500 bytes, así que su duración real es aproximada.', 'Packets dropped by this protocol\'s queue at the router, over those that entered it, from the orchestrator\'s readings (since 3-11-2026). Since 18-11-2026, those that entered according to tc, already segmented like the drops; in earlier runs, according to iptables, which counts each TCP super-packet as one: in DASH those come out 2 to 4 times the real value (ip_down_drop_base in runs.csv says which). It combines queue overflow and the random loss of the network profile: they are only overflow in networks with a bandwidth limit and no loss. The queue is sized in 1500-byte packets, so its real duration is approximate.') },
  // De la emisión, igual en los tres protocolos (desde el 30-10-2026)
  source_lag: { label: t('Retraso máximo de la fuente', 'Maximum source lag'), unit: 'ms', get: (s) => s.source_lag_max_ms, note: t('Es de la emisión, el mismo en los tres protocolos: cuánto llegó a ir FFmpeg por detrás del tiempo real durante la medida. Los reproductores lo ven como esa misma cantidad de latencia de menos.', 'It belongs to the stream, the same in all three protocols: how far FFmpeg fell behind real time during the measurement. The players see it as that same amount of latency less.') },
  source_late: { label: t('Segundos con la fuente retrasada (> 50 ms)', 'Seconds with the source lagging (> 50 ms)'), unit: '%', get: (s) => (s.source_late_share == null ? null : s.source_late_share * 100) },
  height: { label: t('Altura media reproducida', 'Mean played height'), unit: 'p', get: (s) => s.height_mean },
  // No es la misma magnitud en las tres ramas (README, tabla de métricas)
  buffer: {
    label: t('Búfer medio', 'Mean buffer'),
    unit: 'ms',
    get: (s) => (s.buffer_s_mean == null ? null : s.buffer_s_mean * 1000),
    note: t('No es la misma magnitud: en DASH, el vídeo descargado por delante del punto de reproducción; en MoQ y WebRTC, lo que espera de media cada frame en el reproductor (vacío si no sale ninguno, como en un parón).', 'Not the same quantity: in DASH, the video downloaded ahead of the playback position; in MoQ and WebRTC, how long each frame waits in the player on average (empty if none is output, as in a stall).'),
  },
  // Desde el 6-11-2026; antes no está en el resumen (la comparación de dos pruebas sí la saca de sus filas)
  ladder_top: {
    label: t('Tiempo en la calidad más alta de la emisión', 'Time in the top rendition of the stream'),
    unit: '%',
    get: (s) => (s.ladder_top_share == null ? null : s.ladder_top_share * 100),
    note: t('Fracción de los segundos medidos en la calidad más alta de la escalera (o en la fija de la campaña). Vacío en las pruebas anteriores al 6-11-2026.', 'Share of the measured seconds in the top rendition of the ladder (or in the campaign\'s fixed one). Empty in runs before 6-11-2026.'),
  },
  height_max: { label: t('Altura más alta reproducida', 'Maximum played height'), unit: 'p', get: (s) => s.height_max },
  switches: { label: t('Cambios de calidad', 'Quality switches'), unit: '', get: (s) => s.quality_switches },
  frametime: { label: t('Tiempo en pantalla p95 (mediana)', 'Frame display time p95 (median)'), unit: 'ms', get: (s) => s.frametime_p95_ms_median },
  startup: { label: t('Del montaje a la primera latencia', 'From mount to first latency'), unit: 's', get: (s) => s.first_g2g_s },
  skipped: { label: t('Contenido no reproducido', 'Content not played'), unit: '%', get: (s) => (s.content_skipped_share == null ? null : s.content_skipped_share * 100) },
  content: { label: t('Avance del contenido medio', 'Mean content progress rate'), unit: '×', get: (s) => s.content_speed_mean },
  // Solo DASH: las demás ramas no cambian la velocidad del vídeo
  rate: { label: t('Velocidad de reproducción media (DASH)', 'Mean playback rate (DASH)'), unit: '×', get: (s) => s.playback_rate_mean },
  slow: { label: t('Tiempo frenando, por debajo de 1× (DASH)', 'Time slowing down, below 1× (DASH)'), unit: '%', get: (s) => (s.playback_slow_share == null ? null : s.playback_slow_share * 100) },
  fast: { label: t('Tiempo acelerando, por encima de 1× (DASH)', 'Time speeding up, above 1× (DASH)'), unit: '%', get: (s) => (s.playback_fast_share == null ? null : s.playback_fast_share * 100) },
};

const median = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const GRID = '#334155';
const TICK = '#94a3b8';

// La prueba del punto bajo el puntero, si es el de una prueba (no el de la mediana ni el del objetivo)
const runAt = (chart: ChartJS, event: { native: Event | null }): string | null => {
  if (!event.native) return null;
  const hits = chart.getElementsAtEventForMode(event.native, 'nearest', { intersect: true }, true);
  for (const hit of hits) {
    const raw = chart.data.datasets[hit.datasetIndex].data[hit.index] as { run?: string } | undefined;
    if (raw?.run) return raw.run;
  }
  return null;
};

function chartOptions(metric: Metric, log: boolean, xTitle: string, onSelectRun?: (id: string) => void): ChartOptions<'line'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', intersect: false },
    // Pulsar el punto de una prueba la busca en la tabla de pruebas, para repetirla o verla
    onClick: (event, _elements, chart) => {
      const run = onSelectRun && runAt(chart, event);
      if (run) onSelectRun!(run);
    },
    onHover: (event, _elements, chart) => {
      chart.canvas.style.cursor = onSelectRun && runAt(chart, event) ? 'pointer' : 'default';
    },
    scales: {
      x: { type: 'category', grid: { color: GRID }, ticks: { color: TICK }, title: { display: true, text: xTitle, color: TICK } },
      y: {
        type: log ? 'logarithmic' : 'linear',
        min: log ? undefined : 0,
        grid: { color: GRID },
        ticks: { color: TICK },
        title: { display: true, text: metric.unit ? `${metric.label} (${metric.unit})` : metric.label, color: TICK },
      },
    },
    plugins: {
      legend: { labels: { color: '#cbd5e1', usePointStyle: true, filter: (item) => !String(item.text).startsWith('·') } },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const raw = ctx.raw as { y: number; rep?: number; run?: string };
            const value = `${raw.y.toFixed(metric.unit === 'ms' || metric.unit === 'kbit/s' ? 0 : metric.unit === '×' ? 3 : 1)}${metric.unit ? ` ${metric.unit}` : ''}`;
            const name = String(ctx.dataset.label).replace(/^· /, '');
            return raw.run ? `${name}, ${raw.run} (${t('rep.', 'rep.')} ${(raw.rep ?? 0) + 1}): ${value}` : `${name}: ${value}`;
          },
        },
      },
    },
  };
}

/** Datasets de una gráfica: por protocolo, la mediana (línea) y cada prueba (puntos sueltos). */
function datasets(
  runs: CampaignRun[],
  players: PlayerId[],
  xOf: (run: CampaignRun) => string,
  categories: string[],
  metric: Metric,
): ChartDataset<'line'>[] {
  const out: ChartDataset<'line'>[] = [];
  for (const p of players) {
    const points = runs
      .filter((r) => r.players.includes(p) && r.summary?.players[p])
      .map((r) => ({ x: xOf(r), y: metric.get(r.summary!.players[p]!), rep: r.rep, run: r.id }))
      .filter((pt): pt is { x: string; y: number; rep: number; run: string } => pt.y !== null && pt.y !== undefined);
    const st = STYLE[p];
    const medians = categories
      .map((c) => {
        const ys = points.filter((pt) => pt.x === c).map((pt) => pt.y);
        return ys.length ? { x: c, y: median(ys) } : null;
      })
      .filter(Boolean) as { x: string; y: number }[];
    out.push({
      label: st.label,
      data: medians as any,
      borderColor: st.color,
      backgroundColor: st.color,
      borderWidth: 2,
      pointStyle: st.point,
      pointRadius: 5,
      pointHoverRadius: 7,
    });
    out.push({
      label: `· ${st.label}`,
      data: points as any,
      showLine: false,
      borderColor: st.color,
      backgroundColor: `${st.color}55`,
      pointStyle: st.point,
      pointRadius: 3,
      pointHoverRadius: 6,
    });
  }
  return out;
}

const Panel: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
    <h4 className="text-xs font-medium text-slate-300 mb-2" title={hint}>
      {title}
    </h4>
    <div className="h-64">{children}</div>
  </div>
);

export const CampaignResults: React.FC<{
  campaign: Campaign;
  onSelectRun?: (id: string) => void;
  seriesFocus?: { id: string; n: number } | null;
}> = ({ campaign, onSelectRun, seriesFocus }) => {
  const plan = campaign.plan;
  const [metricKey, setMetricKey] = useState('g2g_p50');
  const [axisChoice, setXAxis] = useState<'network' | 'target' | 'stream'>('network');
  // El eje de emisiones solo existe con varias (una campaña duplicada puede tener una sola)
  const xAxis = axisChoice === 'stream' && !multiStream(plan) ? 'network' : axisChoice;
  const [log, setLog] = useState(false);
  const metric = METRICS[metricKey];

  const valid = useMemo(() => (campaign.runs ?? []).filter((r) => r.state === 'done' && r.summary), [campaign.runs]);
  const tests = valid.filter((r) => r.kind === 'test');
  const controls = valid.filter((r) => r.kind === 'control').sort((a, b) => (a.started_ms ?? 0) - (b.started_ms ?? 0));
  const players = plan.players;

  if (!valid.length) return <p className="text-slate-500">{t('Todavía no hay pruebas terminadas y válidas.', 'No finished, valid runs yet.')}</p>;

  // Una gráfica por valor del otro factor (con las emisiones en el eje, por red y objetivo); en el eje, las condiciones
  // de red, los objetivos o las emisiones en el orden del plan
  const networkLabels = plan.networks.map((n) => n.label);
  const targetLabels = plan.targets.map((t) => t.label);
  const streamLabels = plan.streams.map((_, i) => streamName(i));
  const categories = xAxis === 'network' ? networkLabels : xAxis === 'target' ? targetLabels : streamLabels;
  const streams = plan.streams.map((_, i) => i);
  // Facetas: emisión (st), objetivo (t) y red (n); null en lo que va en el eje
  type Facet = { st: number | null; t: number | null; n: number | null };
  const facets: Facet[] =
    xAxis === 'network'
      ? streams.flatMap((st) => plan.targets.map((_, t) => ({ st, t, n: null })))
      : xAxis === 'target'
        ? streams.flatMap((st) => plan.networks.map((_, n) => ({ st, t: null, n })))
        : plan.targets.flatMap((_, t) => plan.networks.map((_, n) => ({ st: null, t, n })));
  const streamPrefix = (st: number | null) => (st !== null && multiStream(plan) ? `${streamName(st)} · ` : '');
  const facetTitle = ({ st, t: ti, n }: Facet) =>
    streamPrefix(st) + [ti !== null && t(`Objetivo ${targetLabels[ti]}`, `Target ${targetLabels[ti]}`), n !== null && networkLabels[n]].filter(Boolean).join(' · ');
  const inFacet = (r: CampaignRun, { st, t, n }: Facet) => (st === null || r.stream === st) && (t === null || r.target === t) && (n === null || r.network === n);
  const xOf = (r: CampaignRun) => (xAxis === 'network' ? networkLabels[r.network!] : xAxis === 'target' ? targetLabels[r.target] : streamLabels[r.stream]);
  const options = chartOptions(metric, log, xAxis === 'network' ? t('Condición de red', 'Network condition') : xAxis === 'target' ? t('Latencia objetivo', 'Target latency') : t('Emisión', 'Stream'), onSelectRun);
  // Con las emisiones en el eje, qué tiene cada una (la etiqueta del eje solo lleva lo que cambia)
  const streamsHint = plan.streams.map((st, i) => `${streamName(i)}: ${streamText(st)}`).join('\n');

  // Línea del objetivo pedido, si es la misma en los tres reproductores y numérica (en auto no hay valor que pintar)
  const targetLine = (facetTarget: number | null): ChartDataset<'line'> | null => {
    if (!metric.latency) return null;
    const data = categories
      .map((c, i) => {
        const t = plan.targets[xAxis === 'target' ? i : facetTarget!];
        const same = t.dash_ms === t.moq_ms && t.moq_ms === t.rtc_ms;
        return same && t.dash_ms !== null ? { x: c, y: t.dash_ms } : null;
      })
      .filter(Boolean);
    if (!data.length) return null;
    // Un trazo horizontal en cada categoría: con un solo objetivo numérico no habría línea que ver
    return {
      label: t('Objetivo pedido', 'Requested target'),
      data: data as any,
      borderColor: '#94a3b8',
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointStyle: 'line',
      pointRadius: 10,
      pointBorderWidth: 2,
      backgroundColor: '#94a3b8',
    };
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">{t('Métrica', 'Metric')}</span>
          <select className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
            {Object.entries(METRICS).map(([k, m]) => (
              <option key={k} value={k}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">{t('En el eje horizontal', 'On the horizontal axis')}</span>
          <select className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" value={xAxis} onChange={(e) => setXAxis(e.target.value as 'network' | 'target' | 'stream')}>
            <option value="network">{t('Condición de red (una gráfica por objetivo)', 'Network condition (one chart per target)')}</option>
            <option value="target">{t('Latencia objetivo (una gráfica por condición de red)', 'Target latency (one chart per network condition)')}</option>
            {multiStream(plan) && <option value="stream">{t('Emisión (una gráfica por objetivo y red)', 'Stream (one chart per target and network)')}</option>}
          </select>
        </label>
        <label className="flex items-center gap-1.5 pb-1 text-slate-300">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />
          {t('Escala logarítmica', 'Logarithmic scale')}
        </label>
        <span className="text-slate-500 pb-1">
          {t(
            `Línea: mediana de las repeticiones; puntos: cada prueba válida (${tests.length} de prueba, ${controls.length} de control).`,
            `Line: median of the repetitions; points: each valid run (${tests.length} test, ${controls.length} control).`,
          )}
          {onSelectRun && t(' Pulsa un punto para ir a su prueba.', ' Click a point to go to its run.')}
          {metric.note && ` ${metric.label}: ${metric.note}`}
        </span>
      </div>

      {/* Con las emisiones en el eje, la clave: lo que cambia entre ellas (la descripción entera, en el título) */}
      {xAxis === 'stream' && (
        <ul className="text-slate-400" title={streamsHint}>
          {streamDifferences(plan).map((d, i) => (
            <li key={i}>
              <span className="text-slate-300">{streamName(i)}:</span> {d || t('igual que las demás', 'same as the others')}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {facets.map((facet) => {
          const runs = tests.filter((r) => inFacet(r, facet));
          if (!runs.length) return null;
          const ds = datasets(runs, players, xOf, categories, metric);
          const line = targetLine(facet.t);
          const { st } = facet;
          return (
            <Panel key={`${st}:${facet.t}:${facet.n}`} title={facetTitle(facet)} hint={st === null ? streamsHint : multiStream(plan) ? streamText(plan.streams[st]) : undefined}>
              <Line data={{ labels: categories, datasets: line ? [...ds, line] : ds }} options={options} />
            </Panel>
          );
        })}
        {/* Con las emisiones en el eje, las de control también, juntas: la misma red sin restricción en cada emisión */}
        {xAxis === 'stream' && controls.length > 0 && (
          <Panel key="control:streams" title={t('Pruebas de control (sin restricción), por emisión', 'Control runs (unrestricted), by stream')} hint={streamsHint}>
            <Line data={{ labels: categories, datasets: datasets(controls, players, xOf, categories, metric) }} options={options} />
          </Panel>
        )}
        {xAxis !== 'stream' && streams.map((st) => {
          const own = controls.filter((r) => r.stream === st);
          if (!own.length) return null;
          return (
            <Panel key={`control:${st}`} title={streamPrefix(st) + t('Pruebas de control (sin restricción), en orden de ejecución: deriva del sistema', 'Control runs (unrestricted), in execution order: system drift')} hint={multiStream(plan) ? streamText(plan.streams[st]) : undefined}>
              <Line
                data={{
                  labels: own.map((r) => r.id),
                  datasets: datasets(own, players, (r) => r.id, own.map((r) => r.id), metric),
                }}
                options={chartOptions(metric, log, t('Prueba de control', 'Control run'), onSelectRun)}
              />
            </Panel>
          );
        })}
      </div>

      <CampaignSeries campaign={campaign} runs={[...tests, ...controls]} focus={seriesFocus ?? null} />
    </div>
  );
};
