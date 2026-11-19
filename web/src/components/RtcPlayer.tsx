import React, { useEffect, useRef, useState } from 'react';
import { FullscreenButton, toggleFullscreen } from './FullscreenButton';
import { GlassMeter, RateWindow, grabFromVideo, DEFAULT_TIMECODE, WATCHDOG_MS, WATCHDOG_GRACE_MS } from '../lib/glass';
import { meters } from '../lib/qoe';
import { RtcTracer } from '../lib/trace';
import { serverNowMs } from '../lib/clock';
import { openMediasoup, openWhep, type RtcCallbacks, type SfuStats } from '../lib/rtcSession';
import type { PlayerMetrics, PlayerPreset, Rendition, TimecodeLayout } from '../types';
import { t } from '../lib/i18n';

interface RtcPlayerProps {
  isStreaming: boolean;
  server: 'mediasoup' | 'mediamtx'; // servidor de la rama (RTC_SERVER)
  renditions: Rendition[]; // escalera de la emisión: con mediasoup, las capas posibles
  mtxPath: string; // con MediaMTX, path que se pide por WHEP
  signalUrl: string; // con mediasoup, WebSocket de señalización (sfuSignalUrl)
  ingest: 'udp' | 'rtsp' | 'rtp'; // cómo le llega el flujo al servidor
  withAudio: boolean; // la rama lleva audio (opción rtc_audio del servidor): se pide también la pista de audio
  audible: boolean; // sonido activado (selector de sonido del dashboard)
  streamStartedMs: number; // hora del servidor (ms epoch) a la que arrancó el empaquetador WebRTC (stream_ids.rtc)
  timecodes?: TimecodeLayout[];
  preset?: PlayerPreset; // ajustes de una prueba de campaña (la calidad la elige el servidor: se ignora quality)
  onMetricsUpdate: (metrics: Partial<PlayerMetrics>) => void;
}

// Señalización de MediaMTX por WHEP, a través del punto de entrada. El vídeo va después directo por UDP.
// El path depende de la ingesta del servidor: liveudp (MPEG-TS por UDP) o live (RTSP, la versión anterior).
const whepUrl = (path: string) => `/rtc/${path}/whep`;

// Tras un reinicio de la emisión no se conecta hasta que esta lleva unos segundos publicada. Una conexión
// abierta en los primeros segundos recibe de golpe el último segundo de media y, con audio, el navegador
// deja el vídeo sincronizado 45-55 ms por encima de lo que queda una conexión abierta más tarde, durante
// toda la sesión (medido el 22-10-2026: README, sección 3.4b). Sin esta espera, aplicar un cambio sin
// recargar la página medía ese caso y recargarla, el otro. El empaquetador tarda 1-2 s en publicar
// (keyframe y sondeo de la entrada); desde ahí, 6 s bastan.
const JOIN_AFTER_START_MS = 8000;

/** Altura de la capa que envía mediasoup: las capas van de la más baja (0) a la más alta, como la escalera ordenada. */
function sfuLayerHeight(sfu: SfuStats | null, renditions: { height: number }[]): number | null {
  if (!sfu || sfu.spatial_layer === null || sfu.layers !== renditions.length) return null;
  return [...renditions].sort((a, b) => a.height - b.height)[sfu.spatial_layer]?.height ?? null;
}

