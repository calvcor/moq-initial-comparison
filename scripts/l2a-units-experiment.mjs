#!/usr/bin/env node
// Experimento declarado (README, sección 6): L2A de dash.js 5.2.1 en su fase estable, tal como viene frente a una
// copia con las unidades corregidas. No cambia nada del banco: el reproductor del dashboard sigue con dash.js tal
// cual. Aquí se descarga dash.js 5.2.1 sin minificar, se preparan dos variantes y se sirven, junto con una página
// de prueba con solo DASH, en el origen del banco (interceptando las peticiones con CDP), para que el MPD, la
// sincronización de reloj y la red emulada sean los de siempre.
//
// El fallo: en la fase estable de L2ARule (desde dash.js 5.0.0), el multiplicador Q y la subida prudente comparan
// rep.bandwidth (bit/s) con el caudal (kbit/s). En 4.7.4 los bitrates se pasaban a kbit/s antes. La variante
// corregida cambia ese único `return rep.bandwidth;` por `return rep.bitrateInKbit;`. Las dos llevan la misma
// traza (Q, w, caudal, velocidad y calidad elegida en cada decisión de la fase estable), en window.__l2aTrace.
//
// Cada pasada fuerza la fase estable como en el experimento del 5-11-2026: objetivo de 2 s hasta que L2A ha decidido
// tres veces en ella (lo dice la traza, que solo se escribe ahí), después el objetivo pedido, sin saltos al directo (maxDrift 0: una búsqueda
// devuelve L2A a su arranque), y se mide. Las variantes se alternan. Al acabar se deja la red como estaba.
//
//   node scripts/l2a-units-experiment.mjs --url https://moq-dash.mininet.duckdns.org --rates 4000,3000 --reps 2
//
// Opciones: --url, --rates (bajadas en kbit/s, cola de 300 ms, sin pérdida), --reps (por variante y red),
// --target (s, 0,5), --measure (s de medida, 60), --out (JSON con todo, l2a-units.json), --chrome, --port (9453).
// Si la emisión está parada, se arranca con su configuración y se vuelve a parar al acabar; si está en marcha, no
// se toca. Un Chrome headless nuevo por pasada; se cierra por su PID.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return pairs;
  }, []),
);
const BASE = String(args.url || 'http://localhost').replace(/\/$/, '');
const RATES = String(args.rates || '4000').split(',').map(Number);
const REPS = Number(args.reps || 2);
const TARGET = Number(args.target || 0.5);
const MEASURE = Number(args.measure || 60);
const OUT = String(args.out || 'l2a-units.json');
const PORT = Number(args.port || 9453);
const CHROME = args.chrome || process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DASHJS = 'https://cdn.jsdelivr.net/npm/dashjs@5.2.1/dist/modern/umd/dash.all.debug.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- variantes de dash.js ---

const original = await (await fetch(DASHJS)).text();
const once = (text, find) => {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`se esperaba una aparición de ${JSON.stringify(find)} y hay ${n}: ¿otra versión de dash.js?`);
};
const BUG = 'return rep.bandwidth;';
const ANCHOR = 'l2AState.lastSegmentUrl = currentHttpRequest.url;';
once(original, BUG);
once(original, ANCHOR);
const TRACE = `${ANCHOR} try { (self.__l2aTrace = self.__l2aTrace || []).push({ t: Date.now(), Q: l2AParameter.Q, w: l2AParameter.w.slice(), thr: lastThroughput, rate: currentPlaybackRate, sel: selectedRepresentation.bitrateInKbit }); } catch (e) {}`;
const variants = {
  original: original.replace(ANCHOR, TRACE),
  corregida: original.replace(ANCHOR, TRACE).replace(BUG, 'return rep.bitrateInKbit;'),
};

