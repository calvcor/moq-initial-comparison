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

// L2A (bugfix), experimento declarado (docs/adaptation-and-experiments.md): una copia de dash.js en la que la fase
// estable de L2A usa kbit/s en el multiplicador Q y en la subida prudente, como dash.js 4.x. En dash.js 5.2 esas dos
// cuentas toman rep.bandwidth (bit/s) frente a un caudal en kbit/s. Solo se compila y se ofrece en la interfaz si el
// patrón exacto aparece una vez en el dash.js instalado; en versiones que ya no lo tienen se sirve un módulo vacío.
const DASHJS_L2AFIX = 'virtual:dashjs-l2afix'
const L2A_UNITS = /(const \w+=\w+\.map\(\(\w=>\w\.)bandwidth(\)\);\w+\.Q=Math\.max\()/g
const dashjsCode = readFileSync(fileURLToPath(new URL('./node_modules/dashjs/dist/modern/esm/dash.all.min.js', import.meta.url)), 'utf8')
const dashL2aFixAvailable = (dashjsCode.match(L2A_UNITS) ?? []).length === 1

// El experimento de sondeo de MoQ (probe / probe2) usa la API de pistas anterior a `viewers` (bc64b9c / @moq/net 0.4.x).
// Con la API nueva (`viewers` en @moq/net o @moq/watch) no se compila ni se puede seleccionar.
const hasViewersApi = (rel: string): boolean => {
  const url = new URL(rel, import.meta.url)
  return existsSync(url) && /\bviewers\b/.test(readFileSync(url, 'utf8'))
}
const moqProbeAvailable = !hasViewersApi('./node_modules/@moq/net/connection/pool.js') && !hasViewersApi('./node_modules/@moq/watch/player.d.ts')
// El experimento de cambio de calidad hacia abajo (`switching`) solo existe con el parche de web/patches/
const moqSwitchingAvailable = gitLabel.includes('+switching')

function dashjsL2aFix(): Plugin {
  return {
    name: 'dashjs-l2afix',
    resolveId: (id) => (id === DASHJS_L2AFIX ? `\0${DASHJS_L2AFIX}` : null),
    load(id) {
      if (id !== `\0${DASHJS_L2AFIX}`) return null
      if (!dashL2aFixAvailable) return 'export default {};'
      return dashjsCode.replace(L2A_UNITS, '$1bitrateInKbit$2')
    },
  }
}

function moqProbeGate(): Plugin {
  return {
    name: 'moq-probe-gate',
    load(id) {
      if (!moqProbeAvailable && /\/src\/lib\/moqProbe\.ts$/.test(id.replace(/\\/g, '/'))) {
        return 'export const MoqProbeAbr = null;\nexport const takeProbeSpans = () => null;\n'
      }
      return null
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
    __EXPERIMENTS__: JSON.stringify({
      dashL2aFix: dashL2aFixAvailable,
      moqProbe: moqProbeAvailable,
      moqSwitching: moqSwitchingAvailable,
    }),
  },
  plugins: [
    react(),
    tailwindcss(),
    dashjsL2aFix(),
    moqProbeGate(),
    webBuild(build),
  ],
  server: {
    port: 5173,
    host: true,
  }
  }
})
