import React, { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, ChartLine, Check, Copy, Download, Eraser, Eye, FlaskConical, GitCompare, ListPlus, ListX, Pause, Pencil, Play, RotateCcw, Server, Settings2, Trash2, X } from 'lucide-react';
import { CampaignEditor, DEFAULT_PLAYER_OPTIONS, formatDuration } from './CampaignEditor';
import { CampaignWorker } from './CampaignWorker';
import { SettingsButton, SettingsModal, type SettingsSection } from './SettingsModal';
import { CampaignList } from './CampaignList';
import { PLAYER_IDS } from '../lib/samples';
import { CampaignResults } from './CampaignResults';
import { CampaignPreview, stopPreview, type Preview } from './CampaignPreview';
import { CampaignCompare, type CompareSide } from './CampaignCompare';
import { CampaignAnalysis } from './CampaignAnalysis';
import { CampaignVersus } from './CampaignVersus';
import { multiStream, streamName, streamText } from '../lib/campaignStreams';
import type { Campaign, CampaignPlan, CampaignQueue, CampaignRun, PlayerId, ServerStatus } from '../types';
import { RouterTreePanel } from './RouterTree';
import { lang, locale, t } from '../lib/i18n';

// Página de campañas de medida (/campaign; docs/campaigns.md): editor, monitor y, en la misma pestaña o en otra
// (/campaign?worker=1), el trabajador que monta los reproductores. Con el trabajador activo el monitor se
// consulta menos y la tabla de pruebas va plegada, para no cargar el navegador que mide.

const STATE_LABEL: Record<string, string> = {
  ready: t('lista', 'ready'),
  running: t('en marcha', 'running'),
  paused: t('en pausa', 'paused'),
  done: t('terminada', 'done'),
  aborted: t('cancelada', 'aborted'),
  pending: t('en cola', 'queued'),
  preparing: t('preparando', 'preparing'),
  mounting: t('montando', 'mounting'),
  warmup: t('calentando', 'warming up'),
  measuring: t('midiendo', 'measuring'),
  closing: t('cerrando', 'closing'),
  invalid: t('inválida', 'invalid'),
  replaced: t('sustituida', 'replaced'),
};
const STATE_STYLE: Record<string, string> = {
  running: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  paused: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  done: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  aborted: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  ready: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
};
const PLAYER_SHORT: Record<PlayerId, string> = { dash: 'DASH', moq: 'MoQ', rtc: 'RTC' };

const ABR_LABEL: Record<string, string> = {
  default: t('por defecto', 'default'),
  l2a: 'L2A',
  l2afix: t('L2A (bugfix, experimento)', 'L2A (bugfix, experiment)'),
  lolp: 'LoL+',
  watch: t('librería', 'library'),
  probe: t('sondeo (experimento)', 'probing (experiment)'),
  probe2: t('sondeo v2 (experimento)', 'probing v2 (experiment)'),
};
const SWITCHING_LABEL: Record<string, string> = {
  seamless: t('sin corte', 'seamless'),
  cancel: t('cancelar (experimento)', 'cancel (experiment)'),
  priority: t('prioridad (experimento)', 'priority (experiment)'),
};

/** Ajustes de los reproductores de la campaña, de los protocolos que prueba. Sin player_options (campañas
 * anteriores), los del dashboard al abrirse. */
function optionsText(plan: Campaign['plan']): string {
  const o = { ...DEFAULT_PLAYER_OPTIONS, ...(plan.player_options ?? {}) };
  const parts = [];
  if (plan.players.includes('dash'))
    parts.push(
      t(
        `DASH: ABR ${ABR_LABEL[o.dash_abr]}, salto al directo ${o.dash_max_drift_s ? `${o.dash_max_drift_s} s` : 'nunca'}, búfer mínimo ${o.dash_playback_buffer_min_s} s`,
        `DASH: ABR ${ABR_LABEL[o.dash_abr]}, jump to live ${o.dash_max_drift_s ? `${o.dash_max_drift_s} s` : 'never'}, minimum buffer ${o.dash_playback_buffer_min_s} s`,
      ),
    );
  if (plan.players.includes('moq'))
    parts.push(t(`MoQ: adaptación ${ABR_LABEL[o.moq_abr]}, cambio ${SWITCHING_LABEL[o.moq_switching]}`, `MoQ: adaptation ${ABR_LABEL[o.moq_abr]}, switching ${SWITCHING_LABEL[o.moq_switching]}`));
  if (plan.players.includes('rtc')) parts.push('WebRTC');
  const mode = plan.player_mode === 'each' ? t('de uno en uno', 'one at a time') : t('a la vez', 'simultaneously');
  const content = plan.content === 'restart' ? t('desde el principio en cada prueba', 'from the start in each run') : t('continuo', 'continuous');
  return `${parts.join(' · ')} · ${mode} · ${t('calidad', 'rendition')} ${plan.quality ? `${plan.quality}p` : 'auto'} · ${t('contenido', 'content')} ${content}`;
}

const fmt = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '--' : v.toFixed(digits));

