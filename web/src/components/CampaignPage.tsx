import React, { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, ChartLine, Check, Copy, Download, Eraser, Eye, FlaskConical, ListPlus, ListX, Pause, Pencil, Play, RotateCcw, Server, Settings2, Trash2, X } from 'lucide-react';
import { CampaignEditor, DEFAULT_PLAYER_OPTIONS, formatDuration } from './CampaignEditor';
import { CampaignWorker } from './CampaignWorker';
import { WorkersModal } from './WorkersModal';
import { CampaignList } from './CampaignList';
import { PLAYER_IDS } from '../lib/samples';
import { CampaignResults } from './CampaignResults';
import { CampaignPreview, stopPreview, type Preview } from './CampaignPreview';
import { multiStream, streamName, streamText } from '../lib/campaignStreams';
import type { Campaign, CampaignPlan, CampaignQueue, CampaignRun, PlayerId, ServerStatus } from '../types';

// Página de campañas de medida (/campaign; README, 4.8): editor, monitor y, en la misma pestaña o en otra
// (/campaign?worker=1), el trabajador que monta los reproductores. Con el trabajador activo el monitor se
// consulta menos y la tabla de pruebas va plegada, para no cargar el navegador que mide.

const STATE_LABEL: Record<string, string> = {
  ready: 'lista',
  running: 'en marcha',
  paused: 'en pausa',
  done: 'terminada',
  aborted: 'cancelada',
  pending: 'en cola',
  preparing: 'preparando',
  mounting: 'montando',
  warmup: 'calentando',
  measuring: 'midiendo',
  closing: 'cerrando',
  invalid: 'inválida',
  replaced: 'sustituida',
};
const STATE_STYLE: Record<string, string> = {
  running: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  paused: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  done: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  aborted: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  ready: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
};
const PLAYER_SHORT: Record<PlayerId, string> = { dash: 'DASH', moq: 'MoQ', rtc: 'RTC' };

const ABR_LABEL: Record<string, string> = { default: 'por defecto', l2a: 'L2A', l2afix: 'L2A (bugfix, experimento)', lolp: 'LoL+', watch: 'librería', probe: 'sondeo (experimento)', probe2: 'sondeo v2 (experimento)' };
const SWITCHING_LABEL: Record<string, string> = { seamless: 'sin corte', cancel: 'cancelar (experimento)', priority: 'prioridad (experimento)' };

/** Ajustes de los reproductores de la campaña, de los protocolos que prueba. Sin player_options (campañas
 * anteriores), los del dashboard al abrirse. */
