import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { PlayerId } from '../types';

// Tablas de la comparación de dos campañas (README 4.8, «Comparar dos campañas»): las mismas cifras que el texto, que
// el orquestador manda en `tables`. Cada valor viene en unidades del resumen; `metrics` dice cómo presentarlo.

const PLAYER_LABEL: Record<PlayerId, string> = { dash: 'LL-DASH', moq: 'MoQ', rtc: 'WebRTC' };
const ORDER: PlayerId[] = ['dash', 'moq', 'rtc'];

interface MetricMeta {
  label: string;
  unit: string;
  scale: number;
  digits: number;
}
type Verdict = 'b_mayor' | 'b_menor' | 'igual' | 'no_concluyente' | 'sin_dato';

export interface VersusTables {
  metrics: Record<string, MetricMeta>;
  summary: Partial<Record<PlayerId, { key: string; a: number; b: number; diff: number; relative: number | null; n: number; b_lower: number; b_higher: number; unclear: number }[]>>;
  by_condition: Partial<Record<PlayerId, { label: string; reps: [number, number]; values: Record<string, { a: number | null; b: number | null; noise: number | null; verdict: Verdict }> }[]>>;
  controls: Partial<Record<PlayerId, { n: [number, number]; rows: { key: string; a: number; b: number; noise: number; beyond: boolean }[] }>>;
  trends: { title: string; levels: string[]; rows: { player: PlayerId; key: string; a: (number | null)[]; b: (number | null)[] }[] }[];
}

const VERDICT: Record<Verdict, { label: string; style: string }> = {
  b_mayor: { label: 'B mayor', style: 'text-sky-300' },
  b_menor: { label: 'B menor', style: 'text-sky-300' },
  igual: { label: 'igual', style: 'text-slate-400' },
  no_concluyente: { label: 'no concluyente', style: 'text-amber-300' },
  sin_dato: { label: 'sin dato', style: 'text-slate-500' },
};

const num = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined ? '--' : v.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const plain = (m: MetricMeta, v: number | null | undefined) => (v === null || v === undefined ? '--' : num(v * m.scale, m.digits));
const withUnit = (m: MetricMeta, v: number | null | undefined) => {
  const text = plain(m, v);
  return text === '--' || !m.unit ? text : m.unit === 'p' ? `${text}p` : `${text} ${m.unit}`;
};
// Una diferencia: en las métricas en %, puntos porcentuales (pt), para no confundirla con el cambio relativo
const diffUnit = (m: MetricMeta, v: number | null | undefined) => {
  const text = plain(m, v);
  return text === '--' ? text : m.unit === '%' ? `${text} pt` : m.unit === 'p' ? `${text}p` : m.unit ? `${text} ${m.unit}` : text;
};
const relText = (r: number | null) => (r === null ? '' : `${r > 0 ? '+' : ''}${num(r * 100, 0)} %`);

