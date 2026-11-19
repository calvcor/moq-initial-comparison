// Fondo de las capturas de gráficas (`capture.ts`), elegido en Ajustes → Capturas y guardado en este navegador:
// - transparent: sin fondo, con textos oscuros y las gráficas en colores para papel (para pegar sobre fondo claro);
// - white: igual, sobre blanco;
// - interface: tal como se ve en la página, sobre el azul oscuro de la interfaz.

export type CaptureBackground = 'transparent' | 'white' | 'interface';

const KEY = 'testbed.captureBackground';
const VALUES: CaptureBackground[] = ['transparent', 'white', 'interface'];

export function captureBackground(): CaptureBackground {
  try {
    const v = localStorage.getItem(KEY) as CaptureBackground | null;
    return v && VALUES.includes(v) ? v : 'transparent';
  } catch {
    return 'transparent';
  }
}

/** Guarda la preferencia; false si el navegador no deja (almacenamiento bloqueado). */
export function setCaptureBackground(v: CaptureBackground): boolean {
  try {
    localStorage.setItem(KEY, v);
    return true;
  } catch {
    return false;
  }
}
