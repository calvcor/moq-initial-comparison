import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Monitor, MonitorOff, Trash2, X } from 'lucide-react';
import type { PoolWorker, WorkerBrowser } from '../types';

// Gestión de los trabajadores independientes de las campañas (README 4.8, trabajadores independientes): su
// estado, lo que están midiendo, su modo de Chrome (headless o ventana en quiosco, si tienen pantalla) y el
// borrado de los que ya no existen. Quedan registrados en el orquestador hasta que se borran aquí.

const PHASE_LABEL: Record<string, string> = {
  preparing: 'preparando',
  mounting: 'montando',
  warmup: 'calentamiento',
  measuring: 'midiendo',
  closing: 'cerrando',
};

const ago = (ms: number | null) => {
  if (!ms) return 'nunca desde que arrancó el orquestador';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(ms).toLocaleString();
};

// "Chrome/154.0.8037.92" del user agent
const chromeVersion = (w: PoolWorker) => String(w.info.user_agent ?? '').match(/(?:HeadlessChrome|Chrome)\/([\d.]+)/)?.[1] ?? null;

// Desde el navegador del panel no se sabe si el orquestador va por IP sin HTTPS: se propone --insecure si la página
// llega por http a algo que no es localhost (Chrome solo trata como seguro localhost)
const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
const suggestInsecure = () => window.location.protocol === 'http:' && !LOCAL.includes(window.location.hostname);

// Dónde va el trabajador, y con ello qué comando se copia
type Target = 'server' | 'desktop' | 'terminal';
const TARGETS: Record<Target, { label: string; help: string }> = {
  server: {
    label: 'Servidor o LXC',
    help: 'Debian o Ubuntu (amd64) con systemd, como root (en un LXC, desde su consola): instala Node 22, Google Chrome (fijado) y el trabajador como servicio del sistema (moq-worker), que arranca con la máquina. Sin pantalla, salvo que se marque Xvfb.',
  },
  desktop: {
    label: 'PC con pantalla (Linux)',
    help: 'Debian o Ubuntu (amd64) con escritorio, desde una terminal de tu sesión y con tu usuario, sin sudo (lo pide solo para instalar lo que falte): el trabajador queda como servicio de tu usuario, arranca con tu sesión gráfica y abre Chrome en tu pantalla.',
  },
  terminal: {
    label: 'Mac u otro equipo, en esta terminal',
    help: 'Cualquier equipo con Node 22 y Google Chrome ya instalados (en macOS, con pantalla): descarga el trabajador y lo ejecuta en la terminal, con tu usuario y tu pantalla, mientras esté abierta. Ctrl+C lo cierra.',
  },
};

