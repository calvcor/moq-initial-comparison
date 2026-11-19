import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Monitor, MonitorOff, Trash2 } from 'lucide-react';
import type { PoolWorker, WorkerBrowser } from '../types';
import { locale, t } from '../lib/i18n';

// Gestión de los trabajadores independientes de las campañas (README 4.8, trabajadores independientes): su
// estado, lo que están midiendo, su modo de Chrome (headless o ventana en quiosco, si tienen pantalla) y el
// borrado de los que ya no existen. Quedan registrados en el orquestador hasta que se borran aquí. Es una
// sección del modal de ajustes (SettingsModal.tsx).

const PHASE_LABEL: Record<string, string> = {
  preparing: t('preparando', 'preparing'),
  mounting: t('montando', 'mounting'),
  warmup: t('calentamiento', 'warm-up'),
  measuring: t('midiendo', 'measuring'),
  closing: t('cerrando', 'closing'),
};

const ago = (ms: number | null) => {
  if (!ms) return t('nunca desde que arrancó el orquestador', 'never since the orchestrator started');
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return t(`hace ${s} s`, `${s} s ago`);
  if (s < 3600) return t(`hace ${Math.round(s / 60)} min`, `${Math.round(s / 60)} min ago`);
  if (s < 86400) return t(`hace ${Math.round(s / 3600)} h`, `${Math.round(s / 3600)} h ago`);
  return new Date(ms).toLocaleString(locale);
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
    label: t('Servidor o LXC', 'Server or LXC'),
    help: t(
      'Debian o Ubuntu (amd64) con systemd, como root (en un LXC, desde su consola): instala Node 22, Google Chrome (fijado) y el trabajador como servicio del sistema (moq-worker), que arranca con la máquina. Sin pantalla, salvo que se marque Xvfb.',
      'Debian or Ubuntu (amd64) with systemd, as root (in an LXC, from its console): installs Node 22, Google Chrome (pinned) and the worker as a system service (moq-worker) that starts with the machine. Without a display, unless Xvfb is ticked.',
    ),
  },
  desktop: {
    label: t('PC con pantalla (Linux)', 'PC with a display (Linux)'),
    help: t(
      'Debian o Ubuntu (amd64) con escritorio, desde una terminal de tu sesión y con tu usuario, sin sudo (lo pide solo para instalar lo que falte): el trabajador queda como servicio de tu usuario, arranca con tu sesión gráfica y abre Chrome en tu pantalla.',
      'Debian or Ubuntu (amd64) with a desktop, from a terminal in your session and as your user, without sudo (it asks only to install what is missing): the worker becomes a user service, starts with your graphical session and opens Chrome on your screen.',
    ),
  },
  terminal: {
    label: t('Mac u otro equipo, en esta terminal', 'Mac or another machine, in this terminal'),
    help: t(
      'Cualquier equipo con Node 22 y Google Chrome ya instalados (en macOS, con pantalla): descarga el trabajador y lo ejecuta en la terminal, con tu usuario y tu pantalla, mientras esté abierta. Ctrl+C lo cierra.',
      'Any machine with Node 22 and Google Chrome already installed (on macOS, with a display): downloads the worker and runs it in the terminal, as your user and on your screen, while it stays open. Ctrl+C closes it.',
    ),
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
        title={t('Copiar', 'Copy')}
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
    { label: t('Estado', 'Status'), command: `${ctl} status moq-worker` },
    { label: t('Registro', 'Log'), command: `${log} -u moq-worker -f`, help: t('Lo que escribe el trabajador, en directo (Ctrl+C sale)', 'What the worker writes, live (Ctrl+C exits)') },
    { label: t('Reiniciar', 'Restart'), command: `${ctl} restart moq-worker`, help: t('Cierra Chrome y lo vuelve a abrir', 'Closes Chrome and opens it again') },
    { label: t('Parar', 'Stop'), command: `${ctl} stop moq-worker`, help: t('Hasta arrancarlo otra vez o reiniciar la máquina (o la sesión)', 'Until it is started again or the machine (or session) restarts') },
    { label: t('Arrancar', 'Start'), command: `${ctl} start moq-worker` },
    {
      label: t('Quitar', 'Remove'),
      command: `${ctl} disable --now moq-worker${xvfb ? ' moq-worker-xvfb' : ''}`,
      help: t(
        'Lo para y deja de arrancar con la máquina (o la sesión). No borra Chrome, Node ni el usuario; después, bórralo del registro aquí abajo',
        'Stops it and no longer starts it with the machine (or session). Does not remove Chrome, Node or the user; afterwards, delete it from the registry below',
      ),
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
  const args = `--url ${origin} --name ${valid ? name : t('<nombre>', '<name>')}${insecure ? ' --insecure' : ''}${softwareDecode ? ' --software-decode' : ''}`;
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
      <div className="font-semibold text-slate-200">{t('Añadir un trabajador', 'Add a worker')}</div>
      <div className="flex flex-wrap gap-1">
        {(Object.keys(TARGETS) as Target[]).map((tg) => (
          <button
            key={tg}
            className={`px-2 py-1 rounded border ${tg === target ? 'border-indigo-500 bg-indigo-900/40 text-white' : 'border-slate-700 text-slate-400 hover:text-white'}`}
            onClick={() => setTarget(tg)}
          >
            {TARGETS[tg].label}
          </button>
        ))}
      </div>
      <p className="text-slate-400">
        {TARGETS[target].help} {t('Se anuncia aquí con ese nombre; repetirlo lo actualiza.', 'It announces itself here under that name; running it again updates it.')}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">{t('Nombre', 'Name')}</span>
          <input
            className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 font-mono w-44"
            value={name}
            placeholder={t('p. ej. lxc-moq', 'e.g. lxc-moq')}
            onChange={(e) => setName(e.target.value.trim())}
          />
        </label>
        {target === 'server' && (
          <label
            className="flex items-center gap-1.5 text-slate-300"
            title={t(
              'Instala Xvfb y da a Chrome una pantalla virtual de 1920x1080, para poder abrirlo en una ventana en quiosco. Solo para máquinas sin pantalla: en un PC con pantalla, elige PC con pantalla.',
              'Installs Xvfb and gives Chrome a 1920x1080 virtual display, so it can open in a kiosk window. Only for machines without a display: on a PC with a display, choose PC with a display.',
            )}
          >
            <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} /> {t('Pantalla virtual (Xvfb)', 'Virtual display (Xvfb)')}
          </label>
        )}
        <label
          className="flex items-center gap-1.5 text-slate-300"
          title={t(
            'El orquestador va por IP sin HTTPS: Chrome lo tratará como origen seguro (hace falta para MoQ)',
            'The orchestrator is reached by IP without HTTPS: Chrome will treat it as a secure origin (needed for MoQ)',
          )}
        >
          <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> {t('Sin HTTPS (--insecure)', 'No HTTPS (--insecure)')}
        </label>
        <label
          className="flex items-center gap-1.5 text-slate-300"
          title={t(
            'Chrome decodifica el vídeo por software en los tres reproductores. Solo si el decodificador por hardware del equipo falla (p. ej. MoQ sin imagen y «Decoding error» en la consola, visto con una Intel HD 500 en Linux). Cuesta más CPU; queda anotado en cada fila (worker_decode).',
            'Chrome decodes the video in software in all three players. Only if the machine’s hardware decoder fails (e.g. MoQ with no picture and “Decoding error” in the console, seen with an Intel HD 500 on Linux). Costs more CPU; recorded in every row (worker_decode).',
          )}
        >
          <input type="checkbox" checked={softwareDecode} onChange={(e) => setSoftwareDecode(e.target.checked)} /> {t('Decodificar por software', 'Software decoding')}
        </label>
      </div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 bg-black/60 border border-slate-800 rounded px-2 py-1.5 font-mono text-slate-200 break-all select-all">{command}</code>
        <button
          className="px-2 rounded border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40"
          disabled={!valid}
          onClick={copy}
          title={valid ? t('Copiar el comando', 'Copy the command') : t('Escribe un nombre válido: letras, cifras, punto, guion y guion bajo', 'Type a valid name: letters, digits, dot, hyphen and underscore')}
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-slate-500">
        {t(
          'Mismo nombre en dos máquinas: el primero que se conecta se lo queda y el otro espera sin medir; si el primero se desconecta, el otro ocupa su sitio con ese nombre. Aquí abajo se avisa cuando pasa. Usa un nombre por máquina.',
          'Same name on two machines: the first to connect keeps it and the other waits without measuring; if the first disconnects, the other takes its place under that name. A warning appears below when this happens. Use one name per machine.',
        )}
      </p>
      <button className="flex items-center gap-1 text-slate-300 hover:text-white" onClick={toggleManage}>
        {showManage ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {t('Gestionarlo después, en esa máquina', 'Manage it later, on that machine')}
        {target === 'desktop' ? t(' (con tu usuario, sin sudo)', ' (as your user, without sudo)') : target === 'server' ? t(' (como root)', ' (as root)') : ''}
      </button>
      {showManage &&
        (target === 'terminal' ? (
          <p className="text-slate-400 pl-5">
            {t(
              'Ctrl+C en esa terminal lo cierra (y su Chrome); volver a ejecutar el comando lo actualiza y lo abre otra vez.',
              'Ctrl+C in that terminal closes it (and its Chrome); running the command again updates it and opens it again.',
            )}
          </p>
        ) : (
          <div className="space-y-1 pl-5">
            {manageCommands(target, display).map((c) => (
              <CommandLine key={c.label} {...c} />
            ))}
          </div>
        ))}
      {LOCAL.includes(window.location.hostname) && (
        <p className="text-amber-300">
          {t(
            `Esta página va por ${window.location.hostname}: otra máquina no llegará ahí. Ábrela por la dirección del servidor para copiar el comando.`,
            `This page is served from ${window.location.hostname}: another machine will not reach it. Open it through the server’s address to copy the command.`,
          )}
        </p>
      )}
    </div>
  );
};