function optionsText(plan: Campaign['plan']): string {
  const o = { ...DEFAULT_PLAYER_OPTIONS, ...(plan.player_options ?? {}) };
  const parts = [];
  if (plan.players.includes('dash'))
    parts.push(`DASH: ABR ${ABR_LABEL[o.dash_abr]}, salto al directo ${o.dash_max_drift_s ? `${o.dash_max_drift_s} s` : 'nunca'}, búfer mínimo ${o.dash_playback_buffer_min_s} s`);
  if (plan.players.includes('moq')) parts.push(`MoQ: adaptación ${ABR_LABEL[o.moq_abr]}, cambio ${SWITCHING_LABEL[o.moq_switching]}`);
  if (plan.players.includes('rtc')) parts.push('WebRTC');
  return `${parts.join(' · ')} · ${plan.player_mode === 'each' ? 'de uno en uno' : 'a la vez'} · calidad ${plan.quality ? `${plan.quality}p` : 'auto'} · contenido ${plan.content === 'restart' ? 'desde el principio en cada prueba' : 'continuo'}`;
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
}> = ({ campaign, focus, onChanged, onPreview, onSeries }) => {
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
            <th className="py-1 pr-2 font-medium">Prueba</th>
            {streams && <th className="py-1 pr-2 font-medium">Emisión</th>}
            <th className="py-1 pr-2 font-medium">Red</th>
            <th className="py-1 pr-2 font-medium">Objetivo</th>
            <th className="py-1 pr-2 font-medium">Rep.</th>
            <th className="py-1 pr-2 font-medium">Estado</th>
            <th className="py-1 pr-2 font-medium" title="Por reproductor: glass-to-glass p50 / p95 (ms), fracción del tiempo parado y cambios de calidad">
              Resultado (p50 / p95 ms · parado · cambios)
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
                    {run.manual ? 'repite' : 'reintenta'} {run.retry_of}
                  </span>
                )}
              </td>
              {streams && (
                <td className="py-1 pr-2 text-slate-300 font-sans" title={streamText(plan.streams[run.stream])}>
                  {run.stream + 1}
                </td>
              )}
              <td className="py-1 pr-2 text-slate-300 font-sans">{run.network === null ? 'sin restricción' : plan.networks[run.network].label}</td>
              <td className="py-1 pr-2 text-slate-300 font-sans">{plan.targets[run.target].label}</td>
              <td className="py-1 pr-2 text-slate-400">{run.rep + 1}</td>
              <td className="py-1 pr-2 font-sans" title={run.invalid_reasons.join('; ')}>
                <span className={run.state === 'invalid' ? 'text-rose-300' : run.state === 'done' ? 'text-emerald-300' : 'text-slate-400'}>
                  {STATE_LABEL[run.state] ?? run.state}
                </span>
                {run.state === 'invalid' && <span className="text-slate-500"> ({run.invalid_reasons.join('; ')})</span>}
                {run.state === 'replaced' && <span className="text-slate-500"> por {run.replaced_by}</span>}
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
                            return `${PLAYER_SHORT[p]} en ${w ?? '?'}${ip ? ` (${ip})` : ''}`;
                          })
                          .join(' · ')
                      : run.worker_info
                        ? `en ${Object.keys(run.worker_info).join(', ')}`
                        : ''}
                    {run.concurrent?.length ? ` · a la vez que ${run.concurrent.join(', ')}` : ''}
                  </div>
                )}
              </td>
              <td className="py-1 pr-2 font-sans">
                <div className="flex items-center gap-3">
                {campaign.state !== 'running' && (
                  <button
                    className="flex items-center gap-1 text-sky-300 hover:text-sky-200"
                    title="Ver en directo los reproductores con los ajustes de esta prueba, aplicando su red y su emisión. No se mide ni se graba nada; al cerrar, la red y la emisión vuelven a como estaban"
                    onClick={() => onPreview(run)}
                  >
                    <Eye className="w-3 h-3" /> Ver
                  </button>
                )}
                {/* Las gráficas solo tienen las pruebas terminadas y válidas */}
                {run.state === 'done' && run.summary && (
                  <button
                    className="flex items-center gap-1 text-emerald-300 hover:text-emerald-200"
                    title="Abrir esta prueba en la gráfica segundo a segundo, con varias métricas"
                    onClick={() => onSeries(run.id)}
                  >
                    <ChartLine className="w-3 h-3" /> Gráfica
                  </button>
                )}
                {(run.state === 'done' || run.state === 'invalid') && !repeated.has(run.id) && (
                  <button
                    className="flex items-center gap-1 text-indigo-300 hover:text-indigo-200"
                    title={
                      run.state === 'done'
                        ? 'Repetir al final de la cola. Este resultado sigue contando hasta que la repetición termine válida, y entonces la sustituye'
                        : 'Repetir al final de la cola'
                    }
                    onClick={() => repeat(run)}
                  >
                    <RotateCcw className="w-3 h-3" /> Repetir
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
}> = ({ campaign, lean, onChanged, onDeleted, onEdit, onPreview }) => {
  const [error, setError] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(!lean);
  // Con el trabajador en esta pestaña, las gráficas van plegadas: no se dibujan mientras mide
  const [showResults, setShowResults] = useState(!lean);
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
    if (!window.confirm(`¿Borrar la campaña ${campaign.name} y todas sus medidas?`)) return;
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
      `¿Borrar las medidas de ${campaign.name}?\n\n` +
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
            <button className="text-slate-500 hover:text-indigo-300" title="Cambiar el nombre" onClick={() => setDraftName(campaign.name)}>
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
            <button className="text-emerald-400 hover:text-emerald-300" title="Guardar (Intro)" onClick={saveName}>
              <Check className="w-4 h-4" />
            </button>
            <button className="text-slate-500 hover:text-slate-300" title="Cancelar (Esc)" onClick={() => setDraftName(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <Badge state={campaign.state} />
        {campaign.archived && <span className="text-[11px] px-2 py-0.5 rounded-full border border-slate-600 text-slate-400">archivada</span>}
        <span className="text-slate-500 font-mono">{campaign.id}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {campaign.state !== 'running' && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-slate-500"
              title={campaign.archived ? 'Vuelve a la lista principal; se puede arrancar y encolar' : 'Se lista aparte, plegada, y no se puede arrancar ni encolar hasta desarchivarla. No borra nada; si estaba en la cola, sale de ella'}
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
              {campaign.archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />} {campaign.archived ? 'Desarchivar' : 'Archivar'}
            </button>
          )}
          {!campaign.archived && (campaign.state === 'ready' || campaign.state === 'paused') && (
            <button className="flex items-center gap-1 px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white" onClick={() => act('start')}>
              <Play className="w-3.5 h-3.5" /> {campaign.state === 'paused' ? 'Reanudar' : 'Arrancar'}
            </button>
          )}
          {!campaign.archived && (campaign.state === 'ready' || campaign.state === 'paused') &&
            (campaign.queue_position ? (
              <button
                className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-rose-500"
                title="Sacarla de la cola; no cambia nada más"
                onClick={() => act('dequeue')}
              >
                <ListX className="w-3.5 h-3.5" /> Sacar de la cola ({campaign.queue_position}.ª)
              </button>
            ) : (
              <button
                className="flex items-center gap-1 px-3 py-1 rounded border border-emerald-700 text-emerald-300 hover:border-emerald-500"
                title="Al final de la cola: arranca sola cuando terminen las de delante. Si no hay ninguna en marcha, arranca ya"
                onClick={() => act('enqueue')}
              >
                <ListPlus className="w-3.5 h-3.5" /> Encolar
              </button>
            ))}
          {campaign.state === 'running' && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white"
              title="Detiene la campaña: la red y la emisión vuelven a como estaban al empezar, sale de la cola y, si quedan otras, la cola se detiene hasta reanudarla. Lo medido se conserva y la prueba en curso se repetirá al reanudar."
              onClick={() => act('pause')}
            >
              <Pause className="w-3.5 h-3.5" /> Pausa
            </button>
          )}
          {/* Lista = aún no ha arrancado nunca (al arrancar pasa a en marcha y de ahí nunca vuelve) */}
          {campaign.state === 'ready' && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
              title="Cambiar el plan: solo antes de arrancarla. Las pruebas se vuelven a sortear."
              onClick={() => onEdit({ initial: campaign.plan, editId: campaign.id })}
            >
              <Settings2 className="w-3.5 h-3.5" /> Editar
            </button>
          )}
          <button
            className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
            title="Campaña nueva con este plan, para repetirla o variar algo. La original no cambia."
            onClick={() => onEdit({ initial: campaign.plan })}
          >
            <Copy className="w-3.5 h-3.5" /> Duplicar
          </button>
          {(['runs', 'samples', 'ip'] as const).map((name) => (
            <a
              key={name}
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-indigo-500"
              href={`/api/campaigns/${campaign.id}/${name}.csv`}
              title={
                name === 'runs'
                  ? 'Una fila por prueba y reproductor, con su resumen'
                  : name === 'samples'
                    ? 'Todas las filas de cada segundo, con la condición de su prueba'
                    : 'Tráfico IP en el router de cada segundo, por protocolo y sentido, leído por el servidor'
              }
            >
              <Download className="w-3.5 h-3.5" /> {name === 'runs' ? 'Resumen CSV' : name === 'samples' ? 'Muestras CSV' : 'Tráfico IP CSV'}
            </a>
          ))}
          {campaign.state !== 'running' && (campaign.state !== 'ready' || Object.keys(campaign.counts).some((k) => k !== 'pending')) && (
            <button
              className="flex items-center gap-1 px-3 py-1 rounded border border-slate-700 text-slate-300 hover:border-rose-500 hover:text-rose-300"
              title="Borra las medidas y la deja lista, con el mismo plan y las mismas pruebas (misma semilla). No se puede deshacer"
              onClick={clearMeasures}
            >
              <Eraser className="w-3.5 h-3.5" /> Borrar medidas
            </button>
          )}
          {campaign.state !== 'running' && (
            <button className="text-slate-500 hover:text-rose-400 px-1" title="Borrar la campaña" onClick={remove}>
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
            <span className="text-slate-600">Sin descripción</span>
          )}
          <button className="text-slate-500 hover:text-indigo-300 shrink-0 mt-0.5" title={plan.description ? 'Cambiar la descripción' : 'Añadir una descripción'} onClick={() => setDraftDescription(plan.description ?? '')}>
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
            placeholder="Qué se quiere ver, hipótesis, qué cambia respecto a otras campañas…"
            onChange={(e) => setDraftDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveDescription();
              if (e.key === 'Escape') setDraftDescription(null);
            }}
          />
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white" onClick={saveDescription}>
              <Check className="w-3.5 h-3.5" /> Guardar
            </button>
            <button className="px-2.5 py-0.5 rounded border border-slate-700 text-slate-300 hover:border-slate-500" onClick={() => setDraftDescription(null)}>
              Descartar
            </button>
            <span className="text-slate-500">Ctrl/⌘ + Intro guarda, Esc descarta</span>
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
            {finished} de {campaign.total_runs} pruebas ({c.done ?? 0} válidas, {c.invalid ?? 0} inválidas{c.replaced ? `, ${c.replaced} ${c.replaced === 1 ? 'sustituida' : 'sustituidas'} por su repetición` : ''})
          </span>
          {campaign.state !== 'done' && campaign.state !== 'aborted' && <span>quedan unas {formatDuration(campaign.eta_s)}</span>}
          <span>
            {multiStream(plan) && `${plan.streams.length} emisiones × `}
            {plan.networks.length} redes × {plan.targets.length} objetivos × {plan.repetitions} repeticiones · {plan.warmup_s} + {plan.measure_s} s · semilla {plan.seed}
          </span>
          <span>{optionsText(plan)}</span>
        </div>
        <ul className="text-slate-400">
          {plan.streams.map((st, i) => (
            <li key={i}>
              <span className="text-slate-300">{multiStream(plan) ? streamName(i) : 'Emisión'}:</span> {streamText(st)}
            </li>
          ))}
        </ul>
      </div>

      {/* Prueba en curso y trabajador */}
      {campaign.state === 'running' && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
          {current ? (
            <span>
              En curso: <span className="font-mono text-slate-200">{campaign.batch?.length ? campaign.batch.join(' + ') : current.id}</span>
              {campaign.batch?.length ? ' (en paralelo)' : ''} · {STATE_LABEL[current.state]}
              {multiStream(plan) && (
                <>
                  {' '}
                  · <span className="text-slate-200" title={streamText(plan.streams[current.stream])}>{streamName(current.stream).toLowerCase()}</span>
                </>
              )}{' '}
              · red{' '}
              <span className="text-slate-200">{current.network === null ? 'sin restricción' : plan.networks[current.network].label}</span> · objetivo{' '}
              <span className="text-slate-200">{plan.targets[current.target].label}</span>
            </span>
          ) : (
            <span>Sin prueba en curso</span>
          )}
          {plan.worker_pool ? (
            // Pruebas en paralelo: el grupo de trabajadores, cada uno con lo que mide
            (campaign.workers ?? []).map((w) => (
              <span key={w.name} className={w.connected && !w.outdated ? 'text-emerald-300' : 'text-amber-300'}>
                {w.name}: {w.connected ? (w.task ? `${w.task.players?.join('|') ?? '?'} · ${w.task.run}` : 'libre') : 'sin conexión'}
                {w.connected && w.outdated && ' · web desactualizada'}
              </span>
            ))
          ) : plan.workers ? (
            // Trabajadores independientes: uno por reproductor (README 4.8, trabajadores independientes)
            PLAYER_IDS.filter((p) => plan.players.includes(p)).map((p) => {
              const name = plan.workers![p]!;
              const w = campaign.workers?.find((x) => x.name === name);
              return (
                <span key={p} className={w?.connected && !w.outdated ? 'text-emerald-300' : 'text-amber-300'}>
                  {p}: {name} {w?.connected ? (w.mounted ? `· ${w.mounted}` : '· conectado') : '· sin conexión'}
                  {w?.connected && w.outdated && ' · web desactualizada'}
                </span>
              );
            })
          ) : (
            <span className={worker?.connected && !worker.outdated ? 'text-emerald-300' : 'text-amber-300'}>
              {worker?.connected ? `Trabajador ${worker.id} conectado` : 'Esperando a un trabajador: abre /campaign?worker=1 en una pestaña visible'}
              {worker?.connected && worker.outdated && ' · web desactualizada: recárgalo'}
            </span>
          )}
        </div>
      )}
      {campaign.state !== 'running' && plan.worker_pool && (
        <p className="text-slate-400">
          Pruebas en paralelo con los trabajadores libres de:{' '}
          {plan.worker_pool.map((n) => `${n}${campaign.workers?.find((x) => x.name === n)?.connected ? '' : ' (sin conexión)'}`).join(' · ')}
        </p>
      )}
      {campaign.state !== 'running' && plan.workers && (
        <p className="text-slate-400">
          Navegadores independientes:{' '}
          {PLAYER_IDS.filter((p) => plan.players.includes(p))
            .map((p) => {
              const w = campaign.workers?.find((x) => x.name === plan.workers![p]);
              return `${p} → ${plan.workers![p]}${w?.connected ? '' : ' (sin conexión)'}`;
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
              <span className="font-mono">{new Date(e.t_ms).toLocaleString()}</span> {e.message}
            </div>
          ))}
        </div>
      )}

      <button className="text-indigo-300 hover:text-indigo-200" onClick={() => setShowRuns((v) => !v)}>
        {showRuns ? 'Ocultar las pruebas ▴' : 'Ver las pruebas ▾'}
      </button>
      {showRuns && <RunsTable campaign={campaign} focus={focus} onChanged={onChanged} onPreview={onPreview} onSeries={showSeries} />}

      <button className="block text-indigo-300 hover:text-indigo-200" onClick={() => setShowResults((v) => !v)}>
        {showResults ? 'Ocultar los resultados ▴' : 'Ver los resultados ▾'}
      </button>
      {showResults && <CampaignResults campaign={campaign} onSelectRun={selectRun} seriesFocus={seriesFocus} />}
    </div>
  );
};

