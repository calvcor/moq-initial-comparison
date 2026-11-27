import React, { useEffect, useRef, useState } from 'react';
import { FullscreenButton, toggleFullscreen } from './FullscreenButton';
import * as Watch from '@moq/watch';
import * as Net from '@moq/net';
import { Signal } from '@moq/signals';
import { GlassMeter, RateWindow, DEFAULT_TIMECODE, WATCHDOG_MS, WATCHDOG_GRACE_MS } from '../lib/glass';
import { meters } from '../lib/qoe';
import { MoqBufferMeter, MoqTracer } from '../lib/trace';
import { MoqProbeAbr } from '../lib/moqProbe';
import { decodedFrame, delayValue, isViewersApi, paintedFrame, playerProps, toMs } from '../lib/moqApi';
import { MoqExplain } from './MoqExplain';
import type { MoqAbr, MoqSwitching, PlayerMetrics, PlayerPreset, Rendition, TimecodeLayout } from '../types';
import { t } from '../lib/i18n';

const SWITCHING_KEY = 'testbed.moqSwitching';
const ABR_KEY = 'testbed.moqAbr';

/** Algoritmo de adaptación recordado en este navegador; por defecto, el de @moq/watch. */
function loadAbr(): MoqAbr {
  try {
    const saved = localStorage.getItem(ABR_KEY);
    if (saved === 'probe' || saved === 'probe2') return saved;
  } catch (_) {}
  return 'watch';
}

/** Variante de cambio recordada en este navegador; si no hay o no se puede leer, la original. */
function loadSwitching(): MoqSwitching {
  try {
    const saved = localStorage.getItem(SWITCHING_KEY);
    if (saved === 'cancel' || saved === 'priority') return saved;
  } catch (_) {}
  return 'seamless';
}

interface MoqPlayerProps {
  url: string;
  isStreaming: boolean;
  timecodes?: TimecodeLayout[];
  renditions?: Rendition[];
  audible: boolean; // sonido activado (selector de sonido del dashboard)
  // Ajustes de una prueba de campaña. Con ellos, adaptación y cambio de calidad son los de la campaña (por
  // defecto, los de @moq/watch), no los recordados en el navegador
  preset?: PlayerPreset;
  onMetricsUpdate: (metrics: Partial<PlayerMetrics>) => void;
}

