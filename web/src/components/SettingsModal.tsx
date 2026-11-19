import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, Languages, Server, Settings, X } from 'lucide-react';
import { lang, setLang, t, type Lang } from '../lib/i18n';
import { WorkersPanel } from './WorkersPanel';
import { captureBackground, setCaptureBackground, type CaptureBackground } from '../lib/captureSettings';

// Ajustes de la página, comunes al dashboard y a la página de campañas: el idioma de la interfaz y el fondo de las
// capturas de gráficas (de este navegador) y los trabajadores independientes de las campañas (del orquestador,
// compartidos por todos).

export type SettingsSection = 'language' | 'captures' | 'workers';

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { id: 'language', label: t('Idioma', 'Language'), icon: <Languages className="w-4 h-4" /> },
  { id: 'captures', label: t('Capturas', 'Screenshots'), icon: <ImageIcon className="w-4 h-4" /> },
  { id: 'workers', label: t('Trabajadores', 'Workers'), icon: <Server className="w-4 h-4" /> },
];

// Cada opción con una muestra de cómo queda: el fondo y un texto y una línea con sus colores
const BACKGROUNDS: { id: CaptureBackground; label: string; hint: string; swatch: React.CSSProperties; ink: string }[] = [
  {
    id: 'transparent',
    label: t('Transparente', 'Transparent'),
    hint: t('Sin fondo, con textos oscuros: para pegar sobre un documento o una diapositiva clara.', 'No background, dark text: to paste onto a light document or slide.'),
    swatch: { backgroundImage: 'repeating-conic-gradient(#cbd5e1 0 25%, #f8fafc 0 50%)', backgroundSize: '12px 12px' },
    ink: '#0f172a',
  },
  {
    id: 'white',
    label: t('Blanco', 'White'),
    hint: t('Fondo blanco y textos oscuros, como al copiar con el botón derecho.', 'White background and dark text, as when copying with the right button.'),
    swatch: { background: '#ffffff' },
    ink: '#0f172a',
  },
  {
    id: 'interface',
    label: t('Azul de la interfaz', 'Interface blue'),
    hint: t('Tal como se ve en la página: el fondo azul oscuro y los textos claros.', 'As seen on the page: the dark blue background and light text.'),
    swatch: { background: '#020617' },
    ink: '#cbd5e1',
  },
];

