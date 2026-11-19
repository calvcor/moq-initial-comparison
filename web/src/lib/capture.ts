// Captura de gráficas como imagen (PNG), para copiarla al portapapeles o descargarla. Se captura un trozo de la página
// tal como está maquetado (títulos, leyendas en HTML, textos, gráficas de Chart.js con sus ejes) en colores para papel:
// fondo blanco, textos oscuros y las gráficas redibujadas con la copia para papel de `chartCopy.ts`. No se hace una
// captura de la pantalla: se recorre el DOM del trozo y se dibuja en un canvas aparte cada fondo de color, borde,
// texto, icono y gráfica en su sitio, así que sale igual aunque esté fuera de la vista y la página no se toca.
//
// Qué se captura lo marcan atributos en el DOM:
// - data-capture="block": un bloque entero (una rejilla de gráficas con sus títulos y leyenda común).
// - data-capture="chart": una gráfica concreta. Su imagen lleva además el contexto que comparte con las demás: subiendo
//   desde ella hasta su bloque, los hermanos marcados con data-capture-keep (la leyenda común, el título de la fila,
//   el título del eje horizontal común), en el orden de la página.
// - data-capture-skip: no sale en la imagen (los propios botones de captura, controles).

import { Chart } from 'chart.js';
import { paperCanvas } from './chartCopy';

const INK = '#0f172a';
const INK_SOFT = '#475569';
const INK_FAINT = '#94a3b8';
const RULE = '#cbd5e1';
const PAPER = '#ffffff';
const PAD = 16; // margen alrededor del contenido, en px CSS
const GAP = 8; // separación entre las piezas de una gráfica suelta

type Rect = { x: number; y: number; w: number; h: number };
type Op = (ctx: CanvasRenderingContext2D) => void;
type Layer = { ops: Op[]; box: Rect | null; align: 'left' | 'center' };

// Colores CSS (en Tailwind 4, oklch) a RGBA, con un canvas de 1 px
const colorCache = new Map<string, [number, number, number, number]>();
let probe: CanvasRenderingContext2D | null = null;
function rgba(css: string): [number, number, number, number] {
  const hit = colorCache.get(css);
  if (hit) return hit;
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  let out: [number, number, number, number] = [0, 0, 0, 0];
  if (probe && css && css !== 'transparent') {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    out = [r, g, b, a / 255];
  }
  colorCache.set(css, out);
  return out;
}
// Gris (fondos, bordes y textos del tema oscuro) frente a color propio (protocolos, muestras de leyenda, botones activos)
const neutral = ([r, g, b]: number[]) => Math.max(r, g, b) - Math.min(r, g, b) < 64; // los slate de Tailwind llegan a ~45
const lightness = ([r, g, b]: number[]) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;

// Un texto gris claro sobre fondo oscuro pasa a tinta oscura, con su jerarquía: lo más claro, lo más oscuro
function inkFor(css: string, onColor: boolean): string {
  const c = rgba(css);
  if (onColor || !neutral(c)) return css;
  const l = lightness(c);
  return l >= 0.6 ? INK : l >= 0.4 ? INK_SOFT : INK_FAINT;
}

