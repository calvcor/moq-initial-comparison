import React, { useEffect, useRef, useState } from 'react';
import { FullscreenButton, toggleFullscreen } from './FullscreenButton';
import * as dashjs from 'dashjs';
import { GlassMeter, RateWindow, grabFromVideo, DEFAULT_TIMECODE, WATCHDOG_MS, WATCHDOG_GRACE_MS } from '../lib/glass';
import { meters } from '../lib/qoe';
import { PlaybackRateTracker, rateTrackers } from '../lib/playbackRate';
import { DashTracer } from '../lib/trace';
import { DashExplain } from './DashExplain';
import { DASH_NEEDS_HOST } from '../lib/dashUrl';
import type { DashAbr, PlayerMetrics, PlayerPreset, Rendition, TimecodeLayout } from '../types';
import { t } from '../lib/i18n';

// Modo de corrección de latencia de dash.js: LoL+, que además de la latencia mira el búfer y frena por debajo
// de playbackBufferMin (0,5 s). Hasta el 27-10-2026 aquí ponía 'liveCatchupModeLoLp', que dash.js no reconoce,
// y se aplicaba su modo por defecto: las medidas de DASH anteriores y posteriores no son comparables.
const CATCHUP_MODE = 'liveCatchupModeLoLP';

interface DashPlayerProps {
  url: string | null; // siempre directa al router (lib/dashUrl.ts); null: no hay camino directo
  isStreaming: boolean;
  timecodes?: TimecodeLayout[];
  renditions?: Rendition[];
  audible: boolean; // sonido activado (selector de sonido del dashboard); el audio se descarga igual
  preset?: PlayerPreset; // ajustes de una prueba de campaña
  onMetricsUpdate: (metrics: Partial<PlayerMetrics>) => void;
}