export const MoqPlayer: React.FC<MoqPlayerProps> = ({
  url,
  isStreaming,
  timecodes,
  renditions,
  audible,
  preset,
  onMetricsUpdate,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null); // zona de vídeo, la que pasa a pantalla completa
  const [status, setStatus] = useState<'idle' | 'connecting' | 'playing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // 0 = auto: no se fija nada y @moq/watch dimensiona el búfer con el RTT que le comunica el relay
  const [targetLatencyMs, setTargetLatencyMs] = useState<number>(preset?.targetMs ?? 0);
  const [resolvedDelayMs, setResolvedDelayMs] = useState<number | null>(null);
  // El retardo en el formato de la versión instalada: milisegundos (bc64b9c) o un Duration (c19c723); lib/moqApi.ts
  const toDelay = (ms: number) => delayValue(playerRef.current, ms);
  const playerRef = useRef<Watch.Player | null>(null);
  const connectionRef = useRef<Net.Connection | null>(null);
  const delaySignalRef = useRef<Signal<any> | null>(null);
  // Silencio de @moq/watch: el reproductor lo sigue en vivo, sin reconectar
  const mutedSignalRef = useRef(new Signal<boolean>(!audible));
  useEffect(() => {
    mutedSignalRef.current.set(!audible);
  }, [audible]);

  // Cambio de calidad hacia abajo (opción `switching` del parche de web/patches, docs/adaptation-and-experiments.md). 'seamless' es el
  // comportamiento original de @moq/watch; las otras dos son el experimento. Sin el parche (versión de npm) la
  // opción no existe, el selector se desactiva y el CSV la deja vacía.
  // Se recuerda en el navegador, como los reproductores activos: la opción solo actúa en el siguiente cambio y
  // el primero llega a los pocos segundos de cargar, así que tiene que estar puesta antes de conectar.
  const [switching, setSwitching] = useState<MoqSwitching>(() => (preset ? (preset.options?.moq_switching ?? 'seamless') : loadSwitching()));
  const switchingSignalRef = useRef(new Signal<MoqSwitching>(switching));
  const [switchingSupported, setSwitchingSupported] = useState<boolean>(__EXPERIMENTS__.moqSwitching);
  const handleSwitchingChange = (value: MoqSwitching) => {
    setSwitching(value);
    switchingSignalRef.current.set(value);
    try {
      localStorage.setItem(SWITCHING_KEY, value);
    } catch (_) {}
  };
  useEffect(() => {
    onMetricsUpdate({ switching: switchingSupported === false ? null : switching });
  }, [switching, switchingSupported]);

  // Adaptación: 'watch' deja decidir a @moq/watch (el comportamiento que se mide); 'probe' y 'probe2' son el experimento
  // de docs/adaptation-and-experiments.md, un controlador propio con sondeo por prioridad que pide la calidad a la librería por target.name.
  const [abr, setAbr] = useState<MoqAbr>(() => (preset ? (preset.options?.moq_abr ?? 'watch') : loadAbr()));
  const [showExplain, setShowExplain] = useState(false);
  const abrRef = useRef<MoqAbr>(abr);
  const probeAbrRef = useRef<MoqProbeAbr | null>(null);
  const handleAbrChange = (value: MoqAbr) => {
    setAbr(value);
    abrRef.current = value;
    try {
      localStorage.setItem(ABR_KEY, value);
    } catch (_) {}
  };
  // El experimento de sondeo usa la API de pistas de bc64b9c (prioridad y maxDelay); con la de c19c723 en adelante
  // (lib/moqApi.ts) no arranca, y decide la librería: el panel y el CSV anotan entonces 'watch', la que decide de verdad
  const [abrSupported, setAbrSupported] = useState<boolean>(__EXPERIMENTS__.moqProbe);
  const abrSupportedRef = useRef<boolean>(__EXPERIMENTS__.moqProbe);
  const effectiveAbr: MoqAbr = !abrSupported ? 'watch' : abr;
  useEffect(() => {
    onMetricsUpdate({ moqAbr: effectiveAbr });
  }, [effectiveAbr]);

  const handleLatencyChange = (newMs: number) => {
    setTargetLatencyMs(newMs);
    if (delaySignalRef.current) {
      delaySignalRef.current.set(toDelay(newMs));
    }
  };

  // El medidor vive lo que el componente, no lo que cada intento de reproducción: así los congelados
  // se siguen contando mientras la vigilancia recrea el reproductor.
  const meterRef = useRef<GlassMeter | null>(null);
  const ladderRef = useRef(renditions);
  ladderRef.current = renditions;
  const timecodesRef = useRef<TimecodeLayout[]>([DEFAULT_TIMECODE]);
  if (timecodes?.length) timecodesRef.current = timecodes;
  const restartsRef = useRef(0);
  const [attempt, setAttempt] = useState(0);

  // Calidad: 'auto' deja toda la decisión a @moq/watch, sin intervenir; un número fija la rendition con
  // esa altura. Se aplica en el muestreo, cuando el catálogo ya la anuncia.
  const [quality, setQuality] = useState<number | 'auto'>(preset?.quality ?? 'auto');
  const qualityRef = useRef<number | 'auto'>(preset?.quality ?? 'auto');
  const switchesRef = useRef(0);
  const lastTrackRef = useRef<string | null>(null);

  const handleQualityChange = (value: number | 'auto') => {
    setQuality(value);
    qualityRef.current = value;
  };

  useEffect(() => {
    onMetricsUpdate({ targetLatencyMs: targetLatencyMs > 0 ? targetLatencyMs : null });
  }, [targetLatencyMs]);

  useEffect(() => {
    // El frame que el reproductor acaba de dibujar en el canvas. Se clona porque el reproductor cierra el
    // suyo en cuanto dibuja el siguiente.
    const grab = () => {
      try {
        return paintedFrame(playerRef.current)?.clone() ?? null;
      } catch (_) {
        return null;
      }
    };
    const glassMeter = new GlassMeter(grab, () => timecodesRef.current);
    meterRef.current = glassMeter;
    meters.moq = glassMeter;
    return () => {
      glassMeter.close();
      if (meters.moq === glassMeter) delete meters.moq;
    };
  }, []);

  useEffect(() => {
    if (!isStreaming) {
      if (playerRef.current) {
        try {
          playerRef.current.close();
        } catch (_) {}
        playerRef.current = null;
      }
      if (connectionRef.current) {
        try {
          connectionRef.current.close();
        } catch (_) {}
        connectionRef.current = null;
      }
      setStatus('idle');
      return;
    }

    if (!('WebTransport' in window)) {
      setStatus('error');
      setErrorMsg(t('WebTransport no está soportado en este navegador. Usa Chrome o Edge.', 'WebTransport is not supported in this browser. Use Chrome or Edge.'));
      onMetricsUpdate({ status: 'error', errorMessage: 'WebTransport no soportado' });
      return;
    }

    setStatus('connecting');
    let isAborted = false;
    let retryTimer: any = null;
    let metricsInterval: any = null;
    let tracer: MoqTracer | null = null;
    let bufferMeter: MoqBufferMeter | null = null;
    let stopProbeWatch: (() => void) | null = null;
    const rate = new RateWindow();
    const networkRate = new RateWindow();
    let networkSource: PlayerMetrics['networkSource'];
    const meter = meterRef.current!;

    // Vigilancia: si no hay imagen nueva durante WATCHDOG_MS (suscripción rechazada, emisión reiniciada, conexión muerta),
    // se recrea el reproductor en vez de esperar a que alguien recargue la pestaña.
    const startedAt = performance.now();
    const watchdog = setInterval(() => {
      const frozen = meter.frozenMs();
      if (frozen !== null && frozen > WATCHDOG_MS && performance.now() - startedAt > WATCHDOG_GRACE_MS) {
        console.warn(`[MoQ] ${Math.round(frozen / 1000)} s sin imagen nueva: se recrea el reproductor`);
        restartsRef.current++;
        setAttempt((a) => a + 1);
      }
    }, 1000);

    async function initMoQ() {
      try {
        // 1. Huella del certificado autofirmado del relay (solo en local; con SERVER_HOST, 404 y se valida la cadena)
        let hexFingerprint = '';
        try {
          const res = await fetch('/certificate.sha256', { cache: 'no-store' });
          if (res.ok) {
            hexFingerprint = (await res.text()).trim();
            console.log('[MoQ] Fingerprint de moq-relay obtenido:', hexFingerprint);
          }
        } catch (e) {
          console.warn('[MoQ] No se pudo obtener fingerprint de moq-relay:', e);
        }

        if (isAborted) return;

        // 2. Conexión segura QUIC con pinning SHA-256
        const targetUrl = new URL(url);
        const connection = new Net.Connection({
          url: targetUrl,
          enabled: true,
          webtransport: hexFingerprint
            ? {
                serverCertificateHashes: [{ algorithm: 'sha-256', value: hexFingerprint }],
              }
            : undefined,
        });
        connectionRef.current = connection;
        abrSupportedRef.current = __EXPERIMENTS__.moqProbe && !isViewersApi(connection);
        setAbrSupported(abrSupportedRef.current);
        // @moq/net solo abre el canal PROBE con el relay mientras alguien observa connection.probe, y @moq/watch deja de
        // observarlo cuando se le pide una calidad por nombre (el sondeo o una calidad fijada a mano): sin esto, en esos
        // casos no llegaría ninguna estimación al panel ni al CSV. Observarla solo mantiene abierto ese canal, por el que
        // el relay informa de su estimación de vez en cuando; no cambia qué calidad se elige ni cómo envía (docs/adaptation-and-experiments.md).
        stopProbeWatch = connection.probe.subscribe(() => {});

        // 3. Instanciar el reproductor oficial @moq/watch con jitter buffer y control reactivo
        // El retardo empieza en 'auto' y se fija en cuanto existe el reproductor: en c19c723 es un Duration, cuya
        // clase se toma del propio reproductor (lib/moqApi.ts)
        const delaySignal = new Signal<any>('auto');
        delaySignalRef.current = delaySignal;

        const targetSignal = new Signal<Watch.Video.Target | undefined>(undefined);
        // Las opciones cambian de forma entre versiones (lib/moqApi.ts); las dos se conectan como <moq-watch>.
        // - Esperar al anuncio de la emisión antes de suscribirse (announced, o follow en c19c723): justo tras un
        //   reinicio del publicador todavía no existe y una suscripción a ciegas se rechaza sin reintento.
        // - visible: 'always'. Por defecto @moq/watch deja de descargar el vídeo cuando el canvas sale de la vista (al
        //   hacer scroll hasta las métricas, por ejemplo). Aquí debe seguir, como hacen los otros dos reproductores, o
        //   la medida se interrumpe cada vez que se mira otra parte de la página.
        // - `buffer` (lookahead en c19c723) se deja en su valor por defecto (0): tolera media adelantada sin
        //   recolocarse hacia el directo, y con un valor mayor la latencia real queda por encima de la del slider.
        // - switching: solo la entiende bc64b9c con el parche de web/patches; las demás ignoran la propiedad.
        const player = new Watch.Player(
          playerProps(connection, {
            origin: connection.origin,
            name: Net.Path.from('live.hang'),
            canvas: canvasRef.current || undefined,
            muted: mutedSignalRef.current,
            delay: delaySignal,
            target: targetSignal,
            switching: switchingSignalRef.current,
          }),
        );
        delaySignal.set(delayValue(player, targetLatencyMs));
        setSwitchingSupported(__EXPERIMENTS__.moqSwitching && 'switching' in (player.in as object));
        playerRef.current = player;
        // Acceso desde la consola del navegador para depurar
        (window as any).moqPlayer = player;

        // Seguimiento de frames concretos por las etapas del recorrido
        tracer = new MoqTracer(
          player,
          meter,
          () => (ladderRef.current ?? []).findIndex((r) => r.height === paintedFrame(player)?.displayHeight),
          (stages) => onMetricsUpdate({ stages }),
        );

        bufferMeter = new MoqBufferMeter(player);

        if (isAborted) return;
        setStatus('playing');
        console.log('[MoQ] Reproductor @moq/watch inicializado con éxito en live.hang');

        // 4. Muestreo de métricas cada 500 ms
        metricsInterval = setInterval(() => {
          if (isAborted || !playerRef.current) return;
          try {
            const syncDelay = toMs(player.sync.out.delay.peek());
            if (syncDelay !== undefined) setResolvedDelayMs(Math.round(syncDelay));
            const held = bufferMeter?.take() ?? null;
            const videoStats = player.video.out.stats.peek();
            if (videoStats) rate.push(videoStats.bytesReceived);
            // Descarga total: bytes recibidos por la conexión WebTransport (todas las pistas y la señalización).
            // Chrome no implementa WebTransport.getStats(): en ese caso se suma la carga útil de las pistas.
            if (networkSource !== 'payload') {
              connection.stats().then((stats) => {
                if (stats?.bytesReceived === undefined) {
                  networkSource = 'payload';
                } else {
                  networkSource = 'transport';
                  networkRate.push(stats.bytesReceived);
                }
              }, () => {});
            } else if (videoStats) {
              networkRate.push(videoStats.bytesReceived + (player.audio.out.stats.peek()?.bytesReceived ?? 0));
            }
            const glass = meter.snapshot();

            // Calidad. En auto no se interviene: decide @moq/watch con su propia lógica (ancho de banda que
            // estima el relay y marcas "stalled" del catálogo). Solo al fijar una a mano se pide por nombre.
            const available = player.video.source.out.available.peek();
            // El controlador del experimento vive mientras esté elegido y la calidad esté en automático
            const variant = abrRef.current === 'watch' || abrSupportedRef.current === false ? null : abrRef.current;
            const probing = variant !== null && qualityRef.current === 'auto';
            // Al cambiar de variante se empieza de cero, con su propio controlador
            if (probeAbrRef.current && (!probing || probeAbrRef.current.variant !== variant)) {
              probeAbrRef.current.close();
              probeAbrRef.current = null;
            }
            if (__EXPERIMENTS__.moqProbe && MoqProbeAbr && probing && !probeAbrRef.current) {
              probeAbrRef.current = new MoqProbeAbr(player, variant);
              // Acceso desde la consola, como window.moqPlayer
              (window as any).moqProbeAbr = probeAbrRef.current;
            }
            const probeState = probeAbrRef.current?.state ?? null;
            const wanted =
              qualityRef.current === 'auto'
                ? probeState?.current && probeState.current in available
                  ? probeState.current
                  : undefined
                : Object.keys(available).find((name) => available[name].codedHeight === qualityRef.current);
            if (targetSignal.peek()?.name !== wanted) targetSignal.set(wanted ? { name: wanted } : undefined);
            const estimate = connection.probe.peek()?.estimatedRecvRate;

            const track = player.video.source.out.track.peek() ?? null;
            const rendition = player.video.source.out.config.peek();
            if (track && lastTrackRef.current && track !== lastTrackRef.current) switchesRef.current++;
            if (track) lastTrackRef.current = track;

            onMetricsUpdate({
              protocol: 'Media over QUIC',
              latencyMs: glass.latencyMs,
              // Retardo del playhead respecto al live edge según el búfer de sincronización
              reportedLatencyMs: typeof syncDelay === 'number' ? Math.round(syncDelay) : null,
              bitrateKbps: rate.kbps(),
              networkKbps: networkRate.kbps(),
              networkSource,
              fps: glass.fps,
              frameTimeSdMs: glass.frameTimeSdMs,
              frameTimeP95Ms: glass.frameTimeP95Ms,
              frameTimeMaxMs: glass.frameTimeMaxMs,
              frameTimes: glass.frameTimes,
              // Tiempo medio que los frames entregados desde la última muestra pasaron retenidos en el reproductor
              bufferLengthSec: held === null ? null : Number(held.toFixed(3)),
              stalls: glass.stalls,
              stallMs: glass.stallMs,
              contentSpeed: glass.contentSpeed,
              contentSkippedMs: glass.contentSkippedMs,
              restarts: restartsRef.current,
              // Altura del frame que de verdad se está pintando y, aparte, la rendition seleccionada: la
              // librería cambia sin corte y mientras dura el cambio (que puede no completarse) no coinciden
              renditionHeight: decodedFrame(player)?.displayHeight ?? rendition?.codedHeight ?? null,
              selectedHeight: rendition?.codedHeight ?? null,
              renditionKbps: rendition?.bitrate ? Math.round(rendition.bitrate / 1000) : null,
              qualitySwitches: switchesRef.current,
              // Tasa de recepción que estima el relay con su control de congestión (mensajes PROBE)
              bandwidthEstimateKbps: estimate ? Math.round(estimate / 1000) : null,
              qualityMode: qualityRef.current === 'auto' ? 'auto' : 'manual',
              probing: probeState ? probeState.probing : null,
              probeCapacityKbps: probeState ? probeState.capacityKbps : null,
              probeCount: probeState ? probeState.probes : null,
              probeCuts: probeState ? probeState.cuts : null,
              status: 'playing',
            });
          } catch (_) {}
        }, 500);
      } catch (err: any) {
        if (isAborted) return;
        console.warn('[MoQ Watch Error - reintentando]:', err);
        setStatus('connecting');
        retryTimer = setTimeout(() => {
          if (!isAborted && isStreaming) {
            initMoQ();
          }
        }, 1200);
      }
    }

    initMoQ();

    return () => {
      isAborted = true;
      clearTimeout(retryTimer);
      clearInterval(metricsInterval);
      clearInterval(watchdog);
      probeAbrRef.current?.close();
      probeAbrRef.current = null;
      tracer?.close();
      bufferMeter?.close();
      stopProbeWatch?.();
      if (playerRef.current) {
        try {
          playerRef.current.close();
        } catch (_) {}
        playerRef.current = null;
      }
      if (connectionRef.current) {
        try {
          connectionRef.current.close();
        } catch (_) {}
        connectionRef.current = null;
      }
    };
  }, [url, isStreaming, attempt]);

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800/80 border-b border-slate-700/50">
        <div className="flex items-center space-x-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <h3 className="font-semibold text-sm text-slate-200">Media over QUIC (MoQ / WebTransport)</h3>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-300 border border-emerald-700/40 font-mono">
          HTTP/3 QUIC (UDP 4433)
        </span>
      </div>

      <div
        ref={screenRef}
        data-player="moq"
        onDoubleClick={() => toggleFullscreen(screenRef.current)}
        className="group relative aspect-video bg-black flex items-center justify-center"
      >
        <FullscreenButton target={screenRef} />
        <canvas
          ref={canvasRef}
          width={1920}
          height={1080}
          className="w-full h-full object-contain"
        />

        {status === 'connecting' && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center space-y-2">
            <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-slate-400">{t('Negociando sesión WebTransport QUIC...', 'Negotiating WebTransport QUIC session...')}</span>
          </div>
        )}

        {status === 'idle' && (
          <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center text-slate-500 space-y-1">
            <p className="text-sm font-medium">{t('Stream detenido', 'Stream stopped')}</p>
            <p className="text-xs text-slate-600">{t('Inicia el pipeline desde el panel de control', 'Start the pipeline from the control panel')}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 bg-red-950/80 flex flex-col items-center justify-center text-red-300 p-4 text-center">
            <p className="text-sm font-semibold">{t('Error de Conexión MoQ', 'MoQ connection error')}</p>
            <p className="text-xs text-red-400 mt-1 max-w-sm">{errorMsg}</p>
          </div>
        )}
      </div>

      {/* Control de Latencia Objetivo en Vivo */}
      <div
        className="px-4 py-2.5 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs"
        title={t(
          'Búfer de jitter de @moq/watch (opción delay), no la latencia total: un retardo de red constante se suma aparte. Con un valor fijo, ese valor. En auto depende de la versión: la 0.6.3 publicada lo calcula como 1,25 veces el RTT mínimo (suelo de 20 ms) y no lo sube durante la sesión hasta recargar; la compilada desde main (git@…) lo estima de lo tarde que llegan los frames respecto al más rápido de los últimos 2 s (percentil 95, techo de unos 2 s): sube al empeorar la red y baja al estabilizarse, aunque la red siga lenta. En ambos casos se suma el jitter que declara el catálogo; el resultado es el que se muestra entre paréntesis.',
          '@moq/watch jitter buffer (delay option), not the total latency: a constant network delay adds on top. With a fixed value, that value. In auto it depends on the version: the published 0.6.3 computes it as 1.25 times the minimum RTT (20 ms floor) and does not raise it during the session until reload; the one built from main (git@…) estimates it from how late frames arrive relative to the fastest one in the last 2 s (95th percentile, ceiling of about 2 s): it rises when the network worsens and drops when it stabilises, even if the network stays slow. In both cases the jitter declared by the catalog is added; the result is the one shown in parentheses.',
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <span className="text-slate-400 font-medium whitespace-nowrap">{t('Latencia objetivo:', 'Target latency:')}</span>
          <span className="font-mono text-emerald-400 font-semibold whitespace-nowrap">
            {targetLatencyMs === 0 ? 'auto (RTT)' : `${targetLatencyMs}ms`}
            {resolvedDelayMs !== null && t(` (efectiva ${resolvedDelayMs}ms)`, ` (effective ${resolvedDelayMs}ms)`)}
          </span>
        </div>
        <div className="flex items-center space-x-3 flex-1 min-w-[10rem] max-w-xs ml-auto">
          <span className="text-[10px] text-slate-500 font-mono">auto</span>
          <input
            type="range"
            min={0}
            max={2000}
            step={50}
            value={targetLatencyMs}
            onChange={(e) => handleLatencyChange(parseInt(e.target.value, 10))}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
          <span className="text-[10px] text-slate-500 font-mono">2000ms</span>
        </div>
      </div>

      <div className="px-4 py-2 bg-slate-950/60 border-t border-slate-800/60 text-[11px] text-slate-500 font-mono space-y-1.5">
        <div className="truncate" title={`${url}/live.hang`}>
          Relay: {url}/live.hang
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <label
          className="flex items-center space-x-1.5 whitespace-nowrap"
          title={t(
            'Experimento, no el comportamiento de @moq/watch. Librería: decide @moq/watch (la estimación del relay y su regla del 80 %). Sondeo: decide un controlador del banco que, a ratos, pide la calidad siguiente con la prioridad mínima y sube si cabe en lo que reciben las dos; baja si la actual deja de llegar a su ritmo (docs/adaptation-and-experiments.md). Sondeo v2: el mismo, sin pedir 10 s de atraso de golpe y subiendo también si la siguiente llega a su ritmo. Solo actúa con Calidad en Auto. Se recuerda en este navegador.',
            'Experiment, not the @moq/watch behaviour. Library: @moq/watch decides (the relay estimate and its 80 % rule). Probing: a testbed controller decides; every so often it requests the next rendition with the lowest priority and switches up if it fits in what both receive; it switches down if the current one stops keeping up with its frame rate (docs/adaptation-and-experiments.md). Probing v2: the same, without requesting a 10 s backlog at once and also switching up if the next one keeps up with its frame rate. Only acts with Rendition on Auto. Remembered in this browser.',
          )}
        >
          <span>ABR:</span>
          <select
            value={effectiveAbr}
            onChange={(e) => handleAbrChange(e.target.value as MoqAbr)}
            className="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-emerald-500"
          >
            <option value="watch">{t('Librería', 'Library')}</option>
            <option value="probe" disabled={abrSupported === false}>{t('Sondeo', 'Probing')}{abrSupported === false ? t(' (no con esta versión)', ' (not with this version)') : ''}</option>
            <option value="probe2" disabled={abrSupported === false}>{t('Sondeo v2', 'Probing v2')}{abrSupported === false ? t(' (no con esta versión)', ' (not with this version)') : ''}</option>
          </select>
        </label>
        <label
          className="flex items-center space-x-1.5 whitespace-nowrap"
          title={t(
            'Experimento, no el comportamiento de @moq/watch: qué hacer al bajar de calidad. Se recuerda en este navegador. Sin corte: el original, sigue descargando la calidad anterior hasta que la nueva la alcanza. Cancelar: deja de descargar la anterior al momento y congela su última imagen hasta que la nueva la alcanza. Prioridad: sin corte, pero la nueva calidad se pide con más prioridad que la anterior. Subir de calidad es siempre sin corte. Se aplica al siguiente cambio, sin reconectar.',
            'Experiment, not the @moq/watch behaviour: what to do when switching down. Remembered in this browser. Seamless: the original, keeps downloading the previous rendition until the new one catches up. Cancel: stops downloading the previous one at once and freezes its last frame until the new one catches up. Priority: seamless, but the new rendition is requested with higher priority than the previous one. Switching up is always seamless. Applies to the next switch, without reconnecting.',
          )}
        >
          <span>{t('Cambio:', 'Switching:')}</span>
          <select
            value={switching}
            disabled={switchingSupported === false}
            onChange={(e) => handleSwitchingChange(e.target.value as MoqSwitching)}
            className="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          >
            <option value="seamless">{t('Sin corte', 'Seamless')}</option>
            <option value="cancel">{t('Cancelar', 'Cancel')}</option>
            <option value="priority">{t('Prioridad', 'Priority')}</option>
          </select>
        </label>
        <label className="flex items-center space-x-1.5 whitespace-nowrap" title={t('Auto deja decidir al algoritmo de adaptación del reproductor; fijar una calidad lo desactiva.', 'Auto lets the player\'s adaptation algorithm decide; fixing a rendition disables it.')}>
          <span>{t('Calidad:', 'Rendition:')}</span>
          <select
            value={quality}
            onChange={(e) => handleQualityChange(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
            className="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-emerald-500"
          >
            <option value="auto">Auto</option>
            {(renditions ?? []).map((r) => (
              <option key={`${r.height}-${r.bitrate_kbps}`} value={r.height}>
                {r.height}p · {r.bitrate_kbps} kbps
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setShowExplain((v) => !v)}
          className="ml-auto text-emerald-400 hover:text-emerald-300 whitespace-nowrap"
          title={t('Cómo sube y baja de calidad este reproductor con las opciones elegidas', 'How this player switches renditions up and down with the selected options')}
        >
          {showExplain ? t('Ocultar explicación ▴', 'Hide explanation ▴') : t('Cómo funciona ▾', 'How it works ▾')}
        </button>
        </div>
      </div>
      {showExplain && (
        <div className="px-4 py-3 bg-slate-950/80 border-t border-slate-800/60 text-[11px] leading-relaxed text-slate-400">
          <MoqExplain abr={effectiveAbr} switching={switching} quality={quality} switchingSupported={switchingSupported} />
        </div>
      )}
    </div>
  );
};