const CapturesSection: React.FC = () => {
  const [value, setValue] = useState<CaptureBackground>(captureBackground);
  const [failed, setFailed] = useState(false);
  return (
    <div className="space-y-3 text-xs">
      <p className="text-slate-400">
        {t(
          'Fondo de las imágenes que dan los botones de captura (copiar imagen y PNG) de cada gráfica y de cada bloque. Se recuerda en este navegador y se aplica a la siguiente captura, sin recargar.',
          'Background of the images given by the capture buttons (copy image and PNG) of each chart and each block. It is remembered in this browser and applies to the next capture, without reloading.',
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {BACKGROUNDS.map((b) => (
          <button
            key={b.id}
            onClick={() => {
              setValue(b.id);
              setFailed(!setCaptureBackground(b.id));
            }}
            title={b.hint}
            className={`w-48 text-left p-2 rounded-lg border ${
              b.id === value ? 'border-indigo-500 bg-indigo-900/40 text-white' : 'border-slate-700 bg-slate-950 text-slate-300 hover:text-white hover:border-slate-500'
            }`}
          >
            <div className="h-14 rounded border border-slate-600 mb-2 flex flex-col justify-center gap-1.5 px-2" style={b.swatch}>
              <span className="text-[10px] font-medium" style={{ color: b.ink }}>
                {t('Objetivo 200 ms', 'Target 200 ms')}
              </span>
              <svg viewBox="0 0 100 12" className="w-full h-3" preserveAspectRatio="none">
                <polyline points="0,10 20,6 40,8 60,3 80,5 100,2" fill="none" stroke="#3b82f6" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                <polyline points="0,11 100,11" fill="none" stroke={b.ink} strokeOpacity="0.4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
            <div className="font-medium">{b.label}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{b.hint}</div>
          </button>
        ))}
      </div>
      <p className="text-slate-500">
        {t(
          'El clic derecho → Copiar imagen sobre una gráfica no cambia: sigue dando solo el canvas, en blanco.',
          'Right click → Copy image on a chart does not change: it still gives only the canvas, on white.',
        )}
      </p>
      {failed && <p className="text-rose-300">{t('Este navegador no deja guardar la preferencia.', 'This browser does not allow saving the preference.')}</p>}
    </div>
  );
};

const LANGS: { id: Lang; label: string }[] = [
  { id: 'es', label: 'Español' },
  { id: 'en', label: 'English' },
];

const LanguageSection: React.FC = () => {
  const [failed, setFailed] = useState(false);
  return (
    <div className="space-y-3 text-xs">
      <p className="text-slate-400">
        {t(
          'Idioma de toda la interfaz, tablas de resultados incluidas. Se recuerda en este navegador; los trabajadores de las campañas no lo ven.',
          'Language of the whole interface, results tables included. It is remembered in this browser; campaign workers do not see it.',
        )}
      </p>
      <div className="flex gap-2">
        {LANGS.map((l) => (
          <button
            key={l.id}
            onClick={() => l.id !== lang && setFailed(!setLang(l.id))}
            className={`px-4 py-2 rounded-lg border font-medium ${
              l.id === lang ? 'border-indigo-500 bg-indigo-900/40 text-white' : 'border-slate-700 bg-slate-950 text-slate-300 hover:text-white hover:border-slate-500'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="text-amber-300/90">
        {t(
          'Cambiarlo recarga la página: los reproductores se reconectan y se pierden las muestras sin exportar de este tramo.',
          'Changing it reloads the page: the players reconnect and unexported samples of this measurement window are lost.',
        )}
      </p>
      <p className="text-slate-500">
        {t(
          'No se traducen los nombres de las columnas del CSV ni de los campos de la API (son datos), ni los mensajes de error que envía el servidor.',
          'CSV column names and API field names are not translated (they are data), nor are the error messages sent by the server.',
        )}
      </p>
      {failed && <p className="text-rose-300">{t('Este navegador no deja guardar la preferencia.', 'This browser does not allow saving the preference.')}</p>}
    </div>
  );
};

export const SettingsModal: React.FC<{ initial?: SettingsSection; onClose: () => void }> = ({ initial = 'language', onClose }) => {
  const [section, setSection] = useState<SettingsSection>(initial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // El panel cabe en la ventana: la cabecera y el índice quedan fijos y solo se desplaza el contenido
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('Ajustes', 'Settings')}
        className="w-full max-w-7xl max-h-full flex flex-col bg-slate-900 border border-slate-700 rounded-xl text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <Settings className="w-4 h-4 text-indigo-400" />
          <h2 className="text-sm font-semibold text-white">{t('Ajustes', 'Settings')}</h2>
          <button className="ml-auto p-1 text-slate-400 hover:text-white" onClick={onClose} title={t('Cerrar (Esc)', 'Close (Esc)')}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col sm:flex-row min-h-0 flex-1">
          <nav className="shrink-0 flex sm:flex-col gap-1 p-2 sm:w-44 border-b sm:border-b-0 sm:border-r border-slate-800 text-xs">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left ${
                  s.id === section ? 'bg-indigo-900/50 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                {s.icon}
                {s.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-4">
            <h3 className="text-sm font-semibold text-slate-200 mb-3">{SECTIONS.find((s) => s.id === section)!.label}</h3>
            {section === 'language' ? <LanguageSection /> : section === 'captures' ? <CapturesSection /> : <WorkersPanel />}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Botón de la cabecera que abre los ajustes. */
export const SettingsButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    title={t('Ajustes: idioma, capturas y trabajadores', 'Settings: language, screenshots and workers')}
    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300 hover:text-white hover:border-indigo-500"
  >
    <Settings className="w-4 h-4" />
    {t('Ajustes', 'Settings')}
  </button>
);
