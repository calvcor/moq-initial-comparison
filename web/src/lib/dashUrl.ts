// LL-DASH va siempre directo al router de emulación, como MoQ y WebRTC: nunca por el punto de entrada ni, por tanto, por
// un proxy delante de la página (Nginx Proxy Manager), que abriría otra conexión TCP y dejaría la del navegador fuera de
// la red emulada. Con DASH_HOST, por HTTPS a dash_url (8443); sin él, por HTTP a dash_http_port (8080) de la dirección
// directa (moq_host) o de la de la página. Una página HTTPS no puede pedir por HTTP: sin DASH_HOST no hay DASH (null).
import { t } from './i18n';

export const DASH_NEEDS_HOST = t(
  'Esta página es HTTPS y el servidor no tiene DASH_HOST: DASH no tiene camino directo (README, sección 1)',
  'This page is HTTPS and the server has no DASH_HOST: DASH has no direct path (README, section 1)',
);

export function dashManifestUrl(
  status: { dash_url?: string | null; dash_http_port?: number; moq_host?: string | null } | null | undefined,
): string | null {
  if (status?.dash_url) return status.dash_url;
  if (window.location.protocol === 'https:') return null;
  return `http://${status?.moq_host || window.location.hostname}:${status?.dash_http_port ?? 8080}/media/dash/manifest.mpd`;
}
