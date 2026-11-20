import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Versión instalada de cada reproductor, leída de node_modules al construir, para mostrarla en el dashboard
const installed = (name: string): string => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version
// Con MOQ_WATCH_FROM=git (web/Dockerfile) los @moq/* vienen de un commit y su versión no lo identifica: git@<commit>
const gitLabel = existsSync(new URL('./moq-pkgs/label', import.meta.url))
  ? readFileSync(new URL('./moq-pkgs/label', import.meta.url), 'utf8').trim()
  : ''
const moq = (name: string): string => gitLabel || installed(name)

// L2A (bugfix), experimento declarado (docs/adaptation-and-experiments.md, docs/adaptation-and-experiments.md): una copia de dash.js en la
// que la fase estable de L2A usa kbit/s en el multiplicador Q y en la subida prudente, como dash.js 4.x. En dash.js 5
// esas dos cuentas toman rep.bandwidth (bit/s) frente a un caudal en kbit/s. El cambio es una sola expresión del
// build minificado: si no aparece exactamente una vez (otra versión de dash.js), la construcción falla en vez de
// servir otra cosa. El reproductor solo carga esta copia con la opción L2A (bugfix); las demás usan dash.js tal cual.
const DASHJS_L2AFIX = 'virtual:dashjs-l2afix'
const L2A_UNITS = /(const \w+=\w+\.map\(\(\w=>\w\.)bandwidth(\)\);\w+\.Q=Math\.max\()/g
function dashjsL2aFix(): Plugin {
  return {
    name: 'dashjs-l2afix',
    resolveId: (id) => (id === DASHJS_L2AFIX ? `\0${DASHJS_L2AFIX}` : null),
    load(id) {
      if (id !== `\0${DASHJS_L2AFIX}`) return null
      const code = readFileSync(fileURLToPath(new URL('./node_modules/dashjs/dist/modern/esm/dash.all.min.js', import.meta.url)), 'utf8')
      const found = code.match(L2A_UNITS) ?? []
      if (found.length !== 1) throw new Error(`L2A (bugfix): se esperaba una aparición del cálculo de Q de L2A en dash.js ${installed('dashjs')} y hay ${found.length}`)
      return code.replace(L2A_UNITS, '$1bitrateInKbit$2')
    },
  }
}

// Identificador de esta construcción de la web: la hora en que se construyó (en desarrollo, "dev"). Va dentro del
// código (__WEB_BUILD__) y en /build.json, que se sirve sin caché: un trabajador de campañas compara los dos y, si la
// web ha cambiado, recarga entre pruebas (docs/campaigns.md). Sin él, un trabajador seguía días con el código que cargó.
function webBuild(id: string): Plugin {
  return {
    name: 'web-build',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build: id }) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const build = command === 'build' ? new Date().toISOString().slice(0, 19) + 'Z' : 'dev'
  return {
  define: {
    __WEB_BUILD__: JSON.stringify(build),
    // @moq/net y @moq/hang son dependencias de @moq/watch, pero contienen la parte de red y el catálogo: también
    // condicionan las medidas, y pueden cambiar sin que cambie @moq/watch
    __PLAYER_VERSIONS__: JSON.stringify({
      moq_watch: moq('@moq/watch'),
      moq_net: moq('@moq/net'),
      moq_hang: moq('@moq/hang'),
      dashjs: installed('dashjs'),
      mediasoup_client: installed('mediasoup-client'),
    }),
  },
  plugins: [
    react(),
    tailwindcss(),
    dashjsL2aFix(),
    webBuild(build),
  ],
  server: {
    port: 5173,
    host: true,
  }
  }
})
