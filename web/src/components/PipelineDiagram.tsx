import React, { useEffect, useRef, useState } from 'react';
import { Workflow } from 'lucide-react';
import { getClockSync } from '../lib/clock';
import type { StageBreakdown } from '../types';
import { t } from '../lib/i18n';

// Recorrido de un frame en cada rama. Los elementos se agrupan por etapa MEDIDA: entre dos puntos de
// medida consecutivos se sabe con exactitud cuánto tarda un frame, pero no cómo se reparte ese tiempo
// entre los elementos de dentro. No se muestra ninguna cifra que no salga de dos horas medidas.
interface Stage {
  key: string;
  name: string;
  nodes: string[];
  includes: string;
  from: string;
  to: string;
  uncertainty: 'server' | 'browser' | 'both';
}

const ENCODE: Stage = {
  key: 'encode',
  name: t('Codificación', 'Encoding'),
  nodes: [t('Fuente + timecode', 'Source + timecode'), 'x264', 'MPEG-TS / UDP'],
  includes: t('Escalado, codificación H.264 de esa calidad, multiplexado MPEG-TS junto al resto de calidades y al audio, y envío por UDP interno.', 'Scaling, H.264 encoding of that rendition, MPEG-TS multiplexing together with the other renditions and the audio, and sending over internal UDP.'),
  from: t('la marca de tiempo que FFmpeg quema en el frame antes de codificarlo', 'the timestamp that FFmpeg burns into the frame before encoding it'),
  to: t('la llegada del último paquete de ese frame al socket de tsgate, la compuerta de la rama (hora que marca el kernel)', 'the arrival of the last packet of that frame at the socket of tsgate, the gate of the branch (kernel timestamp)'),
  uncertainty: 'server',
};

type LaneId = 'dash' | 'moq' | 'rtc';

