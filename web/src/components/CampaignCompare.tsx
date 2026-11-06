import React, { useEffect, useState } from 'react';
import { ArrowLeftRight, Check, Copy, GitCompare, X } from 'lucide-react';
import type { PlayerId } from '../types';

// Comparación en texto de dos pruebas, de la misma campaña o de dos distintas (README 4.8, «Comparar dos pruebas»).
// El texto lo escribe el orquestador (GET /api/compare) con reglas fijas a partir del resumen y las filas de cada
// prueba; aquí solo se elige el protocolo de cada lado y se muestra.

const PLAYER_LABEL: Record<PlayerId, string> = { dash: 'LL-DASH', moq: 'MoQ', rtc: 'WebRTC' };
const ORDER: PlayerId[] = ['dash', 'moq', 'rtc'];

/** Un lado de la comparación: una prueba de una campaña, con los reproductores que tiene. */
export interface CompareSide {
  campaign: string;
  campaignName: string;
  run: string;
  players: PlayerId[];
}

interface SideView {
  ref: string;
  campaign: string;
  campaign_name: string;
  run: string;
  player: PlayerId;
  state: string;
  rep: number;
  kind: 'test' | 'control';
  started_ms: number | null;
  network: string;
  network_profile: string;
  target: string;
  ladder: number[];
  reps: number;
}

interface MetricRow {
  key: string;
  label: string;
  unit: string;
  scale: number;
  digits: number;
  a: number | null;
  b: number | null;
  diff: number | null;
  relative: number | null;
  noise: number | null;
  noise_reps: [number, number];
  verdict: 'igual' | 'a_mayor' | 'b_mayor' | 'no_concluyente' | 'sin_repeticiones' | 'sin_dato';
}

interface Comparison {
  a: SideView;
  b: SideView;
  conditions: { key: string; label: string; a: string; b: string }[];
  metrics: MetricRow[];
  sentences: string[];
  warnings: string[];
}

const VERDICT: Record<MetricRow['verdict'], { label: string; style: string }> = {
  igual: { label: 'igual', style: 'text-slate-400' },
  a_mayor: { label: 'A mayor', style: 'text-sky-300' },
  b_mayor: { label: 'B mayor', style: 'text-sky-300' },
  no_concluyente: { label: 'no concluyente', style: 'text-amber-300' },
  sin_repeticiones: { label: 'sin repeticiones', style: 'text-amber-300' },
  sin_dato: { label: 'sin dato', style: 'text-slate-500' },
};

const num = (v: number | null, digits: number) =>
  v === null ? '--' : v.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const value = (m: MetricRow, v: number | null) => (v === null ? '--' : `${num(v * m.scale, m.digits)}${m.unit ? ` ${m.unit}` : ''}`);

const sideTitle = (s: SideView) =>
  `${PLAYER_LABEL[s.player]} · ${s.run}${s.kind === 'control' ? ' (control)' : ` (rep. ${s.rep + 1})`} de «${s.campaign_name}»`;

/** El texto entero, para pegarlo en notas o en un documento. */
function plainText(c: Comparison): string {
  const side = (name: string, s: SideView) =>
    `${name}: ${sideTitle(s)} [${s.ref}] · ${s.network} · objetivo ${s.target}${s.started_ms ? ` · ${new Date(s.started_ms).toLocaleString('es-ES')}` : ''}`;
  const lines = [side('A', c.a), side('B', c.b), ''];
  if (c.conditions.length) {
    lines.push('Cambia entre las dos:');
    c.conditions.forEach((x) => lines.push(`- ${x.label}: ${x.a} (A) / ${x.b} (B)`));
    lines.push('');
  }
  c.sentences.forEach((s) => lines.push(s));
  if (c.warnings.length) {
    lines.push('', 'Avisos:');
    c.warnings.forEach((w) => lines.push(`- ${w}`));
  }
  return lines.join('\n');
}

