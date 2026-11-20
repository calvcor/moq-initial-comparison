// LL-DASH va siempre directo al router de emulación, como MoQ y WebRTC, nunca por nginx-web: un proxy abriría otra
// conexión TCP y dejaría la del navegador fuera de la red emulada. Con SERVER_HOST, por HTTPS a dash_url (8443); sin él
// (en local), por HTTP a dash_http_port (8080) del host de la página. Una página HTTPS no puede pedir por HTTP: sin
// SERVER_HOST no hay DASH (null).
import { t } from './i18n';

export const DASH_NEEDS_HOST = t(
  'Esta página es HTTPS y el servidor no tiene SERVER_HOST: DASH no tiene camino directo (docs/deployment.md)',
  'This page is HTTPS and the server has no SERVER_HOST: DASH has no direct path (docs/deployment.md)',
);

export function dashManifestUrl(
  status: { dash_url?: string | null; dash_http_port?: number; moq_host?: string | null } | null | undefined,
): string | null {
  if (status?.dash_url) return status.dash_url;
  if (window.location.protocol === 'https:') return null;
  return `http://${status?.moq_host || window.location.hostname}:${status?.dash_http_port ?? 8080}/media/dash/manifest.mpd`;
}
