import React, { useRef, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { copyCapture, downloadCapture } from '../lib/capture';
import { t } from '../lib/i18n';

// Botones para copiar o descargar como PNG la gráfica o el bloque que los contiene (`lib/capture.ts`). Buscan hacia
// arriba el elemento marcado con data-capture="chart" o "block"; no salen en la imagen. Con `label`, llevan texto y van
// en una barra con borde, precedidos de `caption` (los de un bloque, para no confundirlos con los de una gráfica); sin
// él, solo iconos (los de cada gráfica, que aparecen al pasar el ratón: el contenedor lleva `group/cap`).
export const CaptureButtons: React.FC<{ target: 'chart' | 'block'; name: string; label?: boolean; caption?: string; className?: string }> = ({
  target,
  name,
  label = false,
  caption,
  className = '',
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'saved' | 'error'>('idle');
  const element = () => ref.current?.closest(`[data-capture="${target}"]`) ?? null;
  const flash = (s: typeof state) => {
    setState(s);
    setTimeout(() => setState('idle'), s === 'error' ? 4000 : 1500);
  };
  const run = async (copy: boolean) => {
    const el = element();
    if (!el) return;
    setState('busy');
    try {
      if (copy) {
        try {
          await copyCapture(el);
          flash('copied');
        } catch {
          // Sin portapapeles (página sin HTTPS, permiso denegado): se descarga
          await downloadCapture(el, name);
          flash('error');
        }
      } else {
        await downloadCapture(el, name);
        flash('saved');
      }
    } catch {
      flash('error');
    }
  };
  const what = target === 'chart' ? t('esta gráfica', 'this chart') : t('todo el bloque', 'the whole block');
  const btn = 'flex items-center gap-1 rounded px-1 py-0.5 text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50';
  return (
    <span
      ref={ref}
      data-capture-skip=""
      className={`inline-flex items-center gap-0.5 text-[11px] ${label ? 'bg-slate-900 border border-slate-800 rounded-md pl-2 pr-0.5 py-0.5' : ''} ${className}`}
    >
      {caption && <span className="text-slate-500 mr-1">{caption}</span>}
      {state === 'error' && <span className="text-amber-300 mr-1">{t('No se pudo copiar: descargada', 'Could not copy: downloaded')}</span>}
      <button
        type="button"
        className={btn}
        disabled={state === 'busy'}
        onClick={() => run(true)}
        title={t(`Copiar ${what} como imagen (con leyenda, títulos y ejes, en colores para papel)`, `Copy ${what} as an image (with legend, titles and axes, in print colours)`)}
      >
        {state === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
        {label && (state === 'copied' ? t('Copiada', 'Copied') : t('Copiar imagen', 'Copy image'))}
      </button>
      <button
        type="button"
        className={btn}
        disabled={state === 'busy'}
        onClick={() => run(false)}
        title={t(`Descargar ${what} como PNG`, `Download ${what} as PNG`)}
      >
        {state === 'saved' ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Download className="w-3.5 h-3.5" />}
        {label && 'PNG'}
      </button>
    </span>
  );
};

// Clases para el contenedor de una gráfica con sus botones en la esquina, visibles al pasar el ratón
export const CAPTURE_CORNER = 'absolute top-0 right-0 z-10 opacity-0 group-hover/cap:opacity-100 focus-within:opacity-100 bg-slate-950/80 rounded';