const LANES: { id: LaneId; title: string; color: string; bar: string; stages: Stage[] }[] = [
  {
    id: 'dash',
    title: 'LL-DASH',
    color: 'text-blue-400',
    bar: '#3b82f6',
    stages: [
      ENCODE,
      {
        key: 'ingest',
        name: t('Entrada al empaquetador', 'Packager ingest'),
        nodes: ['tsgate'],
        includes:
          t('Tiempo que el frame, ya codificado, espera a que el FFmpeg que empaqueta lo acepte. tsgate le entrega los datos por una tubería y se bloquea si FFmpeg no la vacía; si esta etapa crece, el empaquetador no da abasto.', 'Time the already encoded frame waits for the packaging FFmpeg to accept it. tsgate hands it the data through a pipe and blocks if FFmpeg does not drain it; if this stage grows, the packager cannot keep up.'),
        from: t('la llegada del frame al socket de tsgate', 'the arrival of the frame at the tsgate socket'),
        to: t('el instante en que tsgate lo lee y lo escribe hacia FFmpeg', 'the instant tsgate reads it and writes it to FFmpeg'),
        uncertainty: 'server',
      },
      {
        key: 'package',
        name: t('Empaquetado CMAF', 'CMAF packaging'),
        nodes: ['FFmpeg dash', t('Origen', 'Origin')],
        includes:
          t('Lectura del MPEG-TS en FFmpeg (retiene unos 2 frames: PROTOCOLOS, 6.4), espera a que se complete el fragmento CMAF que contiene el frame (hasta la duración de fragmento configurada) y su escritura en el origen.', 'MPEG-TS reading in FFmpeg (it holds about 2 frames: PROTOCOLOS, 6.4), wait for the CMAF fragment containing the frame to complete (up to the configured fragment duration) and its write to the origin.'),
        from: t('la entrega del frame a FFmpeg', 'the delivery of the frame to FFmpeg'),
        to: t('el instante en que su fragmento queda completo en el origen', 'the instant its fragment is complete at the origin'),
        uncertainty: 'server',
      },
      {
        key: 'deliver',
        name: t('Entrega', 'Delivery'),
        nodes: ['Nginx', t('Router (emulación)', 'Router (emulation)'), t('Red', 'Network'), 'dash.js'],
        includes:
          t('Camino HTTP del fragmento desde el origen hasta el búfer del navegador: Nginx, router de emulación de red, la red y la descarga y anexado por dash.js. Si el navegador aún no había pedido el segmento, también esa espera.', 'HTTP path of the fragment from the origin to the browser buffer: Nginx, network emulation router, the network, and the download and append by dash.js. If the browser had not yet requested the segment, that wait too.'),
        from: t('el fragmento completo en el origen', 'the complete fragment at the origin'),
        to: t('el primer instante en que el búfer del <video> contiene ese frame (se comprueba cada 20 ms)', 'the first instant the <video> buffer contains that frame (checked every 20 ms)'),
        uncertainty: 'both',
      },
      {
        key: 'player',
        name: t('Búfer y pintado', 'Buffer and rendering'),
        nodes: [t('Búfer MSE', 'MSE buffer'), t('Decodificador', 'Decoder'), t('Pantalla', 'Display')],
        includes: t('Tiempo que el frame espera en el búfer del reproductor hasta que le toca, más decodificación y presentación. Es donde actúa la latencia objetivo.', 'Time the frame waits in the player buffer until its turn, plus decoding and presentation. This is where the target latency acts.'),
        from: t('la entrada del frame en el búfer', 'the entry of the frame into the buffer'),
        to: t('el instante en que el navegador lo presenta', 'the instant the browser presents it'),
        uncertainty: 'browser',
      },
    ],
  },
  {
    id: 'moq',
    title: 'Media over QUIC',
    color: 'text-emerald-400',
    bar: '#10b981',
    stages: [
      ENCODE,
      {
        key: 'ingest',
        name: t('Entrada al publicador', 'Publisher ingest'),
        nodes: ['tsgate'],
        includes:
          t('Tiempo que el frame, ya codificado, espera a que el publicador lo acepte. tsgate le entrega los datos por una tubería y se bloquea si el publicador no la vacía; si esta etapa crece, el publicador (o lo que tiene detrás) no da abasto.', 'Time the already encoded frame waits for the publisher to accept it. tsgate hands it the data through a pipe and blocks if the publisher does not drain it; if this stage grows, the publisher (or what is behind it) cannot keep up.'),
        from: t('la llegada del frame al socket de tsgate', 'the arrival of the frame at the tsgate socket'),
        to: t('el instante en que tsgate lo lee y lo escribe hacia el publicador', 'the instant tsgate reads it and writes it to the publisher'),
        uncertainty: 'server',
      },
      {
        key: 'transport',
        name: t('Publicación y transporte', 'Publishing and transport'),
        nodes: ['moq import', 'Relay', t('Router (emulación)', 'Router (emulation)'), t('Red QUIC', 'QUIC network')],
        includes:
          t('Publicador, relay y red juntos: no se pueden separar sin instrumentar el relay, que es un binario de terceros. Incluye retransmisiones QUIC si hay pérdidas.', 'Publisher, relay and network together: they cannot be separated without instrumenting the relay, which is a third-party binary. Includes QUIC retransmissions if there is loss.'),
        from: t('la entrega del frame al publicador', 'the delivery of the frame to the publisher'),
        to: t('el instante en que el reproductor lo lee de la conexión, antes de decodificarlo', 'the instant the player reads it from the connection, before decoding it'),
        uncertainty: 'both',
      },
      {
        key: 'player',
        name: t('Búfer de jitter y pintado', 'Jitter buffer and rendering'),
        nodes: [t('Búfer de jitter', 'Jitter buffer'), 'WebCodecs', 'Canvas'],
        includes: t('Espera en el búfer de sincronización hasta su hora de presentación (latencia objetivo), decodificación y dibujado en el canvas.', 'Wait in the synchronisation buffer until its presentation time (target latency), decoding and drawing on the canvas.'),
        from: t('la llegada del frame al reproductor', 'the arrival of the frame at the player'),
        to: t('el instante en que está dibujado en el canvas', 'the instant it is drawn on the canvas'),
        uncertainty: 'browser',
      },
    ],
  },
  {
    id: 'rtc',
    title: 'WebRTC',
    color: 'text-amber-400',
    bar: '#f59e0b',
    stages: [
      ENCODE,
      {
        key: 'ingest',
        name: t('Entrada al empaquetador', 'Packager ingest'),
        nodes: ['tsgate'],
        includes:
          t('Tiempo que el frame, ya codificado, espera a que el FFmpeg que lo publica por RTSP lo acepte. tsgate le entrega los datos por una tubería y se bloquea si no la vacía.', 'Time the already encoded frame waits for the FFmpeg that publishes it over RTSP to accept it. tsgate hands it the data through a pipe and blocks if it is not drained.'),
        from: t('la llegada del frame al socket de tsgate', 'the arrival of the frame at the tsgate socket'),
        to: t('el instante en que tsgate lo lee y lo escribe hacia FFmpeg', 'the instant tsgate reads it and writes it to FFmpeg'),
        uncertainty: 'server',
      },
      {
        key: 'transport',
        name: t('Publicación y transporte', 'Publishing and transport'),
        nodes: ['FFmpeg (RTSP)', 'MediaMTX', t('Router (emulación)', 'Router (emulation)'), t('Red SRTP', 'SRTP network')],
        includes:
          t('Reempaquetado a RTSP, MediaMTX y la red juntos: no se pueden separar sin instrumentar MediaMTX. Incluye las retransmisiones que pida el navegador si hay pérdidas.', 'Repackaging to RTSP, MediaMTX and the network together: they cannot be separated without instrumenting MediaMTX. Includes the retransmissions the browser requests if there is loss.'),
        from: t('la entrega del frame al FFmpeg que publica', 'the delivery of the frame to the publishing FFmpeg'),
        to: t('la hora a la que el navegador recibe el último paquete de ese frame (la da el propio navegador con cada frame)', 'the time at which the browser receives the last packet of that frame (reported by the browser itself with each frame)'),
        uncertainty: 'both',
      },
      {
        key: 'player',
        name: t('Búfer de jitter y pintado', 'Jitter buffer and rendering'),
        nodes: [t('Búfer de jitter', 'Jitter buffer'), t('Decodificador', 'Decoder'), t('Pantalla', 'Display')],
        includes: t('Espera en el búfer de jitter del navegador, decodificación y presentación.', 'Wait in the browser jitter buffer, decoding and presentation.'),
        from: t('la recepción del último paquete del frame', 'the reception of the last packet of the frame'),
        to: t('el instante en que el navegador lo presenta', 'the instant the browser presents it'),
        uncertainty: 'browser',
      },
    ],
  },
];