// Página de prueba: solo un <video> con DASH, con los mismos ajustes que el reproductor del dashboard
// (web/src/components/DashPlayer.tsx) y L2A en solitario
const page = (variant) => `<!doctype html><meta charset="utf-8"><title>L2A ${variant}</title>
<video id="v" muted autoplay playsinline style="width:1280px;height:720px;background:#000"></video>
<script src="/__l2a/dash-${variant}.js"></script>
<script>
(async () => {
  const status = await (await fetch('/api/status')).json();
  const url = status.dash_url || '/media/dash/manifest.mpd';
  const p = dashjs.MediaPlayer().create();
  p.updateSettings({ streaming: {
    delay: { liveDelay: 2.0 },
    liveCatchup: { enabled: true, maxDrift: 0, playbackBufferMin: 0, mode: 'liveCatchupModeLoLP' },
    retryAttempts: { MPD: 15, MediaSegment: 15, InitializationSegment: 15 },
    retryIntervals: { MPD: 1000, MediaSegment: 1000 },
    abr: { rules: { throughputRule: { active: false }, bolaRule: { active: false }, insufficientBufferRule: { active: false },
      switchHistoryRule: { active: false }, droppedFramesRule: { active: false }, abandonRequestsRule: { active: false },
      l2ARule: { active: true }, loLPRule: { active: false } } },
  } });
  window.__ev = [];
  p.on('qualityChangeRequested', (e) => window.__ev.push({ t: Date.now(), from: e.oldRepresentation && e.oldRepresentation.height, to: e.newRepresentation && e.newRepresentation.height, state: e.reason && e.reason.state }));
  p.on('playbackSeeking', () => window.__ev.push({ t: Date.now(), seek: true }));
  p.initialize(document.getElementById('v'), url, true);
  window.dashPlayer = p;
})();
</script>`;

// --- API del banco ---

// body undefined: GET; null: POST sin cuerpo (en /api/start, un cuerpo vacío se tomaría por una configuración nueva)
const api = async (path, body) => {
  const init = body === undefined ? {} : body === null ? { method: 'POST' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, init);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};
const before = await api('/api/status');
if (before.campaign) throw new Error('Hay una campaña en marcha');
const started = before.status !== 'running';
if (started) {
  await api('/api/start', null);
  await sleep(15000); // como stream_settle_s de las campañas
  const now = await api('/api/status');
  if (JSON.stringify(now.config) !== JSON.stringify(before.config)) {
    await api('/api/stop', null);
    throw new Error('La emisión arrancó con otra configuración: parada otra vez');
  }
}
const free = { rate_kbit: null, delay_ms: 0, jitter_ms: 0, loss_pct: 0, queue_ms: 300 };

// --- una pasada ---

