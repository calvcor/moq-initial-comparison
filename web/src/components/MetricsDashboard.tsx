import { gridCols } from '../lib/layout';
import React, { useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { Info } from 'lucide-react';
import { getClockSync } from '../lib/clock';
import type { PlayerMetrics, RtcServer, SampleRow } from '../types';
import type { FrameTime } from '../lib/glass';
import { lang, t } from '../lib/i18n';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

interface MetricsDashboardProps {
  dashMetrics: PlayerMetrics;
  moqMetrics: PlayerMetrics;
  rtcMetrics: PlayerMetrics;
  players: { dash: boolean; moq: boolean; rtc: boolean };
  rtcServer: RtcServer; // servidor de la rama WebRTC: cambia lo que significan sus campos
  rtcAudio: boolean; // la emisión lleva audio en WebRTC
  history: {
    labels: string[];
    dashLatency: (number | null)[];
    moqLatency: (number | null)[];
    dashBitrate: (number | null)[];
    moqBitrate: (number | null)[];
    rtcLatency: (number | null)[];
    rtcBitrate: (number | null)[];
    dashFrames: FrameTime[];
    moqFrames: FrameTime[];
    rtcFrames: FrameTime[];
    framesAt: number;
  };
  samples: SampleRow[];
  anomalies?: { master: number; dash: number; moq: number; rtc: number };
  availabilityDriftMs?: number | null;
  sourceLagMs?: number | null;
  pipelineRestarts?: { master: number; dash: number; moq: number; rtc: number };
  onExport: () => void;
  onReset: () => void;
}

const WARMUP_S = 10; // arranque y catch-up inicial, fuera de los estadísticos

const FRAME_TIME_HINT = lang === 'en' ? (
  <p>
    How long each frame stayed on screen over the last second: standard deviation and p95, from one frame being painted to the
    next. It comes in display refreshes (16.7 ms at 60 Hz), so it depends on the display and the browser as well as on the
    protocol. A frame the meter fails to read counts as one of double duration. Stalls of 150 ms or more are left out: they are
    counted in Freezes.
  </p>
) : (
  <p>
    Tiempo que cada frame estuvo en pantalla en el último segundo: desviación típica y p95, del pintado de uno al
    del siguiente. Va en refrescos de pantalla (16,7 ms a 60 Hz), así que depende de la pantalla y del navegador
    además del protocolo. Un frame que el medidor no llega a leer cuenta como uno de doble duración. Los parones
    de 150 ms o más no entran: se cuentan en Congelados.
  </p>
);

const fmt = (value: number | null, unit: string) => (value === null ? '--' : `${value} ${unit}`);

// Estadísticos de latencia glass-to-glass sobre las muestras del epoch actual
function summarize(values: (number | null)[]) {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (v.length < 2) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, mean: Math.round(mean), sd: Math.round(sd), p50: q(0.5), p95: q(0.95), min: v[0], max: v[v.length - 1] };
}

const Stat: React.FC<{ label: string; value: string; accent?: boolean; wide?: boolean; hint?: React.ReactNode }> = ({
  label,
  value,
  accent,
  wide,
  hint,
}) => (
  <div className={`group relative bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80 ${wide ? 'col-span-2' : ''} ${hint ? 'cursor-help' : ''}`}>
    <span className="text-xs text-slate-400 flex items-center justify-center gap-1 mb-0.5">
      {label}
      {hint && <Info className="w-3 h-3 text-slate-500" />}
    </span>
    <span className={`text-lg font-bold ${accent ? 'text-emerald-400' : 'text-slate-200'}`}>{value}</span>
    {hint && (
      <div className="pointer-events-none absolute z-10 left-1/2 -translate-x-1/2 top-full mt-1 w-72 hidden group-hover:block bg-slate-800 border border-slate-600 rounded-lg p-3 text-left text-[11px] leading-snug text-slate-200 shadow-xl space-y-1.5">
        {hint}
      </div>
    )}
  </div>
);

const VIDEO_HINT = lang === 'en' ? (
  <p>Only the video payload delivered by the player, 10 s mean. No audio, manifest or protocol headers.</p>
) : (
  <p>Solo la carga útil de vídeo que entrega el reproductor, media de 10 s. Sin audio, manifiesto ni cabeceras de protocolo.</p>
);

const LAYER_WARNING = lang === 'en' ? (
  <p className="text-amber-300">
    Each protocol is counted at a different layer: the comparison between them is only indicative. It is not the actual bandwidth on the network.
  </p>
) : (
  <p className="text-amber-300">
    Cada protocolo se cuenta en una capa distinta: la comparación entre ambos es orientativa. No es el ancho de banda real en la red.
  </p>
);

const DASH_NETWORK_HINT = lang === 'en' ? (
  <>
    <p>
      <b>What it measures:</b> transferred size of all HTTP requests to the DASH server (video, audio and manifest), including their HTTP response
      headers. 10 s mean.
    </p>
    <p>
      <b>Source:</b> the browser's Resource Timing API (<code>transferSize</code>). Updated when each request completes, that is, once per
      segment.
    </p>
    <p>
      <b>Excludes:</b> request headers, TCP/IP overhead and TCP retransmissions.
    </p>
    {LAYER_WARNING}
  </>
) : (
  <>
    <p>
      <b>Qué mide:</b> tamaño transferido de todas las peticiones HTTP al servidor DASH (vídeo, audio y manifiesto), con sus cabeceras HTTP de
      respuesta. Media de 10 s.
    </p>
    <p>
      <b>Fuente:</b> Resource Timing API del navegador (<code>transferSize</code>). Se actualiza al terminar cada petición, es decir, una vez por
      segmento.
    </p>
    <p>
      <b>No incluye:</b> cabeceras de las peticiones, sobrecarga TCP/IP ni retransmisiones TCP.
    </p>
    {LAYER_WARNING}
  </>
);