export const RtcPlayer: React.FC<RtcPlayerProps> = ({ isStreaming, server, renditions, mtxPath, signalUrl, ingest, withAudio, audible, streamStartedMs, timecodes, preset, onMetricsUpdate }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null); // zona de vídeo, la que pasa a pantalla completa

  // El atributo muted del <video> solo vale al montarlo: después se cambia la propiedad
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !audible;
  }, [audible]);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'playing' | 'error'>('idle');
  // Búfer de jitter que se le pide al navegador (RTCRtpReceiver.jitterBufferTarget). 0 = no pedir nada
  // y dejar el comportamiento por defecto del navegador, que lo ajusta solo.
  const [targetMs, setTargetMs] = useState<number>(preset?.targetMs ?? 0);
  const targetRef = useRef(preset?.targetMs ?? 0);
  const receiverRef = useRef<RTCRtpReceiver | null>(null);

  // El medidor vive lo que el componente, no lo que cada intento de reproducción: así los congelados
  // se siguen contando mientras la vigilancia recrea el reproductor.
  const meterRef = useRef<GlassMeter | null>(null);
  const timecodesRef = useRef<TimecodeLayout[]>([DEFAULT_TIMECODE]);
  if (timecodes?.length) timecodesRef.current = timecodes;
  const restartsRef = useRef(0);
  const switchesRef = useRef(0); // cambios de altura de lo que llega: los decide el servidor
  const renditionsRef = useRef(renditions);
  renditionsRef.current = renditions;
  const [attempt, setAttempt] = useState(0);
  const [joinWaitS, setJoinWaitS] = useState<number | null>(null); // espera antes de conectar tras un reinicio

  const applyTarget = (receiver: RTCRtpReceiver | null, ms: number) => {
    if (receiver && 'jitterBufferTarget' in receiver) (receiver as any).jitterBufferTarget = ms > 0 ? ms : null;
  };

  const handleTargetChange = (ms: number) => {
    setTargetMs(ms);
    targetRef.current = ms;
    applyTarget(receiverRef.current, ms);
  };

  useEffect(() => {
    onMetricsUpdate({ targetLatencyMs: targetMs > 0 ? targetMs : null });
  }, [targetMs]);

  useEffect(() => {
    onMetricsUpdate({ status });
  }, [status]);

  useEffect(() => {
    const glassMeter = new GlassMeter(() => grabFromVideo(videoRef.current), () => timecodesRef.current);
    meterRef.current = glassMeter;
    meters.rtc = glassMeter;
    return () => {
      glassMeter.close();
      if (meters.rtc === glassMeter) delete meters.rtc;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!isStreaming || !video) {
      setStatus('idle');
      return;
    }

    setStatus('connecting');
    let isAborted = false;
    let retryTimer: any = null;
    let joinTimer: any = null;
    const meter = meterRef.current!;
    const rate = new RateWindow();
    const networkRate = new RateWindow();
    const callbacks: RtcCallbacks = {
      // Las pistas en el mismo MediaStream del <video>, lleguen en el orden que lleguen
      onTrack: (track, stream) => {
        if (stream) {
          if (video.srcObject !== stream) video.srcObject = stream;
        } else {
          const current = video.srcObject instanceof MediaStream ? video.srcObject : new MediaStream();
          current.addTrack(track);
          video.srcObject = current;
        }
        video.play().catch(() => {});
      },
      onState: (state) => {
        if (isAborted) return;
        if (state === 'connected') setStatus('playing');
        if (state === 'failed') setStatus('connecting');
      },
      onReceiver: (receiver) => {
        receiverRef.current = receiver;
        applyTarget(receiver, targetRef.current);
      },
    };
    const session = server === 'mediasoup' ? openMediasoup(signalUrl, withAudio, callbacks) : openWhep(whepUrl(mtxPath), withAudio, callbacks);

    async function negotiate() {
      try {
        await session.start();
      } catch (err) {
        if (isAborted) return;
        // Lo habitual justo tras un arranque: el servidor aún no tiene la emisión publicada
        console.warn('[WebRTC] negociación fallida, reintentando:', err);
        retryTimer = setTimeout(() => !isAborted && setAttempt((a) => a + 1), 1500);
      }
    }
    const now = serverNowMs() ?? Date.now();
    const joinWait = Math.max(0, streamStartedMs + JOIN_AFTER_START_MS - now);
    setJoinWaitS(joinWait > 0 ? Math.ceil(joinWait / 1000) : null);
    joinTimer = setTimeout(() => {
      setJoinWaitS(null);
      negotiate();
    }, joinWait);

    // Vigilancia: si no hay imagen nueva durante WATCHDOG_MS (emisión reiniciada, conexión muerta),
    // se recrea la conexión en vez de esperar a que alguien recargue la pestaña.
    const startedAt = performance.now() + joinWait;
    const watchdog = setInterval(() => {
      const frozen = meter.frozenMs();
      if (frozen !== null && frozen > WATCHDOG_MS && performance.now() - startedAt > WATCHDOG_GRACE_MS) {
        console.warn(`[WebRTC] ${Math.round(frozen / 1000)} s sin imagen nueva: se recrea el reproductor`);
        restartsRef.current++;
        setAttempt((a) => a + 1);
      }
    }, 1000);

    // Seguimiento de frames concretos por las etapas del recorrido
    // Cada calidad es un flujo distinto para el servidor; con MediaMTX, siempre la más alta
    const tracer = new RtcTracer(video, meter, () => Math.max(0, renditionsRef.current.findIndex((r) => r.height === video.videoHeight)), (stages) => onMetricsUpdate({ stages }));

    // Muestreo de métricas cada 500 ms, de las estadísticas del propio navegador (getStats)
    let lastBuffer = { delay: 0, emitted: 0 };
    let lastHeight: number | null = null;
    let sfu: SfuStats | null = null;
    let ticks = 0;
    const interval = setInterval(async () => {
      if (isAborted || !session.connected()) return;
      try {
        // Lo que decide mediasoup, cada segundo (cada 2 s hasta el 4-11-2026): es una petición al servidor, no algo
        // que el navegador ya sepa; con filas de un segundo, cada 2 s repetía valor en la mitad de ellas
        if (session.sfuStats && ticks++ % 2 === 0) session.sfuStats().then((stats) => (sfu = stats));
        const report = await session.getStats();
        let inbound: any = null;
        let transport: any = null;
        report.forEach((entry: any) => {
          if (entry.type === 'inbound-rtp' && entry.kind === 'video') inbound = entry;
          if (entry.type === 'transport') transport = entry;
        });
        if (!inbound || isAborted) return;
        rate.push(inbound.bytesReceived);
        if (transport?.bytesReceived !== undefined) networkRate.push(transport.bytesReceived);

        // Tiempo medio que los frames emitidos desde la última muestra pasaron en el búfer de jitter
        const emitted = inbound.jitterBufferEmittedCount - lastBuffer.emitted;
        const bufferSec = emitted > 0 ? (inbound.jitterBufferDelay - lastBuffer.delay) / emitted : null;
        lastBuffer = { delay: inbound.jitterBufferDelay, emitted: inbound.jitterBufferEmittedCount };

        const height: number | null = inbound.frameHeight ?? null;
        if (height !== null) {
          if (lastHeight !== null && height !== lastHeight) switchesRef.current++;
          lastHeight = height;
        }

        const glass = meter.snapshot();
        onMetricsUpdate({
          protocol: 'WebRTC',
          latencyMs: glass.latencyMs,
          // WebRTC no declara una latencia respecto al directo: no hay equivalente a la de los otros dos
          reportedLatencyMs: null,
          bitrateKbps: rate.kbps(),
          networkKbps: networkRate.kbps(),
          networkSource: 'transport',
          fps: glass.fps,
          frameTimeSdMs: glass.frameTimeSdMs,
          frameTimeP95Ms: glass.frameTimeP95Ms,
          frameTimeMaxMs: glass.frameTimeMaxMs,
          frameTimes: glass.frameTimes,
          bufferLengthSec: bufferSec === null ? null : Number(bufferSec.toFixed(3)),
          stalls: glass.stalls,
          stallMs: glass.stallMs,
          contentSpeed: glass.contentSpeed,
          contentSkippedMs: glass.contentSkippedMs,
          restarts: restartsRef.current,
          renditionHeight: inbound.frameHeight ?? null,
          // La capa que envía mediasoup (0, la más baja): la que eligió; la que llega cambia en el siguiente keyframe
          selectedHeight: sfuLayerHeight(sfu, renditionsRef.current),
          renditionKbps: server === 'mediasoup' ? renditionsRef.current.find((r) => r.height === height)?.bitrate_kbps ?? null : null,
          qualitySwitches: switchesRef.current,
          bandwidthEstimateKbps: sfu?.available_kbps ?? null,
          qualityMode: server === 'mediasoup' ? 'auto' : 'manual',
          packetsLost: inbound.packetsLost ?? null,
        });
      } catch (_) {
        // La conexión se está cerrando
      }
    }, 500);

    return () => {
      isAborted = true;
      clearTimeout(retryTimer);
      clearTimeout(joinTimer);
      clearInterval(interval);
      clearInterval(watchdog);
      tracer.close();
      receiverRef.current = null;
      session.close();
      video.srcObject = null;
    };
  }, [isStreaming, attempt, withAudio, streamStartedMs, mtxPath, server, signalUrl]);

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800/80 border-b border-slate-700/50">
        <div className="flex items-center space-x-2">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
          <h3 className="font-semibold text-sm text-slate-200">WebRTC ({server === 'mediasoup' ? 'SFU' : 'WHEP'})</h3>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-700/40 font-mono">SRTP / UDP 8189</span>
      </div>

      <div
        ref={screenRef}
        data-player="rtc"
        onDoubleClick={() => toggleFullscreen(screenRef.current)}
        className="group relative aspect-video bg-black flex items-center justify-center"
      >
        <FullscreenButton target={screenRef} />
        <video ref={videoRef} className="w-full h-full object-contain" muted autoPlay playsInline />

        {status === 'connecting' && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center space-y-2">
            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-slate-400">
              {joinWaitS !== null
                ? t(
                    `Esperando a que la emisión lleve unos segundos publicada (~${joinWaitS} s)...`,
                    `Waiting until the stream has been published for a few seconds (~${joinWaitS} s)...`,
                  )
                : t('Negociando sesión WebRTC...', 'Negotiating WebRTC session...')}
            </span>
          </div>
        )}

        {status === 'idle' && (
          <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center text-slate-500 space-y-1">
            <p className="text-sm font-medium">{t('Stream detenido', 'Stream stopped')}</p>
            <p className="text-xs text-slate-600">{t('Inicia el pipeline desde el panel de control', 'Start the pipeline from the control panel')}</p>
          </div>
        )}
      </div>

      {/* Búfer de jitter objetivo */}
      <div
        className="px-4 py-2.5 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs"
        title={t(
          'Búfer de jitter que se pide al navegador (RTCRtpReceiver.jitterBufferTarget). En auto no se pide nada y el navegador lo ajusta solo según la red.',
          'Jitter buffer requested from the browser (RTCRtpReceiver.jitterBufferTarget). In auto nothing is requested and the browser adjusts it on its own to the network.',
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <span className="text-slate-400 font-medium whitespace-nowrap">{t('Búfer objetivo:', 'Target buffer:')}</span>
          <span className="font-mono text-amber-400 font-semibold whitespace-nowrap">{targetMs === 0 ? t('auto (navegador)', 'auto (browser)') : `${targetMs}ms`}</span>
        </div>
        <div className="flex items-center space-x-3 flex-1 min-w-[10rem] max-w-xs ml-auto">
          <span className="text-[10px] text-slate-500 font-mono">auto</span>
          <input
            type="range"
            min={0}
            max={2000}
            step={50}
            value={targetMs}
            onChange={(e) => handleTargetChange(parseInt(e.target.value, 10))}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
          />
          <span className="text-[10px] text-slate-500 font-mono">2000ms</span>
        </div>
      </div>

      <div className="px-4 py-2 bg-slate-950/60 border-t border-slate-800/60 text-[11px] text-slate-500 flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono">
        {server === 'mediasoup' ? (
          <span
            title={t(
              'Un FFmpeg pasa el MPEG-TS a RTP, sin recodificar, y mediasoup elige la capa de este espectador (RTC_SERVER=mediasoup). No atiende peticiones de keyframe: cada cambio espera al siguiente IDR.',
              'An FFmpeg passes the MPEG-TS to RTP, without re-encoding, and mediasoup picks the layer for this viewer (RTC_SERVER=mediasoup). Keyframe requests are not served: each switch waits for the next IDR.',
            )}
          >
            {t(`mediasoup · RTP · simulcast de ${renditions.length}`, `mediasoup · RTP · simulcast of ${renditions.length}`)}
          </span>
        ) : (
          <span
            title={
              ingest === 'udp'
                ? t('MediaMTX lee el MPEG-TS de la fuente por UDP, sin FFmpeg intermedio (RTC_INGEST=udp).', 'MediaMTX reads the source MPEG-TS over UDP, with no intermediate FFmpeg (RTC_INGEST=udp).')
                : t('Un FFmpeg remultiplexa el MPEG-TS y lo publica en MediaMTX por RTSP (RTC_INGEST=rtsp, la versión anterior).', 'An FFmpeg remuxes the MPEG-TS and publishes it to MediaMTX over RTSP (RTC_INGEST=rtsp, the previous version).')
            }
          >
            MediaMTX · {ingest === 'udp' ? t('UDP directo', 'direct UDP') : t('vía RTSP', 'via RTSP')} · {whepUrl(mtxPath)}
          </span>
        )}
        <span>{server === 'mediasoup' ? 'mediasoup-client' : 'RTCPeerConnection'} + &lt;video&gt;</span>
      </div>
    </div>
  );
};