const union = (a: Rect | null, b: Rect): Rect => {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const intersect = (a: Rect, b: Rect | null): Rect | null => {
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};
const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Recorre un elemento y anota, en coordenadas de la ventana, lo que hay que dibujar y el rectángulo que ocupa. */
async function layout(root: Element, ratio: number): Promise<Layer> {
  const ops: Op[] = [];
  let box: Rect | null = null;
  const mark = (r: Rect, clip: Rect | null) => {
    const v = intersect(r, clip);
    if (v) box = union(box, v);
    return !!v;
  };
  const measure = document.createElement('canvas').getContext('2d')!;

  async function walk(el: Element, clip: Rect | null, alpha: number, onColor: boolean, strike: boolean, isRoot: boolean) {
    if (el.hasAttribute('data-capture-skip')) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'video' || tag === 'script' || tag === 'style') return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    alpha *= parseFloat(style.opacity || '1');
    if (alpha <= 0.01) return;
    const rect = toRect(el.getBoundingClientRect());
    const a = alpha;

    // Fondo: los grises del tema oscuro se quedan en blanco; los de color (muestras de leyenda, botón activo), tal cual
    const bg = rgba(style.backgroundColor);
    if (!isRoot && bg[3] > 0 && rect.w > 0 && rect.h > 0 && !neutral(bg)) {
      if (mark(rect, clip)) {
        const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, rect.w / 2, rect.h / 2);
        const fill = style.backgroundColor;
        ops.push((ctx) => {
          ctx.globalAlpha = a;
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
          ctx.fill();
        });
      }
      onColor = true;
    }
    // Bordes: los de color tal cual (también discontinuos), los grises como una línea clara
    if (!isRoot) {
      for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
        const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
        const kind = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
        if (!width || kind === 'none' || kind === 'hidden') continue;
        const css = style.getPropertyValue(`border-${side.toLowerCase()}-color`);
        const c = rgba(css);
        if (c[3] === 0) continue;
        const color = neutral(c) ? RULE : css;
        const half = width / 2;
        const [x1, y1, x2, y2] =
          side === 'Top' ? [rect.x, rect.y + half, rect.x + rect.w, rect.y + half]
          : side === 'Bottom' ? [rect.x, rect.y + rect.h - half, rect.x + rect.w, rect.y + rect.h - half]
          : side === 'Left' ? [rect.x + half, rect.y, rect.x + half, rect.y + rect.h]
          : [rect.x + rect.w - half, rect.y, rect.x + rect.w - half, rect.y + rect.h];
        if (!mark({ x: Math.min(x1, x2) - half, y: Math.min(y1, y2) - half, w: Math.abs(x2 - x1) + width, h: Math.abs(y2 - y1) + width }, clip)) continue;
        ops.push((ctx) => {
          ctx.globalAlpha = a;
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.setLineDash(kind === 'dashed' ? [width * 3, width * 2] : kind === 'dotted' ? [width, width] : []);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }
    }

    // Gráficas de Chart.js, redibujadas para papel; otros canvas e imágenes, tal cual
    if (el instanceof HTMLCanvasElement) {
      const chart = Chart.getChart(el);
      let source: CanvasImageSource = el;
      if (chart) {
        try {
          source = paperCanvas(chart, ratio);
        } catch {
          /* la gráfica tal como se ve */
        }
      }
      if (rect.w > 0 && rect.h > 0 && mark(rect, clip)) {
        ops.push((ctx) => {
          ctx.globalAlpha = a;
          ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h);
        });
      }
      return;
    }
    if (el instanceof HTMLImageElement) {
      if (el.complete && el.naturalWidth && mark(rect, clip)) {
        ops.push((ctx) => {
          ctx.globalAlpha = a;
          ctx.drawImage(el, rect.x, rect.y, rect.w, rect.h);
        });
      }
      return;
    }
    // Iconos (SVG en línea): con su color pasado a tinta
    if (el instanceof SVGSVGElement) {
      if (rect.w > 0 && rect.h > 0 && mark(rect, clip)) {
        const clone = el.cloneNode(true) as SVGSVGElement;
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('width', String(rect.w));
        clone.setAttribute('height', String(rect.h));
        clone.style.color = inkFor(style.color, onColor);
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
        const img = await loadImage(url);
        URL.revokeObjectURL(url);
        if (img) {
          ops.push((ctx) => {
            ctx.globalAlpha = a;
            ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
          });
        }
      }
      return;
    }

    // Lo que desborda un contenedor con scroll u oculto no sale
    if (!isRoot && style.overflowX !== 'visible' && style.overflowY !== 'visible') {
      clip = intersect(rect, clip);
      if (!clip) return;
    }
    strike ||= style.textDecorationLine.includes('line-through');

    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        await walk(node as Element, clip, alpha, onColor, strike, false);
      } else if (node.nodeType === Node.TEXT_NODE) {
        text(node as Text, style, clip, alpha, onColor, strike);
      }
    }
  }

  // Un texto, palabra a palabra en la posición que le da el navegador (así respeta los saltos de línea)
  function text(node: Text, style: CSSStyleDeclaration, clip: Rect | null, alpha: number, onColor: boolean, strike: boolean) {
    const content = node.data;
    if (!content.trim()) return;
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const color = inkFor(style.color, onColor);
    const transform = style.textTransform;
    const range = document.createRange();
    measure.font = font;
    let offset = 0;
    for (const token of content.split(/(\s+)/)) {
      const start = offset;
      offset += token.length;
      if (!token || /^\s+$/.test(token)) continue;
      range.setStart(node, start);
      range.setEnd(node, start + token.length);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const r = toRect(rects[0]);
      if (r.w === 0 || !mark(r, clip)) continue;
      const word = transform === 'uppercase' ? token.toUpperCase() : transform === 'lowercase' ? token.toLowerCase() : token;
      const m = measure.measureText(word);
      const ascent = m.fontBoundingBoxAscent;
      const baseline = r.y + (r.h - (ascent + m.fontBoundingBoxDescent)) / 2 + ascent;
      const box = clip;
      ops.push((ctx) => {
        ctx.save();
        if (box) {
          ctx.beginPath();
          ctx.rect(box.x, box.y, box.w, box.h);
          ctx.clip();
        }
        ctx.globalAlpha = alpha;
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(word, r.x, baseline);
        if (strike) {
          ctx.fillRect(r.x, Math.round(r.y + r.h / 2), r.w, 1);
        }
        ctx.restore();
      });
    }
  }

  await walk(root, null, 1, false, false, true);
  const align = getComputedStyle(root).textAlign === 'center' ? 'center' : 'left';
  return { ops, box, align };
}