// Copia un texto al portapapeles; sin portapapeles (origen no seguro), seleccionando un textarea
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/** Un comando con su botón de copiar. */
const CommandLine: React.FC<{ label: string; command: string; help?: string }> = ({ label, command, help }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2" title={help}>
      <span className="w-20 shrink-0 text-slate-500">{label}</span>
      <code className="flex-1 bg-black/60 border border-slate-800 rounded px-2 py-1 font-mono text-slate-200 break-all select-all">{command}</code>
      <button
        className="px-1.5 py-1 rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500"
        title="Copiar"
        onClick={async () => {
          await copyText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
};

// Los comandos que imprime el instalador al terminar (scripts/install-worker.sh), para gestionar el trabajador ya
// instalado en esa máquina. En un servidor, como root; en un PC con pantalla, con el usuario que lo instaló
function manageCommands(target: Target, display: boolean): { label: string; command: string; help?: string }[] {
  if (target === 'terminal') return [];
  const ctl = target === 'desktop' ? 'systemctl --user' : 'systemctl';
  const log = target === 'desktop' ? 'journalctl --user' : 'journalctl';
  const xvfb = target === 'server' && display;
  return [
    { label: 'Estado', command: `${ctl} status moq-worker` },
    { label: 'Registro', command: `${log} -u moq-worker -f`, help: 'Lo que escribe el trabajador, en directo (Ctrl+C sale)' },
    { label: 'Reiniciar', command: `${ctl} restart moq-worker`, help: 'Cierra Chrome y lo vuelve a abrir' },
    { label: 'Parar', command: `${ctl} stop moq-worker`, help: 'Hasta arrancarlo otra vez o reiniciar la máquina (o la sesión)' },
    { label: 'Arrancar', command: `${ctl} start moq-worker` },
    {
      label: 'Quitar',
      command: `${ctl} disable --now moq-worker${xvfb ? ' moq-worker-xvfb' : ''}`,
      help: 'Lo para y deja de arrancar con la máquina (o la sesión). No borra Chrome, Node ni el usuario; después, bórralo del registro aquí abajo',
    },
  ];
}

/** Comando para instalar o lanzar un trabajador (scripts/install-worker.sh o el script del trabajador, que sirve el orquestador). */
const AddWorker: React.FC = () => {
  const origin = window.location.origin;
  const [target, setTarget] = useState<Target>('server');
  const [name, setName] = useState('');
  const [display, setDisplay] = useState(false);
  const [insecure, setInsecure] = useState(suggestInsecure);
  const [softwareDecode, setSoftwareDecode] = useState(false);
  const [copied, setCopied] = useState(false);
  // Los comandos de gestión, plegados por defecto; el navegador recuerda si se dejaron abiertos
  const [showManage, setShowManage] = useState(() => {
    try {
      return localStorage.getItem('workers.manage.open') === '1';
    } catch {
      return false;
    }
  });
  const toggleManage = () => {
    try {
      localStorage.setItem('workers.manage.open', showManage ? '0' : '1');
    } catch {
      /* sin almacenamiento: no se recuerda */
    }
    setShowManage(!showManage);
  };
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name);
  const args = `--url ${origin} --name ${valid ? name : '<nombre>'}${insecure ? ' --insecure' : ''}${softwareDecode ? ' --software-decode' : ''}`;
  const command =
    target === 'terminal'
      ? `mkdir -p ~/moq-worker && curl -fsSL ${origin}/api/worker/campaign-worker.mjs -o ~/moq-worker/campaign-worker.mjs && node ~/moq-worker/campaign-worker.mjs ${args}`
      : `curl -fsSL ${origin}/api/worker/install.sh | bash -s -- ${args}` +
        (target === 'desktop' ? ' --desktop' : display ? ' --display' : '');
  const copy = async () => {
    await copyText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="shrink-0 rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2">
      <div className="font-semibold text-slate-200">Añadir un trabajador</div>
      <div className="flex flex-wrap gap-1">
        {(Object.keys(TARGETS) as Target[]).map((t) => (
          <button
            key={t}
            className={`px-2 py-1 rounded border ${t === target ? 'border-indigo-500 bg-indigo-900/40 text-white' : 'border-slate-700 text-slate-400 hover:text-white'}`}
            onClick={() => setTarget(t)}
          >
            {TARGETS[t].label}
          </button>
        ))}
      </div>
      <p className="text-slate-400">{TARGETS[target].help} Se anuncia aquí con ese nombre; repetirlo lo actualiza.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Nombre</span>
          <input
            className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 font-mono w-44"
            value={name}
            placeholder="p. ej. lxc-moq"
            onChange={(e) => setName(e.target.value.trim())}
          />
        </label>
        {target === 'server' && (
          <label className="flex items-center gap-1.5 text-slate-300" title="Instala Xvfb y da a Chrome una pantalla virtual de 1920x1080, para poder abrirlo en una ventana en quiosco. Solo para máquinas sin pantalla: en un PC con pantalla, elige PC con pantalla.">
            <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} /> Pantalla virtual (Xvfb)
          </label>
        )}
        <label className="flex items-center gap-1.5 text-slate-300" title="El orquestador va por IP sin HTTPS: Chrome lo tratará como origen seguro (hace falta para MoQ)">
          <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> Sin HTTPS (--insecure)
        </label>
        <label
          className="flex items-center gap-1.5 text-slate-300"
          title="Chrome decodifica el vídeo por software en los tres reproductores. Solo si el decodificador por hardware del equipo falla (p. ej. MoQ sin imagen y «Decoding error» en la consola, visto con una Intel HD 500 en Linux). Cuesta más CPU; queda anotado en cada fila (worker_decode)."
        >
          <input type="checkbox" checked={softwareDecode} onChange={(e) => setSoftwareDecode(e.target.checked)} /> Decodificar por software
        </label>
      </div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 bg-black/60 border border-slate-800 rounded px-2 py-1.5 font-mono text-slate-200 break-all select-all">{command}</code>
        <button
          className="px-2 rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40"
          disabled={!valid}
          onClick={copy}
          title={valid ? 'Copiar el comando' : 'Escribe un nombre válido: letras, cifras, punto, guion y guion bajo'}
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-slate-500">
        Mismo nombre en dos máquinas: el primero que se conecta se lo queda y el otro espera sin medir; si el primero se desconecta, el otro ocupa su
        sitio con ese nombre. Aquí abajo se avisa cuando pasa. Usa un nombre por máquina.
      </p>
      <button className="flex items-center gap-1 text-slate-300 hover:text-white" onClick={toggleManage}>
        {showManage ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Gestionarlo después, en esa máquina
        {target === 'desktop' ? ' (con tu usuario, sin sudo)' : target === 'server' ? ' (como root)' : ''}
      </button>
      {showManage &&
        (target === 'terminal' ? (
          <p className="text-slate-400 pl-5">Ctrl+C en esa terminal lo cierra (y su Chrome); volver a ejecutar el comando lo actualiza y lo abre otra vez.</p>
        ) : (
          <div className="space-y-1 pl-5">
            {manageCommands(target, display).map((c) => (
              <CommandLine key={c.label} {...c} />
            ))}
          </div>
        ))}
      {LOCAL.includes(window.location.hostname) && (
        <p className="text-amber-300">Esta página va por {window.location.hostname}: otra máquina no llegará ahí. Ábrela por la dirección del servidor para copiar el comando.</p>
      )}
    </div>
  );
};

export const WorkersModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [workers, setWorkers] = useState<PoolWorker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const load = () =>
      fetch('/api/campaigns-workers')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`(${res.status})`))))
        .then(setWorkers)
        .catch((e) => setError(`No se pudo leer la lista: ${e.message}`));
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [tick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const request = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null))?.detail;
      setError(typeof detail === 'string' ? detail : `Rechazado (${res.status})`);
      return;
    }
    setError(null);
    setTick((t) => t + 1);
  };
  const setBrowser = (w: PoolWorker, browser: WorkerBrowser) => request(`/api/campaigns-workers/${encodeURIComponent(w.name)}`, 'PATCH', { browser });
  const forget = (w: PoolWorker) => {
    if (window.confirm(`¿Borrar ${w.name} del registro? Si vuelve a conectarse, se anunciará de nuevo.`)) {
      void request(`/api/campaigns-workers/${encodeURIComponent(w.name)}`, 'DELETE');
    }
  };

  return (
    // El panel cabe en la ventana: la cabecera y el bloque de añadir quedan fijos y solo se desplaza la lista
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-7xl max-h-full overflow-y-auto flex flex-col bg-slate-900 border border-slate-700 rounded-xl p-4 gap-3 text-xs" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white">Trabajadores independientes</h2>
          <span className="text-slate-500">Un navegador por reproductor, lanzado con scripts/campaign-worker.mjs --name</span>
          <button className="ml-auto p-1 text-slate-400 hover:text-white" onClick={onClose} title="Cerrar (Esc)">
            <X className="w-4 h-4" />
          </button>
        </div>
        <AddWorker />
        {error && <p className="text-rose-300">{error}</p>}
        {workers === null ? (
          <p className="text-slate-400">Cargando…</p>
        ) : !workers.length ? (
          <p className="text-slate-400">Ninguno registrado. Se registran solos al anunciarse por primera vez (comando de arriba).</p>
        ) : (
          <div className="min-h-[10rem] overflow-y-auto -mx-1 px-1">
          <table className="w-full text-left">
            <thead className="text-slate-500 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-slate-900">
              <tr>
                <th className="py-1 pr-3 font-medium">Trabajador</th>
                <th className="py-1 pr-3 font-medium">Estado</th>
                <th className="py-1 pr-3 font-medium">Ejecutando</th>
                <th className="py-1 pr-3 font-medium">Ventana</th>
                <th className="py-1 pr-3 font-medium" title="Modo en que debe abrir Chrome. Cada campaña fija el de cada trabajador al empezarla; no se cambia mientras una campaña en marcha o en pausa lo use.">
                  Chrome
                </th>
                <th className="py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => {
                const display = w.info.display;
                const openAs = w.connected ? String(w.info.browser ?? '?') : null;
                const version = chromeVersion(w);
                return (
                  <tr key={w.name} className="border-t border-slate-800 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-mono text-slate-100">{w.name}</div>
                      {w.id && <div className="text-slate-500 font-mono">{w.id}</div>}
                      {version && <div className="text-slate-500">Chrome {version}</div>}
                    </td>
                    <td className="py-2 pr-3">
                      <div className={w.connected ? 'text-emerald-300' : 'text-slate-400'}>{w.connected ? 'Conectado' : 'Sin conexión'}</div>
                      <div className="text-slate-500">Último latido {ago(w.seen_ms)}</div>
                      {w.locked && <div className="text-amber-300">Lo usa la campaña {w.locked}</div>}
                      {w.rivals?.map((r) => (
                        <div key={r.id} className="text-rose-300" title={r.user_agent ?? undefined}>
                          Otro navegador usa este nombre{r.ip ? ` desde ${r.ip}` : ''} (<span className="font-mono">{r.id}</span>): espera sin medir y, si este se
                          desconecta, ocupará su sitio. Cambia el nombre de uno de los dos.
                        </div>
                      ))}
                      {w.connected && w.outdated && (
                        <div className="text-amber-300" title="No recibe pruebas hasta tener la web que se sirve. Recarga sola entre pruebas; si es de antes del 6-11-2026, hay que reiniciarla (README 4.8)">
                          {w.info.build ? `Web desactualizada (${String(w.info.build)})` : 'Web anterior al 6-11-2026: reinícialo'}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {w.task ? (
                        <>
                          <div className="text-indigo-300">
                            {w.task.players?.join(', ') ?? '—'} · {PHASE_LABEL[w.task.phase] ?? w.task.phase}
                          </div>
                          <div className="text-slate-500">
                            {w.task.campaign_name} · prueba <span className="font-mono">{w.task.run}</span>
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-500">{w.connected ? 'Libre' : '—'}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-mono text-slate-300">{w.connected ? String(w.info.viewport ?? '?') : '—'}</div>
                      {w.connected && w.info.ip != null && (
                        <div className="font-mono text-slate-500" title="La IP desde la que late: el router separa por ella las colas de las pruebas en paralelo">
                          {String(w.info.ip)}
                        </div>
                      )}
                      <div className="text-slate-500 flex items-center gap-1">
                        {display === false ? <MonitorOff className="w-3 h-3" /> : <Monitor className="w-3 h-3" />}
                        {display === false ? 'Sin pantalla' : display === true ? 'Con pantalla' : 'Pantalla desconocida'}
                      </div>
                      {w.connected && w.info.decode === 'software' && <div className="text-amber-300">Decodifica por software</div>}
                    </td>
                    <td className="py-2 pr-3">
                      <select
                        className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 disabled:opacity-50"
                        value={w.browser}
                        disabled={!!w.locked}
                        onChange={(e) => setBrowser(w, e.target.value as WorkerBrowser)}
                      >
                        <option value="headless">Headless</option>
                        <option value="kiosk" disabled={display === false}>
                          Ventana en quiosco{display === false ? ' (sin pantalla)' : ''}
                        </option>
                      </select>
                      {openAs && openAs !== w.browser && <div className="text-slate-500 mt-1">Abierto ahora en {openAs}: cambia al empezar una prueba</div>}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        className="p-1 text-slate-400 hover:text-rose-300 disabled:opacity-30 disabled:hover:text-slate-400"
                        disabled={w.connected || !!w.locked}
                        onClick={() => forget(w)}
                        title={w.connected ? 'Está conectado: ciérralo antes, o se volverá a anunciar' : w.locked ? `Lo usa la campaña ${w.locked}` : 'Borrar del registro'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
};