/** Una tabla con su botón de copiar en TSV (se pega en una hoja de cálculo). */
const CopyableTable: React.FC<{ title: string; head: string[]; rows: (string | React.ReactNode)[][]; tsv: string[][]; note?: string }> = ({
  title,
  head,
  rows,
  tsv,
  note,
}) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([head, ...tsv].map((r) => r.join('\t')).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin portapapeles: la tabla sigue a la vista
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold text-slate-300">{title}</h4>
        <button className="ml-auto flex items-center gap-1 text-slate-400 hover:text-white" onClick={copy} title="Copiar la tabla (separada por tabuladores, para pegarla en una hoja de cálculo)">
          {copied ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />} {copied ? 'Copiada' : 'Copiar tabla'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-[10px] text-slate-500 uppercase">
            <tr>
              {head.map((h, i) => (
                <th key={i} className={`py-0.5 pr-3 font-medium whitespace-nowrap ${i === 0 ? '' : 'text-right'}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-800/60">
                {r.map((c, j) => (
                  <td key={j} className={`py-0.5 pr-3 whitespace-nowrap ${j === 0 ? 'font-sans text-slate-300' : 'text-right text-slate-200'}`}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="text-slate-500">{note}</p>}
    </div>
  );
};

const Select: React.FC<{ value: string; onChange: (v: string) => void; options: [string, string][] }> = ({ value, onChange, options }) => (
  <select className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
    {options.map(([v, label]) => (
      <option key={v} value={v}>
        {label}
      </option>
    ))}
  </select>
);

export const CampaignVersusTables: React.FC<{ tables: VersusTables }> = ({ tables }) => {
  const { metrics } = tables;
  const players = ORDER.filter((p) => tables.summary[p]?.length);
  const metricKeys = Object.keys(metrics);
  const [showConditions, setShowConditions] = useState(false);
  const [condPlayer, setCondPlayer] = useState<PlayerId>(players[0] ?? 'dash');
  const [condMetric, setCondMetric] = useState(metricKeys.includes('stall_ratio') ? 'stall_ratio' : metricKeys[0]);
  const [showTrends, setShowTrends] = useState(false);
  const [trendIdx, setTrendIdx] = useState(0);
  const trend = tables.trends[trendIdx];
  const trendMetrics = trend ? [...new Set(trend.rows.map((r) => r.key))] : [];
  const [trendMetric, setTrendMetric] = useState('stall_ratio');
  const tMetric = trendMetrics.includes(trendMetric) ? trendMetric : trendMetrics[0];

  const controlPlayers = ORDER.filter((p) => tables.controls[p]);
  const conditions = tables.by_condition[condPlayer] ?? [];
  const cm = metrics[condMetric];

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-lg p-3 space-y-4">
      <h3 className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800 pb-0.5">Tablas</h3>

      {players.map((p) => {
        const rows = tables.summary[p]!;
        return (
          <CopyableTable
            key={p}
            title={`${PLAYER_LABEL[p]}: condiciones emparejadas`}
            head={['Métrica', 'A', 'B', 'B − A', 'B menor', 'B mayor', 'No concluyente']}
            rows={rows.map((r) => {
              const m = metrics[r.key];
              return [
                m.label[0].toUpperCase() + m.label.slice(1),
                withUnit(m, r.a),
                withUnit(m, r.b),
                <>
                  {diffUnit(m, r.diff)} <span className="text-slate-500">{relText(r.relative)}</span>
                </>,
                `${r.b_lower} de ${r.n}`,
                `${r.b_higher} de ${r.n}`,
                `${r.unclear} de ${r.n}`,
              ];
            })}
            tsv={rows.map((r) => {
              const m = metrics[r.key];
              return [m.label, plain(m, r.a), plain(m, r.b), plain(m, r.diff), String(r.b_lower), String(r.b_higher), String(r.unclear)];
            })}
            note="A y B: media de las condiciones emparejadas con dato en las dos (las «de n»; cada una, la mediana de sus repeticiones). B menor / B mayor: condiciones en que la diferencia supera la variación entre repeticiones de las dos. En las métricas en %, la diferencia va en puntos (pt) y entre paréntesis el cambio relativo."
          />
        );
      })}

      {controlPlayers.length > 0 && (
        <CopyableTable
          title="Pruebas de control (sin restricción de red)"
          head={['Protocolo · métrica', 'A', 'B', 'B − A', 'Variación entre las de control', '¿Difieren?']}
          rows={controlPlayers.flatMap((p) =>
            tables.controls[p]!.rows.map((r) => {
              const m = metrics[r.key];
              return [
                `${PLAYER_LABEL[p]} · ${m.label}`,
                withUnit(m, r.a),
                withUnit(m, r.b),
                diffUnit(m, r.b - r.a),
                diffUnit(m, r.noise),
                <span className={r.beyond ? 'text-amber-300' : 'text-slate-400'}>{r.beyond ? 'sí' : 'no'}</span>,
              ];
            }),
          )}
          tsv={controlPlayers.flatMap((p) =>
            tables.controls[p]!.rows.map((r) => {
              const m = metrics[r.key];
              return [`${PLAYER_LABEL[p]} · ${m.label}`, plain(m, r.a), plain(m, r.b), plain(m, r.b - r.a), plain(m, r.noise), r.beyond ? 'sí' : 'no'];
            }),
          )}
          note="Mediana de las pruebas de control de cada campaña. «Difieren»: más que la variación entre las de control y que 2 frames de latencia, medio punto de tiempo parado o un 5 % de altura o bitrate."
        />
      )}

      <div className="space-y-2">
        <button className="text-indigo-300 hover:text-indigo-200" onClick={() => setShowConditions((v) => !v)}>
          {showConditions ? 'Ocultar la tabla por condición ▴' : 'Ver la tabla por condición ▾'}
        </button>
        {showConditions && cm && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={condPlayer} onChange={(v) => setCondPlayer(v as PlayerId)} options={players.map((p) => [p, PLAYER_LABEL[p]])} />
              <Select value={condMetric} onChange={setCondMetric} options={metricKeys.map((k) => [k, metrics[k].label])} />
            </div>
            <CopyableTable
              title={`${PLAYER_LABEL[condPlayer]} · ${cm.label}, por condición`}
              head={['Condición', 'Rep. A / B', 'A', 'B', 'B − A', 'Variación', 'Veredicto']}
              rows={conditions.map((c) => {
                const v = c.values[condMetric];
                return [
                  c.label,
                  `${c.reps[0]} / ${c.reps[1]}`,
                  withUnit(cm, v?.a),
                  withUnit(cm, v?.b),
                  v && v.a !== null && v.b !== null ? diffUnit(cm, v.b - v.a) : '--',
                  diffUnit(cm, v?.noise),
                  <span className={`font-sans ${VERDICT[v?.verdict ?? 'sin_dato'].style}`}>{VERDICT[v?.verdict ?? 'sin_dato'].label}</span>,
                ];
              })}
              tsv={conditions.map((c) => {
                const v = c.values[condMetric];
                return [c.label, `${c.reps[0]}/${c.reps[1]}`, plain(cm, v?.a), plain(cm, v?.b), v && v.a !== null && v.b !== null ? plain(cm, v.b - v.a) : '--', plain(cm, v?.noise), VERDICT[v?.verdict ?? 'sin_dato'].label];
              })}
              note="Cada valor, la mediana de las repeticiones de la condición. Variación: el mayor recorrido entre repeticiones de las dos condiciones; la condición de B tiene el mismo perfil de red, la misma latencia objetivo en ms y la emisión equivalente (el nombre es el de A)."
            />
          </>
        )}
      </div>

      {tables.trends.length > 0 && trend && tMetric && (
        <div className="space-y-2">
          <button className="text-indigo-300 hover:text-indigo-200" onClick={() => setShowTrends((v) => !v)}>
            {showTrends ? 'Ocultar las tendencias en tabla ▴' : 'Ver las tendencias en tabla ▾'}
          </button>
          {showTrends && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={String(trendIdx)} onChange={(v) => setTrendIdx(Number(v))} options={tables.trends.map((t, i) => [String(i), t.title])} />
                <Select value={tMetric} onChange={setTrendMetric} options={trendMetrics.map((k) => [k, metrics[k].label])} />
              </div>
              {(() => {
                const m = metrics[tMetric];
                const rows = trend.rows.filter((r) => r.key === tMetric);
                const head = ['Nivel', ...rows.flatMap((r) => [`${PLAYER_LABEL[r.player]} A`, `${PLAYER_LABEL[r.player]} B`])];
                return (
                  <CopyableTable
                    title={`${m.label[0].toUpperCase() + m.label.slice(1)} · ${trend.title}`}
                    head={head}
                    rows={trend.levels.map((level, i) => [level, ...rows.flatMap((r) => [withUnit(m, r.a[i]), withUnit(m, r.b[i])])])}
                    tsv={trend.levels.map((level, i) => [level, ...rows.flatMap((r) => [plain(m, r.a[i]), plain(m, r.b[i])])])}
                    note="Cada valor, la mediana de las condiciones de ese nivel medidas en todos los niveles de la serie (las demás no entran, para no mezclar efectos)."
                  />
                );
              })()}
            </>
          )}
        </div>
      )}
    </div>
  );
};
