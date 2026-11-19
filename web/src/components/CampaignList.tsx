import React, { useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import type { Campaign } from '../types';
import { locale, t } from '../lib/i18n';

// Lista de campañas (README, 4.8): vertical y plegable, agrupada por día de creación (de la más reciente a la más
// antigua), con las archivadas aparte y plegadas. Plegar la lista y la sección de archivadas se recuerda en el navegador.

const STATE_DOT: Record<string, string> = {
  ready: 'bg-slate-400',
  running: 'bg-emerald-400',
  paused: 'bg-amber-400',
  done: 'bg-sky-400',
  aborted: 'bg-rose-400',
};
const STATE_LABEL: Record<string, string> = {
  ready: t('lista', 'ready'),
  running: t('en marcha', 'running'),
  paused: t('en pausa', 'paused'),
  done: t('terminada', 'done'),
  aborted: t('cancelada', 'aborted'),
};

const remembered = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const remember = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* sin almacenamiento: no se recuerda */
  }
};

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayLabel = (key: string) => {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86_400_000);
  if (key === today) return t('Hoy', 'Today');
  if (key === yesterday) return t('Ayer', 'Yesterday');
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

function byDay(list: Campaign[]): [string, Campaign[]][] {
  const groups = new Map<string, Campaign[]>();
  for (const c of [...list].sort((a, b) => b.created_ms - a.created_ms)) {
    const k = dayKey(c.created_ms);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  return [...groups.entries()];
}

export const CampaignList: React.FC<{
  list: Campaign[];
  selectedId: string | null;
  creating: boolean;
  editing: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onArchive: (id: string, archived: boolean) => void;
}> = ({ list, selectedId, creating, editing, onSelect, onNew, onArchive }) => {
  const [open, setOpen] = useState(() => remembered('campaigns.list.open', true));
  const [showArchived, setShowArchived] = useState(() => remembered('campaigns.list.archived', false));
  const toggle = () => {
    remember('campaigns.list.open', !open);
    setOpen(!open);
  };
  const active = list.filter((c) => !c.archived);
  const archived = list.filter((c) => c.archived);
  const selected = list.find((c) => c.id === selectedId);

  if (!open)
    return (
      <aside className="shrink-0 flex md:flex-col items-center gap-2 text-xs">
        <button className="p-1.5 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500" title={t('Mostrar la lista de campañas', 'Show the campaign list')} onClick={toggle}>
          <PanelLeftOpen className="w-4 h-4" />
        </button>
        <button className="p-1.5 rounded-lg border border-slate-700 text-emerald-300 hover:border-emerald-500" title={t('Nueva campaña', 'New campaign')} onClick={onNew}>
          <Plus className="w-4 h-4" />
        </button>
        {selected && !editing && <span className="md:hidden text-slate-400 truncate">{selected.name}</span>}
      </aside>
    );

  const item = (c: Campaign) => {
    const current = c.id === selectedId && !editing;
    return (
      <li key={c.id} className="group relative">
        <button
          className={`w-full text-left pl-2.5 pr-8 py-1.5 rounded-lg border ${current ? 'border-indigo-500 bg-indigo-900/40 text-indigo-100' : 'border-transparent text-slate-300 hover:bg-slate-900 hover:border-slate-700'}`}
          title={`${c.name} · ${STATE_LABEL[c.state] ?? c.state} · ${c.id}${c.plan.description ? `\n\n${c.plan.description}` : ''}`}
          onClick={() => onSelect(c.id)}
        >
          <span className="flex items-start gap-2">
            <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${STATE_DOT[c.state] ?? STATE_DOT.ready}`} />
            <span className="min-w-0">
              <span className="block break-words leading-snug">{c.name}</span>
              <span className="block text-[10px] text-slate-500">
                {new Date(c.created_ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })} · {STATE_LABEL[c.state] ?? c.state}
                {c.queue_position && <span className="text-emerald-300 font-mono"> · {t(`cola ${c.queue_position}.ª`, `queue #${c.queue_position}`)}</span>}
              </span>
            </span>
          </span>
        </button>
        {c.state !== 'running' && (
          <button
            className="absolute right-1.5 top-1.5 p-1 rounded text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 focus:opacity-100"
            title={
              c.archived
                ? t('Desarchivar', 'Unarchive')
                : t(
                    'Archivar: se lista aparte, plegada, y no se puede arrancar ni encolar hasta desarchivarla. No borra nada.',
                    'Archive: listed separately, collapsed, and it cannot be started or queued until unarchived. Nothing is deleted.',
                  )
            }
            onClick={() => onArchive(c.id, !c.archived)}
          >
            {c.archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
          </button>
        )}
      </li>
    );
  };

  return (
    <aside className="w-full md:w-72 shrink-0 bg-slate-900/60 border border-slate-800 rounded-xl p-2 text-xs md:h-full md:overflow-y-auto">
      <div className="flex items-center gap-2 px-1 pb-2">
        <span className="font-semibold text-slate-200">{t('Campañas', 'Campaigns')}</span>
        <span className="text-slate-500">{active.length}</span>
        <button
          className={`ml-auto flex items-center gap-1 px-2 py-0.5 rounded-lg border ${creating ? 'border-emerald-500 bg-emerald-900/40 text-emerald-100' : 'border-slate-700 text-emerald-300 hover:border-emerald-500'}`}
          onClick={onNew}
        >
          <Plus className="w-3.5 h-3.5" /> {t('Nueva', 'New')}
        </button>
        <button className="p-1 text-slate-400 hover:text-white" title={t('Ocultar la lista', 'Hide the list')} onClick={toggle}>
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>
      {active.length === 0 && <p className="px-2 py-1 text-slate-500">{t('No hay campañas sin archivar.', 'No unarchived campaigns.')}</p>}
      {byDay(active).map(([day, cs]) => (
        <section key={day} className="mb-2">
          <h3 className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500 first-letter:uppercase">{dayLabel(day)}</h3>
          <ul className="space-y-0.5">{cs.map(item)}</ul>
        </section>
      ))}
      {archived.length > 0 && (
        <section className="border-t border-slate-800 pt-2">
          <button
            className="flex items-center gap-1 px-2 py-1 text-slate-400 hover:text-slate-200"
            onClick={() => {
              remember('campaigns.list.archived', !showArchived);
              setShowArchived(!showArchived);
            }}
          >
            {showArchived ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Archive className="w-3.5 h-3.5" /> {t('Archivadas', 'Archived')} ({archived.length})
          </button>
          {showArchived &&
            byDay(archived).map(([day, cs]) => (
              <section key={day} className="mb-2">
                <h3 className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500">{dayLabel(day)}</h3>
                <ul className="space-y-0.5 opacity-80">{cs.map(item)}</ul>
              </section>
            ))}
        </section>
      )}
    </aside>
  );
};