// Cola de campañas (README, 4.8): al terminar la que está en marcha, el servidor arranca la primera. Pausar la que
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
        <span className="font-semibold text-emerald-200">Cola de campañas</span>
        <span className="text-slate-500">
          {queue.campaigns.length} {queue.campaigns.length === 1 ? 'campaña' : 'campañas'} · unas {formatDuration(total)} en total
        </span>
        {queue.halted ? (
          <>
            <span className="text-amber-300">Detenida por una pausa: no arranca ninguna hasta reanudarla.</span>
            <button
              className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
              onClick={() => run(() => call('/api/campaigns-queue/resume', 'POST'))}
            >
              <Play className="w-3 h-3" /> Reanudar la cola
            </button>
          </>
        ) : (
          <span className="text-slate-500">Arranca la siguiente al terminar la que está en marcha.</span>
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
            <span className="text-slate-500">unas {formatDuration(c.eta_s)}</span>
            <span className="ml-auto flex items-center gap-1">
              <button className="p-0.5 text-slate-400 hover:text-white disabled:opacity-30" disabled={i === 0} title="Subir" onClick={() => move(i, -1)}>
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-0.5 text-slate-400 hover:text-white disabled:opacity-30"
                disabled={i === queue.campaigns.length - 1}
                title="Bajar"
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button className="p-0.5 text-slate-400 hover:text-rose-400" title="Sacar de la cola" onClick={() => run(() => call(`/api/campaigns/${c.id}/dequeue`, 'POST'))}>
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
  // Trabajador independiente (?worker=1&name=...): solo el trabajador, sin monitor ni editor (README 4.8, trabajadores independientes)
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
  const [managing, setManaging] = useState(false);
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
      setListError(`No se pudo ${archived ? 'archivar' : 'desarchivar'}: ${(e as Error).message}`);
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
    // por su cuenta, para que la lista llegue siempre al borde de abajo (si no, dependía del alto del contenido)
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
              <h1 className="text-xl font-bold tracking-tight text-white">Campañas de medida</h1>
              <p className="text-xs text-slate-400">Pruebas desatendidas por condición de red y latencia objetivo (README, 4.8)</p>
            </div>
          </div>
          <button
            className="ml-auto flex items-center gap-1.5 text-xs text-slate-300 hover:text-white"
            onClick={() => setManaging(true)}
            title="Trabajadores independientes (un navegador por reproductor): estado, lo que están midiendo, modo de Chrome y borrado"
          >
            <Server className="w-4 h-4" /> Trabajadores
          </button>
          <label
            className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer"
            title="Esta pestaña monta los reproductores de cada prueba y sube sus medidas. Un solo trabajador a la vez; la pestaña tiene que quedar visible."
          >
            <input type="checkbox" checked={worker} onChange={toggleWorker} />
            Esta pestaña es el trabajador
          </label>
        </header>

        {managing && <WorkersModal onClose={() => setManaging(false)} />}
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
        {previewError && <p className="text-xs text-rose-400">Vista previa: {previewError}</p>}

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
            onDeleted={() => {
              setSelectedId(null);
              refresh();
            }}
          />
        ) : (
          <p className="text-xs text-slate-500">No hay campañas todavía.</p>
        )}
        </div>
        </div>
      </div>
    </div>
  );
};
