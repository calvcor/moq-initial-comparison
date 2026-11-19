// Idioma de la interfaz: español (por defecto) o inglés, elegido en Ajustes y recordado en este navegador.
// Los textos van junto al código como t('español', 'english'): el idioma se fija al cargar la página y cambiarlo la
// recarga, así que también valen las constantes de módulo. Lo que no se traduce: los nombres de las columnas del
// CSV y de los campos de la API (son datos) y los mensajes de error que llegan del servidor.

export type Lang = 'es' | 'en';

const KEY = 'testbed.lang';

function load(): Lang {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'es';
  } catch {
    return 'es';
  }
}

export const lang: Lang = load();

/** Locale para fechas y números. */
export const locale = lang === 'en' ? 'en-GB' : 'es-ES';

/** El texto en el idioma de la interfaz. */
export const t = (es: string, en: string): string => (lang === 'en' ? en : es);

/** Cambia el idioma y recarga la página. Sin almacenamiento, no se puede recordar y no cambia. */
export function setLang(next: Lang): boolean {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

if (typeof document !== 'undefined') document.documentElement.lang = lang;
