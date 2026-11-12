import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import type { NetworkState, RouterBand, RouterSlot, RouterTree as Tree } from '../types';

// Esquema del árbol de tc del router de emulación (README, sección 5): la raíz 1:, una banda por cola (protocolo y
// sentido) y, en cada una, su prio con las plazas de los clientes de las pruebas en paralelo y la general, cada una con
// su tbf y su netem. Plegado por defecto: abierto se repinta con cada lectura, y en la página de campañas solo entonces
// pide el estado al servidor (cada 2 s), para no cargar la pestaña de un trabajador mientras mide.

const OPEN_KEY = 'router-tree-open';
const POLL_MS = 2000;

const QUEUE_COLOR: Record<string, string> = {
  dash: 'text-blue-300 border-blue-700/60',
  moq: 'text-emerald-300 border-emerald-700/60',
  rtc: 'text-amber-300 border-amber-700/60',
};

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

// Lo aplicado en una plaza, dato a dato (se parte de línea solo entre datos)
function linkParts(slot: RouterSlot): string[] {
  const l = slot.link;
  if (!l) return ['sin restricciones: pasa tal cual, sin tbf ni netem'];
  const parts = [l.rate_kbit ? `${l.rate_kbit} kbit/s` : 'sin límite de caudal'];
  if (l.delay_ms || l.jitter_ms) parts.push(`retardo ${l.delay_ms} ms${l.jitter_ms ? ` ±${l.jitter_ms}` : ''}`);
  if (l.loss_pct) parts.push(`pérdida ${l.loss_pct} %`);
  if (l.rate_kbit) parts.push(`cola ${l.queue_ms} ms`);
  parts.push(`${l.limit} paq.`); // limit de netem
  return parts;
}

// Caudal de cada plaza entre dos lecturas: los bytes de iptables son acumulados
function useRates(tree: Tree | null | undefined): Record<string, number | null> {
  const prev = useRef<{ t: number; bytes: Record<string, number> } | null>(null);
  const [rates, setRates] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (!tree) return;
    const now = performance.now();
    const bytes: Record<string, number> = {};
    for (const b of tree.bands) for (const s of b.slots) bytes[s.band] = s.bytes;
    const p = prev.current;
    if (p && now > p.t) {
      const next: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(bytes)) next[k] = k in p.bytes && v >= p.bytes[k] ? Math.round(((v - p.bytes[k]) * 8) / (now - p.t)) : null;
      setRates(next);
    }
    prev.current = { t: now, bytes };
  }, [tree]);
  return rates;
}

// Una plaza en dos líneas: banda, de quién es y contadores; debajo, su tbf y netem con el perfil aplicado
const Slot: React.FC<{ slot: RouterSlot; kbps: number | null | undefined }> = ({ slot, kbps }) => (
  <li className="py-1 border-t border-slate-800 first:border-t-0">
    <div className="flex items-baseline gap-x-2">
      <span className="font-mono text-slate-200 shrink-0">{slot.band}</span>
      <span className={`truncate ${slot.general ? 'text-slate-300' : 'text-indigo-300'}`}>
        {slot.general ? 'general' : `plaza ${slot.slot} · ${slot.client}`}
      </span>
      <span className="ml-auto shrink-0 text-slate-500 tabular-nums" title="Caudal reenviado · descartes de netem acumulados · paquetes en cola ahora">
        {kbps === null || kbps === undefined ? '--' : `${kbps} kbit/s`} · {slot.dropped} desc. · {slot.queued} en cola
      </span>
    </div>
    <div className="text-slate-400">
      {slot.limiter && (
        <span className="font-mono text-slate-500" title={`tbf ${slot.limiter} (caudal) y, debajo, netem ${slot.netem} (retardo, pérdida y cola)`}>
          tbf/netem {slot.limiter}/{slot.netem} ·{' '}
        </span>
      )}
      {linkParts(slot).map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && ' · '}
          <span className="whitespace-nowrap">{part}</span>
        </React.Fragment>
      ))}
    </div>
  </li>
);

