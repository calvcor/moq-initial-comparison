// Carga del hilo principal de la página, para ver si lo que hace el navegador (los tres reproductores, el
// medidor de timecode, el panel) interfiere con los protocolos. @moq/watch y dash.js trabajan en ese hilo: MoQ
// pinta cada frame con setTimeout y requestAnimationFrame, así que un hilo ocupado le hace perder frames
// (docs/measurement.md, "Why presented frames drop below 60"). El <video> de DASH y WebRTC presenta en el
// compositor, fuera de él.
//
// Dos medidas pasivas, sin leer píxeles ni ejecutar trabajo propio salvo una vuelta vacía por refresco:
// - Frames largos (Long Animation Frames API, Chrome 123+): el navegador avisa de cada frame que tardó 50 ms o
//   más entre que empezó a trabajar y pintó. Llegan después, en un observador; sin la API quedan a null.
// - Refrescos perdidos: un requestAnimationFrame que no hace nada salvo anotar su hora. Si entre dos pasan N
//   refrescos de pantalla, se perdieron N-1: en ellos el hilo no llegó a pintar. El periodo del refresco se
//   estima con los intervalos recientes (el menor de los habituales), así vale para 60 o 120 Hz.

/** Lo ocurrido desde la última recogida. */
export interface MainThreadWindow {
  longFrames: number | null; // frames de 50 ms o más
  longFrameMs: number | null; // su duración sumada
  longFrameMaxMs: number | null; // el más largo
  refreshesMissed: number; // refrescos sin requestAnimationFrame
  rafGapMaxMs: number | null; // el mayor intervalo entre dos requestAnimationFrame
}

const PERIOD_SAMPLES = 120;

interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
}

class MainThreadMonitor {
  #loaf = typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame');
  #longFrames = 0;
  #longFrameMs = 0;
  #longFrameMaxMs = 0;
  #missed = 0;
  #gapMax: number | null = null;
  #last: number | null = null;
  #intervals: number[] = [];
  #started = false;

  start() {
    if (this.#started || typeof window === 'undefined') return;
    this.#started = true;
    if (this.#loaf) {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as LoafEntry[]) {
          this.#longFrames++;
          this.#longFrameMs += e.duration;
          this.#longFrameMaxMs = Math.max(this.#longFrameMaxMs, e.duration);
        }
      }).observe({ type: 'long-animation-frame', buffered: false });
    }
    // Con la pestaña oculta el navegador no ejecuta requestAnimationFrame: ese hueco no es carga
    document.addEventListener('visibilitychange', () => {
      this.#last = null;
    });
    const tick = (t: number) => {
      if (this.#last !== null && !document.hidden) {
        const dt = t - this.#last;
        this.#gapMax = Math.max(this.#gapMax ?? 0, dt);
        const period = this.#period();
        if (period) this.#missed += Math.max(0, Math.round(dt / period) - 1);
        this.#intervals.push(dt);
        if (this.#intervals.length > PERIOD_SAMPLES) this.#intervals.shift();
      }
      this.#last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // El periodo del refresco: el percentil 10 de los intervalos recientes (los perdidos son múltiplos de él)
  #period(): number | null {
    if (this.#intervals.length < 30) return null;
    const sorted = [...this.#intervals].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.1)];
  }

  /** Lo acumulado desde la recogida anterior; recogerlo lo vacía, como los parones del medidor. */
  take(): MainThreadWindow {
    const out: MainThreadWindow = {
      longFrames: this.#loaf ? this.#longFrames : null,
      longFrameMs: this.#loaf ? Math.round(this.#longFrameMs) : null,
      longFrameMaxMs: this.#loaf ? (this.#longFrames ? Math.round(this.#longFrameMaxMs) : 0) : null,
      refreshesMissed: this.#missed,
      rafGapMaxMs: this.#gapMax === null ? null : Math.round(this.#gapMax * 10) / 10,
    };
    this.#longFrames = 0;
    this.#longFrameMs = 0;
    this.#longFrameMaxMs = 0;
    this.#missed = 0;
    this.#gapMax = null;
    return out;
  }
}

export const mainThread = new MainThreadMonitor();