const MOQ_TRANSPORT_HINT = lang === 'en' ? (
  <>
    <p>
      <b>What it measures:</b> bytes received over the WebTransport connection in streams and datagrams (video, audio, catalog and MoQ signalling),
      duplicates included. 10 s mean.
    </p>
    <p>
      <b>Source:</b> <code>WebTransport.getStats()</code> (<code>bytesReceived</code>), sampled every 500 ms.
    </p>
    <p>
      <b>Excludes:</b> QUIC headers, UDP/IP, encryption and control packets (ACK).
    </p>
    {LAYER_WARNING}
  </>
) : (
  <>
    <p>
      <b>Qué mide:</b> bytes recibidos por la conexión WebTransport en streams y datagramas (vídeo, audio, catálogo y señalización MoQ), duplicados
      incluidos. Media de 10 s.
    </p>
    <p>
      <b>Fuente:</b> <code>WebTransport.getStats()</code> (<code>bytesReceived</code>), muestreado cada 500 ms.
    </p>
    <p>
      <b>No incluye:</b> cabeceras QUIC, UDP/IP, cifrado ni paquetes de control (ACK).
    </p>
    {LAYER_WARNING}
  </>
);

const MOQ_PAYLOAD_HINT = lang === 'en' ? (
  <>
    <p>
      <b>What it measures:</b> payload of the tracks the player downloads: video and, only when not muted, audio. 10 s mean.
    </p>
    <p>
      <b>Source:</b> <code>@moq/watch</code> counters, because this browser does not implement <code>WebTransport.getStats()</code>.
    </p>
    <p>
      <b>Excludes:</b> MoQ framing, catalog, QUIC headers, UDP/IP, encryption and retransmissions.
    </p>
    <p>When muted, MoQ does not download the audio; DASH always does. That explains part of the difference between them.</p>
    {LAYER_WARNING}
  </>
) : (
  <>
    <p>
      <b>Qué mide:</b> carga útil de las pistas que descarga el reproductor: vídeo y, solo si no está silenciado, audio. Media de 10 s.
    </p>
    <p>
      <b>Fuente:</b> contadores de <code>@moq/watch</code>, porque este navegador no implementa <code>WebTransport.getStats()</code>.
    </p>
    <p>
      <b>No incluye:</b> tramas MoQ, catálogo, cabeceras QUIC, UDP/IP, cifrado ni retransmisiones.
    </p>
    <p>Silenciado, MoQ no descarga el audio; DASH lo descarga siempre. Parte de la diferencia entre ambos es eso.</p>
    {LAYER_WARNING}
  </>
);

const rtcNetworkHint = (server: RtcServer, withAudio: boolean) => lang === 'en' ? (
  <>
    <p>
      <b>What it measures:</b> bytes received by the transport of the WebRTC connection (RTP with the {withAudio ? 'video and audio' : 'video'}, RTCP and retransmissions
      {server === 'mediasoup' ? ', plus the bursts mediasoup uses to probe whether more fits' : ''}). 10 s mean.
    </p>
    <p>
      <b>Source:</b> browser statistics (<code>RTCPeerConnection.getStats()</code>, transport, <code>bytesReceived</code>).
    </p>
    <p>
      <b>Excludes:</b> UDP/IP headers and ICE connectivity checks.{withAudio ? '' : ' This stream carries no audio in WebRTC.'}
    </p>
    {LAYER_WARNING}
  </>
) : (
  <>
    <p>
      <b>Qué mide:</b> bytes recibidos por el transporte de la conexión WebRTC (RTP con el {withAudio ? 'vídeo y el audio' : 'vídeo'}, RTCP y retransmisiones
      {server === 'mediasoup' ? ', y las ráfagas con las que mediasoup sondea si cabe más' : ''}). Media de 10 s.
    </p>
    <p>
      <b>Fuente:</b> estadísticas del navegador (<code>RTCPeerConnection.getStats()</code>, transporte, <code>bytesReceived</code>).
    </p>
    <p>
      <b>No incluye:</b> cabeceras UDP/IP ni las comprobaciones de conectividad ICE.{withAudio ? '' : ' Esta emisión no lleva audio en WebRTC.'}
    </p>
    {LAYER_WARNING}
  </>
);