/** Estado y configuración de los trabajadores: comando para añadir uno y la lista registrada en el orquestador. */
export const WorkersPanel: React.FC = () => {
  const [workers, setWorkers] = useState<PoolWorker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const load = () =>
      fetch('/api/campaigns-workers')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`(${res.status})`))))
        .then(setWorkers)
        .catch((e) => setError(t(`No se pudo leer la lista: ${e.message}`, `Could not read the list: ${e.message}`)));
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [tick]);

  const request = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null))?.detail;
      setError(typeof detail === 'string' ? detail : t(`Rechazado (${res.status})`, `Rejected (${res.status})`));
      return;
    }
    setError(null);
    setTick((n) => n + 1);
  };
  const setBrowser = (w: PoolWorker, browser: WorkerBrowser) => request(`/api/campaigns-workers/${encodeURIComponent(w.name)}`, 'PATCH', { browser });
  const forget = (w: PoolWorker) => {
    if (window.confirm(t(`¿Borrar ${w.name} del registro? Si vuelve a conectarse, se anunciará de nuevo.`, `Delete ${w.name} from the registry? If it connects again, it will announce itself again.`))) {
      void request(`/api/campaigns-workers/${encodeURIComponent(w.name)}`, 'DELETE');
    }
  };

  const connected = workers?.filter((w) => w.connected).length ?? 0;
  const busy = workers?.filter((w) => w.task).length ?? 0;

  return (
    <div className="flex flex-col gap-3 text-xs min-h-0">
      <p className="text-slate-400">
        {t(
          'Un navegador por reproductor, lanzado con scripts/campaign-worker.mjs --name (README 4.8). Las campañas los usan con workers o worker_pool en el plan.',
          'One browser per player, launched with scripts/campaign-worker.mjs --name (README 4.8). Campaigns use them through workers or worker_pool in the plan.',
        )}
      </p>
      {workers && workers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="px-2 py-1 rounded border border-slate-800 bg-slate-950/60 text-slate-300">
            {t('Registrados', 'Registered')}: <span className="font-mono text-white">{workers.length}</span>
          </span>
          <span className="px-2 py-1 rounded border border-slate-800 bg-slate-950/60 text-slate-300">
            {t('Conectados', 'Connected')}: <span className="font-mono text-emerald-300">{connected}</span>
          </span>
          <span className="px-2 py-1 rounded border border-slate-800 bg-slate-950/60 text-slate-300">
            {t('Midiendo', 'Measuring')}: <span className="font-mono text-indigo-300">{busy}</span>
          </span>
        </div>
      )}
      <AddWorker />
      {error && <p className="text-rose-300">{error}</p>}
      {workers === null ? (
        <p className="text-slate-400">{t('Cargando…', 'Loading…')}</p>
      ) : !workers.length ? (
        <p className="text-slate-400">
          {t('Ninguno registrado. Se registran solos al anunciarse por primera vez (comando de arriba).', 'None registered. They register themselves when they first announce (command above).')}
        </p>
      ) : (
        <div className="min-h-[10rem] overflow-x-auto -mx-1 px-1">
          <table className="w-full text-left">
            <thead className="text-slate-500 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-slate-900">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('Trabajador', 'Worker')}</th>
                <th className="py-1 pr-3 font-medium">{t('Estado', 'Status')}</th>
                <th className="py-1 pr-3 font-medium">{t('Ejecutando', 'Running')}</th>
                <th className="py-1 pr-3 font-medium">{t('Ventana', 'Window')}</th>
                <th
                  className="py-1 pr-3 font-medium"
                  title={t(
                    'Modo en que debe abrir Chrome. Cada campaña fija el de cada trabajador al empezarla; no se cambia mientras una campaña en marcha o en pausa lo use.',
                    'Mode in which Chrome must open. Each campaign sets it for each worker when it starts; it cannot be changed while a running or paused campaign uses it.',
                  )}
                >
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
                      <div className={w.connected ? 'text-emerald-300' : 'text-slate-400'}>{w.connected ? t('Conectado', 'Connected') : t('Sin conexión', 'Disconnected')}</div>
                      <div className="text-slate-500">
                        {t('Último latido', 'Last heartbeat')} {ago(w.seen_ms)}
                      </div>
                      {w.locked && <div className="text-amber-300">{t(`Lo usa la campaña ${w.locked}`, `In use by campaign ${w.locked}`)}</div>}
                      {w.rivals?.map((r) => (
                        <div key={r.id} className="text-rose-300" title={r.user_agent ?? undefined}>
                          {t('Otro navegador usa este nombre', 'Another browser uses this name')}
                          {r.ip ? t(` desde ${r.ip}`, ` from ${r.ip}`) : ''} (<span className="font-mono">{r.id}</span>
                          {t(
                            '): espera sin medir y, si este se desconecta, ocupará su sitio. Cambia el nombre de uno de los dos.',
                            '): it waits without measuring and, if this one disconnects, will take its place. Rename one of the two.',
                          )}
                        </div>
                      ))}
                      {w.connected && w.outdated && (
                        <div
                          className="text-amber-300"
                          title={t(
                            'No recibe pruebas hasta tener la web que se sirve. Recarga sola entre pruebas; si es de antes del 6-11-2026, hay que reiniciarla (README 4.8)',
                            'It gets no runs until it has the web build being served. It reloads by itself between runs; if it predates 6-11-2026, it has to be restarted (README 4.8)',
                          )}
                        >
                          {w.info.build
                            ? t(`Web desactualizada (${String(w.info.build)})`, `Outdated web build (${String(w.info.build)})`)
                            : t('Web anterior al 6-11-2026: reinícialo', 'Web build older than 6-11-2026: restart it')}
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
                            {w.task.campaign_name} · {t('prueba', 'run')} <span className="font-mono">{w.task.run}</span>
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-500">{w.connected ? t('Libre', 'Idle') : '—'}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-mono text-slate-300">{w.connected ? String(w.info.viewport ?? '?') : '—'}</div>
                      {w.connected && w.info.ip != null && (
                        <div
                          className="font-mono text-slate-500"
                          title={t(
                            'La IP desde la que late: el router separa por ella las colas de las pruebas en paralelo',
                            'The IP it sends heartbeats from: the router uses it to separate the queues of parallel runs',
                          )}
                        >
                          {String(w.info.ip)}
                        </div>
                      )}
                      <div className="text-slate-500 flex items-center gap-1">
                        {display === false ? <MonitorOff className="w-3 h-3" /> : <Monitor className="w-3 h-3" />}
                        {display === false ? t('Sin pantalla', 'No display') : display === true ? t('Con pantalla', 'With display') : t('Pantalla desconocida', 'Display unknown')}
                      </div>
                      {w.connected && w.info.decode === 'software' && <div className="text-amber-300">{t('Decodifica por software', 'Software decoding')}</div>}
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
                          {t('Ventana en quiosco', 'Kiosk window')}
                          {display === false ? t(' (sin pantalla)', ' (no display)') : ''}
                        </option>
                      </select>
                      {openAs && openAs !== w.browser && (
                        <div className="text-slate-500 mt-1">{t(`Abierto ahora en ${openAs}: cambia al empezar una prueba`, `Currently open as ${openAs}: changes when a run starts`)}</div>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        className="p-1 text-slate-400 hover:text-rose-300 disabled:opacity-30 disabled:hover:text-slate-400"
                        disabled={w.connected || !!w.locked}
                        onClick={() => forget(w)}
                        title={
                          w.connected
                            ? t('Está conectado: ciérralo antes, o se volverá a anunciar', 'It is connected: close it first, or it will announce itself again')
                            : w.locked
                              ? t(`Lo usa la campaña ${w.locked}`, `In use by campaign ${w.locked}`)
                              : t('Borrar del registro', 'Delete from the registry')
                        }
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
  );
};
