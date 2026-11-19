// Emisiones de una campaña (plan.streams): cada prueba lleva el índice de la suya (run.stream). Con más de una, la
// página la muestra en cada prueba y las gráficas no mezclan pruebas de emisiones distintas.

import type { CampaignPlan } from '../types';
import { lang, t } from './i18n';

type Stream = CampaignPlan['streams'][number];

const SOURCE_LABEL: Record<string, string> = { file: 'Big Buck Bunny', tos: 'Tears of Steel', camera: t('cámara', 'camera') };

export const multiStream = (plan: CampaignPlan) => plan.streams.length > 1;

export const streamName = (index: number) => t(`Emisión ${index + 1}`, `Stream ${index + 1}`);

// "Big Buck Bunny · GOP 60 · segmento 2 s, fragmento 0,1 s · 1080p 4000, 720p 2000, 360p 700 kbit/s", y " · audio
// WebRTC" o " · pacer WebRTC" si los lleva. El fragmento 0 es de 1 frame (-frag_type every_frame)
const seconds = (v: number) => `${lang === 'en' ? String(v) : String(v).replace('.', ',')} s`;

export function streamText(stream: Stream): string {
  const ladder = stream.renditions.map((r) => `${r.height}p ${r.bitrate_kbps}`).join(', ');
  const frag = stream.frag_duration === 0 ? '1 frame' : seconds(stream.frag_duration);
  const extras = [stream.rtc_audio && 'audio WebRTC', stream.rtc_pacing && 'pacer WebRTC'].filter(Boolean);
  return [SOURCE_LABEL[stream.source ?? 'file'] ?? stream.source, `GOP ${stream.gop_size}`,
    t(`segmento ${seconds(stream.seg_duration)}, fragmento ${frag}`, `segment ${seconds(stream.seg_duration)}, fragment ${frag}`), `${ladder} kbit/s`, ...extras].join(' · ');
}

// Lo que distingue a cada emisión de un plan, para la clave junto a un eje o una leyenda que solo lleva «Emisión N»:
// solo lo que cambia entre ellas ("seg 2 s · frag 1 frame"); vacío si no cambia nada (emisiones repetidas)
export function streamDifferences(plan: CampaignPlan): string[] {
  const parts = (s: Stream): [string, string][] => [
    ['source', SOURCE_LABEL[s.source ?? 'file'] ?? String(s.source)],
    ['gop', `GOP ${s.gop_size}`],
    ['seg', `seg ${seconds(s.seg_duration)}`],
    ['frag', `frag ${s.frag_duration === 0 ? '1 frame' : seconds(s.frag_duration)}`],
    ['ladder', s.renditions.map((r) => `${r.height}p ${r.bitrate_kbps}`).join(', ')],
    ['audio', s.rtc_audio ? 'audio WebRTC' : t('sin audio', 'no audio')],
    ['pacing', s.rtc_pacing ? 'pacer WebRTC' : t('sin pacer', 'no pacer')],
  ];
  const all = plan.streams.map(parts);
  const differs = (k: number) => new Set(all.map((p) => p[k][1])).size > 1;
  return all.map((p) => p.filter((_, k) => differs(k)).map(([, v]) => v).join(' · '));
}