const rtcReportedHint = (server: RtcServer) => lang === 'en' ? (
  <>
    <p>
      <b>Not available:</b> the WebRTC API reports no latency relative to the live edge, and the browser has nothing to compute it
      from. It receives RTP timestamps, which are relative (how far a frame is from the previous one), not the time at which each
      one was captured.
    </p>
    {server === 'mediasoup' ? (
      <p>
        The protocol provides two ways to know that time: a header extension with the capture time, which mediasoup supports but the FFmpeg that
        turns the stream into RTP does not send, and the sender's RTCP reports, whose clock is that FFmpeg's and not the capture time.
      </p>
    ) : (
      <p>
        The protocol provides two ways to know that time: a header extension with the capture time, which MediaMTX does not negotiate, and
        the sender's RTCP reports, which here would at most give the arrival time at MediaMTX, not the capture time.
      </p>
    )}
    <p>What is measured is the glass-to-glass latency and, as part of it, the jitter buffer.</p>
  </>
) : (
  <>
    <p>
      <b>No disponible:</b> la API de WebRTC no informa de ninguna latencia respecto al directo, y el navegador no tiene con qué
      calcularla. Recibe marcas de tiempo RTP, que son relativas (cuánto dista un frame del anterior), no la hora a la que se
      capturó cada uno.
    </p>
    {server === 'mediasoup' ? (
      <p>
        El protocolo prevé dos formas de saber esa hora: una extensión de cabecera con la hora de captura, que mediasoup admite pero el FFmpeg que
        pasa el flujo a RTP no envía, y los informes RTCP del emisor, cuya hora es la de ese FFmpeg y no la de captura.
      </p>
    ) : (
      <p>
        El protocolo prevé dos formas de saber esa hora: una extensión de cabecera con la hora de captura, que MediaMTX no negocia, y
        los informes RTCP del emisor, que aquí darían como mucho la hora de llegada a MediaMTX y no la de captura.
      </p>
    )}
    <p>Lo que sí se mide es la glass-to-glass y, como parte de ella, el búfer de jitter.</p>
  </>
);

const rtcQualityHint = (server: RtcServer) =>
  server === 'mediasoup' ? lang === 'en' ? (
    <>
      <p>
        Height of the video reaching the browser and nominal bitrate of that rendition. <b>The server chooses it</b>, mediasoup, and the browser only receives that one, so
        it cannot be set by hand here (README, 3.4c).
      </p>
      <p>
        It moves up to a layer if the estimate covers its bitrate measured at ingest plus 20 %, and if not even the lowest is covered it stops sending video. Each switch waits for the next keyframe:
        in this testbed nobody serves keyframe requests. With a single rendition in the ladder there is nothing to choose.
      </p>
    </>
  ) : (
    <>
      <p>
        Altura del vídeo que llega al navegador y bitrate nominal de esa calidad. <b>La elige el servidor</b>, mediasoup, y el navegador solo recibe esa, así que
        aquí no se puede fijar a mano (README, 3.4c).
      </p>
      <p>
        Sube a una capa si la estimación cubre su bitrate medido en la entrada más un 20 %, y sin cubrir ni la más baja deja de enviar vídeo. Cada cambio espera al siguiente keyframe:
        en este banco nadie atiende las peticiones de keyframe. Con una sola calidad en la escalera no hay nada que elegir.
      </p>
    </>
  ) : lang === 'en' ? (
    <p>Height of the received video. MediaMTX always serves the highest rendition of the ladder: this branch has no adaptation, and the rendition bitrate is not shown.</p>
  ) : (
    <p>Altura del vídeo recibido. MediaMTX sirve siempre la calidad más alta de la escalera: en esta rama no hay adaptación, y el bitrate de la calidad no se muestra.</p>
  );

const rtcSwitchesHint = (server: RtcServer) =>
  server === 'mediasoup' ? lang === 'en' ? (
    <p>Number of times the height of the video reaching the browser changes, read from <code>getStats()</code> every 500 ms. Two switches less than that apart show up as one or none. The exact mediasoup log is in <code>docker logs testbed-sfu</code>.</p>
  ) : (
    <p>Veces que cambia la altura del vídeo que llega al navegador, leída de <code>getStats()</code> cada 500 ms. Dos cambios seguidos en menos de ese tiempo se ven como uno o ninguno. El registro exacto de mediasoup está en <code>docker logs testbed-sfu</code>.</p>
  ) : (
    <p>{t('Siempre 0: MediaMTX envía una sola calidad.', 'Always 0: MediaMTX sends a single rendition.')}</p>
  );

const rtcEstimateHint = (server: RtcServer) =>
  server === 'mediasoup' ? lang === 'en' ? (
    <p>
      What mediasoup estimates fits towards this viewer, from the browser's TWCC feedback (delay, loss and probes), and what it uses to choose the layer. It is measured
      by the server and polled every 2 s. It can stay far below the actual capacity for a long time: after a drop it grows slowly (README, 3.4c).
    </p>
  ) : (
    <p>
      Lo que mediasoup estima que cabe hacia este espectador, a partir de la realimentación TWCC del navegador (retardo, pérdidas y sondeos), y con lo que elige la capa. Lo mide
      el servidor y se le pregunta cada 2 s. Puede quedarse muy por debajo de la capacidad real durante mucho tiempo: tras una bajada crece despacio (README, 3.4c).
    </p>
  ) : lang === 'en' ? (
    <p>Not applicable with MediaMTX: it does not estimate bandwidth to choose a rendition, because there is only one. With mediasoup (<code>RTC_SERVER=mediasoup</code>) its estimate is shown here.</p>
  ) : (
    <p>No aplica con MediaMTX: no estima el ancho de banda para elegir calidad, porque solo hay una. Con mediasoup (<code>RTC_SERVER=mediasoup</code>) aquí se ve su estimación.</p>
  );

