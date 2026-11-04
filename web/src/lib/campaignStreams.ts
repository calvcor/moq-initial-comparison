// Emisiones de una campaña (plan.streams): cada prueba lleva el índice de la suya (run.stream). Con más de una, la
// página la muestra en cada prueba y las gráficas no mezclan pruebas de emisiones distintas.

import type { CampaignPlan } from '../types';

type Stream = CampaignPlan['streams'][number];

const SOURCE_LABEL: Record<string, string> = { file: 'Big Buck Bunny', tos: 'Tears of Steel', camera: 'cámara' };

export const multiStream = (plan: CampaignPlan) => plan.streams.length > 1;

export const streamName = (index: number) => `Emisión ${index + 1}`;

// "Big Buck Bunny · GOP 60 · 1080p 4000, 720p 2000, 360p 700 kbit/s"
export function streamText(stream: Stream): string {
  const ladder = stream.renditions.map((r) => `${r.height}p ${r.bitrate_kbps}`).join(', ');
  return `${SOURCE_LABEL[stream.source ?? 'file'] ?? stream.source} · GOP ${stream.gop_size} · ${ladder} kbit/s`;
}
