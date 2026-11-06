// Versiones de los reproductores empaquetados, inyectadas por Vite al construir (vite.config.ts)
// Construcción de la web (vite.config.ts): la hora en que se construyó, o "dev"; la misma que /build.json
declare const __WEB_BUILD__: string;

declare const __PLAYER_VERSIONS__: { moq_watch: string; moq_net: string; moq_hang: string; dashjs: string; mediasoup_client: string };

// Copia de dash.js con la fase estable de L2A corregida (vite.config.ts); misma interfaz que 'dashjs'
declare module 'virtual:dashjs-l2afix' {
  export * from 'dashjs';
}