async function pass(variant, rate) {
  const prof = mkdtempSync(join(tmpdir(), 'l2a-units-'));
  // La página interceptada no tiene dirección de origen y Chrome la trata como pública: sin desactivar Local
  // Network Access, bloquea las peticiones al DASH directo del servidor, que está en la red local
  const chrome = spawn(CHROME, ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-features=LocalNetworkAccessChecks', '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', `--user-data-dir=${prof}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
  const out = { variant, rate_kbit: rate, frag_duration: before.config.frag_duration, rows: [] };
  try {
    let tabs; for (let i = 0; i < 40 && !tabs; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(250); } }
    const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = {}; const handlers = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; } else if (m.method) handlers.forEach((h) => h(m)); };
    const send = (method, params = {}) => new Promise((r) => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
    // La página y las dos variantes se sirven en el origen del banco
    handlers.push((m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const path = new URL(m.params.request.url).pathname;
      const body = path === '/__l2a/page.html' ? page(variant) : path.startsWith('/__l2a/dash-') ? variants[path.slice(12, -3)] : null;
      if (body == null) { send('Fetch.continueRequest', { requestId: m.params.requestId }); return; }
      const type = path.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8';
      send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(body).toString('base64') });
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: `${BASE}/__l2a/*` }] });
    await send('Page.navigate', { url: `${BASE}/__l2a/page.html` });
    for (let i = 0; i < 60; i++) { if (await ev(`!!window.dashPlayer`)) break; await sleep(500); }
    // Fase estable: la traza solo se escribe en ella, así que se espera a tener tres decisiones (con el objetivo de 2 s)
    let decisions = 0; const t0 = Date.now();
    while (Date.now() - t0 < 150000) { decisions = await ev(`(self.__l2aTrace || []).length`); if (decisions >= 3) break; await sleep(1000); }
    out.steady_wait_s = (Date.now() - t0) / 1000; out.steady_reached = decisions >= 3;
    await ev(`window.dashPlayer.updateSettings({ streaming: { delay: { liveDelay: ${TARGET} } } })`);
    await sleep(15000); // que la corrección baje la latencia hacia el objetivo
    const mark = Date.now();
    await ev(`(() => { const v = document.getElementById('v'); const p = window.__probe = { frames: 0, gaps: [], last: null, start: performance.now() };
      const cb = (now) => { p.frames++; if (p.last !== null && now - p.last >= 150) p.gaps.push(now - p.last); p.last = now; v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb); return true; })()`);
    for (let i = 0; i < MEASURE; i++) {
      out.rows.push(await ev(`(() => { const p = window.dashPlayer; const r = p.getCurrentRepresentationForType('video');
        return { t: Date.now(), h: r && r.height, buf: p.getBufferLength('video'), lat: p.getCurrentLiveLatency(), est: p.getAverageThroughput('video'), rate: document.getElementById('v').playbackRate }; })()`));
      await sleep(1000);
    }
    out.probe = await ev(`(() => { const p = window.__probe; const end = performance.now(); const g = [...p.gaps]; if (p.last !== null && end - p.last >= 150) g.push(end - p.last);
      return { seconds: (end - p.start) / 1000, frames: p.frames, stall_s: g.reduce((a, b) => a + b, 0) / 1000, gaps: g.length }; })()`);
    out.events = (await ev(`window.__ev`)).filter((e) => e.t >= mark);
    out.trace = (await ev(`self.__l2aTrace || []`)).filter((e) => e.t >= mark);
  } finally {
    chrome.kill('SIGTERM'); await sleep(1500); try { process.kill(chrome.pid, 'SIGKILL'); } catch {}
    rmSync(prof, { recursive: true, force: true });
  }
  return out;
}

// --- resumen ---

const median = (v) => { const s = v.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
function summary(r) {
  const n = r.rows.length || 1;
  const share = (h) => Math.round((100 * r.rows.filter((x) => x.h === h).length) / n);
  const changes = r.events.filter((e) => !e.seek);
  return {
    variante: r.variant, red: r.rate_kbit, estable: r.steady_reached, parado_s: +r.probe.stall_s.toFixed(1),
    cambios: changes.length, en_fase_estable: changes.filter((e) => e.state === 'L2A_STATE_STEADY').length, busquedas: r.events.length - changes.length,
    t360: share(360), t720: share(720), t1080: share(1080),
    latencia: median(r.rows.map((x) => x.lat)), bufer: median(r.rows.map((x) => x.buf)), estimacion: median(r.rows.map((x) => x.est)),
    Q_mediana: median(r.trace.map((x) => x.Q)) == null ? null : Math.round(median(r.trace.map((x) => x.Q)) * 10) / 10, decisiones: r.trace.length,
  };
}

const results = [];
try {
  for (const rate of RATES) {
    await api('/api/network', { down: { ...free, rate_kbit: rate }, up: free });
    for (let rep = 0; rep < REPS; rep++) {
      // Alternando, y empezando cada repetición por la otra variante
      const order = rep % 2 ? ['corregida', 'original'] : ['original', 'corregida'];
      for (const variant of order) {
        const r = await pass(variant, rate);
        results.push(r);
        console.log(JSON.stringify(summary(r)));
      }
    }
  }
} finally {
  await api('/api/network', before.network.profile);
  if (started) await api('/api/stop', null);
  writeFileSync(OUT, JSON.stringify({ base: BASE, target_s: TARGET, measure_s: MEASURE, dashjs: DASHJS, results }));
  console.log(`Red restaurada${started ? ' y emisión parada otra vez' : ''}; datos en ${OUT}`);
}
