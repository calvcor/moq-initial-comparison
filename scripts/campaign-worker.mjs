#!/usr/bin/env node
// Trabajador de campañas en Chrome headless (README, 4.8), para dejar el equipo midiendo sin una pestaña a la
// vista. Abre /campaign?worker=1 y lo vigila: si Chrome se cae lo vuelve a lanzar, y si la página se cuelga o
// deja de latir con una campaña en marcha, la recarga (la prueba interrumpida la repite el servidor).
//
//   node scripts/campaign-worker.mjs                                  # contra http://localhost
//   node scripts/campaign-worker.mjs --url https://moq-dash.mininet.duckdns.org
//   node scripts/campaign-worker.mjs --url http://10.20.40.90 --insecure
//   node scripts/campaign-worker.mjs --url https://moq-dash.mininet.duckdns.org --name lxc-moq
//
// Opciones: --url, --chrome (ruta del ejecutable; también CHROME), --port (depuración remota, 9400),
// --insecure (trata como seguro el origen HTTP de --url: hace falta por IP sin HTTPS, no con localhost) y
// --no-sandbox: Chrome sin su sandbox, solo si no arranca (p. ej. en un LXC sin privilegios y sin nesting=1).
// --name: trabajador independiente con ese nombre (README 4.8, trabajadores independientes), que se anuncia y monta solo los reproductores
// que le asigne una campaña que lo elija; su ventana toma el tamaño que pide el servidor (la calidad más alta de
// la emisión). Sin --name, el trabajador único de siempre. Varios en una máquina: un --port distinto cada uno.
// Un trabajador independiente abre Chrome headless y lo relanza en el modo que pida la campaña: headless o
// ventana en quiosco (--kiosk, a pantalla completa y sin barras). Para la ventana hace falta pantalla: en macOS
// la hay siempre; en Linux, la de DISPLAY (o WAYLAND_DISPLAY), p. ej. un Xvfb en el LXC. Lo anuncia al servidor.
// Necesita Node 22 (WebSocket y fetch globales). En macOS impide que el equipo se duerma mientras corre.
// Ctrl+C cierra Chrome y borra su perfil desechable.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return pairs;
  }, []),
);
const BASE = String(args.url || 'http://localhost').replace(/\/$/, '');
const PORT = Number(args.port || 9400);
const NAME = typeof args.name === 'string' ? args.name : null;
if (NAME && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(NAME)) throw new Error(`--name no válido: ${NAME}`);
// Hay pantalla donde abrir una ventana
const HAS_DISPLAY = process.platform === 'darwin' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
// Modo de Chrome del trabajador independiente: headless al empezar, y el que pida la campaña después
let browserMode = 'headless';
// Ventana con la que se relanzará (la última que pidió el servidor)
let wantedViewport = { width: 1920, height: 1080 };
const workerUrl = () =>
  `${BASE}/campaign?worker=1${NAME ? `&name=${encodeURIComponent(NAME)}&browser=${browserMode}&display=${HAS_DISPLAY ? 1 : 0}` : ''}`;
// Cada cuánto se comprueba que la ventana tiene el tamaño que pide el servidor (trabajador independiente)
const VIEWPORT_MS = 1000;
const CHROME =
  args.chrome ||
  process.env.CHROME ||
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
// Sin latido del trabajador durante este tiempo, con una campaña en marcha, se recarga la página
const STALE_MS = 60_000;
const CHECK_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toLocaleString(), ...m);

let chrome = null;
// Chrome ha terminado. No vale exitCode: si lo mata una señal (p. ej. SIGKILL), exitCode se queda en null
let chromeExited = false;
let profile = null;
let ws = null;
let stopping = false;
// La pestaña ha desaparecido con Chrome vivo (visto el 3-11-2026: /json sin páginas). Recargar no sirve: se relanza
let pageLost = false;

function cleanup() {
  stopping = true;
  try {
    ws?.close();
  } catch {}
  if (chrome && !chromeExited) {
    chrome.kill('SIGTERM');
    // Si no se cierra por las buenas, a la fuerza: un Chrome huérfano seguiría reproduciendo y compartiría
    // la cola de emulación con las medidas siguientes
    const pid = chrome.pid;
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {}
    }, 2000).unref();
  }
  if (profile) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('Cerrando Chrome y saliendo');
    cleanup();
    setTimeout(() => process.exit(0), 2500);
  });
}
process.on('exit', cleanup);

if (process.platform === 'darwin') {
  // Que el Mac no se duerma mientras viva este proceso
  spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' }).unref();
}

