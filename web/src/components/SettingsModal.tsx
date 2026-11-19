import React, { useEffect, useState } from 'react';
import { Languages, Server, Settings, X } from 'lucide-react';
import { lang, setLang, t, type Lang } from '../lib/i18n';
import { WorkersPanel } from './WorkersPanel';

// Ajustes de la página, comunes al dashboard y a la página de campañas: el idioma de la interfaz (de este navegador)
// y los trabajadores independientes de las campañas (del orquestador, compartidos por todos).

export type SettingsSection = 'language' | 'workers';

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { id: 'language', label: t('Idioma', 'Language'), icon: <Languages className="w-4 h-4" /> },
  { id: 'workers', label: t('Trabajadores', 'Workers'), icon: <Server className="w-4 h-4" /> },
];

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
            {section === 'language' ? <LanguageSection /> : <WorkersPanel />}
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
    title={t('Ajustes: idioma y trabajadores', 'Settings: language and workers')}
    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300 hover:text-white hover:border-indigo-500"
  >
    <Settings className="w-4 h-4" />
    {t('Ajustes', 'Settings')}
  </button>
);
