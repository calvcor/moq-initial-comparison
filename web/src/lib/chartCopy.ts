// Copiar una gráfica para un documento: en la página, las gráficas van con textos claros sobre el fondo oscuro, pero
// «Copiar imagen» (clic derecho) debe dar una imagen legible sobre papel. Al pulsar el botón derecho sobre una gráfica
// de Chart.js se dibuja una copia aparte, fuera de la página, con los mismos datos y opciones pero textos oscuros,
// rejilla clara y fondo blanco, sin tooltip ni cursor; la gráfica que se ve no se toca. Su imagen va en un <img>
// invisible encima del canvas, que es lo que recibe el menú contextual y lo que se copia. Se quita en cuanto el ratón
// vuelve a moverse tras cerrar el menú, para no tapar la gráfica (tooltips, clics en los puntos).

import { BasicPlatform, Chart } from 'chart.js';

const INK = '#0f172a';
const GRID = '#cbd5e1';
const PAPER = '#ffffff';

// La gráfica es la copia para papel: lo consultan los plugins propios (el cursor común de las franjas, la leyenda de
// los protocolos), que dibujan con sus propios colores
export const isPrinting = (chart: Chart) => chart.canvas?.dataset.paper === '1';

// Fondo blanco solo en la copia para papel (en la página el canvas es transparente); antes de todo lo demás
Chart.register({
  id: 'paperBackground',
  beforeDraw(chart: Chart) {
    if (!isPrinting(chart)) return;
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
});

// Copia profunda de objetos y listas planos, que conserva las funciones (callbacks, generateLabels…) y lo demás por
// referencia: así la copia no comparte nada que se pueda modificar con la gráfica de la página
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  }
  return value;
}

/** La imagen de la gráfica en colores para papel (PNG en data URL), dibujada en una copia aparte. */
function paperImage(chart: Chart): string {
  const config = chart.config as unknown as { type: string; data: any; options: any; plugins: any[] };
  const options = clone(config.options ?? {});
  options.color = INK;
  for (const scale of Object.values(options.scales ?? {}) as any[]) {
    scale.ticks = { ...scale.ticks, color: INK };
    scale.title = { ...scale.title, color: INK };
    if (scale.grid?.display !== false) scale.grid = { ...scale.grid, color: GRID };
    scale.border = { ...scale.border, color: '#94a3b8' };
  }
  options.plugins = { ...options.plugins };
  options.plugins.legend = { ...options.plugins.legend, labels: { ...options.plugins.legend?.labels, color: INK } };
  for (const key of ['title', 'subtitle']) if (options.plugins[key]) options.plugins[key] = { ...options.plugins[key], color: INK };
  options.plugins.tooltip = { ...options.plugins.tooltip, enabled: false };
  Object.assign(options, { animation: false, responsive: false, maintainAspectRatio: false, events: [], devicePixelRatio: chart.currentDevicePixelRatio });
  // Los mismos datos, con los protocolos o pruebas ocultos desde la leyenda también ocultos
  const data = clone(config.data);
  data.datasets?.forEach((d: any, i: number) => (d.hidden = !chart.isDatasetVisible(i)));
  const canvas = document.createElement('canvas');
  canvas.dataset.paper = '1';
  canvas.width = chart.width;
  canvas.height = chart.height;
  const copy = new Chart(canvas, { type: config.type as any, data, options, plugins: config.plugins, platform: BasicPlatform } as any);
  try {
    return copy.toBase64Image('image/png', 1);
  } finally {
    copy.destroy();
  }
}

let overlay: HTMLImageElement | null = null;
const removeOverlay = () => {
  overlay?.remove();
  overlay = null;
};

function onPointerDown(e: PointerEvent) {
  if (e.button !== 2) return;
  removeOverlay();
  const canvas = e.target;
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const chart = Chart.getChart(canvas);
  if (!chart) return;
  let src: string;
  try {
    src = paperImage(chart);
  } catch {
    return; // si algo falla, el clic derecho copia la gráfica tal cual se ve
  }
  const rect = canvas.getBoundingClientRect();
  const img = document.createElement('img');
  img.src = src;
  img.alt = 'Gráfica';
  img.draggable = false;
  Object.assign(img.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    opacity: '0',
    zIndex: '2147483647',
  });
  document.body.appendChild(img);
  overlay = img;
  // Se quita al volver a mover el ratón después del menú (en Windows y Linux el menú sale al soltar: hasta entonces se
  // queda), al desplazar la página o, por si acaso, a los 30 s
  const armed = { menu: false };
  img.addEventListener('contextmenu', () => (armed.menu = true), { once: true });
  const done = () => {
    if (overlay !== img) return;
    removeOverlay();
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('wheel', done, true);
    window.removeEventListener('scroll', done, true);
  };
  const onMove = () => armed.menu && done();
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('wheel', done, true);
  window.addEventListener('scroll', done, true);
  img.addEventListener('pointerdown', (ev) => ev.button !== 2 && done());
  setTimeout(done, 30000);
}

let installed = false;
/** Activa la copia en colores de papel para todas las gráficas de la página (una vez). */
export function installChartCopy() {
  if (installed) return;
  installed = true;
  window.addEventListener('pointerdown', onPointerDown, true);
}