// Con la ingesta directa de WebRTC (RTC_INGEST=udp) no hay FFmpeg intermedio: tsgate envía el MPEG-TS
// por UDP a MediaMTX. Cambian las etapas que lo mencionan.
const RTC_UDP_STAGES: Record<string, Partial<Stage>> = {
  ingest: {
    includes:
      t('Tiempo que el frame, ya codificado, pasa en tsgate antes de salir por UDP hacia MediaMTX. Con la ingesta directa no hay nadie que pueda frenarla, así que debería ser casi cero.', 'Time the already encoded frame spends in tsgate before leaving over UDP to MediaMTX. With direct ingest nothing can hold it back, so it should be almost zero.'),
    to: t('el instante en que tsgate lo lee y lo envía por UDP a MediaMTX', 'the instant tsgate reads it and sends it over UDP to MediaMTX'),
  },
  transport: {
    nodes: ['MediaMTX', t('Router (emulación)', 'Router (emulation)'), t('Red SRTP', 'SRTP network')],
    includes:
      t('Lectura del MPEG-TS en MediaMTX, reempaquetado a RTP y la red, juntos: no se pueden separar sin instrumentar MediaMTX. Incluye las retransmisiones que pida el navegador si hay pérdidas.', 'MPEG-TS reading in MediaMTX, repackaging to RTP and the network, together: they cannot be separated without instrumenting MediaMTX. Includes the retransmissions the browser requests if there is loss.'),
    from: t('el envío del frame por UDP a MediaMTX', 'the sending of the frame over UDP to MediaMTX'),
  },
};

