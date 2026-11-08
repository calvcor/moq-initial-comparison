import React, { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Campaign } from '../types';

// Análisis en texto de una campaña (README 4.8, «Análisis de la campaña»): lo escribe el orquestador
// (GET /api/campaigns/{id}/analysis) con reglas fijas a partir de las pruebas válidas; aquí solo se muestra. TextReport
// pinta también la comparación de dos campañas (CampaignVersus), que tiene la misma forma.

export interface TextAnalysis {
  overview: string[];
  sections: { title: string; blocks: { title: string; sentences: string[] }[] }[];
  warnings: string[];
  conditions?: { key: string; label: string; a: string; b: string }[]; // solo la comparación de campañas
}

export const BUSY_NOTE = (busy: string) =>
  `Hay una campaña en marcha («${busy}»): el análisis y la comparación esperan a que termine o se ponga en pausa, para no interferir en sus medidas.`;

/** El texto entero, para pegarlo en notas o en un documento. */
function plainText(title: string, a: TextAnalysis): string {
  const lines = [title, '', ...a.overview];
  if (a.conditions?.length) {
    lines.push('', 'QUÉ CAMBIA ENTRE LAS DOS');
    a.conditions.forEach((c) => lines.push(`- ${c.label}: ${c.a} (A) / ${c.b} (B)`));
  }
  for (const section of a.sections) {
    lines.push('', section.title.toUpperCase());
    for (const block of section.blocks) {
      if (block.title) lines.push('', block.title);
      block.sentences.forEach((s) => lines.push(`- ${s}`));
    }
  }
  if (a.warnings.length) {
    lines.push('', 'AVISOS');
    a.warnings.forEach((w) => lines.push(`- ${w}`));
  }
  return lines.join('\n');
}

/** Un informe en texto del orquestador: resumen, avisos, qué cambia (si lo trae), secciones y una nota del método. */
export const TextReport: React.FC<{ data: TextAnalysis; title: string; method: string }> = ({ data, title, method }) => {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText(title, data));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-lg p-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className="space-y-0.5 text-[13px] text-slate-200 leading-snug">
          {data.overview.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </div>
        <button className="ml-auto shrink-0 flex items-center gap-1 text-slate-300 hover:text-white" onClick={copy} title="Copiar como texto">
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copiado' : 'Copiar texto'}
        </button>
      </div>
      {copyError && <p className="text-rose-300">No se pudo copiar al portapapeles</p>}
      {data.warnings.length > 0 && (
        <ul className="space-y-0.5 text-amber-300/90">
          {data.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {data.conditions && data.conditions.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800 pb-0.5">Qué cambia entre las dos</h3>
          <table className="w-full text-left">
            <thead className="text-[10px] text-slate-500 uppercase">
              <tr>
                <th className="py-0.5 pr-2 font-medium" />
                <th className="py-0.5 pr-2 font-medium">A</th>
                <th className="py-0.5 pr-2 font-medium">B</th>
              </tr>
            </thead>
            <tbody>
              {data.conditions.map((c) => (
                <tr key={c.key} className="border-t border-slate-800/60">
                  <td className="py-0.5 pr-2 text-slate-400">{c.label}</td>
                  <td className="py-0.5 pr-2 text-slate-200 font-mono break-all">{c.a}</td>
                  <td className="py-0.5 pr-2 text-slate-200 font-mono break-all">{c.b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {data.sections.map((section) => (
        <section key={section.title} className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800 pb-0.5">{section.title}</h3>
          {section.blocks.map((block, i) => (
            <div key={i} className="space-y-1">
              {block.title && <h4 className="text-xs font-semibold text-slate-300">{block.title}</h4>}
              <ul className="space-y-1 text-[13px] leading-snug text-slate-200 list-disc pl-5 marker:text-slate-600">
                {block.sentences.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
      <p className="text-slate-500">{method}</p>
    </div>
  );
};

// busy: el nombre de la campaña en marcha, si la hay: entonces no se pide (el servidor respondería 409)
export const CampaignAnalysis: React.FC<{ campaign: Campaign; busy: string | null }> = ({ campaign, busy }) => {
  const [data, setData] = useState<TextAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Se vuelve a pedir cuando cambia el número de pruebas terminadas, no en cada recarga de la campaña
  const done = campaign.counts?.done ?? 0;

  useEffect(() => {
    if (busy) return;
    let cancelled = false;
    fetch(`/api/campaigns/${campaign.id}/analysis`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`);
        return body as TextAnalysis;
      })
      .then((body) => {
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [campaign.id, done, busy]);

  if (busy) return <p className="text-amber-300/90">{BUSY_NOTE(busy)}</p>;
  if (error) return <p className="text-rose-300">Análisis: {error}</p>;
  if (!data) return <p className="text-slate-500">Analizando…</p>;
  return (
    <TextReport
      data={data}
      title={`Análisis de «${campaign.name}»`}
      method="Reglas fijas sobre las pruebas válidas: la unidad es la condición (emisión × red × objetivo), con la mediana de sus repeticiones. Una diferencia cuenta en una condición si supera la variación entre sus repeticiones; las tendencias usan solo las combinaciones medidas en todos los niveles. Es una lectura descriptiva, no un contraste estadístico (README 4.8)."
    />
  );
};