const Telemetry: React.FC<{
  title: string;
  engine: string;
  color: string;
  bufferLabel: string;
  bufferHint?: React.ReactNode;
  reportedHint: React.ReactNode;
  networkHint: React.ReactNode;
  qualityHint: React.ReactNode;
  switchesHint?: React.ReactNode;
  estimateHint: React.ReactNode;
  metrics: PlayerMetrics;
  stats: ReturnType<typeof summarize>;
}> = ({ title, engine, color, bufferLabel, bufferHint, reportedHint, networkHint, qualityHint, switchesHint, estimateHint, metrics, stats }) => (
  <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl">
    <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-800">
      <span className={`font-semibold text-sm ${color}`}>{title}</span>
      <span className="text-xs text-slate-500">{engine}</span>
    </div>
    <div className="grid grid-cols-2 gap-3 text-center">
      <Stat label={t('Latencia glass-to-glass', 'Glass-to-glass latency')} value={fmt(metrics.latencyMs, 'ms')} accent wide />
      <Stat label={t('Latencia según reproductor', 'Player-reported latency')} value={fmt(metrics.reportedLatencyMs, 'ms')} hint={reportedHint} />
      <Stat label={t('Frames presentados', 'Presented frames')} value={fmt(metrics.fps, 'fps')} />
      <Stat
        label={t('Tiempo en pantalla σ · p95', 'Time on screen σ · p95')}
        value={metrics.frameTimeSdMs === null ? '--' : `${metrics.frameTimeSdMs} · ${metrics.frameTimeP95Ms} ms`}
        wide
        hint={FRAME_TIME_HINT}
      />
      <Stat
        label={t(`Calidad (${metrics.qualityMode === 'auto' ? 'auto' : 'fijada'})`, `Rendition (${metrics.qualityMode === 'auto' ? 'auto' : 'fixed'})`)}
        value={
          metrics.renditionHeight === null
            ? '--'
            : `${metrics.renditionHeight}p · ${metrics.renditionKbps ?? '--'} kbps` +
              (metrics.selectedHeight && metrics.selectedHeight !== metrics.renditionHeight ? t(` (sel. ${metrics.selectedHeight}p)`, ` (selected ${metrics.selectedHeight}p)`) : '')
        }
        wide
        hint={qualityHint}
      />
      <Stat label={t('Cambios de calidad', 'Quality switches')} value={String(metrics.qualitySwitches)} hint={switchesHint} />
      <Stat label={t('Ancho de banda estimado', 'Estimated bandwidth')} value={fmt(metrics.bandwidthEstimateKbps, 'kbps')} hint={estimateHint} />
      {(metrics.moqAbr === 'probe' || metrics.moqAbr === 'probe2') && (
        <Stat
          label={t(`Capacidad por sondeo${metrics.probing ? ' (sondeando)' : ''}`, `Probed capacity${metrics.probing ? ' (probing)' : ''}`)}
          value={fmt(metrics.probeCapacityKbps ?? null, 'kbps')}
          hint={t('Experimento (README 6.3): lo que recibían la calidad actual y la de sondeo en el último sondeo. Con él decide el controlador del banco, no @moq/watch.', 'Experiment (README 6.3): what the current rendition and the probe rendition received in the last probe. The testbed controller decides with it, not @moq/watch.')}
        />
      )}
      {(metrics.moqAbr === 'probe' || metrics.moqAbr === 'probe2') && (
        <Stat
          label={t('Sondeos (cortados)', 'Probes (cut)')}
          value={metrics.probeCount == null ? '--' : `${metrics.probeCount} (${metrics.probeCuts ?? 0})`}
          hint={t('Sondeos empezados desde que arrancó el controlador y, entre paréntesis, cuántos se cortaron porque la calidad actual perdió ritmo (README 6.3). En el CSV, moq_probe_count, moq_probe_cuts y cada sondeo con su inicio, fin y resultado en moq_probe_spans.', 'Probes started since the controller started and, in brackets, how many were cut because the current rendition fell behind (README 6.3). In the CSV, moq_probe_count, moq_probe_cuts and each probe with its start, end and result in moq_probe_spans.')}
        />
      )}
      <Stat label={t('Bitrate vídeo recibido', 'Received video bitrate')} value={fmt(metrics.bitrateKbps, 'kbps')} hint={VIDEO_HINT} />
      <Stat label={t('Descarga total', 'Total download')} value={fmt(metrics.networkKbps, 'kbps')} hint={networkHint} />
      <Stat label={bufferLabel} value={fmt(metrics.bufferLengthSec, 's')} hint={bufferHint} />
      {metrics.playbackRate !== undefined && (
        <Stat
          label={t('Velocidad de reproducción', 'Playback rate')}
          value={metrics.playbackRate === null ? '--' : `${metrics.playbackRate.toFixed(2)}×`}
          hint={t('La que dash.js pone al <video> para acercarse a la latencia objetivo (más de 1×) o, con LoL+, para rellenar el búfer (menos de 1×). En el CSV, media, mínimo y máximo de cada segundo y el tiempo por debajo y por encima de 1×.', 'The rate dash.js sets on the <video> to approach the target latency (above 1×) or, with LoL+, to refill the buffer (below 1×). In the CSV, mean, minimum and maximum per second and the time below and above 1×.')}
        />
      )}
      <Stat label={t('Congelados', 'Freezes')} value={`${metrics.stalls} (${metrics.stallMs} ms)`} />
      <Stat
        label={t('Contenido · no reproducido', 'Content · not played')}
        value={`${metrics.contentSpeed === null ? '--' : `${metrics.contentSpeed.toFixed(2)}×`} · ${(metrics.contentSkippedMs / 1000).toFixed(1)} s`}
        hint={t('Según el timecode de cada frame pintado. Primero, cuánto avanza el contenido por cada segundo real en los últimos 2 s (1× = tiempo real; más, el reproductor recupera latencia saltando frames o acelerando; menos, se retrasa). Después, cuánto contenido de la fuente no llegó a pintarse desde que arrancó el reproductor: frames saltados y lo que avanzó durante un parón tras el que se salta al directo. Un reproductor que reanuda donde se quedó no salta nada.', 'From the timecode of each painted frame. First, how much the content advances per real second over the last 2 s (1× = real time; above, the player recovers latency by skipping frames or speeding up; below, it falls behind). Then, how much source content was never painted since the player started: skipped frames and what advanced during a stall after which the player jumps to the live edge. A player that resumes where it stopped skips nothing.')}
      />
    </div>
    <p className="mt-3 text-[11px] font-mono text-slate-400">
      {stats
        ? t(
            `G2G n=${stats.n} · media ${stats.mean} · σ ${stats.sd} · p50 ${stats.p50} · p95 ${stats.p95} · min ${stats.min} · max ${stats.max} ms`,
            `G2G n=${stats.n} · mean ${stats.mean} · σ ${stats.sd} · p50 ${stats.p50} · p95 ${stats.p95} · min ${stats.min} · max ${stats.max} ms`,
          )
        : t(`G2G: esperando muestras (se descartan los primeros ${WARMUP_S} s)`, `G2G: waiting for samples (the first ${WARMUP_S} s are discarded)`)}
    </p>
  </div>
);