export const CampaignCompare: React.FC<{ a: CompareSide; b: CompareSide; onClose: () => void; onSwap: () => void }> = ({ a, b, onClose, onSwap }) => {
  // El protocolo de cada lado: por defecto, el primero que tengan las dos; si no comparten ninguno, el primero de cada una
  const shared = ORDER.filter((p) => a.players.includes(p) && b.players.includes(p));
  const [pa, setPa] = useState<PlayerId>(shared[0] ?? a.players[0]);
  const [pb, setPb] = useState<PlayerId>(shared[0] ?? b.players[0]);
  useEffect(() => {
    setPa(shared[0] ?? a.players[0]);
    setPb(shared[0] ?? b.players[0]);
  }, [a.campaign, a.run, b.campaign, b.run]);
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const q = new URLSearchParams({ a: `${a.campaign}/${a.run}/${pa}`, b: `${b.campaign}/${b.run}/${pb}` });
    fetch(`/api/compare?${q}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`);
        return body as Comparison;
      })
      .then((body) => !cancelled && setData(body))
      .catch((e) => {
        if (!cancelled) {
          setData(null);
          setError((e as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [a.campaign, a.run, b.campaign, b.run, pa, pb]);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(plainText(data));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No se pudo copiar al portapapeles');
    }
  };

  // Al elegir el protocolo de A, B le sigue si lo tiene: lo normal es comparar el mismo
  const chooseA = (p: PlayerId) => {
    setPa(p);
    if (b.players.includes(p)) setPb(p);
  };
  const picker = (side: CompareSide, current: PlayerId, choose: (p: PlayerId) => void) => (
    <select
      className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-xs"
      value={current}
      onChange={(e) => choose(e.target.value as PlayerId)}
    >
      {ORDER.filter((p) => side.players.includes(p)).map((p) => (
        <option key={p} value={p}>
          {PLAYER_LABEL[p]}
        </option>
      ))}
    </select>
  );

  return (
    <section className="bg-slate-900 border border-sky-800/60 rounded-xl p-4 space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <GitCompare className="w-4 h-4 text-sky-300" />
        <h2 className="text-sm font-semibold text-white">Comparación de dos pruebas</h2>
        <div className="ml-auto flex items-center gap-3">
          <button className="flex items-center gap-1 text-slate-300 hover:text-white" onClick={onSwap} title="Intercambiar A y B">
            <ArrowLeftRight className="w-3.5 h-3.5" /> Intercambiar
          </button>
          <button className="flex items-center gap-1 text-slate-300 hover:text-white disabled:opacity-40" onClick={copy} disabled={!data} title="Copiar la comparación como texto">
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copiado' : 'Copiar texto'}
          </button>
          <button className="text-slate-400 hover:text-white" onClick={onClose} title="Cerrar la comparación">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {([['A', a, pa, chooseA, data?.a], ['B', b, pb, setPb, data?.b]] as const).map(([name, side, current, choose, view]) => (
          <div key={name} className="bg-slate-950/60 border border-slate-800 rounded-lg p-2 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-bold text-sky-300">{name}</span>
              {picker(side, current, choose)}
              <span className="font-mono text-slate-300">{side.run}</span>
              {view && view.kind === 'control' && <span className="text-slate-500">control</span>}
              {view && view.kind === 'test' && <span className="text-slate-500">rep. {view.rep + 1}</span>}
            </div>
            <div className="text-slate-400 truncate" title={side.campaignName}>
              {side.campaignName}
            </div>
            {view && (
              <div className="text-slate-500">
                {view.network} · objetivo {view.target}
                {view.started_ms ? ` · ${new Date(view.started_ms).toLocaleString('es-ES')}` : ''}
                {` · ${view.reps} ${view.reps === 1 ? 'repetición válida' : 'repeticiones válidas'} de la condición`}
              </div>
            )}
          </div>
        ))}
      </div>

      {error && <p className="text-rose-300">{error}</p>}
      {!data && !error && <p className="text-slate-500">Comparando…</p>}

      {data && (
        <>
          <ul className="space-y-1.5 text-[13px] leading-snug text-slate-200">
            {data.sentences.map((s, i) => (
              <li key={i} className={i === 0 && s.startsWith('Superan') ? 'text-white font-medium' : ''}>
                {s}
              </li>
            ))}
          </ul>

          {data.warnings.length > 0 && (
            <ul className="space-y-0.5 text-amber-300/90">
              {data.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}

          <div>
            <h3 className="text-[11px] uppercase text-slate-500 mb-1">Lo que cambia entre las dos</h3>
            {data.conditions.length ? (
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
            ) : (
              <p className="text-slate-400">Nada de lo que se registra: misma emisión, red, objetivo, ajustes, versiones y trabajador.</p>
            )}
          </div>

          <button className="text-indigo-300 hover:text-indigo-200" onClick={() => setShowMetrics((v) => !v)}>
            {showMetrics ? 'Ocultar todas las métricas ▴' : 'Ver todas las métricas ▾'}
          </button>
          {showMetrics && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-[10px] text-slate-500 uppercase">
                  <tr>
                    <th className="py-0.5 pr-2 font-medium">Métrica</th>
                    <th className="py-0.5 pr-2 font-medium text-right">A</th>
                    <th className="py-0.5 pr-2 font-medium text-right">B</th>
                    <th className="py-0.5 pr-2 font-medium text-right">A − B</th>
                    <th className="py-0.5 pr-2 font-medium text-right" title="Recorrido de la métrica entre las repeticiones válidas de la misma condición, el mayor de las dos campañas">
                      Entre repeticiones
                    </th>
                    <th className="py-0.5 pr-2 font-medium">Veredicto</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {data.metrics.map((m) => (
                    <tr key={m.key} className="border-t border-slate-800/60">
                      <td className="py-0.5 pr-2 text-slate-400 font-sans">{m.label}</td>
                      <td className="py-0.5 pr-2 text-right text-slate-200">{value(m, m.a)}</td>
                      <td className="py-0.5 pr-2 text-right text-slate-200">{value(m, m.b)}</td>
                      <td className="py-0.5 pr-2 text-right text-slate-300">
                        {value(m, m.diff)}
                        {m.relative !== null && <span className="text-slate-500"> ({m.relative > 0 ? '+' : ''}{num(m.relative * 100, 0)} %)</span>}
                      </td>
                      <td className="py-0.5 pr-2 text-right text-slate-400">{value(m, m.noise)}</td>
                      <td className={`py-0.5 pr-2 font-sans ${VERDICT[m.verdict].style}`}>{VERDICT[m.verdict].label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-slate-500 mt-1">
                «Entre repeticiones»: cuánto varía la métrica entre las repeticiones válidas de la misma condición (emisión, red y objetivo) en la campaña de cada prueba, el mayor de los
                dos. Una diferencia que no lo supera no es concluyente. Es una regla práctica, no un contraste estadístico: con dos o tres repeticiones, el recorrido se queda corto.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
};