// Una cola: su banda en la raíz, su prio y sus plazas ocupadas (las libres, agrupadas en una línea)
const Band: React.FC<{ band: RouterBand; rates: Record<string, number | null>; showFree: boolean }> = ({ band, rates, showFree }) => {
  const shown = band.slots.filter((s) => s.general || s.client || showFree);
  const free = band.slots.filter((s) => !s.general && !s.client).length;
  const direction = band.queue?.endsWith('_down') ? 'bajada' : 'subida';
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5 min-w-0">
      <div className="flex items-baseline gap-x-2">
        <span className="font-mono text-slate-200">{band.band}</span>
        <span className="text-slate-300">{direction}</span>
        <span className="font-mono text-slate-500">→ prio {band.handle}</span>
        {!showFree && free > 0 && <span className="ml-auto text-slate-600">{free} plazas libres</span>}
      </div>
      <div className="text-slate-500 truncate" title={band.match}>
        {band.match}
      </div>
      <ul className="mt-1">
        {shown.map((s) => (
          <Slot key={s.band} slot={s} kbps={rates[s.band]} />
        ))}
      </ul>
    </div>
  );
};

const PROTOCOLS: { key: string; label: string }[] = [
  { key: 'dash', label: 'LL-DASH' },
  { key: 'moq', label: 'MoQ' },
  { key: 'rtc', label: 'WebRTC' },
];

// La raíz arriba y, debajo, una columna por protocolo con sus dos colas (bajada y subida)
const TreeView: React.FC<{ tree: Tree }> = ({ tree }) => {
  const rates = useRates(tree);
  const [showFree, setShowFree] = useState(false);
  const rest = tree.bands.find((b) => !b.queue);
  return (
    <div className="text-[11px] leading-snug">
      <div className="flex flex-wrap items-center gap-2">
        <div className="rounded border border-slate-600 px-2 py-1 bg-slate-900/60 text-slate-200">
          <span className="font-mono">{tree.root}</span> raíz · prio, {tree.bands.length} bandas <span className="text-slate-500">en {tree.interfaces.join(', ')}</span>
        </div>
        {rest && (
          <div className="rounded border border-slate-800 px-2 py-1 text-slate-400">
            <span className="font-mono text-slate-300">{rest.band}</span> resto: {rest.match}
          </div>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-slate-400 cursor-pointer select-none">
          <input type="checkbox" checked={showFree} onChange={(e) => setShowFree(e.target.checked)} />
          Mostrar las plazas libres
        </label>
      </div>
      <div className="mt-2 grid gap-2 grid-cols-1 lg:grid-cols-3">
        {PROTOCOLS.map((p) => (
          <div key={p.key} className={`rounded-lg border-t-2 ${QUEUE_COLOR[p.key]} bg-slate-900/40 p-2 space-y-2 min-w-0`}>
            <div className="font-medium">{p.label}</div>
            {tree.bands
              .filter((b) => b.queue?.startsWith(p.key + '_'))
              .map((b) => (
                <Band key={b.band} band={b} rates={rates} showFree={showFree} />
              ))}
          </div>
        ))}
      </div>
      <p className="text-slate-500 mt-2">
        Caudal y paquetes: lo reenviado (iptables), antes de la emulación. Descartes: pérdida aleatoria de netem y cola llena, acumulados desde que se montó cada netem.
      </p>
    </div>
  );
};

interface RouterTreeProps {
  // Estado del router ya leído (dashboard: viene en /api/status); sin él, lo pide el propio panel a /api/router
  network?: NetworkState | null;
  poll?: boolean;
}

export const RouterTreePanel: React.FC<RouterTreeProps> = ({ network, poll = false }) => {
  const [open, setOpen] = useState(readOpen);
  const [polled, setPolled] = useState<NetworkState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? '0' : '1');
      } catch {}
      return !o;
    });
  };

  useEffect(() => {
    if (!poll || !open) return;
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch('/api/router');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: NetworkState = await res.json();
        if (!cancelled) {
          setPolled(data);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [poll, open]);

  const state = poll ? polled : network;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 text-xs">
      <button onClick={toggle} className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-slate-300 hover:text-white">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <GitBranch className="w-3.5 h-3.5" />
        <span className="font-medium">Esquema del router (tc)</span>
        <span className="text-slate-500">raíz, colas por protocolo y sentido, y plazas por cliente</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {error && <p className="text-rose-300">No se pudo leer el router: {error}</p>}
          {state?.emulation_error && <p className="text-amber-300">Sin emulación de red en este servidor: {state.emulation_error}</p>}
          {state?.tree ? <TreeView tree={state.tree} /> : !error && !state?.emulation_error && <p className="text-slate-500">Leyendo el router…</p>}
        </div>
      )}
    </div>
  );
};
