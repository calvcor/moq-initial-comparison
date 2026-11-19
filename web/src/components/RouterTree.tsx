import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import type { NetworkState, RouterBand, RouterSlot, RouterTree as Tree } from '../types';
import { t } from '../lib/i18n';

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
  if (!l) return [t('sin restricciones: pasa tal cual, sin tbf ni netem', 'unrestricted: passes as is, without tbf or netem')];
  const parts = [l.rate_kbit ? `${l.rate_kbit} kbit/s` : t('sin límite de caudal', 'no bandwidth limit')];
  if (l.delay_ms || l.jitter_ms) parts.push(t('retardo', 'delay') + ` ${l.delay_ms} ms${l.jitter_ms ? ` ±${l.jitter_ms}` : ''}`);
  if (l.loss_pct) parts.push(t(`pérdida ${l.loss_pct} %`, `loss ${l.loss_pct} %`));
  if (l.rate_kbit) parts.push(t(`cola ${l.queue_ms} ms`, `queue ${l.queue_ms} ms`));
  // El limitador experimental (README, sección 5): el ritmo lo pone netem rate y el tbf solo trocea
  if (l.rate_kbit && l.shaper === 'netem') parts.push(t('ritmo con netem rate (experimento)', 'rate set by netem rate (experiment)'));
  parts.push(t(`${l.limit} paq.`, `${l.limit} pkts`)); // limit de netem
  return parts;
}

// Caudal de cada plaza entre dos lecturas, lo que entra (clave: la banda, "300:9") y lo que sale ("300:9>"): los bytes
// de iptables y de tc son acumulados. Si un contador baja (qdisc vuelta a crear), ese intervalo queda vacío
const outKey = (band: string) => `${band}>`;

function useRates(tree: Tree | null | undefined): Record<string, number | null> {
  const prev = useRef<{ t: number; bytes: Record<string, number> } | null>(null);
  const [rates, setRates] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (!tree) return;
    const now = performance.now();
    const bytes: Record<string, number> = {};
    for (const b of tree.bands)
      for (const s of b.slots) {
        bytes[s.band] = s.bytes;
        if (typeof s.out_bytes === 'number') bytes[outKey(s.band)] = s.out_bytes;
      }
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

const kbit = (v: number | null | undefined) => (v === null || v === undefined ? '--' : String(v));

// Una plaza en dos líneas: banda, de quién es y contadores; debajo, su tbf y netem con el perfil aplicado
const Slot: React.FC<{ slot: RouterSlot; kbpsIn: number | null | undefined; kbpsOut: number | null | undefined }> = ({ slot, kbpsIn, kbpsOut }) => (
  <li className="py-1 border-t border-slate-800 first:border-t-0">
    <div className="flex items-baseline gap-x-2">
      <span className="font-mono text-slate-200 shrink-0">{slot.band}</span>
      <span className={`truncate ${slot.general ? 'text-slate-300' : 'text-indigo-300'}`}>
        {slot.general ? t('general', 'general') : t(`plaza ${slot.slot} · ${slot.client}`, `slot ${slot.slot} · ${slot.client}`)}
      </span>
      <span
        className="ml-auto shrink-0 text-slate-500 tabular-nums"
        title={t(
          'Entra: lo que el servidor (o el cliente, en la subida) mete en la plaza, contado por iptables antes de la emulación. Sale: lo que deja pasar la plaza, contado por tc. Con límite de caudal, sale como mucho ese caudal; la diferencia se descarta o espera en la cola. Descartes de netem desde el último perfil aplicado y paquetes en cola ahora.',
          'In: what the server (or the client, on the uplink) puts into the slot, counted by iptables before the emulation. Out: what the slot lets through, counted by tc. With a bandwidth limit, at most that rate goes out; the difference is dropped or waits in the queue. netem drops since the last applied profile and packets queued now.',
        )}
      >
        {t('entra', 'in')} {kbit(kbpsIn)} · {t('sale', 'out')} {kbit(kbpsOut)} kbit/s · {slot.dropped} {t('desc.', 'drops')} · {slot.queued} {t('en cola', 'queued')}
      </span>
    </div>
    <div className="text-slate-400">
      {slot.limiter && (
        <span className="font-mono text-slate-500" title={t(`tbf ${slot.limiter} (caudal) y, debajo, netem ${slot.netem} (retardo, pérdida y cola)`, `tbf ${slot.limiter} (rate) and, below it, netem ${slot.netem} (delay, loss and queue)`)}>
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
  const direction = band.queue?.endsWith('_down') ? t('bajada', 'downlink') : t('subida', 'uplink');
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5 min-w-0">
      <div className="flex items-baseline gap-x-2">
        <span className="font-mono text-slate-200">{band.band}</span>
        <span className="text-slate-300">{direction}</span>
        <span className="font-mono text-slate-500">→ prio {band.handle}</span>
        {!showFree && free > 0 && <span className="ml-auto text-slate-600">{t(`${free} plazas libres`, `${free} free slots`)}</span>}
      </div>
      <div className="text-slate-500 truncate" title={band.match}>
        {band.match}
      </div>
      <ul className="mt-1">
        {shown.map((s) => (
          <Slot key={s.band} slot={s} kbpsIn={rates[s.band]} kbpsOut={rates[outKey(s.band)]} />
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
          <span className="font-mono">{tree.root}</span> {t(`raíz · prio, ${tree.bands.length} bandas`, `root · prio, ${tree.bands.length} bands`)}{' '}
          <span className="text-slate-500">{t(`en ${tree.interfaces.join(', ')}`, `on ${tree.interfaces.join(', ')}`)}</span>
        </div>
        {rest && (
          <div className="rounded border border-slate-800 px-2 py-1 text-slate-400">
            <span className="font-mono text-slate-300">{rest.band}</span> {t('resto', 'rest')}: {rest.match}
          </div>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-slate-400 cursor-pointer select-none">
          <input type="checkbox" checked={showFree} onChange={(e) => setShowFree(e.target.checked)} />
          {t('Mostrar las plazas libres', 'Show free slots')}
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
        {t(
          'Entra: lo que llega a cada plaza (iptables, antes de la emulación); sale: lo que deja pasar (tc), en la misma capa (bytes IP). Descartes: pérdida aleatoria de netem y cola llena, desde el último perfil aplicado (cambio de red o, en una campaña, inicio de la prueba).',
          'In: what reaches each slot (iptables, before the emulation); out: what it lets through (tc), at the same layer (IP bytes). Drops: netem random loss and full queue, since the last applied profile (network change or, in a campaign, start of the run).',
        )}
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
        <span className="font-medium">{t('Esquema del router (tc)', 'Router layout (tc)')}</span>
        <span className="text-slate-500">{t('raíz, colas por protocolo y sentido, y plazas por cliente', 'root, queues per protocol and direction, and slots per client')}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {error && <p className="text-rose-300">{t('No se pudo leer el router:', 'Could not read the router:')} {error}</p>}
          {state?.emulation_error && <p className="text-amber-300">{t('Sin emulación de red en este servidor:', 'No network emulation on this server:')} {state.emulation_error}</p>}
          {state?.tree ? <TreeView tree={state.tree} /> : !error && !state?.emulation_error && <p className="text-slate-500">{t('Leyendo el router…', 'Reading the router…')}</p>}
        </div>
      )}
    </div>
  );
};
