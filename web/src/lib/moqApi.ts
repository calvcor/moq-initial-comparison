// Diferencias de API entre las dos versiones de @moq/watch y @moq/net que usa el banco:
// bc64b9c (por defecto) y c19c723 (con MOQ_WATCH_COMMIT en el .env).
// Solo traduce cómo se conecta el reproductor y cómo se leen sus salidas: no cambia nada de lo que hace. Las dos se
// conectan como el elemento oficial <moq-watch> de su versión (js/watch/src/element.ts).
//
// - Adaptación. En bc64b9c el reproductor recibe la estimación del relay (`probe: connection.probe`) y elige la
//   calidad de mayor bitrate que quepa en su 80 %. En c19c723 no: reserva una parte de la estimación de la
//   conexión (`viewer: { viewers: connection.viewers }`), elige con lo que se le concede y, con la suma de lo que
//   piden los reproductores, la conexión pide al relay hasta dónde sondear (PROBE). La estimación sigue en
//   connection.probe (estimatedRecvRate), que es la que va al CSV.
// - Nombres: `announced` pasa a `follow` (el nombre antiguo lanza un error) y canvas, visible, target y muted van
//   dentro de `video` y `audio`.
// - Tiempos: el retardo y las marcas de tiempo eran milisegundos (un número); en c19c723 son `Duration`.
// - Frames: el último pintado era `renderer.out.frame`; en c19c723 es `renderer.painted` (interno, el mismo frame,
//   que se actualiza tras cada pintado). El decodificado sigue en `video.out.frame` (interno en c19c723).
// Los tipos de cada versión no compilan contra la otra, así que aquí se trabaja sin ellos.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** La API de c19c723 en adelante: la conexión reparte su estimación entre los reproductores. */
export function isViewersApi(connection: unknown): boolean {
  return !!connection && typeof connection === 'object' && 'viewers' in connection;
}

export interface PlayerOptions {
  origin: unknown;
  name: unknown;
  canvas: HTMLCanvasElement | undefined;
  muted: unknown;
  delay: unknown;
  target: unknown;
  /** Solo en bc64b9c con el parche de web/patches (docs/adaptation-and-experiments.md); en c19c723 no se pasa. */
  switching: unknown;
}

/** Las opciones del constructor de Watch.Player en la versión instalada. */
export function playerProps(connection: any, o: PlayerOptions): any {
  if (isViewersApi(connection)) {
    return {
      origin: o.origin,
      name: o.name,
      // Esperar al anuncio de la emisión antes de suscribirse (en bc64b9c, `announced`)
      follow: true,
      delay: o.delay,
      video: { canvas: o.canvas, visible: 'always', target: o.target },
      audio: { muted: o.muted },
      // Como <moq-watch>: reservar una parte de la estimación de la conexión, con el techo que marca el catálogo
      viewer: { viewers: connection.viewers },
    };
  }
  return {
    origin: o.origin,
    probe: connection.probe,
    name: o.name,
    announced: true,
    visible: 'always',
    canvas: o.canvas,
    muted: o.muted,
    delay: o.delay,
    target: o.target,
    switching: o.switching,
  };
}

/** Milisegundos de un tiempo de la librería: un número (bc64b9c) o un Duration (c19c723). */
export function toMs(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value && typeof (value as any).asMillis === 'function') return (value as any).asMillis();
  return undefined;
}

/** El retardo pedido en el formato de la versión: 'auto' sin objetivo; si no, milisegundos o un Duration. La clase
 * Duration se toma del propio reproductor (su retardo efectivo ya es un Duration), sin importar @moq/clock, que con
 * los paquetes publicados de npm puede no estar instalado. Sin reproductor todavía, 'auto'. */
export function delayValue(player: any, ms: number): unknown {
  if (ms <= 0) return 'auto';
  const current = player?.sync?.out?.delay?.peek?.();
  if (typeof current === 'number' || current === undefined) return player ? ms : 'auto';
  const Duration = current.constructor as { millis?: (ms: number) => unknown };
  return typeof Duration.millis === 'function' ? Duration.millis(ms) : 'auto';
}

/** El último frame pintado en el canvas. */
export function paintedFrame(player: any): VideoFrame | undefined {
  const signal = player?.renderer?.painted ?? player?.renderer?.out?.frame;
  return signal?.peek?.() ?? undefined;
}

/** El último frame decodificado (el siguiente que se pinta). */
export function decodedFrame(player: any): VideoFrame | undefined {
  return player?.video?.out?.frame?.peek?.() ?? undefined;
}

/** Suscribe a una marca de tiempo de la librería y la entrega en milisegundos. */
export function subscribeMs(signal: any, fn: (ms: number | undefined) => void): () => void {
  return signal.subscribe((value: unknown) => fn(toMs(value)));
}
