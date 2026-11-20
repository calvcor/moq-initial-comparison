import React, { useEffect, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { Campaign } from '../types';
import { BUSY_NOTE, TextReport, type TextAnalysis } from './CampaignAnalysis';
import { CampaignVersusTables, type VersusTables } from './CampaignVersusTables';
import { lang, t } from '../lib/i18n';

// Comparación en texto de dos campañas enteras (docs/campaigns.md, «Comparar dos campañas»): la que se está viendo y otra que
// se elige. La escribe el orquestador (GET /api/campaigns-compare) emparejando condiciones por perfil de red, latencia
// objetivo y emisión; aquí solo se elige la otra y se muestra.

export const CampaignVersus: React.FC<{ campaign: Campaign; busy: string | null }> = ({ campaign, busy }) => {
  const [others, setOthers] = useState<Campaign[]>([]);
  const [other, setOther] = useState<string>('');
  // Por defecto, la que se ve es A y la elegida, B; se puede dar la vuelta
  const [swapped, setSwapped] = useState(false);
  const [data, setData] = useState<(TextAnalysis & { tables?: VersusTables }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = campaign.counts?.done ?? 0;

  useEffect(() => {
    fetch('/api/campaigns')
      .then((res) => (res.ok ? res.json() : []))
      .then((all: Campaign[]) => setOthers(all.filter((c) => c.id !== campaign.id && (c.counts?.done ?? 0) > 0)))
      .catch(() => setOthers([]));
    setOther('');
    setData(null);
  }, [campaign.id]);

  const [a, b] = swapped ? [other, campaign.id] : [campaign.id, other];
  useEffect(() => {
    if (busy || !other) return;
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/campaigns-compare?${new URLSearchParams({ a, b, lang })}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`);
        return body as TextAnalysis & { tables?: VersusTables };
      })
      .then((body) => !cancelled && setData(body))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [a, b, done, busy]);

  if (busy) return <p className="text-amber-300/90">{BUSY_NOTE(busy)}</p>;
  const name = (id: string) => (id === campaign.id ? campaign.name : others.find((c) => c.id === id)?.name ?? id);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-400">{t('Comparar con', 'Compare with')}</span>
        <select
          className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-xs max-w-md"
          value={other}
          onChange={(e) => setOther(e.target.value)}
        >
          <option value="">{t('elige una campaña…', 'choose a campaign…')}</option>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.id}){c.archived ? t(' · archivada', ' · archived') : ''}
            </option>
          ))}
        </select>
        {other && (
          <button className="flex items-center gap-1 text-slate-300 hover:text-white" onClick={() => setSwapped((v) => !v)} title={t('Intercambiar A y B', 'Swap A and B')}>
            <ArrowLeftRight className="w-3.5 h-3.5" /> {t('Intercambiar', 'Swap')}
          </button>
        )}
      </div>
      {other && (
        <p className="text-slate-400">
          A: <span className="text-slate-200">{name(a)}</span> · B: <span className="text-slate-200">{name(b)}</span>
        </p>
      )}
      {error && <p className="text-rose-300">{t('Comparación', 'Comparison')}: {error}</p>}
      {other && !data && !error && <p className="text-slate-500">{t('Comparando…', 'Comparing…')}</p>}
      {data && (
        <TextReport
          data={data}
          title={t(`Comparación de «${name(a)}» (A) y «${name(b)}» (B)`, `Comparison of “${name(a)}” (A) and “${name(b)}” (B)`)}
          method={t(
            'Reglas fijas sobre las pruebas válidas de las dos: se emparejan las condiciones con el mismo perfil de red, la misma latencia objetivo (en ms) y la misma emisión (con una sola en cada campaña, aunque difieran). Una diferencia cuenta en una condición si supera la variación entre repeticiones de las dos; las tendencias usan solo los niveles medidos en las dos. Es una lectura descriptiva, no un contraste estadístico (docs/campaigns.md).',
            'Fixed rules over the valid runs of both: conditions are paired by the same network profile, the same target latency (in ms) and the same stream (with a single stream in each campaign, even if they differ). A difference counts in a condition if it exceeds the variation between repetitions of both; trends use only the levels measured in both. This is a descriptive reading, not a statistical test (docs/campaigns.md).',
          )}
        />
      )}
      {data?.tables && <CampaignVersusTables tables={data.tables} />}
    </div>
  );
};