// Con mediasoup (RTC_SERVER=mediasoup): FFmpeg pasa el MPEG-TS a RTP y el relay junta las pistas en un socket
const RTC_RTP_STAGES: Record<string, Partial<Stage>> = {
  ingest: {
    includes:
      t('Tiempo que el frame, ya codificado, espera a que el FFmpeg que lo pasa a RTP lo acepte. tsgate le entrega los datos por una tubería y se bloquea si no la vacía.', 'Time the already encoded frame waits for the FFmpeg that converts it to RTP to accept it. tsgate hands it the data through a pipe and blocks if it is not drained.'),
    to: t('el instante en que tsgate lo lee y lo escribe hacia FFmpeg', 'the instant tsgate reads it and writes it to FFmpeg'),
  },
  transport: {
    nodes: ['FFmpeg (RTP)', 'Relay', 'mediasoup', t('Router (emulación)', 'Router (emulation)'), t('Red SRTP', 'SRTP network')],
    includes:
      t('Paso a RTP (FFmpeg retiene varios frames al leer el MPEG-TS: PROTOCOLOS, 6.4), relay, mediasoup y la red, juntos: no se pueden separar sin instrumentar mediasoup. Incluye las retransmisiones que pida el navegador si hay pérdidas.', 'Conversion to RTP (FFmpeg holds several frames when reading the MPEG-TS: PROTOCOLOS, 6.4), relay, mediasoup and the network, together: they cannot be separated without instrumenting mediasoup. Includes the retransmissions the browser requests if there is loss.'),
    from: t('la entrega del frame al FFmpeg que lo pasa a RTP', 'the delivery of the frame to the FFmpeg that converts it to RTP'),
  },
};

interface PipelineDiagramProps {
  rtcIngest?: 'udp' | 'rtsp' | 'rtp';
  players: Record<LaneId, boolean>;
  stages: Record<LaneId, StageBreakdown | null | undefined>;
  latency: Record<LaneId, number | null>;
}

const stageMs = (breakdown: StageBreakdown | null | undefined, key: string) => breakdown?.stages.find((s) => s.key === key)?.ms ?? null;

/** Puntos que recorren el carril a velocidad real: tardan en cada etapa lo que se ha medido en ella. */
const Particles: React.FC<{ stages: Stage[]; breakdown?: StageBreakdown | null; color: string }> = ({ stages, breakdown, color }) => {
  const track = useRef<HTMLDivElement | null>(null);
  const latest = useRef(breakdown);
  latest.current = breakdown;

  useEffect(() => {
    const timer = setInterval(() => {
      const current = latest.current;
      const host = track.current;
      if (!current || !host || document.hidden || current.totalMs <= 0) return;
      const nodes = stages.reduce((sum, s) => sum + s.nodes.length, 0);
      // Fotogramas clave en las fronteras entre etapas: posición según el esquema, tiempo según lo medido.
      // Se anima transform y no left, para que lo mueva el compositor sin recalcular el layout.
      const width = host.clientWidth;
      let position = 0;
      let elapsed = 0;
      const frames: Keyframe[] = [{ transform: 'translateX(0px)', offset: 0 }];
      for (const s of stages) {
        position += s.nodes.length / nodes;
        elapsed += Math.max(0, stageMs(current, s.key) ?? 0);
        frames.push({ transform: `translateX(${Math.round(position * width)}px)`, offset: Math.min(1, elapsed / current.totalMs) });
      }
      frames[frames.length - 1].offset = 1;
      const dot = document.createElement('span');
      dot.style.cssText = `position:absolute;top:-3px;left:-4px;width:8px;height:8px;border-radius:9999px;background:${color};box-shadow:0 0 8px ${color};will-change:transform`;
      host.appendChild(dot);
      dot.animate(frames, { duration: Math.max(200, current.totalMs), easing: 'linear' }).onfinish = () => dot.remove();
    }, 400);
    return () => clearInterval(timer);
  }, [stages, color]);

  return <div ref={track} className="relative h-0.5 bg-slate-700/70 rounded mx-1 my-2" />;
};