const Badge: React.FC<{ state: string }> = ({ state }) => (
  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATE_STYLE[state] ?? STATE_STYLE.ready}`}>{STATE_LABEL[state] ?? state}</span>
);

async function call(path: string, method = 'GET', payload?: unknown): Promise<any> {
  const res = await fetch(path, payload === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `Error ${res.status}`);
  return body;
}

// focus: la prueba pulsada en los resultados (n cambia en cada clic, para volver a ella aunque sea la misma)
const RunsTable: React.FC<{
  campaign: Campaign;
  focus: { id: string; n: number } | null;
  onChanged: () => void;
  onPreview: (run: CampaignRun) => void;
  onSeries: (id: string) => void;
  // Comparación de dos pruebas: la elegida como A (de esta campaña o de otra) y elegir una
  compareFrom: CompareSide | null;
  onCompare: (side: CompareSide) => void;
  busy: string | null; // nombre de la campaña en marcha: sin comparaciones mientras mide
}> = ({ campaign, focus, onChanged, onPreview, onSeries, compareFrom, onCompare, busy }) => {
  const plan = campaign.plan;
  const runs = campaign.runs ?? [];
  const streams = multiStream(plan);
  const [error, setError] = useState<string | null>(null);
  // Resaltada unos segundos, para encontrarla en la tabla
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    document.getElementById(`run-${campaign.id}-${focus.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(focus.id);
    const timer = setTimeout(() => setHighlight(null), 6000);
    return () => clearTimeout(timer);
  }, [focus, campaign.id]);
  // Se repite una prueba terminada que no tenga ya su repetición (la de la copia se repite en la copia)
  const repeated = new Set(runs.map((r) => r.retry_of).filter(Boolean));
  const repeat = async (run: CampaignRun) => {
    try {
      await call(`/api/campaigns/${campaign.id}/runs/${run.id}/repeat`, 'POST');
      setError(null);
      onChanged();
    } catch (e) {
      setError(`${run.id}: ${(e as Error).message}`);
    }
  };
  return (
    <div className="overflow-x-auto">
      {error && <p className="text-rose-400 mb-1">{error}</p>}
      <table className="w-full text-left text-[11px]">
        <thead className="text-[10px] text-slate-500 uppercase">
          <tr>
            <th className="py-1 pr-2 font-medium">{t('Prueba', 'Run')}</th>
            {streams && <th className="py-1 pr-2 font-medium">{t('Emisión', 'Stream')}</th>}
            <th className="py-1 pr-2 font-medium">{t('Red', 'Network')}</th>
            <th className="py-1 pr-2 font-medium">{t('Objetivo', 'Target')}</th>
            <th className="py-1 pr-2 font-medium">{t('Rep.', 'Rep.')}</th>
            <th className="py-1 pr-2 font-medium">{t('Estado', 'State')}</th>
            <th
              className="py-1 pr-2 font-medium"
              title={t('Por reproductor: glass-to-glass p50 / p95 (ms), fracción del tiempo parado y cambios de calidad', 'Per player: glass-to-glass p50 / p95 (ms), stall time fraction and quality switches')}
            >
              {t('Resultado (p50 / p95 ms · parado · cambios)', 'Result (p50 / p95 ms · stalled · switches)')}
            </th>
            <th className="py-1 pr-2 font-medium" />
          </tr>
        </thead>
        <tbody className="font-mono">
          {runs.map((run: CampaignRun) => (
            <tr
              key={run.id}
              id={`run-${campaign.id}-${run.id}`}
              className={`border-t border-slate-800/60 transition-colors ${
                run.id === highlight
                  ? 'bg-amber-900/40 outline outline-1 outline-amber-500/70'
                  : run.id === campaign.current
                    ? 'bg-indigo-950/40 hover:bg-indigo-900/40'
                    : 'hover:bg-slate-800/60'
              }`}
            >
              <td className="py-1 pr-2 text-slate-300">
                {run.id}
                {run.kind === 'control' && <span className="text-slate-500"> control</span>}
                {run.retry_of && (
                  <span className="text-slate-500">
                    {' '}
                    {run.manual ? t('repite', 'repeats') : t('reintenta', 'retries')} {run.retry_of}
                  </span>
                )}
              </td>
              {streams && (
                <td className="py-1 pr-2 text-slate-300 font-sans" title={streamText(plan.streams[run.stream])}>
                  {run.stream + 1}
                </td>
              )}
              <td className="py-1 pr-2 text-slate-300 font-sans">{run.network === null ? t('sin restricción', 'unrestricted') : plan.networks[run.network].label}</td>
              <td className="py-1 pr-2 text-slate-300 font-sans">{plan.targets[run.target].label}</td>
              <td className="py-1 pr-2 text-slate-400">{run.rep + 1}</td>
              <td className="py-1 pr-2 font-sans" title={run.invalid_reasons.join('; ')}>
                <span className={run.state === 'invalid' ? 'text-rose-300' : run.state === 'done' ? 'text-emerald-300' : 'text-slate-400'}>
                  {STATE_LABEL[run.state] ?? run.state}
                </span>
                {run.state === 'invalid' && <span className="text-slate-500"> ({run.invalid_reasons.join('; ')})</span>}
                {run.state === 'replaced' && <span className="text-slate-500"> {t('por', 'by')} {run.replaced_by}</span>}
              </td>
              <td className="py-1 pr-2 text-slate-300">
                {run.summary
                  ? run.players
                      .map((p) => {
                        const s = run.summary!.players[p] ?? {};
                        return `${PLAYER_SHORT[p]} ${fmt(s.g2g_p50_ms)}/${fmt(s.g2g_p95_ms)} · ${s.stall_ratio == null ? '--' : `${(s.stall_ratio * 100).toFixed(1)} %`} · ${fmt(s.quality_switches)}`;
                      })
                      .join('   ')
                  : run.players.map((p) => PLAYER_SHORT[p]).join(' + ')}
                {(run.workers || run.worker_info || run.concurrent) && (
                  <div className="text-[10px] text-slate-500 font-sans">
                    {run.workers
                      ? run.players
                          .map((p) => {
                            const w = run.workers![p];
                            const ip = w ? run.client_ips?.[w] : undefined;
                            return t(`${PLAYER_SHORT[p]} en ${w ?? '?'}${ip ? ` (${ip})` : ''}`, `${PLAYER_SHORT[p]} on ${w ?? '?'}${ip ? ` (${ip})` : ''}`);
                          })
                          .join(' · ')
                      : run.worker_info
                        ? t(`en ${Object.keys(run.worker_info).join(', ')}`, `on ${Object.keys(run.worker_info).join(', ')}`)
                        : ''}
                    {run.concurrent?.length ? t(` · a la vez que ${run.concurrent.join(', ')}`, ` · concurrently with ${run.concurrent.join(', ')}`) : ''}
                  </div>
                )}
              </td>
              <td className="py-1 pr-2 font-sans">
                <div className="flex items-center gap-3">
                {campaign.state !== 'running' && (
                  <button
                    className="flex items-center gap-1 text-sky-300 hover:text-sky-200"
                    title={t(
                      'Ver en directo los reproductores con los ajustes de esta prueba, aplicando su red y su emisión. No se mide ni se graba nada; al cerrar, la red y la emisión vuelven a como estaban',
                      "Watch the players live with this run's settings, applying its network and stream. Nothing is measured or recorded; on closing, the network and stream are restored",
                    )}
                    onClick={() => onPreview(run)}
                  >
                    <Eye className="w-3 h-3" /> {t('Ver', 'View')}
                  </button>
                )}
                {/* Las gráficas solo tienen las pruebas terminadas y válidas */}
                {run.state === 'done' && run.summary && (
                  <button
                    className="flex items-center gap-1 text-emerald-300 hover:text-emerald-200"
                    title={t('Abrir esta prueba en la gráfica segundo a segundo, con varias métricas', 'Open this run in the per-second chart, with several metrics')}
                    onClick={() => onSeries(run.id)}
                  >
                    <ChartLine className="w-3 h-3" /> {t('Gráfica', 'Chart')}
                  </button>
                )}
                {/* Con resumen: las terminadas, válidas o no (la comparación avisa si no es válida) */}
                {run.summary && (
                  <button
                    className={`flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed ${compareFrom?.campaign === campaign.id && compareFrom.run === run.id ? 'text-sky-200 font-semibold' : 'text-sky-300 hover:text-sky-200'}`}
                    disabled={!!busy}
                    title={
                      busy
                        ? t(
                            `Hay una campaña en marcha («${busy}»): la comparación espera a que termine o se ponga en pausa, para no interferir en sus medidas`,
                            `A campaign is running ("${busy}"): comparison waits until it ends or is paused, so as not to interfere with its measurements`,
                          )
                        : !compareFrom
                        ? t('Elegir esta prueba como A para compararla con otra, de esta campaña o de otra', 'Pick this run as A to compare it with another, from this campaign or another one')
                        : compareFrom.campaign === campaign.id && compareFrom.run === run.id
                          ? t('Es la prueba A: pulsa para dejar de compararla', 'This is run A: click to stop comparing it')
                          : t(`Comparar con A (${compareFrom.run} de «${compareFrom.campaignName}»)`, `Compare with A (${compareFrom.run} from "${compareFrom.campaignName}")`)
                    }
                    onClick={() => onCompare({ campaign: campaign.id, campaignName: campaign.name, run: run.id, players: run.players })}
                  >
                    <GitCompare className="w-3 h-3" />{' '}
                    {!compareFrom
                      ? t('Comparar', 'Compare')
                      : compareFrom.campaign === campaign.id && compareFrom.run === run.id
                        ? t('Es A', 'Is A')
                        : t('Comparar con A', 'Compare with A')}
                  </button>
                )}
                {(run.state === 'done' || run.state === 'invalid') && !repeated.has(run.id) && (
                  <button
                    className="flex items-center gap-1 text-indigo-300 hover:text-indigo-200"
                    title={
                      run.state === 'done'
                        ? t(
                            'Repetir al final de la cola. Este resultado sigue contando hasta que la repetición termine válida, y entonces la sustituye',
                            'Repeat at the end of the queue. This result keeps counting until the repetition finishes valid, which then replaces it',
                          )
                        : t('Repetir al final de la cola', 'Repeat at the end of the queue')
                    }
                    onClick={() => repeat(run)}
                  >
                    <RotateCcw className="w-3 h-3" /> {t('Repetir', 'Repeat')}
                  </button>
                )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// Lo que muestra el editor: una campaña nueva, la copia de otra o el plan de una que aún no ha empezado
type EditorMode = { initial?: CampaignPlan; editId?: string };

const Monitor: React.FC<{
  campaign: Campaign;
  lean: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onEdit: (mode: EditorMode) => void;
  onPreview: (run: CampaignRun) => void;
  compareFrom: CompareSide | null;
  onCompare: (side: CompareSide) => void;
  busy: string | null;
}> = ({ campaign, lean, onChanged, onDeleted, onEdit, onPreview, compareFrom, onCompare, busy }) => {
  const [error, setError] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(!lean);
  // Con el trabajador en esta pestaña, las gráficas van plegadas: no se dibujan mientras mide
  const [showResults, setShowResults] = useState(!lean);
  // El análisis en texto, plegado por defecto: lee las filas de toda la campaña
  const [showAnalysis, setShowAnalysis] = useState(false);
  // Comparación con otra campaña entera, plegada por defecto
  const [showVersus, setShowVersus] = useState(false);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  // La prueba que se abre en la gráfica segundo a segundo desde la tabla (n, como en focus)
  const [seriesFocus, setSeriesFocus] = useState<{ id: string; n: number } | null>(null);
  const showSeries = (id: string) => {
    setShowResults(true);
    setSeriesFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  };
  const selectRun = (id: string) => {
    setShowRuns(true);
    setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  };
  // Nombre en edición; null si no se está editando
  const [draftName, setDraftName] = useState<string | null>(null);
  // Descripción en edición, igual
  const [draftDescription, setDraftDescription] = useState<string | null>(null);
  // Al pasar a otra campaña no se arrastra lo que se estuviera escribiendo en la anterior
  useEffect(() => {
    setDraftName(null);
    setDraftDescription(null);
  }, [campaign.id]);
  const saveDescription = async () => {
    if (draftDescription === null) return;
    try {
      await call(`/api/campaigns/${campaign.id}`, 'PATCH', { description: draftDescription });
      setDraftDescription(null);
      setError(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveName = async () => {
    const name = draftName?.trim();
    if (!name || name === campaign.name) return setDraftName(null);
    try {
      await call(`/api/campaigns/${campaign.id}`, 'PATCH', { name });
      setDraftName(null);
      setError(null);
      onChanged();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  const act = async (action: 'start' | 'pause' | 'enqueue' | 'dequeue') => {
    try {
      await call(`/api/campaigns/${campaign.id}/${action}`, 'POST');
      setError(null);
      onChanged();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  const remove = async () => {
    if (!window.confirm(t(`¿Borrar la campaña ${campaign.name} y todas sus medidas?`, `Delete campaign ${campaign.name} and all its measurements?`))) return;
    try {
      await call(`/api/campaigns/${campaign.id}`, 'DELETE');
      onDeleted();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  // Borra las medidas y la deja lista, con las mismas pruebas sorteadas de nuevo (no se deshace)
  const clearMeasures = async () => {
    const measured = (campaign.runs ?? []).filter((r) => r.state !== 'pending').length;
    const manual = (campaign.runs ?? []).filter((r) => r.manual).length;
    const text =
      lang === 'en'
        ? `Delete the measurements of ${campaign.name}?\n\n` +
          `${measured} measured or attempted runs are lost (samples, runs and IP) and this cannot be undone.` +
          (manual ? ` The ${manual} manually added repetitions are also removed.` : '') +
          `\n\nIt is left ready, with the same plan and the same runs in the same order (same seed); the name, description and events are kept.`
        : `¿Borrar las medidas de ${campaign.name}?\n\n` +
          `Se pierden ${measured} pruebas medidas o intentadas (samples, runs e IP) y no se puede deshacer.` +
          (manual ? ` También desaparecen las ${manual} repeticiones añadidas a mano.` : '') +
          `\n\nQueda lista, con el mismo plan y las mismas pruebas en el mismo orden (misma semilla); el nombre, la descripción y los eventos se conservan.`;
    if (!window.confirm(text)) return;
    try {
      await call(`/api/campaigns/${campaign.id}/clear`, 'POST');
      setError(null);
      onChanged();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const c = campaign.counts;
  const finished = (c.done ?? 0) + (c.invalid ?? 0) + (c.replaced ?? 0);
  const current = campaign.runs?.find((r) => r.id === campaign.current);
  const worker = campaign.worker;
  const plan = campaign.plan;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        {draftName === null ? (
          <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
            {campaign.name}
            <button className="text-slate-500 hover:text-indigo-300" title={t('Cambiar el nombre', 'Rename')} onClick={() => setDraftName(campaign.name)}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </h2>
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              maxLength={120}
              className="bg-slate-950 border border-indigo-500 rounded px-2 py-1 text-sm text-white w-80 focus:outline-none"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName();
                if (e.key === 'Escape') setDraftName(null);
              }}
            />
            <button className="text-emerald-400 hover:text-emerald-300" title={t('Guardar (Intro)', 'Save (Enter)')} onClick={saveName}>
              <Check className="w-4 h-4" />
            </button>
            <button className="text-slate-500 hover:text-slate-300" title={t('Cancelar (Esc)', 'Cancel (Esc)')} onClick={() => setDraftName(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <Badge state={campaign.state} />
        {campaign.archived && <span className="text-[11px] px-2 py-0.5 rounded-full border border-slate-600 text-slate-400">{t('archivada', 'archived')}</span>}
        <span className="text-slate-500 font-mono">{campaign.id}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {campaign.state !== 'running' && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-slate-500"
              title={
                campaign.archived
                  ? t('Vuelve a la lista principal; se puede arrancar y encolar', 'Returns to the main list; it can be started and queued')
                  : t(
                      'Se lista aparte, plegada, y no se puede arrancar ni encolar hasta desarchivarla. No borra nada; si estaba en la cola, sale de ella',
                      'Listed separately, collapsed, and it cannot be started or queued until unarchived. Nothing is deleted; if it was queued, it leaves the queue',
                    )
              }
              onClick={async () => {
                try {
                  await call(`/api/campaigns/${campaign.id}`, 'PATCH', { archived: !campaign.archived });
                  setError(null);
                  onChanged();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {campaign.archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />} {campaign.archived ? t('Desarchivar', 'Unarchive') : t('Archivar', 'Archive')}
            </button>
          )}
          {!campaign.archived && (campaign.state === 'ready' || campaign.state === 'paused') && (
            <button className="flex items-center gap-1 px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white" onClick={() => act('start')}>
              <Play className="w-3.5 h-3.5" /> {campaign.state === 'paused' ? t('Reanudar', 'Resume') : t('Arrancar', 'Start')}
            </button>
          )}
          {!campaign.archived && (campaign.state === 'ready' || campaign.state === 'paused') &&
            (campaign.queue_position ? (
              <button
                className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-rose-500"
                title={t('Sacarla de la cola; no cambia nada más', 'Remove it from the queue; nothing else changes')}
                onClick={() => act('dequeue')}
              >
                <ListX className="w-3.5 h-3.5" /> {t(`Sacar de la cola (${campaign.queue_position}.ª)`, `Dequeue (#${campaign.queue_position})`)}
              </button>
            ) : (
              <button
                className="flex items-center gap-1 px-3 py-1 rounded border border-emerald-700 text-emerald-300 hover:border-emerald-500"
                title={t(
                  'Al final de la cola: arranca sola cuando terminen las de delante. Si no hay ninguna en marcha, arranca ya',
                  'At the end of the queue: starts on its own when the ones ahead finish. If none is running, it starts now',
                )}
                onClick={() => act('enqueue')}
              >
                <ListPlus className="w-3.5 h-3.5" /> {t('Encolar', 'Enqueue')}
              </button>
            ))}
          {campaign.state === 'running' && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white"
              title={t(
                'Detiene la campaña: la red y la emisión vuelven a como estaban al empezar, sale de la cola y, si quedan otras, la cola se detiene hasta reanudarla. Lo medido se conserva y la prueba en curso se repetirá al reanudar.',
                'Stops the campaign: the network and stream return to how they were at the start, it leaves the queue and, if others remain, the queue halts until resumed. What was measured is kept and the current run is repeated on resuming.',
              )}
              onClick={() => act('pause')}
            >
              <Pause className="w-3.5 h-3.5" /> {t('Pausa', 'Pause')}
            </button>
          )}
          {/* Lista = aún no ha arrancado nunca (al arrancar pasa a en marcha y de ahí nunca vuelve) */}
          {campaign.state === 'ready' && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
              title={t('Cambiar el plan: solo antes de arrancarla. Las pruebas se vuelven a sortear.', 'Change the plan: only before starting it. The runs are shuffled again.')}
              onClick={() => onEdit({ initial: campaign.plan, editId: campaign.id })}
            >
              <Settings2 className="w-3.5 h-3.5" /> {t('Editar', 'Edit')}
            </button>
          )}
          <button
            className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
            title={t('Campaña nueva con este plan, para repetirla o variar algo. La original no cambia.', 'New campaign with this plan, to repeat it or vary something. The original does not change.')}
            onClick={() => onEdit({ initial: campaign.plan })}
          >
            <Copy className="w-3.5 h-3.5" /> {t('Duplicar', 'Duplicate')}
          </button>
          {(['runs', 'samples', 'ip'] as const).map((name) => (
            <a
              key={name}
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
              href={`/api/campaigns/${campaign.id}/${name}.csv`}
              title={
                name === 'runs'
                  ? t('Una fila por prueba y reproductor, con su resumen', 'One row per run and player, with its summary')
                  : name === 'samples'
                    ? t('Todas las filas de cada segundo, con la condición de su prueba', 'All per-second rows, with the condition of their run')
                    : t('Tráfico IP en el router de cada segundo, por protocolo y sentido, leído por el servidor', 'Per-second IP traffic at the router, by protocol and direction, read by the server')
              }
            >
              <Download className="w-3.5 h-3.5" /> {name === 'runs' ? t('Resumen CSV', 'Summary CSV') : name === 'samples' ? t('Muestras CSV', 'Samples CSV') : t('Tráfico IP CSV', 'IP traffic CSV')}
            </a>
          ))}
          {campaign.state !== 'running' && (campaign.state !== 'ready' || Object.keys(campaign.counts).some((k) => k !== 'pending')) && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-rose-500 hover:text-rose-300"
              title={t(
                'Borra las medidas y la deja lista, con el mismo plan y las mismas pruebas (misma semilla). No se puede deshacer',
                'Deletes the measurements and leaves it ready, with the same plan and the same runs (same seed). Cannot be undone',
              )}
              onClick={clearMeasures}
            >
              <Eraser className="w-3.5 h-3.5" /> {t('Borrar medidas', 'Delete measurements')}
            </button>
          )}
          {campaign.state !== 'running' && (
            <button className="text-slate-500 hover:text-rose-400 px-1" title={t('Borrar la campaña', 'Delete the campaign')} onClick={remove}>
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Descripción: texto libre, editable en cualquier estado (como el nombre) */}
      {draftDescription === null ? (
        <div className="group flex items-start gap-1.5">
          {plan.description ? (
            <p className="text-slate-300 whitespace-pre-wrap break-words max-w-4xl leading-relaxed">{plan.description}</p>
          ) : (
            <span className="text-slate-600">{t('Sin descripción', 'No description')}</span>
          )}
          <button className="text-slate-500 hover:text-indigo-300 shrink-0 mt-0.5" title={plan.description ? t('Cambiar la descripción', 'Edit the description') : t('Añadir una descripción', 'Add a description')} onClick={() => setDraftDescription(plan.description ?? '')}>
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="space-y-1 max-w-4xl">
          <textarea
            autoFocus
            maxLength={20000}
            className="w-full min-h-[6rem] resize-y bg-slate-950 border border-indigo-500 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
            value={draftDescription}
            placeholder={t('Qué se quiere ver, hipótesis, qué cambia respecto a otras campañas…', 'What to look for, hypotheses, what changes with respect to other campaigns…')}
            onChange={(e) => setDraftDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveDescription();
              if (e.key === 'Escape') setDraftDescription(null);
            }}
          />
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white" onClick={saveDescription}>
              <Check className="w-3.5 h-3.5" /> {t('Guardar', 'Save')}
            </button>
            <button className="px-2.5 py-0.5 rounded border border-slate-700 text-slate-300 hover:border-slate-500" onClick={() => setDraftDescription(null)}>
              {t('Descartar', 'Discard')}
            </button>
            <span className="text-slate-500">{t('Ctrl/⌘ + Intro guarda, Esc descarta', 'Ctrl/⌘ + Enter saves, Esc discards')}</span>
          </div>
        </div>
      )}

      {/* Progreso */}
      <div className="space-y-1">
        <div className="h-2 rounded bg-slate-800 overflow-hidden flex">
          <div className="bg-emerald-500" style={{ width: `${(100 * (c.done ?? 0)) / Math.max(1, campaign.total_runs)}%` }} />
          <div className="bg-rose-500" style={{ width: `${(100 * (c.invalid ?? 0)) / Math.max(1, campaign.total_runs)}%` }} />
          <div className="bg-slate-500" style={{ width: `${(100 * (c.replaced ?? 0)) / Math.max(1, campaign.total_runs)}%` }} />
        </div>
        <div className="flex flex-wrap gap-x-4 text-slate-400">
          <span>
            {t(
              `${finished} de ${campaign.total_runs} pruebas (${c.done ?? 0} válidas, ${c.invalid ?? 0} inválidas${c.replaced ? `, ${c.replaced} ${c.replaced === 1 ? 'sustituida' : 'sustituidas'} por su repetición` : ''})`,
              `${finished} of ${campaign.total_runs} runs (${c.done ?? 0} valid, ${c.invalid ?? 0} invalid${c.replaced ? `, ${c.replaced} replaced by their repetition` : ''})`,
            )}
          </span>
          {campaign.state !== 'done' && campaign.state !== 'aborted' && <span>{t(`quedan unas ${formatDuration(campaign.eta_s)}`, `about ${formatDuration(campaign.eta_s)} left`)}</span>}
          <span>
            {multiStream(plan) && t(`${plan.streams.length} emisiones × `, `${plan.streams.length} streams × `)}
            {t(
              `${plan.networks.length} redes × ${plan.targets.length} objetivos × ${plan.repetitions} repeticiones · ${plan.warmup_s} + ${plan.measure_s} s · semilla ${plan.seed}`,
              `${plan.networks.length} networks × ${plan.targets.length} targets × ${plan.repetitions} repetitions · ${plan.warmup_s} + ${plan.measure_s} s · seed ${plan.seed}`,
            )}
          </span>
          <span>{optionsText(plan)}</span>
        </div>
        <ul className="text-slate-400">
          {plan.streams.map((st, i) => (
            <li key={i}>
              <span className="text-slate-300">{multiStream(plan) ? streamName(i) : t('Emisión', 'Stream')}:</span> {streamText(st)}
            </li>
          ))}
        </ul>
      </div>

      {/* Prueba en curso y trabajador */}
      {campaign.state === 'running' && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
          {current ? (
            <span>
              {t('En curso', 'Current')}: <span className="font-mono text-slate-200">{campaign.batch?.length ? campaign.batch.join(' + ') : current.id}</span>
              {campaign.batch?.length ? t(' (en paralelo)', ' (in parallel)') : ''} · {STATE_LABEL[current.state]}
              {multiStream(plan) && (
                <>
                  {' '}
                  · <span className="text-slate-200" title={streamText(plan.streams[current.stream])}>{streamName(current.stream).toLowerCase()}</span>
                </>
              )}{' '}
              · {t('red', 'network')}{' '}
              <span className="text-slate-200">{current.network === null ? t('sin restricción', 'unrestricted') : plan.networks[current.network].label}</span> · {t('objetivo', 'target')}{' '}
              <span className="text-slate-200">{plan.targets[current.target].label}</span>
            </span>
          ) : (
            <span>{t('Sin prueba en curso', 'No run in progress')}</span>
          )}
          {plan.worker_pool ? (
            // Pruebas en paralelo: el grupo de trabajadores, cada uno con lo que mide
            (campaign.workers ?? []).map((w) => (
              <span key={w.name} className={w.connected && !w.outdated ? 'text-emerald-300' : 'text-amber-300'}>
                {w.name}: {w.connected ? (w.task ? `${w.task.players?.join('|') ?? '?'} · ${w.task.run}` : t('libre', 'idle')) : t('sin conexión', 'disconnected')}
                {w.connected && w.outdated && t(' · web desactualizada', ' · outdated web')}
              </span>
            ))
          ) : plan.workers ? (
            // Trabajadores independientes: uno por reproductor (docs/campaigns.md, trabajadores independientes)
            PLAYER_IDS.filter((p) => plan.players.includes(p)).map((p) => {
              const name = plan.workers![p]!;
              const w = campaign.workers?.find((x) => x.name === name);
              return (
                <span key={p} className={w?.connected && !w.outdated ? 'text-emerald-300' : 'text-amber-300'}>
                  {p}: {name} {w?.connected ? (w.mounted ? `· ${w.mounted}` : t('· conectado', '· connected')) : t('· sin conexión', '· disconnected')}
                  {w?.connected && w.outdated && t(' · web desactualizada', ' · outdated web')}
                </span>
              );
            })
          ) : (
            <span className={worker?.connected && !worker.outdated ? 'text-emerald-300' : 'text-amber-300'}>
              {worker?.connected
                ? t(`Trabajador ${worker.id} conectado`, `Worker ${worker.id} connected`)
                : t('Esperando a un trabajador: abre /campaign?worker=1 en una pestaña visible', 'Waiting for a worker: open /campaign?worker=1 in a visible tab')}
              {worker?.connected && worker.outdated && t(' · web desactualizada: recárgalo', ' · outdated web: reload it')}
            </span>
          )}
        </div>
      )}
      {/* Árbol de tc del router durante la prueba: con pruebas en paralelo, la plaza de cada trabajador con su red. No con
          el trabajador en esta pestaña (lean): leerlo y pintarlo cada 2 s cargaría la página que mide */}
      {campaign.state === 'running' && !lean && <RouterTreePanel poll />}
      {campaign.state !== 'running' && plan.worker_pool && (
        <p className="text-slate-400">
          {t('Pruebas en paralelo con los trabajadores libres de', 'Parallel runs with the idle workers of')}:{' '}
          {plan.worker_pool.map((n) => `${n}${campaign.workers?.find((x) => x.name === n)?.connected ? '' : t(' (sin conexión)', ' (disconnected)')}`).join(' · ')}
        </p>
      )}
      {campaign.state !== 'running' && plan.workers && (
        <p className="text-slate-400">
          {t('Navegadores independientes', 'Independent browsers')}:{' '}
          {PLAYER_IDS.filter((p) => plan.players.includes(p))
            .map((p) => {
              const w = campaign.workers?.find((x) => x.name === plan.workers![p]);
              return `${p} → ${plan.workers![p]}${w?.connected ? '' : t(' (sin conexión)', ' (disconnected)')}`;
            })
            .join(' · ')}
        </p>
      )}
      {error && <p className="text-rose-300">{error}</p>}

      {/* Eventos */}
      {!!campaign.events?.length && (
        <div className="text-slate-500 space-y-0.5 max-h-28 overflow-y-auto">
          {[...campaign.events].reverse().slice(0, lean ? 3 : 20).map((e, i) => (
            <div key={i}>
              <span className="font-mono">{new Date(e.t_ms).toLocaleString(locale)}</span> {e.message}
            </div>
          ))}
        </div>
      )}

      <button className="text-indigo-300 hover:text-indigo-200" onClick={() => setShowRuns((v) => !v)}>
        {showRuns ? t('Ocultar las pruebas ▴', 'Hide the runs ▴') : t('Ver las pruebas ▾', 'Show the runs ▾')}
      </button>
      {showRuns && <RunsTable campaign={campaign} focus={focus} onChanged={onChanged} onPreview={onPreview} onSeries={showSeries} compareFrom={compareFrom} onCompare={onCompare} busy={busy} />}

      <button className="block text-indigo-300 hover:text-indigo-200" onClick={() => setShowResults((v) => !v)}>
        {showResults ? t('Ocultar los resultados ▴', 'Hide the results ▴') : t('Ver los resultados ▾', 'Show the results ▾')}
      </button>
      {showResults && <CampaignResults campaign={campaign} onSelectRun={selectRun} seriesFocus={seriesFocus} />}

      <button className="block text-indigo-300 hover:text-indigo-200" onClick={() => setShowAnalysis((v) => !v)}>
        {showAnalysis ? t('Ocultar el análisis en texto ▴', 'Hide the text analysis ▴') : t('Ver el análisis en texto ▾', 'Show the text analysis ▾')}
      </button>
      {showAnalysis && <CampaignAnalysis campaign={campaign} busy={busy} />}

      <button className="block text-indigo-300 hover:text-indigo-200" onClick={() => setShowVersus((v) => !v)}>
        {showVersus ? t('Ocultar la comparación con otra campaña ▴', 'Hide the comparison with another campaign ▴') : t('Comparar con otra campaña ▾', 'Compare with another campaign ▾')}
      </button>
      {showVersus && <CampaignVersus campaign={campaign} busy={busy} />}
    </div>
  );
};

// Cola de campañas (docs/campaigns.md): al terminar la que está en marcha, el servidor arranca la primera. Pausar la que
// está en marcha la saca de la cola y la detiene hasta reanudarla
const QueuePanel: React.FC<{ queue: CampaignQueue; onChanged: () => void; onSelect: (id: string) => void }> = ({ queue, onChanged, onSelect }) => {
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      setError(null);
      onChanged();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  const move = (i: number, d: number) => {
    const ids = [...queue.ids];
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    run(() => call('/api/campaigns-queue', 'PUT', { ids }));
  };
  const total = queue.campaigns.reduce((t, c) => t + c.eta_s, 0);
  return (
    <div className="bg-slate-900 border border-emerald-900/60 rounded-xl px-4 py-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-emerald-200">{t('Cola de campañas', 'Campaign queue')}</span>
        <span className="text-slate-500">
          {lang === 'en'
            ? `${queue.campaigns.length} ${queue.campaigns.length === 1 ? 'campaign' : 'campaigns'} · about ${formatDuration(total)} in total`
            : `${queue.campaigns.length} ${queue.campaigns.length === 1 ? 'campaña' : 'campañas'} · unas ${formatDuration(total)} en total`}
        </span>
        {queue.halted ? (
          <>
            <span className="text-amber-300">{t('Detenida por una pausa: no arranca ninguna hasta reanudarla.', 'Halted by a pause: none starts until it is resumed.')}</span>
            <button
              className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
              onClick={() => run(() => call('/api/campaigns-queue/resume', 'POST'))}
            >
              <Play className="w-3 h-3" /> {t('Reanudar la cola', 'Resume the queue')}
            </button>
          </>
        ) : (
          <span className="text-slate-500">{t('Arranca la siguiente al terminar la que está en marcha.', 'Starts the next one when the running one ends.')}</span>
        )}
      </div>
      <ol className="space-y-1">
        {queue.campaigns.map((c, i) => (
          <li key={c.id} className="flex items-center gap-2">
            <span className="w-5 text-right font-mono text-slate-500">{i + 1}.</span>
            <button className="text-slate-200 hover:text-indigo-300" onClick={() => onSelect(c.id)}>
              {c.name}
            </button>
            <Badge state={c.state} />
            <span className="text-slate-500">{t(`unas ${formatDuration(c.eta_s)}`, `about ${formatDuration(c.eta_s)}`)}</span>
            <span className="ml-auto flex items-center gap-1">
              <button className="p-0.5 text-slate-400 hover:text-white disabled:opacity-30" disabled={i === 0} title={t('Subir', 'Move up')} onClick={() => move(i, -1)}>
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-0.5 text-slate-400 hover:text-white disabled:opacity-30"
                disabled={i === queue.campaigns.length - 1}
                title={t('Bajar', 'Move down')}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button className="p-0.5 text-slate-400 hover:text-rose-400" title={t('Sacar de la cola', 'Dequeue')} onClick={() => run(() => call(`/api/campaigns/${c.id}/dequeue`, 'POST'))}>
                <X className="w-3.5 h-3.5" />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {error && <p className="text-rose-400">{error}</p>}
    </div>
  );
};

export const CampaignPage: React.FC = () => {
  // Trabajador independiente (?worker=1&name=...): solo el trabajador, sin monitor ni editor (docs/campaigns.md, trabajadores independientes)
  const workerName = new URLSearchParams(window.location.search).get('name');
  if (workerName && new URLSearchParams(window.location.search).get('worker') === '1') {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-2 font-sans">
        <CampaignWorker name={workerName} />
      </div>
    );
  }
  return <CampaignMonitorPage />;
};

const CampaignMonitorPage: React.FC = () => {
  const [worker, setWorker] = useState(() => new URLSearchParams(window.location.search).get('worker') === '1');
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [list, setList] = useState<Campaign[]>([]);
  const [queue, setQueue] = useState<CampaignQueue | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Campaign | null>(null);
  // Vista previa de una prueba: el servidor aplica su red y su emisión y aquí se montan sus reproductores
  const [preview, setPreview] = useState<Preview | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const openPreview = async (run: CampaignRun) => {
    if (!selected) return;
    try {
      const body = await call(`/api/campaigns/${selected.id}/runs/${run.id}/preview`, 'POST');
      setPreview({ ...body, settle_s: selected.plan.stream_settle_s });
      setPreviewError(null);
      // En escritorio se desplaza el contenido, no la ventana
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  };
  // Comparación de dos pruebas (docs/campaigns.md, «Comparar dos pruebas»): la A se elige en una campaña y la B en la misma o
  // en otra. La A se recuerda en el navegador, para elegirla y volver más tarde a por la B
  const [compareFrom, setCompareFrom] = useState<CompareSide | null>(() => {
    try {
      return JSON.parse(localStorage.getItem('campaign-compare-from') ?? 'null');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (compareFrom) localStorage.setItem('campaign-compare-from', JSON.stringify(compareFrom));
      else localStorage.removeItem('campaign-compare-from');
    } catch {
      // Sin almacenamiento, la A dura lo que la página
    }
  }, [compareFrom]);
  const [comparison, setComparison] = useState<{ a: CompareSide; b: CompareSide } | null>(null);
  // Con una campaña en marcha no se analiza ni se compara (el servidor responde 409): lee cientos de MB y ocupa CPU del
  // orquestador mientras mide
  const busy = list.find((c) => c.state === 'running')?.name ?? null;
  const pickCompare = (side: CompareSide) => {
    if (!compareFrom) return setCompareFrom(side);
    if (compareFrom.campaign === side.campaign && compareFrom.run === side.run) return setCompareFrom(null);
    setComparison({ a: compareFrom, b: side });
    mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  // Editor abierto (y con qué plan); null, el monitor
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const editing = editor !== null;
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    fetch('/api/status')
      .then((res) => (res.ok ? res.json() : null))
      .then(setStatus)
      .catch(() => {});
  }, []);

  // Lista de campañas; por defecto se sigue la que esté en marcha o la más reciente
  useEffect(() => {
    const load = () =>
      call('/api/campaigns')
        .then((all: Campaign[]) => {
          setList(all);
          setSelectedId((id) => id ?? all.find((c) => c.state === 'running')?.id ?? all.find((c) => !c.archived)?.id ?? null);
        })
        .catch(() => {});
      call('/api/campaigns-queue')
        .then(setQueue)
        .catch(() => {});
    load();
    const timer = setInterval(load, worker ? 15000 : 5000);
    return () => clearInterval(timer);
  }, [worker, tick]);

  useEffect(() => {
    if (!selectedId) return setSelected(null);
    const load = () =>
      call(`/api/campaigns/${selectedId}`)
        .then(setSelected)
        .catch(() => setSelected(null));
    load();
    const timer = setInterval(load, worker ? 10000 : 3000);
    return () => clearInterval(timer);
  }, [selectedId, worker, tick]);

  // Archivar o desarchivar desde la lista o el monitor
  const [listError, setListError] = useState<string | null>(null);
  const archive = async (id: string, archived: boolean) => {
    try {
      await call(`/api/campaigns/${id}`, 'PATCH', { archived });
      setListError(null);
      refresh();
    } catch (e) {
      setListError(
        archived
          ? t(`No se pudo archivar: ${(e as Error).message}`, `Could not archive: ${(e as Error).message}`)
          : t(`No se pudo desarchivar: ${(e as Error).message}`, `Could not unarchive: ${(e as Error).message}`),
      );
    }
  };

  const toggleWorker = () => {
    const next = !worker;
    setWorker(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('worker', '1');
    else url.searchParams.delete('worker');
    window.history.replaceState(null, '', url);
  };

  // La emisión por defecto del editor: la que esté configurada ahora
  const cfg = status?.config;
  const defaultStream = {
    source: cfg?.source ?? 'file',
    rtc_audio: cfg?.rtc_audio ?? false,
    rtc_pacing: cfg?.rtc_pacing ?? false,
    gop_size: cfg?.gop_size ?? 60,
    seg_duration: cfg?.seg_duration ?? 2.0,
    frag_duration: cfg?.frag_duration ?? 0.1,
    renditions: cfg?.renditions ?? [{ height: 1080, bitrate_kbps: 4000 }],
  };

  return (
    // En escritorio la página ocupa la ventana: la cabecera queda fija y la lista y el contenido se desplazan cada uno
    // por su cuenta, para que la lista llegue siempre al borde de abajo (si no, dependería del alto del contenido)
    <div className="min-h-screen md:h-screen md:flex md:flex-col bg-slate-950 text-slate-100 p-6 font-sans">
      <div className="w-full space-y-4 md:space-y-0 md:flex md:flex-col md:gap-4 md:flex-1 md:min-h-0">
        <header className="flex flex-wrap items-center gap-4 pb-4 border-b border-slate-800">
          <a href="/" className="text-slate-400 hover:text-white flex items-center gap-1 text-xs">
            <ArrowLeft className="w-4 h-4" /> Dashboard
          </a>
          <div className="flex items-center gap-2">
            <span className="p-2 bg-indigo-900/60 border border-indigo-700/50 rounded-lg text-indigo-400">
              <FlaskConical className="w-5 h-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">{t('Campañas de medida', 'Measurement campaigns')}</h1>
              <p className="text-xs text-slate-400">{t('Pruebas desatendidas por condición de red y latencia objetivo (docs/campaigns.md)', 'Unattended runs by network condition and target latency (docs/campaigns.md)')}</p>
            </div>
          </div>
          <button
            className="ml-auto flex items-center gap-1.5 text-xs text-slate-300 hover:text-white"
            onClick={() => setSettings('workers')}
            title={t(
              'Trabajadores independientes (un navegador por reproductor): estado, lo que están midiendo, modo de Chrome y borrado',
              'Independent workers (one browser per player): state, what they are measuring, Chrome mode and removal',
            )}
          >
            <Server className="w-4 h-4" /> {t('Trabajadores', 'Workers')}
          </button>
          <label
            className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer"
            title={t(
              'Esta pestaña monta los reproductores de cada prueba y sube sus medidas. Un solo trabajador a la vez; la pestaña tiene que quedar visible.',
              'This tab mounts the players of each run and uploads their measurements. One worker at a time; the tab must stay visible.',
            )}
          >
            <input type="checkbox" checked={worker} onChange={toggleWorker} />
            {t('Esta pestaña es el trabajador', 'This tab is the worker')}
          </label>
          <SettingsButton onClick={() => setSettings('language')} />
        </header>

        {settings && <SettingsModal initial={settings} onClose={() => setSettings(null)} />}
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-stretch md:flex-1 md:min-h-0">
        <CampaignList
          list={list}
          selectedId={selectedId}
          creating={editing && !editor.initial}
          editing={editing}
          onSelect={(id) => {
            setSelectedId(id);
            setEditor(null);
          }}
          onNew={() => setEditor({})}
          onArchive={archive}
        />
        <div ref={mainRef} className="flex-1 min-w-0 w-full space-y-4 md:h-full md:overflow-y-auto md:pr-1">
        {worker && <CampaignWorker />}

        {preview && (
          <CampaignPreview
            preview={preview}
            onClose={() => {
              stopPreview();
              setPreview(null);
            }}
          />
        )}
        {previewError && <p className="text-xs text-rose-400">{t('Vista previa', 'Preview')}: {previewError}</p>}

        {compareFrom && (
          <div className="flex flex-wrap items-center gap-2 text-xs bg-sky-950/40 border border-sky-800/60 rounded-lg px-3 py-2 text-sky-200">
            <GitCompare className="w-3.5 h-3.5" />
            {lang === 'en' ? (
              <span>
                A: <span className="font-mono">{compareFrom.run}</span> from "{compareFrom.campaignName}". Pick run B with <span className="font-semibold">Compare with A</span>, in
                this campaign or another one in the list.
              </span>
            ) : (
              <span>
                A: <span className="font-mono">{compareFrom.run}</span> de «{compareFrom.campaignName}». Elige la prueba B con <span className="font-semibold">Comparar con A</span>, en
                esta campaña o en otra de la lista.
              </span>
            )}
            <button className="ml-auto text-slate-300 hover:text-white" onClick={() => setCompareFrom(null)}>
              {t('Dejar de comparar', 'Stop comparing')}
            </button>
          </div>
        )}
        {comparison && (
          <CampaignCompare
            a={comparison.a}
            b={comparison.b}
            busy={busy}
            onClose={() => setComparison(null)}
            onSwap={() => setComparison({ a: comparison.b, b: comparison.a })}
          />
        )}

        {listError && <p className="text-xs text-rose-400">{listError}</p>}
        {queue && queue.ids.length > 0 && <QueuePanel queue={queue} onChanged={refresh} onSelect={setSelectedId} />}

        {editing ? (
          <CampaignEditor
            key={`${status ? 'ready' : 'loading'}-${editor.editId ?? ''}-${editor.initial ? 'plan' : 'new'}`}
            defaultStream={defaultStream}
            rtcServer={status?.rtc_server}
            initial={editor.initial}
            editId={editor.editId}
            onCreated={(id) => {
              setEditor(null);
              setSelectedId(id);
              refresh();
            }}
          />
        ) : selected ? (
          <Monitor
            campaign={selected}
            lean={worker}
            onChanged={refresh}
            onEdit={setEditor}
            onPreview={openPreview}
            compareFrom={compareFrom}
            onCompare={pickCompare}
            busy={busy}
            onDeleted={() => {
              setSelectedId(null);
              refresh();
            }}
          />
        ) : (
          <p className="text-xs text-slate-500">{t('No hay campañas todavía.', 'No campaigns yet.')}</p>
        )}
        </div>
        </div>
      </div>
    </div>
  );
};