async function launch() {
  profile = mkdtempSync(join(tmpdir(), 'campaign-worker-'));
  const kiosk = NAME && browserMode === 'kiosk';
  const flags = [
    ...(kiosk
      ? [
          // Ventana a pantalla completa, sin barras, en la esquina; sin que Chrome la frene si la tapa otra
          '--kiosk',
          '--window-position=0,0',
          `--window-size=${wantedViewport.width},${wantedViewport.height}`,
          '--no-first-run',
          '--disable-infobars',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
        ]
      : ['--headless=new']),
    // Metal solo existe en macOS; en Linux (p. ej. un LXC sin GPU) Chrome elige lo que haya
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    // El trabajador independiente empieza con la última ventana pedida y se ajusta a lo que pida el servidor
    // (fitViewport); en quiosco ya la lleva arriba
    ...(kiosk ? [] : [NAME ? `--window-size=${wantedViewport.width},${wantedViewport.height}` : '--window-size=1600,1000']),
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
  ];
  if (args.insecure) flags.push(`--unsafely-treat-insecure-origin-as-secure=${new URL(BASE).origin}`);
  if (args['no-sandbox']) flags.push('--no-sandbox');
  chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: 'ignore' });
  chromeExited = false;
  log(`Chrome lanzado (pid ${chrome.pid}${NAME ? `, ${browserMode}` : ''})`);
  chrome.on('exit', (code, signal) => {
    chromeExited = true;
    if (!stopping) log(`Chrome ha terminado (${signal ? `señal ${signal}` : `código ${code}`})`);
  });

  let tabs = null;
  for (let i = 0; i < 80 && !tabs; i++) {
    try {
      tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    } catch {
      await sleep(250);
    }
  }
  const page = tabs?.find((t) => t.type === 'page');
  if (!page) throw new Error('Chrome no ofrece la pestaña por el puerto de depuración');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  pageLost = false;
  ws.onclose = () => (pageLost = true);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Inspector.targetCrashed') {
      log('La pestaña se ha colgado: se recarga');
      navigate();
    }
  };
  ws.send(JSON.stringify({ id: ++id, method: 'Inspector.enable' }));
  ws.send(JSON.stringify({ id: ++id, method: 'Page.enable' }));
  // Se abre en about:blank y se navega después: abrir la URL directamente ha dado pestañas sin el
  // reproductor de MoQ (CLAUDE.md)
  const navigate = () => ws.send(JSON.stringify({ id: ++id, method: 'Page.navigate', params: { url: workerUrl() } }));
  navigate();
  log(`Trabajador abierto en ${workerUrl()}`);
  call = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => pending.delete(i) && resolve(null), 5000);
    });
  return navigate;
}

// Petición por el protocolo de depuración a la pestaña abierta (la pone launch)
let call = async () => null;

// Trabajador independiente: la página publica en window.__workerViewport el tamaño que pide el servidor, y aquí
// se le da a la ventana (sin escalado: un píxel CSS por píxel). La página no monta hasta que encaja.
// Con el modo de Chrome (window.__workerBrowser) igual: si pide otro, se cierra Chrome y el bucle principal lo
// relanza en ese modo.
let blindWarned = false;
async function fitViewport() {
  const res = await call('Runtime.evaluate', {
    expression: 'JSON.stringify({ want: window.__workerViewport ?? null, mode: window.__workerBrowser ?? null, w: innerWidth, h: innerHeight })',
    returnByValue: true,
  });
  const value = res?.result?.result?.value;
  if (!value) return;
  const { want, mode, w, h } = JSON.parse(value);
  if (want) wantedViewport = want;
  if (mode && mode !== browserMode) {
    if (mode === 'kiosk' && !HAS_DISPLAY) {
      if (!blindWarned) log('La campaña pide una ventana en quiosco y aquí no hay pantalla (DISPLAY): no se monta');
      blindWarned = true;
      return;
    }
    log(`La campaña pide Chrome en modo ${mode}: se relanza`);
    browserMode = mode;
    blindWarned = false;
    chrome.kill('SIGTERM');
    return;
  }
  if (!want || (want.width === w && want.height === h)) return;
  await call('Emulation.setDeviceMetricsOverride', { width: want.width, height: want.height, deviceScaleFactor: 1, mobile: false });
  log(`Ventana a ${want.width}×${want.height} (estaba en ${w}×${h})`);
}

async function main() {
  let navigate = await launch();
  if (NAME) {
    const timer = setInterval(() => !stopping && !chromeExited && fitViewport().catch(() => {}), VIEWPORT_MS);
    timer.unref();
  }
  let staleSince = null;
  let last = '';
  while (!stopping) {
    // Cada CHECK_MS, o antes si Chrome se cierra (p. ej. para relanzarlo en otro modo)
    for (let t = 0; t < CHECK_MS && !stopping && !chromeExited && !pageLost; t += 500) await sleep(500);
    if (stopping) break; // nada de relanzar Chrome mientras se cierra
    if (pageLost && !chromeExited) {
      log('Se ha perdido la pestaña con Chrome vivo: se cierra Chrome para relanzarlo');
      chrome.kill('SIGKILL');
      for (let i = 0; i < 20 && !chromeExited; i++) await sleep(250);
    }
    if (chromeExited) {
      log(`Se vuelve a lanzar Chrome${NAME ? ` (${browserMode})` : ''}`);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
      await sleep(3000);
      navigate = await launch();
      staleSince = null;
      continue;
    }
    let campaign = null;
    try {
      campaign = (await (await fetch(`${BASE}/api/status`)).json()).campaign;
    } catch {
      continue; // servidor caído: el servidor retoma la campaña al volver y la página se reengancha sola
    }
    // Un trabajador independiente solo vigila las campañas que lo usan (las demás no esperan su latido)
    const mine = NAME ? campaign?.workers?.find((w) => w.name === NAME) : null;
    const connected = NAME ? mine?.connected : campaign?.worker.connected;
    const line = !campaign
      ? 'Sin campaña en marcha'
      : NAME && !mine
        ? `Campaña «${campaign.name}»: ${campaign.state}, sin este trabajador`
        : `Campaña «${campaign.name}»: ${campaign.state}, prueba ${campaign.current ?? '-'}, trabajador ${connected ? (NAME ?? campaign.worker.id) : 'desconectado'}`;
    if (line !== last) log(line);
    last = line;
    if (campaign?.state === 'running' && (!NAME || mine) && !connected) {
      staleSince ??= Date.now();
      if (Date.now() - staleSince > STALE_MS) {
        log('La página no late con la campaña en marcha: se recarga');
        navigate();
        staleSince = null;
      }
    } else {
      staleSince = null;
    }
  }
}

main().catch((e) => {
  console.error(e);
  cleanup();
  setTimeout(() => process.exit(1), 2500);
});