export const DashPlayer: React.FC<DashPlayerProps> = ({
  url: manifestPath,
  isStreaming,
  timecodes,
  renditions,
  audible,
  preset,
  onMetricsUpdate,
}) => {
  // El navegador conecta siempre al servidor de DASH a través del router, y su propia conexión TCP es la que sufre la
  // red emulada, como en MoQ y WebRTC. Sin URL (página HTTPS sin DASH_HOST) no hay camino directo y no se reproduce:
  // desde el 12-11-2026 no se recurre al punto de entrada, que es un proxy.
  const url = manifestPath ?? '';
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null); // zona de vídeo, la que pasa a pantalla completa

  // El atributo muted del <video> solo vale al montarlo: después se cambia la propiedad
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !audible;
  }, [audible]);
  const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const [playerStatus, setPlayerStatus] = useState<'idle' | 'connecting' | 'playing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // En segundos. null (solo en campañas): no se fija liveDelay y dash.js usa el suyo (README, 4.8)
  const [targetLatency, setTargetLatency] = useState<number | null>(() =>
    preset ? (preset.targetMs === null ? null : preset.targetMs / 1000) : 0.3,
  );
  // Desvío respecto al objetivo a partir del cual dash.js deja de corregir con la velocidad de
  // reproducción y salta al directo, abortando las descargas en curso. 0 = no saltar nunca.
  const [maxDrift, setMaxDrift] = useState<number>(preset?.options?.dash_max_drift_s ?? 1.5);
  // Búfer mínimo de la corrección LoL+ (liveCatchup.playbackBufferMin): por debajo, dash.js frena la
  // reproducción para rellenarlo, más cuanto menos búfer, y no persigue el objetivo hasta superarlo. Hace de
  // suelo de la latencia. 0 = no frenar nunca por búfer, el valor al abrir la página para que no limite los
  // objetivos bajos; 0,5 s es el de fábrica de dash.js.
  const [playbackBufferMin, setPlaybackBufferMin] = useState<number>(preset?.options?.dash_playback_buffer_min_s ?? 0);
  const [showExplain, setShowExplain] = useState(false);

  // Actualizar liveDelay en caliente si el reproductor está activo
  const handleLatencyChange = (newSec: number) => {
    setTargetLatency(newSec);
    if (playerRef.current) {
      playerRef.current.updateSettings({
        streaming: {
          delay: {
            liveDelay: newSec,
          },
        },
      });
    }
  };

  // El medidor vive lo que el componente, no lo que cada intento de reproducción: así los congelados
  // se siguen contando mientras la vigilancia recrea el reproductor.
  const meterRef = useRef<GlassMeter | null>(null);
  const rateTrackerRef = useRef<PlaybackRateTracker | null>(null);
  const ladderRef = useRef(renditions);
  ladderRef.current = renditions;
  const timecodesRef = useRef<TimecodeLayout[]>([DEFAULT_TIMECODE]);
  if (timecodes?.length) timecodesRef.current = timecodes;
  const restartsRef = useRef(0);
  const [attempt, setAttempt] = useState(0);

  // Calidad: 'auto' deja decidir al ABR de dash.js; un número fija la calidad con esa altura
  const [quality, setQuality] = useState<number | 'auto'>(preset?.quality ?? 'auto');
  const qualityRef = useRef<number | 'auto'>(preset?.quality ?? 'auto');
  const switchesRef = useRef(0);
  const lastHeightRef = useRef<number | null>(null);

  const applyQuality = (player: dashjs.MediaPlayerClass, value: number | 'auto') => {
    player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: value === 'auto' } } } });
    if (value === 'auto') return;
    const representation = player.getRepresentationsByType('video').find((r) => r.height === value);
    if (representation) player.setRepresentationForTypeById('video', representation.id, true);
  };

  const handleQualityChange = (value: number | 'auto') => {
    setQuality(value);
    qualityRef.current = value;
    if (playerRef.current) applyQuality(playerRef.current, value);
  };

  const handleMaxDriftChange = (newSec: number) => {
    setMaxDrift(newSec);
    if (playerRef.current) {
      playerRef.current.updateSettings({ streaming: { liveCatchup: { maxDrift: newSec } } });
    }
  };

  // Algoritmo de adaptación. 'default' deja las reglas de fábrica de dash.js (caudal y BOLA en modo
  // dinámico, búfer insuficiente, historial de cambios y abandono de peticiones). L2A y LoL+ son las reglas
  // de dash.js para baja latencia; según su documentación están probadas en solitario, así que se activa
  // solo la elegida, como en su ejemplo de baja latencia. Cambiarlo recrea el reproductor: el ejemplo
  // oficial pide recargar porque las dos guardan estado desde el arranque.
  const [abr, setAbr] = useState<DashAbr>(preset?.options?.dash_abr ?? 'default');
  const abrSettings = (mode: DashAbr) =>
    mode === 'default'
      ? {}
      : {
          streaming: {
            abr: {
              rules: {
                throughputRule: { active: false },
                bolaRule: { active: false },
                insufficientBufferRule: { active: false },
                switchHistoryRule: { active: false },
                droppedFramesRule: { active: false },
                abandonRequestsRule: { active: false },
                l2ARule: { active: mode === 'l2a' || mode === 'l2afix' },
                loLPRule: { active: mode === 'lolp' },
              },
            },
          },
        };

  const handlePlaybackBufferMinChange = (newSec: number) => {
    setPlaybackBufferMin(newSec);
    if (playerRef.current) playerRef.current.updateSettings({ streaming: { liveCatchup: { playbackBufferMin: newSec } } });
  };

  useEffect(() => {
    onMetricsUpdate({ targetLatencyMs: targetLatency === null ? null : Math.round(targetLatency * 1000), maxDriftSec: maxDrift, playbackBufferMinSec: playbackBufferMin, abr });
  }, [targetLatency, maxDrift, playbackBufferMin, abr]);

  useEffect(() => {
    const glassMeter = new GlassMeter(() => grabFromVideo(videoRef.current), () => timecodesRef.current);
    meterRef.current = glassMeter;
    meters.dash = glassMeter;
    // Velocidad que pone dash.js al <video> (catch-up y LoL+); cada fila recoge su ventana
    const rateTracker = videoRef.current ? new PlaybackRateTracker(videoRef.current) : null;
    rateTrackerRef.current = rateTracker;
    if (rateTracker) rateTrackers.dash = rateTracker;
    return () => {
      glassMeter.close();
      if (meters.dash === glassMeter) delete meters.dash;
      rateTracker?.close();
      if (rateTrackers.dash === rateTracker) delete rateTrackers.dash;
    };
  }, []);

  useEffect(() => {
    if (!isStreaming || !videoRef.current) {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
      setPlayerStatus('idle');
      return;
    }

    if (!url) {
      setPlayerStatus('error');
      setErrorMsg(DASH_NEEDS_HOST);
      return;
    }

    setPlayerStatus('connecting');
    let isCancelled = false;
    let retryTimer: any = null;
    let videoBytes = 0;
    const rate = new RateWindow();

    // Descarga total: tamaño transferido (cabeceras HTTP + cuerpo) de todas las peticiones al servidor DASH
    let networkBytes = 0;
    let lastResponseEnd = 0;
    const networkRate = new RateWindow();
    const dashBase = new URL('.', url).href;
    const resources = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        // transferSize es 0 si el servidor no envía Timing-Allow-Origin: mejor sin dato que un cero falso
        if (!entry.name.startsWith(dashBase) || !entry.transferSize) continue;
        networkBytes += entry.transferSize;
        lastResponseEnd = Math.max(lastResponseEnd, entry.responseEnd);
        networkRate.push(networkBytes, lastResponseEnd);
      }
    });
    resources.observe({ type: 'resource' });

    const meter = meterRef.current!;

    // Vigilancia: si no hay imagen nueva durante WATCHDOG_MS (manifiesto que no llega, dash.js atascado, emisión reiniciada),
    // se recrea el reproductor en vez de esperar a que alguien recargue la pestaña.
    const startedAt = performance.now();
    const watchdog = setInterval(() => {
      const frozen = meter.frozenMs();
      if (frozen !== null && frozen > WATCHDOG_MS && performance.now() - startedAt > WATCHDOG_GRACE_MS) {
        console.warn(`[dash.js] ${Math.round(frozen / 1000)} s sin imagen nueva: se recrea el reproductor`);
        restartsRef.current++;
        setAttempt((a) => a + 1);
      }
    }, 1000);

    async function startDash() {
      // 1. Esperar a que el manifest devuelva HTTP 200: el origen no lo publica hasta calibrar el
      // availabilityStartTime, lo que tarda unos pocos segmentos tras cada arranque
      let attempts = 0;
      while (!isCancelled && attempts < 75) {
        try {
          const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
          if (res.ok) break;
        } catch (_) {}
        attempts++;
        await new Promise((r) => setTimeout(r, 400));
      }

      if (isCancelled || !videoRef.current) return;

      if (attempts >= 75) {
        setPlayerStatus('error');
        setErrorMsg(t('El archivo manifest.mpd aún no está disponible', 'manifest.mpd is not available yet'));
        return;
      }

      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch (_) {}
        playerRef.current = null;
      }

      // L2A (bugfix): copia de dash.js con el fallo de unidades de L2A corregido (vite.config.ts, README 6). Solo se
      // carga con esta opción; las demás usan dash.js tal cual
      const lib: typeof dashjs = abr === 'l2afix' ? await import('virtual:dashjs-l2afix') : dashjs;
      if (isCancelled || !videoRef.current) return;
      const player = lib.MediaPlayer().create();
      playerRef.current = player;
      // Acceso desde la consola del navegador para depurar (p. ej. subir el nivel de log de dash.js)
      (window as any).dashPlayer = player;

      // Configuración para Low-Latency DASH (LL-DASH / CMAF)
      player.updateSettings({
        streaming: {
          delay: {
            // NaN es el valor de fábrica de dash.js: calcula el retardo a partir del manifiesto
            liveDelay: targetLatency ?? NaN,
          },
          liveCatchup: {
            enabled: true,
            maxDrift,
            playbackBufferMin,
            mode: CATCHUP_MODE,
          },
          retryAttempts: {
            MPD: 15,
            MediaSegment: 15,
            InitializationSegment: 15,
          },
          retryIntervals: {
            MPD: 1000,
            MediaSegment: 1000,
          },
        },
      });
      player.updateSettings(abrSettings(abr));

      player.on(lib.MediaPlayer.events.STREAM_INITIALIZED, () => {
        console.log('[dash.js] Stream inicializado');
        applyQuality(player, qualityRef.current);
      });

      player.on(lib.MediaPlayer.events.CAN_PLAY, () => {
        if (!isCancelled) setPlayerStatus('playing');
      });

      player.on(lib.MediaPlayer.events.PLAYBACK_PLAYING, () => {
        if (!isCancelled) setPlayerStatus('playing');
      });

      player.on(lib.MediaPlayer.events.ERROR, (e: any) => {
        if (isCancelled) return;
        console.warn('[dash.js error temporal - reconectando]', e);
        setPlayerStatus('connecting');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (!isCancelled && isStreaming) {
            startDash();
          }
        }, 1200);
      });

      // Bytes de vídeo realmente descargados, para medir bitrate recibido igual que en MoQ
      player.on(lib.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, (e: any) => {
        if (e.request?.mediaType !== 'video' || e.request?.type !== 'MediaSegment') return;
        videoBytes += e.response?.byteLength || e.request.bytesLoaded || 0;
        rate.push(videoBytes);
      });

      player.initialize(videoRef.current, url, true);
    }

    startDash();

    // Seguimiento de frames concretos por las etapas del recorrido
    const video = videoRef.current;
    const tracer = new DashTracer(
      video,
      meter,
      () => (ladderRef.current ?? []).findIndex((r) => r.height === video.videoHeight),
      (stages) => onMetricsUpdate({ stages }),
    );

    // Muestreo de métricas cada 500 ms
    const interval = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        const liveLatency = p.getCurrentLiveLatency();
        const glass = meter.snapshot();
        // La representación actual es la que eligió el ABR y se está descargando; lo que se pinta es la del <video>,
        // que cambia cuando el búfer llega a los segmentos nuevos (hasta el 4-11-2026, dash_height era la elegida)
        const representation = p.getCurrentRepresentationForType('video');
        const height = representation?.height ?? null;
        const shown = videoRef.current?.videoHeight || null;
        if (height !== null && lastHeightRef.current !== null && height !== lastHeightRef.current) switchesRef.current++;
        if (height !== null) lastHeightRef.current = height;
        const throughput = p.getAverageThroughput('video');
        onMetricsUpdate({
          protocol: 'LL-DASH',
          latencyMs: glass.latencyMs,
          reportedLatencyMs: liveLatency > 0 ? Math.round(liveLatency * 1000) : null,
          bufferLengthSec: Number((p.getBufferLength('video') || 0).toFixed(2)),
          playbackRate: rateTrackerRef.current?.current ?? null,
          bitrateKbps: rate.kbps(),
          networkKbps: networkRate.kbps(),
          fps: glass.fps,
          frameTimeSdMs: glass.frameTimeSdMs,
          frameTimeP95Ms: glass.frameTimeP95Ms,
          frameTimeMaxMs: glass.frameTimeMaxMs,
          frameTimes: glass.frameTimes,
          stalls: glass.stalls,
          stallMs: glass.stallMs,
          contentSpeed: glass.contentSpeed,
          contentSkippedMs: glass.contentSkippedMs,
          restarts: restartsRef.current,
          renditionHeight: shown,
          selectedHeight: height,
          renditionKbps: representation ? Math.round(representation.bandwidth / 1000) : null,
          qualitySwitches: switchesRef.current,
          // Caudal medio que dash.js mide en las descargas y con el que decide su ABR
          bandwidthEstimateKbps: throughput > 0 ? Math.round(throughput) : null,
          qualityMode: qualityRef.current === 'auto' ? 'auto' : 'manual',
        });
      } catch (err) {
        // Ignorar si el reproductor está reiniciando
      }
    }, 500);

    return () => {
      isCancelled = true;
      clearTimeout(retryTimer);
      clearInterval(interval);
      clearInterval(watchdog);
      tracer.close();
      resources.disconnect();
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [url, isStreaming, attempt, abr]);

  useEffect(() => {
    onMetricsUpdate({ status: playerStatus });
  }, [playerStatus]);

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800/80 border-b border-slate-700/50">
        <div className="flex items-center space-x-2">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
          <h3 className="font-semibold text-sm text-slate-200">LL-DASH (CMAF / HTTP/1.1-H2)</h3>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-700/40 font-mono">
          dash.js lowLatency
        </span>
      </div>

      <div
        ref={screenRef}
        data-player="dash"
        onDoubleClick={() => toggleFullscreen(screenRef.current)}
        className="group relative aspect-video bg-black flex items-center justify-center"
      >
        <FullscreenButton target={screenRef} />
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          muted
          autoPlay
          playsInline
        />

        {playerStatus === 'connecting' && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center space-y-2">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-slate-400">{t('Sincronizando Live Edge CMAF...', 'Syncing to the CMAF live edge...')}</span>
          </div>
        )}

        {playerStatus === 'idle' && (
          <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center text-slate-500 space-y-1">
            <p className="text-sm font-medium">{t('Stream detenido', 'Stream stopped')}</p>
            <p className="text-xs text-slate-600">{t('Inicia el pipeline desde el panel de control', 'Start the pipeline from the control panel')}</p>
          </div>
        )}

        {playerStatus === 'error' && (
          <div className="absolute inset-0 bg-red-950/80 flex flex-col items-center justify-center text-red-300 p-4 text-center">
            <p className="text-sm font-semibold">{t('Error en LL-DASH', 'LL-DASH error')}</p>
            <p className="text-xs text-red-400 mt-1">{errorMsg || t('No se puede conectar al manifiesto', 'Cannot connect to the manifest')}</p>
          </div>
        )}
      </div>

      {/* Control de Latencia Objetivo en Vivo */}
      <div className="px-4 py-2.5 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <span className="text-slate-400 font-medium whitespace-nowrap">{t('Latencia objetivo:', 'Target latency:')}</span>
          <span className="font-mono text-blue-400 font-semibold whitespace-nowrap">{targetLatency === null ? t('de fábrica (dash.js)', 'default (dash.js)') : `${targetLatency.toFixed(2)}s (${Math.round(targetLatency * 1000)}ms)`}</span>
        </div>
        <div className="flex items-center space-x-3 flex-1 min-w-[10rem] max-w-xs ml-auto">
          <span className="text-[10px] text-slate-500 font-mono">0.05s</span>
          <input
            type="range"
            min={0.05}
            max={2.0}
            step={0.05}
            value={targetLatency ?? 0.3}
            onChange={(e) => handleLatencyChange(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
          />
          <span className="text-[10px] text-slate-500 font-mono">2.0s</span>
        </div>
      </div>

      {/* Búfer mínimo de la corrección LoL+ (liveCatchup.playbackBufferMin) */}
      <div
        className="px-4 py-2.5 bg-slate-900 border-t border-slate-800/60 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs"
        title={t(
          'Corrección de latencia LoL+ (liveCatchup.playbackBufferMin): si el búfer baja de este nivel, dash.js frena la reproducción para rellenarlo (más cuanto menos búfer, hasta casi 0,5×) y no persigue la latencia objetivo hasta superarlo. Como la latencia nunca es menor que el búfer, hace de suelo: con un objetivo por debajo de este valor, la latencia queda por encima del objetivo. 0 = no frenar nunca por búfer (valor al abrir la página). 0,5 s es el valor de fábrica de dash.js.',
          'LoL+ latency correction (liveCatchup.playbackBufferMin): if the buffer drops below this level, dash.js slows playback to refill it (more the less buffer there is, down to almost 0.5×) and does not chase the target latency until it is exceeded again. Since latency is never lower than the buffer, it acts as a floor: with a target below this value, latency stays above the target. 0 = never slow down for the buffer (value on page load). 0.5 s is the dash.js default.',
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <span className="text-slate-400 font-medium whitespace-nowrap">{t('Búfer mínimo:', 'Minimum buffer:')}</span>
          <span className="font-mono text-blue-400 font-semibold whitespace-nowrap">
            {playbackBufferMin === 0 ? t('sin frenar', 'no slowdown') : `${playbackBufferMin.toFixed(2)}s`}
            {playbackBufferMin === 0.5 && t(' (de fábrica)', ' (default)')}
          </span>
        </div>
        <div className="flex items-center space-x-3 flex-1 min-w-[10rem] max-w-xs ml-auto">
          <span className="text-[10px] text-slate-500 font-mono">0s</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={playbackBufferMin}
            onChange={(e) => handlePlaybackBufferMinChange(Math.round(parseFloat(e.target.value) * 100) / 100)}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
          />
          <span className="text-[10px] text-slate-500 font-mono">2s</span>
        </div>
      </div>

      {/* Umbral de salto al directo (liveCatchup.maxDrift) */}
      <div
        className="px-4 py-2.5 bg-slate-900 border-t border-slate-800/60 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs"
        title={t(
          'Si la latencia se desvía del objetivo más que este valor, dash.js salta al directo en vez de corregir con la velocidad de reproducción. El salto aborta las descargas en curso y abre conexiones TCP nuevas: con retardo de red alto puede encadenar saltos y paradas. 0 = no saltar nunca.',
          'If latency deviates from the target by more than this value, dash.js seeks to the live edge instead of correcting with the playback rate. The seek aborts in-flight downloads and opens new TCP connections: with high network delay it can chain seeks and stalls. 0 = never seek.',
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <span className="text-slate-400 font-medium whitespace-nowrap">{t('Salto al directo:', 'Seek to live:')}</span>
          <span className="font-mono text-blue-400 font-semibold whitespace-nowrap">
            {maxDrift === 0 ? t('desactivado', 'disabled') : t(`desvío > ${maxDrift.toFixed(1)}s`, `drift > ${maxDrift.toFixed(1)}s`)}
          </span>
        </div>
        <div className="flex items-center space-x-3 flex-1 min-w-[10rem] max-w-xs ml-auto">
          <span className="text-[10px] text-slate-500 font-mono">no</span>
          <input
            type="range"
            min={0}
            max={10}
            step={0.5}
            value={maxDrift}
            onChange={(e) => handleMaxDriftChange(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
          />
          <span className="text-[10px] text-slate-500 font-mono">10s</span>
        </div>
      </div>

      <div className="px-4 py-2 bg-slate-950/60 border-t border-slate-800/60 text-[11px] text-slate-500 font-mono space-y-1.5">
        <div
          className="truncate"
          title={
            url
              ? t(
                  'El navegador conecta directamente al servidor de DASH a través del router de emulación: su propia conexión TCP atraviesa la red emulada, como en MoQ y WebRTC.',
                  'The browser connects directly to the DASH server through the emulation router: its own TCP connection crosses the emulated network, as in MoQ and WebRTC.',
                )
              : DASH_NEEDS_HOST
          }
        >
          {url ? t(`Directo · ${new URL(url).host}`, `Direct · ${new URL(url).host}`) : t('Sin camino directo (falta DASH_HOST)', 'No direct path (DASH_HOST missing)')}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <label
          className="flex items-center space-x-1.5 whitespace-nowrap"
          title={t(
            'Reglas de adaptación de dash.js en Auto. Por defecto: las de fábrica (caudal y BOLA, búfer insuficiente, historial de cambios, abandono de peticiones). L2A y LoL+: sus reglas para baja latencia, cada una en solitario. L2A (bugfix): experimento, L2A con su fallo de unidades de dash.js 5 corregido (README 6). Cambiarlo recrea el reproductor.',
            'dash.js adaptation rules in Auto. Default: the stock ones (throughput and BOLA, insufficient buffer, switch history, request abandonment). L2A and LoL+: their low-latency rules, each on its own. L2A (bugfix): experiment, L2A with its dash.js 5 units bug fixed (README 6). Changing it recreates the player.',
          )}
        >
          <span>ABR:</span>
          <select
            value={abr}
            onChange={(e) => setAbr(e.target.value as DashAbr)}
            className="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
          >
            <option value="default">{t('Por defecto', 'Default')}</option>
            <option value="l2a">L2A</option>
            <option value="l2afix">L2A (bugfix)</option>
            <option value="lolp">LoL+</option>
          </select>
        </label>
        <label className="flex items-center space-x-1.5 whitespace-nowrap" title={t('Auto deja decidir al algoritmo de adaptación del reproductor; fijar una calidad lo desactiva.', 'Auto lets the player\'s adaptation algorithm decide; fixing a rendition disables it.')}>
          <span>{t('Calidad:', 'Rendition:')}</span>
          <select
            value={quality}
            onChange={(e) => handleQualityChange(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
            className="bg-slate-900 border border-slate-700 text-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
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
          className="ml-auto text-blue-400 hover:text-blue-300 whitespace-nowrap"
          title={t('Cómo elige calidad y cómo persigue la latencia este reproductor con las opciones elegidas', 'How this player picks a rendition and chases latency with the selected options')}
        >
          {showExplain ? t('Ocultar explicación ▴', 'Hide explanation ▴') : t('Cómo funciona ▾', 'How it works ▾')}
        </button>
        </div>
      </div>
      {showExplain && (
        <div className="px-4 py-3 bg-slate-950/80 border-t border-slate-800/60 text-[11px] leading-relaxed text-slate-400">
          <DashExplain
            abr={abr}
            quality={quality}
            targetLatency={targetLatency ?? playerRef.current?.getTargetLiveDelay() ?? 0}
            maxDrift={maxDrift}
            playbackBufferMin={playbackBufferMin}
          />
        </div>
      )}
    </div>
  );
};
