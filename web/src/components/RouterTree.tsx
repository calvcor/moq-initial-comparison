import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import type { NetworkState, RouterBand, RouterSlot, RouterTree as Tree } from '../types';

// Esquema del árbol de tc del router de emulación (README, sección 5): la raíz 1:, una banda por cola (protocolo y
// sentido) y, en cada una, su prio con las plazas de los clientes de las pruebas en paralelo y la general, cada una con
// su tbf y su netem. Plegado por defecto: abierto se repinta con cada lectura, y en la página de campañas solo entonces
// pide el estado al servidor (cada 2 s), para no cargar la pestaña de un trabajador mientras mide.

const OPEN_KEY = 'router-tree-open';
const POLL_MS = 2000;

const QUEUE_LABEL: Record<string, string> = {
  dash_down: 'LL-DASH · bajada',
  dash_up: 'LL-DASH · subida',
  moq_down: 'MoQ · bajada',
  moq_up: 'MoQ · subida',
  rtc_down: 'WebRTC · bajada',
  rtc_up: 'WebRTC · subida',
};
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

function linkText(slot: RouterSlot): string {
  const l = slot.link;
  if (!l) return 'sin restricciones: pasa tal cual, sin tbf ni netem';
  const parts = [l.rate_kbit ? `${l.rate_kbit} kbit/s` : 'sin límite de caudal'];
  if (l.delay_ms || l.jitter_ms) parts.push(`retardo ${l.delay_ms} ms${l.jitter_ms ? ` ±${l.jitter_ms}` : ''}`);
  if (l.loss_pct) parts.push(`pérdida ${l.loss_pct} %`);
  if (l.rate_kbit) parts.push(`cola ${l.queue_ms} ms`);
  parts.push(`limit ${l.limit} paq.`);
  return parts.join(' · ');
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

const Slot: React.FC<{ slot: RouterSlot; kbps: number | null | undefined }> = ({ slot, kbps }) => (
  <li className="relative pl-4 before:absolute before:left-0 before:top-2.5 before:w-3 before:border-t before:border-slate-700">
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-mono text-slate-200">{slot.band}</span>
      <span className={slot.general ? 'text-slate-300' : 'text-indigo-300'}>
        {slot.general ? 'general' : `plaza ${slot.slot} · ${slot.client}`}
      </span>
      {slot.limiter && (
        <span className="font-mono text-slate-500">
          → tbf {slot.limiter} → netem {slot.netem}
        </span>
      )}
    </div>
    <div className="text-slate-400">{linkText(slot)}</div>
    <div className="text-slate-500">
      {kbps === null || kbps === undefined ? '--' : `${kbps} kbit/s`} · {slot.dropped} descartes · {slot.queued} en cola
    </div>
  </li>
);

const Band: React.FC<{ band: RouterBand; rates: Record<string, number | null>; showFree: boolean }> = ({ band, rates, showFree }) => {
  const color = band.queue ? QUEUE_COLOR[band.queue.split('_')[0]] : 'text-slate-400 border-slate-700';
  const shown = band.slots.filter((s) => s.general || s.client || showFree);
  const free = band.slots.filter((s) => !s.general && !s.client).length;
  return (
    <li className="relative pl-5 before:absolute before:left-0 before:top-3 before:w-4 before:border-t before:border-slate-700">
      <div className={`inline-flex flex-wrap items-baseline gap-x-2 rounded border px-2 py-1 bg-slate-900/60 ${color}`}>
        <span className="font-mono">{band.band}</span>
        <span>{band.queue ? QUEUE_LABEL[band.queue] : 'resto'}</span>
        {band.handle && <span className="font-mono text-slate-400">→ prio {band.handle}, {band.slots.length} bandas</span>}
      </div>
      <div className="text-slate-500 mt-0.5">{band.match}</div>
      {band.slots.length > 0 && (
        <ul className="mt-1 ml-2 space-y-1.5 border-l border-slate-700">
          {shown.map((s) => (
            <Slot key={s.band} slot={s} kbps={rates[s.band]} />
          ))}
          {!showFree && free > 0 && (
            <li className="relative pl-4 text-slate-600 before:absolute before:left-0 before:top-2.5 before:w-3 before:border-t before:border-slate-700">
              {free} plazas libres (sin clientes)
            </li>
          )}
        </ul>
      )}
    </li>
  );
};

const TreeView: React.FC<{ tree: Tree }> = ({ tree }) => {
  const rates = useRates(tree);
  const [showFree, setShowFree] = useState(false);
  return (
    <div className="text-[11px] leading-relaxed">
      <label className="flex items-center gap-1.5 text-slate-400 mb-2 cursor-pointer select-none w-fit">
        <input type="checkbox" checked={showFree} onChange={(e) => setShowFree(e.target.checked)} />
        Mostrar las plazas libres
      </label>
      <div className="inline-flex flex-wrap items-baseline gap-x-2 rounded border border-slate-600 px-2 py-1 bg-slate-900/60 text-slate-200">
        <span className="font-mono">{tree.root}</span>
        <span>raíz · prio, {tree.bands.length} bandas</span>
        <span className="text-slate-500">en {tree.interfaces.join(', ')}</span>
      </div>
      <ul className="mt-1 ml-2 space-y-2 border-l border-slate-700">
        {tree.bands.map((b) => (
          <Band key={b.band} band={b} rates={rates} showFree={showFree} />
        ))}
      </ul>
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