export const PipelineDiagram: React.FC<PipelineDiagramProps> = ({ rtcIngest, players, stages: data, latency }) => {
  const rtcStages = rtcIngest === 'udp' ? RTC_UDP_STAGES : rtcIngest === 'rtp' ? RTC_RTP_STAGES : null;
  const allLanes = rtcStages
    ? LANES.map((l) => (l.id === 'rtc' ? { ...l, stages: l.stages.map((st) => ({ ...st, ...rtcStages[st.key] })) } : l))
    : LANES;
  const [chosen, setSelected] = useState<{ lane: LaneId; key: string }>({ lane: 'dash', key: 'deliver' });
  // Solo los carriles de los reproductores activos; si el elegido se apaga, se muestra el primero que quede
  const lanes = allLanes.filter((l) => players[l.id]);
  const selected = players[chosen.lane] ? chosen : { lane: lanes[0].id, key: lanes[0].stages[0].key };
  const scaleMs = Math.max(...lanes.map((l) => data[l.id]?.totalMs ?? 0), 1);
  const clock = getClockSync();
  const clockError = clock ? clock.rttMs / 2 : null;

  const lane = allLanes.find((l) => l.id === selected.lane)!;
  const stage = lane.stages.find((s) => s.key === selected.key) ?? lane.stages[0];
  const value = stageMs(data[lane.id], stage.key);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg">
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
        <div className="flex items-center space-x-2">
          <Workflow className="w-5 h-5 text-indigo-400" />
          <h3 className="font-semibold text-slate-200">{t('Recorrido de un frame y latencia medida en cada etapa', 'Path of a frame and latency measured at each stage')}</h3>
        </div>
        <span className="text-[11px] text-slate-500">{t('Los puntos viajan a velocidad real. Pulsa una etapa para ver qué incluye y cómo se mide.', 'The dots travel at real speed. Click a stage to see what it includes and how it is measured.')}</span>
      </div>

      <div className="space-y-5">
        {lanes.map((l) => {
          const breakdown = data[l.id];
          const nodes = l.stages.reduce((sum, s) => sum + s.nodes.length, 0);
          return (
            <div key={l.id}>
              <div className="flex items-baseline justify-between mb-1.5 text-xs">
                <span className={`font-semibold ${l.color}`}>{l.title}</span>
                <span className="font-mono text-slate-400">
                  {breakdown
                    ? t(
                        `este frame: ${breakdown.totalMs} ms · mediana glass-to-glass ${latency[l.id] ?? '--'} ms · ${breakdown.samples} frames seguidos en el último segundo`,
                        `this frame: ${breakdown.totalMs} ms · median glass-to-glass ${latency[l.id] ?? '--'} ms · ${breakdown.samples} frames tracked in the last second`,
                      )
                    : t('sin frames seguidos de principio a fin en el último segundo', 'no frames tracked end to end in the last second')}
                </span>
              </div>

              {/* Elementos del recorrido, agrupados por etapa medida */}
              <div className="flex gap-1.5">
                {l.stages.map((s) => {
                  const ms = stageMs(breakdown, s.key);
                  const active = selected.lane === l.id && selected.key === s.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => setSelected({ lane: l.id, key: s.key })}
                      style={{ flexGrow: s.nodes.length, flexBasis: 0 }}
                      className={`min-w-0 text-left rounded-lg border p-2 cursor-pointer transition ${
                        active ? 'border-indigo-500 bg-indigo-950/40' : 'border-slate-800 bg-slate-950/60 hover:border-slate-600'
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2 mb-1.5">
                        <span className="text-[11px] text-slate-400 truncate">{s.name}</span>
                        <span className="font-mono text-sm font-bold text-slate-100 whitespace-nowrap">{ms === null ? '--' : `${ms} ms`}</span>
                      </div>
                      <div className="flex gap-1">
                        {s.nodes.map((node) => (
                          <span
                            key={node}
                            className="flex-1 min-w-0 truncate text-center text-[10px] text-slate-300 bg-slate-800/80 border border-slate-700/60 rounded px-1 py-1"
                            title={node}
                          >
                            {node}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div style={{ paddingLeft: 0 }}>
                <Particles stages={l.stages} breakdown={breakdown} color={l.bar} />
              </div>

              {/* Reparto a escala de tiempo común para las dos ramas */}
              <div className="flex h-5 rounded overflow-hidden bg-slate-950/60 border border-slate-800" title={t(`Barra a escala: ${nodes} elementos, ${breakdown?.totalMs ?? '--'} ms`, `Bar to scale: ${nodes} elements, ${breakdown?.totalMs ?? '--'} ms`)}>
                {breakdown?.stages.map((s, i) => (
                  <div
                    key={s.key}
                    style={{ width: `${(Math.max(0, s.ms) / scaleMs) * 100}%`, background: l.bar, opacity: 1 - i * 0.2 }}
                    className="h-full flex items-center justify-center text-[10px] font-mono text-white/90 overflow-hidden whitespace-nowrap border-r border-slate-950/60"
                  >
                    {s.ms > scaleMs * 0.04 ? s.ms : ''}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detalle de la etapa seleccionada */}
      <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-300 space-y-1.5">
        <p>
          <span className={`font-semibold ${lane.color}`}>{lane.title}</span> · <span className="font-semibold text-slate-100">{stage.name}</span>:{' '}
          <span className="font-mono">{value === null ? t('sin medida', 'no data') : `${value} ms`}</span>
        </p>
        <p>
          <span className="text-slate-500">{t('Qué incluye:', 'What it includes:')}</span> {stage.includes}
        </p>
        <p>
          <span className="text-slate-500">{t('Cómo se mide:', 'How it is measured:')}</span>{' '}
          {t(
            `desde ${stage.from} hasta ${stage.to}. Las cifras son las de un frame real: el de latencia total mediana entre los seguidos en el último segundo.`,
            `from ${stage.from} to ${stage.to}. The figures are those of a real frame: the one with the median total latency among those tracked in the last second.`,
          )}
        </p>
        <p className="text-slate-400">
          <span className="text-slate-500">{t('Incertidumbre:', 'Uncertainty:')}</span>{' '}
          {stage.uncertainty === 'server' && t('las dos horas son del reloj del servidor: precisión de milisegundos.', 'both timestamps come from the server clock: millisecond precision.')}
          {stage.uncertainty === 'browser' && t('las dos horas son del reloj del navegador: la limita el periodo de refresco de pantalla (unos 17 ms a 60 Hz).', 'both timestamps come from the browser clock: limited by the display refresh period (about 17 ms at 60 Hz).')}
          {stage.uncertainty === 'both' &&
            t(
              `una hora es del servidor y la otra del navegador, así que se suma el error de sincronización de relojes${
                clockError === null ? '' : ` (±${clockError.toFixed(1)} ms ahora)`
              }.`,
              `one timestamp is from the server and the other from the browser, so the clock synchronisation error adds up${
                clockError === null ? '' : ` (±${clockError.toFixed(1)} ms now)`
              }.`,
            )}
        </p>
      </div>
    </div>
  );
};
