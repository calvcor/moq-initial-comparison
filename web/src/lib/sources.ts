import type { LoopVideo, SourceKind } from '../types';

// Vídeos en bucle de la fuente (server/app/source.py). La cadencia es la del fichero: la emisión no la convierte.
export const LOOP_VIDEOS: Record<LoopVideo, { label: string; fps: number; detail: string }> = {
  file: { label: 'Big Buck Bunny', fps: 60, detail: '1080p a 60 fps' },
  tos: { label: 'Tears of Steel', fps: 24, detail: '1920x800 a 24 fps, con bandas hasta 1080p' },
};

export const isLoopVideo = (source: SourceKind): source is LoopVideo => source !== 'camera';

// GOP con la misma duración en segundos al pasar de una cadencia a otra
export const gopAt = (gop: number, fromFps: number, toFps: number) => Math.max(1, Math.round((gop / fromFps) * toFps));