/** Las piezas que forman la imagen: el bloque entero o la gráfica con el contexto que comparte con sus vecinas. */
function partsOf(target: Element): Element[] {
  if (target.getAttribute('data-capture') !== 'chart') return [target];
  const parts: Element[] = [target];
  for (let el: Element | null = target; el && el.getAttribute('data-capture') !== 'block'; el = el.parentElement) {
    const parent: Element | null = el.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== el && sibling.hasAttribute('data-capture-keep')) parts.push(sibling);
    }
  }
  return parts.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

/** La imagen (PNG) de un bloque o de una gráfica marcados con data-capture, en colores para papel. */
export async function captureBlob(target: Element): Promise<Blob> {
  const ratio = Math.max(2, window.devicePixelRatio || 1);
  const layers = (await Promise.all(partsOf(target).map((el) => layout(el, ratio)))).filter((l) => l.box);
  if (!layers.length) throw new Error('nothing to capture');
  const width = Math.max(...layers.map((l) => l.box!.w));
  const height = layers.reduce((sum, l) => sum + l.box!.h, 0) + GAP * (layers.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((width + 2 * PAD) * ratio);
  canvas.height = Math.ceil((height + 2 * PAD) * ratio);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = PAD;
  for (const { ops, box, align } of layers) {
    const b = box!;
    const x = PAD + (align === 'center' ? (width - b.w) / 2 : 0);
    ctx.save();
    // De coordenadas de la ventana a las de la imagen
    ctx.setTransform(ratio, 0, 0, ratio, (x - b.x) * ratio, (y - b.y) * ratio);
    for (const op of ops) {
      ctx.save();
      op(ctx);
      ctx.restore();
    }
    ctx.restore();
    y += b.h + GAP;
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob'))), 'image/png'));
}

/** Copia la imagen al portapapeles; si el navegador no deja (sin HTTPS, por ejemplo), lanza un error. */
export async function copyCapture(target: Element): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('clipboard');
  // La promesa dentro del ClipboardItem conserva el gesto del usuario mientras se dibuja (Safari lo exige)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': captureBlob(target) })]);
}

/** Descarga la imagen como PNG. */
export async function downloadCapture(target: Element, name: string): Promise<void> {
  const blob = await captureBlob(target);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'grafica'}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