export const MetricsDashboard: React.FC<MetricsDashboardProps> = ({
  dashMetrics,
  moqMetrics,
  rtcMetrics,
  players,
  rtcServer,
  rtcAudio,
  history,
  samples,
  anomalies,
  availabilityDriftMs,
  sourceLagMs,
  pipelineRestarts,
  onExport,
  onReset,
}) => {
  const [metricTab, setMetricTab] = useState<'latency' | 'bitrate' | 'frametime' | 'main'>('latency');

  const steady = samples.filter((r) => r.elapsed_s >= WARMUP_S && !r.tab_hidden);
  const dashStats = summarize(steady.map((r) => r.dash_g2g_ms));
  const moqStats = summarize(steady.map((r) => r.moq_g2g_ms));
  const rtcStats = summarize(steady.map((r) => r.rtc_g2g_ms));
  const clock = getClockSync();
  const totalAnomalies = anomalies ? anomalies.master + anomalies.dash + anomalies.moq + (anomalies.rtc ?? 0) : 0;
  const serverRestarts = pipelineRestarts ? pipelineRestarts.master + pipelineRestarts.dash + pipelineRestarts.moq + (pipelineRestarts.rtc ?? 0) : 0;
  const playerRestarts = dashMetrics.restarts + moqMetrics.restarts + rtcMetrics.restarts;

  const latencyChartData = {
    labels: history.labels,
    datasets: [
      {
        label: t('LL-DASH Latencia G2G (ms)', 'LL-DASH G2G latency (ms)'),
        hidden: !players.dash,
        data: history.dashLatency,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.5)',
        tension: 0.3,
      },
      {
        label: t('MoQ Latencia G2G (ms)', 'MoQ G2G latency (ms)'),
        hidden: !players.moq,
        data: history.moqLatency,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.5)',
        tension: 0.3,
      },
      {
        label: t('WebRTC Latencia G2G (ms)', 'WebRTC G2G latency (ms)'),
        hidden: !players.rtc,
        data: history.rtcLatency,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.5)',
        tension: 0.3,
      },
    ],
  };

  const bitrateChartData = {
    labels: history.labels,
    datasets: [
      {
        label: t('LL-DASH Bitrate Recibido (kbps)', 'LL-DASH received bitrate (kbps)'),
        hidden: !players.dash,
        data: history.dashBitrate,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.5)',
        tension: 0.3,
      },
      {
        label: t('MoQ Bitrate Recibido (kbps)', 'MoQ received bitrate (kbps)'),
        hidden: !players.moq,
        data: history.moqBitrate,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.5)',
        tension: 0.3,
      },
      {
        label: t('WebRTC Bitrate Recibido (kbps)', 'WebRTC received bitrate (kbps)'),
        hidden: !players.rtc,
        data: history.rtcBitrate,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.5)',
        tension: 0.3,
      },
    ],
  };

  // Un punto por frame pintado: x en segundos respecto a la última actualización, y su tiempo en pantalla
  const framePoints = (frames: FrameTime[]) => frames.map((f) => ({ x: (f.t - history.framesAt) / 1000, y: Math.round(f.dt * 10) / 10 }));
  const frameTimeChartData = {
    datasets: [
      { label: 'LL-DASH', hidden: !players.dash, data: framePoints(history.dashFrames), borderColor: '#3b82f6', backgroundColor: '#3b82f6' },
      { label: 'MoQ', hidden: !players.moq, data: framePoints(history.moqFrames), borderColor: '#10b981', backgroundColor: '#10b981' },
      { label: 'WebRTC', hidden: !players.rtc, data: framePoints(history.rtcFrames), borderColor: '#f59e0b', backgroundColor: '#f59e0b' },
    ].map((d) => ({ ...d, borderWidth: 1, pointRadius: 1.5, tension: 0 })),
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    scales: {
      y: {
        grid: { color: '#334155' },
        ticks: { color: '#94a3b8' },
      },
      x: {
        grid: { display: false },
        ticks: { color: '#94a3b8' },
      },
    },
    plugins: {
      legend: {
        labels: { color: '#cbd5e1', font: { size: 12 } },
      },
    },
  };

  // Carga del hilo principal (lib/mainThread.ts), de las filas de cada segundo del tramo: las últimas 25, como
  // las demás gráficas. Refrescos perdidos a la izquierda y tiempo en frames largos a la derecha
  const mainRows = samples.slice(-25);
  const mainChartData = {
    labels: mainRows.map((r) => `${r.elapsed_s} s`),
    datasets: [
      { label: t('Refrescos perdidos (por s)', 'Missed refreshes (per s)'), data: mainRows.map((r) => r.main_refreshes_missed), borderColor: '#e879f9', backgroundColor: '#e879f9', yAxisID: 'y' },
      { label: t('Frames de 50 ms o más (ms por s)', 'Frames of 50 ms or more (ms per s)'), data: mainRows.map((r) => r.main_long_frame_ms), borderColor: '#94a3b8', backgroundColor: '#94a3b8', yAxisID: 'y1' },
    ].map((d) => ({ ...d, borderWidth: 1.5, pointRadius: 1.5, tension: 0 })),
  };
  const mainChartOptions = {
    ...chartOptions,
    scales: {
      ...chartOptions.scales,
      y: { ...chartOptions.scales.y, min: 0, title: { display: true, text: t('refrescos perdidos', 'missed refreshes'), color: '#94a3b8' } },
      y1: { position: 'right' as const, min: 0, grid: { display: false }, ticks: { color: '#94a3b8' }, title: { display: true, text: t('ms en frames largos', 'ms in long frames'), color: '#94a3b8' } },
    },
  };
  const lastMain = samples.at(-1);

  const frameTimeChartOptions = {
    ...chartOptions,
    parsing: false as const,
    scales: {
      y: { ...chartOptions.scales.y, min: 0, title: { display: true, text: t('ms en pantalla', 'ms on screen'), color: '#94a3b8' } },
      x: {
        ...chartOptions.scales.x,
        type: 'linear' as const,
        min: -10,
        max: 0,
        title: { display: true, text: t('segundos', 'seconds'), color: '#94a3b8' },
      },
    },
  };

  return (
    <div className="space-y-4">
      {/* Tarjetas comparativas: mismas métricas y mismo método de medida en las tres ramas */}
      <div className={`grid gap-4 ${gridCols(players)}`}>
        {players.dash && <Telemetry
          title={t('Telemetría LL-DASH', 'LL-DASH telemetry')}
          engine="dash.js engine"
          color="text-blue-400"
          bufferLabel={t('Búfer local', 'Local buffer')}
          reportedHint={
            lang === 'en' ? (
              <>
                <p>
                  <b>What it is:</b> the distance to the live edge computed by dash.js itself (<code>getCurrentLiveLatency()</code>): the current time,
                  synchronised with the server, minus the video position counted from the manifest's start time.
                </p>
                <p>
                  <b>It is a real measurement</b>, but by the manifest's clock: it leaves out whatever happens before that start time, essentially
                  encoding. That is why it comes out somewhat below the glass-to-glass latency.
                </p>
                <p>For comparison only: the rigorous figure is the glass-to-glass latency, measured the same way in all three branches.</p>
              </>
            ) : (
            <>
              <p>
                <b>Qué es:</b> la distancia al directo que calcula el propio dash.js (<code>getCurrentLiveLatency()</code>): la hora actual,
                sincronizada con el servidor, menos la posición del vídeo contada desde la hora de inicio del manifiesto.
              </p>
              <p>
                <b>Es una medida real</b>, pero según el reloj del manifiesto: deja fuera lo anterior a esa hora de inicio, básicamente la
                codificación. Por eso sale algo por debajo de la glass-to-glass.
              </p>
              <p>Solo como contraste: la cifra rigurosa es la glass-to-glass, que se mide igual en las tres ramas.</p>
            </>
            )
          }
          networkHint={DASH_NETWORK_HINT}
          qualityHint={<p>{t('Representación que reproduce dash.js y su bitrate declarado en el manifiesto. En auto decide su algoritmo ABR por defecto.', 'Representation played by dash.js and its bitrate as declared in the manifest. In auto, its default ABR algorithm decides.')}</p>}
          estimateHint={<p>{t('Caudal medio que dash.js mide en sus descargas de vídeo; es la entrada de su ABR. Con entrega chunked de baja latencia esta medida es poco precisa.', 'Mean throughput dash.js measures on its video downloads; it is the input to its ABR. With low-latency chunked delivery this measurement is imprecise.')}</p>}
          metrics={dashMetrics}
          stats={dashStats}
        />}
        {players.moq && <Telemetry
          title={t('Telemetría Media over QUIC', 'Media over QUIC telemetry')}
          engine="WebTransport QUIC"
          color="text-emerald-400"
          bufferLabel={t('Búfer de jitter', 'Jitter buffer')}
          reportedHint={
            lang === 'en' ? (
              <>
                <p>
                  <b>What it is:</b> the @moq/watch synchronisation delay: the target latency from the slider (or the one computed in auto) plus the
                  jitter the catalog declares for the tracks.
                </p>
                <p>
                  <b>It is not a measurement but a target:</b> how long the player intends to wait from the earliest-arriving frame. It knows
                  nothing about the path to the browser (encoding, publisher, relay and network), so it comes out well below the
                  glass-to-glass latency.
                </p>
                <p>For comparison only: the rigorous figure is the glass-to-glass latency, measured the same way in all three branches.</p>
              </>
            ) : (
            <>
              <p>
                <b>Qué es:</b> el retardo de sincronización de @moq/watch: la latencia objetivo del slider (o la calculada en auto) más el
                jitter que el catálogo declara para las pistas.
              </p>
              <p>
                <b>No es una medida, sino un objetivo:</b> cuánto se propone esperar el reproductor desde el frame que más rápido llegó. No
                sabe nada del camino hasta el navegador (codificación, publicador, relay y red), así que sale bastante por debajo de la
                glass-to-glass.
              </p>
              <p>Solo como contraste: la cifra rigurosa es la glass-to-glass, que se mide igual en las tres ramas.</p>
            </>
            )
          }
          bufferHint={
            lang === 'en' ? (
              <p>
                Mean time each frame is held in the player: from when @moq/watch reads it from the network until it hands it over to be
                painted. It is the same measurement as in WebRTC, with one difference: here it includes decoding (1-2 ms per frame), which in
                WebRTC happens after the buffer.
              </p>
            ) : (
            <p>
              Tiempo medio que cada frame pasa retenido en el reproductor: desde que @moq/watch lo lee de la red hasta que lo entrega para
              pintarlo. Es la misma medida que en WebRTC, con una diferencia: aquí incluye la decodificación (1-2 ms por frame), que en
              WebRTC ocurre después del búfer.
            </p>
            )
          }
          networkHint={moqMetrics.networkSource === 'transport' ? MOQ_TRANSPORT_HINT : MOQ_PAYLOAD_HINT}
          qualityHint={
            lang === 'en' ? (
              <p>
                Height of the frame being painted and bitrate of the selected rendition according to the catalog, which the publisher measures and
                which comes out higher than the nominal one. In auto, @moq/watch decides without intervention: the highest rendition whose bitrate fits in 80 % of the
                estimated bandwidth, discarding those the publisher marks as stalled. It switches seamlessly, so during a switch the selected and
                the painted rendition may differ.
              </p>
            ) : (
            <p>
              Altura del frame que se está pintando y bitrate de la rendition seleccionada según el catálogo, que lo mide el publicador y sale
              más alto que el nominal. En auto decide @moq/watch sin intervención: la más alta cuyo bitrate quepa en el 80 % del ancho de banda
              estimado, descartando las que el publicador marca como atascadas. Cambia sin corte, así que durante un cambio la seleccionada y
              la pintada pueden no coincidir.
            </p>
            )
          }
          estimateHint={<p>{t('Tasa de recepción que estima el relay con su control de congestión y envía al reproductor (mensajes PROBE de MoQ).', 'Receive rate the relay estimates with its congestion control and sends to the player (MoQ PROBE messages).')}</p>}
          metrics={moqMetrics}
          stats={moqStats}
        />}
        {players.rtc && <Telemetry
          title={t('Telemetría WebRTC', 'WebRTC telemetry')}
          engine={rtcServer === 'mediasoup' ? 'mediasoup · mediasoup-client' : 'MediaMTX · RTCPeerConnection'}
          color="text-amber-400"
          bufferLabel={t('Búfer de jitter', 'Jitter buffer')}
          reportedHint={rtcReportedHint(rtcServer)}
          bufferHint={
            lang === 'en' ? (
              <p>
                Mean time each frame spends in the browser's jitter buffer: from the arrival of its first packet until it leaves for the
                decoder (<code>jitterBufferDelay / jitterBufferEmittedCount</code> from <code>getStats()</code>).
              </p>
            ) : (
            <p>
              Tiempo medio que cada frame pasa en el búfer de jitter del navegador: desde que llega su primer paquete hasta que sale hacia el
              decodificador (<code>jitterBufferDelay / jitterBufferEmittedCount</code> de <code>getStats()</code>).
            </p>
            )
          }
          networkHint={rtcNetworkHint(rtcServer, rtcAudio)}
          qualityHint={rtcQualityHint(rtcServer)}
          switchesHint={rtcSwitchesHint(rtcServer)}
          estimateHint={rtcEstimateHint(rtcServer)}
          metrics={rtcMetrics}
          stats={rtcStats}
        />}
      </div>

      {/* Validez de la medida y exportación */}
      <div className="flex items-center justify-between bg-slate-900/90 border border-slate-800 px-4 py-2.5 rounded-xl text-[11px] font-mono">
        <div className="flex items-center space-x-4">
          <span className={clock && clock.rttMs < 10 ? 'text-slate-400' : 'text-amber-400'}>
            {t('Reloj servidor', 'Server clock')}: {clock ? t(`offset ${clock.offsetMs.toFixed(1)} ms · incertidumbre ±${(clock.rttMs / 2).toFixed(1)} ms`, `offset ${clock.offsetMs.toFixed(1)} ms · uncertainty ±${(clock.rttMs / 2).toFixed(1)} ms`) : t('sin sincronizar', 'not synchronised')}
          </span>
          <span className={totalAnomalies ? 'text-rose-400 font-bold' : 'text-slate-400'}>
            {t('Anomalías de ingesta', 'Ingest anomalies')}: {anomalies ? t(`${totalAnomalies} (fuente ${anomalies.master} · DASH ${anomalies.dash} · MoQ ${anomalies.moq} · WebRTC ${anomalies.rtc ?? 0})`, `${totalAnomalies} (source ${anomalies.master} · DASH ${anomalies.dash} · MoQ ${anomalies.moq} · WebRTC ${anomalies.rtc ?? 0})`) : '--'}
          </span>
          <span className={Math.abs(availabilityDriftMs ?? 0) > 100 ? 'text-amber-400' : 'text-slate-400'}>
            {t('Deriva disponibilidad DASH', 'DASH availability drift')}: {availabilityDriftMs == null ? '--' : `${availabilityDriftMs} ms`}
          </span>
          <span
            className={(sourceLagMs ?? 0) > 50 ? 'text-amber-400' : 'text-slate-400'}
            title={t('Cuánto va la fuente por detrás del tiempo real en los últimos 2 s: la marca quemada en cada frame menos lo que le toca por su número. Los reproductores pintan por PTS, así que lo ven como menos latencia.', 'How far the source lags behind real time over the last 2 s: the timestamp burnt into each frame minus what its frame number corresponds to. Players paint by PTS, so they see it as lower latency.')}
          >
            {t('Retraso de la fuente', 'Source lag')}: {sourceLagMs == null ? '--' : `${Math.round(sourceLagMs)} ms`}
          </span>
          <span
            className={(lastMain?.main_refreshes_missed ?? 0) > 3 ? 'text-amber-400' : 'text-slate-400'}
            title={t('Carga del hilo principal de esta página en el último segundo: refrescos de pantalla en que no llegó a pintar y tiempo en frames de 50 ms o más (Long Animation Frames API). MoQ pinta en ese hilo; el <video> de DASH y WebRTC, no.', "Load on this page's main thread over the last second: display refreshes in which it failed to paint and time in frames of 50 ms or more (Long Animation Frames API). MoQ paints on that thread; the DASH and WebRTC <video> elements do not.")}
          >
            {t('Hilo principal', 'Main thread')}: {lastMain ? t(`${lastMain.main_refreshes_missed} refrescos perdidos · ${lastMain.main_long_frame_ms ?? '--'} ms en frames largos`, `${lastMain.main_refreshes_missed} missed refreshes · ${lastMain.main_long_frame_ms ?? '--'} ms in long frames`) : '--'}
          </span>
          <span
            className={playerRestarts + serverRestarts ? 'text-amber-400' : 'text-slate-400'}
            title={t('Recuperaciones automáticas. Servidor: el supervisor relanzó la fuente o un empaquetador caído o colgado. Reproductores: llevaban 10 s sin imagen nueva y se recrearon.', 'Automatic recoveries. Server: the supervisor relaunched the source or a crashed or hung packager. Players: they had gone 10 s without a new picture and were recreated.')}
          >
            {t('Reinicios: servidor', 'Restarts: server')} {pipelineRestarts ? serverRestarts : '--'} · DASH {dashMetrics.restarts} · MoQ {moqMetrics.restarts} · WebRTC {rtcMetrics.restarts}
          </span>
          <span className="text-slate-500">{samples.length} {t('muestras', 'samples')}</span>
        </div>
        <div className="flex items-center space-x-2 font-sans text-xs">
          <button onClick={onReset} className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer">
            {t('Reiniciar medida', 'Reset measurement')}
          </button>
          <button onClick={onExport} className="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium cursor-pointer">
            {t('Exportar CSV', 'Export CSV')}
          </button>
        </div>
      </div>

      {/* Gráfica de evolución en tiempo real con selector de métrica */}
      <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-slate-300">
            {metricTab === 'latency'
              ? t('Evolución de Latencia Glass-to-Glass (ms)', 'Glass-to-glass latency over time (ms)')
              : metricTab === 'bitrate'
                ? t('Evolución de Bitrate Recibido (kbps)', 'Received bitrate over time (kbps)')
                : metricTab === 'frametime'
                  ? t('Tiempo en pantalla de cada frame, últimos 10 s (ms)', 'Time on screen of each frame, last 10 s (ms)')
                  : t('Carga del hilo principal de esta página', "Load on this page's main thread")}
          </h4>
          <div className="flex space-x-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <button
              onClick={() => setMetricTab('latency')}
              className={`px-3 py-1 rounded transition-colors ${
                metricTab === 'latency'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('Latencia (ms)', 'Latency (ms)')}
            </button>
            <button
              onClick={() => setMetricTab('bitrate')}
              className={`px-3 py-1 rounded transition-colors ${
                metricTab === 'bitrate'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Bitrate (kbps)
            </button>
            <button
              onClick={() => setMetricTab('frametime')}
              className={`px-3 py-1 rounded transition-colors ${
                metricTab === 'frametime'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('Tiempo en pantalla (ms)', 'Time on screen (ms)')}
            </button>
            <button
              onClick={() => setMetricTab('main')}
              title={t('Lo que hace esta página (reproductores, medidor, panel) en su hilo principal. MoQ pinta en él; el <video> de DASH y WebRTC, no.', 'What this page (players, meter, dashboard) does on its main thread. MoQ paints on it; the DASH and WebRTC <video> elements do not.')}
              className={`px-3 py-1 rounded transition-colors ${
                metricTab === 'main'
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('Hilo principal', 'Main thread')}
            </button>
          </div>
        </div>

        <div className="h-64 relative">
          {history.labels.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
              {t('Recolectando datos de telemetría en tiempo real...', 'Collecting real-time telemetry...')}
            </div>
          ) : (
            // Una gráfica por pestaña (key): Chart.js no soporta cambiar en caliente el eje x de numérico
            // (tiempo en pantalla) a categorías, y al volver a latencia o bitrate la página se quedaba en blanco
            metricTab === 'frametime' ? (
              <Line key="frametime" data={frameTimeChartData} options={frameTimeChartOptions} />
            ) : metricTab === 'main' ? (
              <Line key="main" data={mainChartData} options={mainChartOptions} />
            ) : (
              <Line key={metricTab} data={metricTab === 'latency' ? latencyChartData : bitrateChartData} options={chartOptions} />
            )
          )}
        </div>
      </div>
    </div>
  );
};
