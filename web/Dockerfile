# Origen de @moq/watch y de los paquetes @moq/* de los que depende. "release" (por defecto): los publicados en
# npm, fijados en package-lock.json. "git": compilados desde el commit MOQ_WATCH_COMMIT de moq, para medir
# versiones aún no publicadas. Docker solo construye la etapa que se elige. Se pasa desde docker-compose.yml.
ARG MOQ_WATCH_FROM=release
# Versión de bun con la que se instala y se compila moq. La 1.3.5 lee el lockfile de bc64b9c; el de commits
# posteriores (c19c723) necesita una más nueva: la 1.4.4, la que instala la integración continua de moq.
ARG MOQ_WATCH_BUN=1.3.5

FROM alpine:3.22 AS moqwatch-release
RUN mkdir /pkgs

# Paquetes compilados desde un commit, empaquetados como los publica moq (su build + js/common/package.ts).
# Al instalar en Linux, el lockfile de moq no trae dos cosas que hacen falta y se añaden en la versión que fija:
# el binario nativo de rolldown (el empaquetador de vite) y pako (dependencia de @moq/flate, si el commit la tiene).
# Sin pako, el build de flate, json, hang y watch falla y se empaquetarían sus fuentes .ts sin compilar: por eso se
# exige dist/package.json antes de empaquetar cada uno. Se identifican como git@<commit> en el panel y en el CSV.
FROM oven/bun:${MOQ_WATCH_BUN} AS moqwatch-git
ARG MOQ_WATCH_COMMIT=bc64b9c52561209322dcb8dec9992bf867f499f7
# Parches de patches/: "1" (por defecto) los aplica todos y la versión sale como git@<commit>+switching; "0" no
# aplica ninguno (git@<commit>). Están hechos para el commit fijado por defecto: con otro, o se rehacen o se
# construye con MOQ_WATCH_PATCHES=0 (p. ej. c19c723, que no tiene el parche).
ARG MOQ_WATCH_PATCHES=1
ADD https://codeload.github.com/moq-dev/moq/tar.gz/${MOQ_WATCH_COMMIT} /tmp/moq.tar.gz
WORKDIR /moq
# Desde c19c723, el postinstall de la raíz de moq construye @moq/libav, que sin Nix falla (más abajo va vacío): en esta
# copia se quita, solo si es exactamente eso, antes de instalar
RUN tar -xzf /tmp/moq.tar.gz --strip-components=1 && \
    bun -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json")); \
      if (p.scripts?.postinstall === "bun run --cwd js/libav build") { delete p.scripts.postinstall; fs.writeFileSync("package.json", JSON.stringify(p, null, 2)); console.log("Sin el postinstall de @moq/libav"); }' && \
    bun install --frozen-lockfile
# Parches del testbed sobre ese commit (patches/, docs/adaptation-and-experiments.md). Uno: la opción `switching` del cambio
# de calidad de MoQ, que por defecto deja el comportamiento original. Si se aplican y uno no entra, la
# construcción falla en vez de compilar otra cosa.
COPY patches/ /patches/
RUN set -e; if [ "${MOQ_WATCH_PATCHES}" = 1 ]; then \
      apt-get update -qq && apt-get install -y -qq --no-install-recommends patch >/dev/null; \
      for p in /patches/*.patch; do patch -p1 --forward < "$p"; done; \
    fi
RUN set -e; \
    case "$(uname -m)" in aarch64) arch=arm64 ;; *) arch=x64 ;; esac; \
    rolldown=$(bun -e 'console.log(require("/moq/node_modules/rolldown/package.json").version)'); \
    pako=$(grep -o '"pako@[0-9][^"]*"' bun.lock | head -1 | tr -d '"' | cut -d@ -f2); \
    mkdir /tmp/extra && cd /tmp/extra && bun add "@rolldown/binding-linux-$arch-gnu@$rolldown" ${pako:+"pako@$pako"} && \
    cp -r node_modules/@rolldown/. /moq/node_modules/@rolldown/ && \
    if [ -n "$pako" ]; then cp -r node_modules/pako /moq/node_modules/; fi
# Los paquetes @moq/* que necesita @moq/watch, sacados de sus package.json (dependencias de dependencias, cada uno
# después de los suyos), y no de una lista fija: cambian entre commits (c19c723 no tiene @moq/flate y añade
# @moq/qmux y @moq/libav). Los que no están en js/ del commit (en bc64b9c, @moq/qmux) llegan de npm.
# @moq/libav (desde c19c723) solo se construye con Nix o se descarga de npm, donde aún no está publicado: va
# vacío, un módulo que da error si se carga, y un fichero de marca con .wasm. en el nombre para el plugin de vite
# de @moq/watch, que copia a sus assets el worker y el wasm de libav y falla si no hay ninguno. @moq/hang solo lo
# carga como polyfill si el navegador no tiene AudioDecoder y AudioEncoder, y Chrome los tiene, así que no cambia
# nada de lo que se mide.
RUN set -e; mkdir /pkgs; \
    pkgs=$(bun -e ' \
      const fs = require("fs"); const seen = new Set(); const order = []; \
      const visit = (p) => { \
        if (seen.has(p)) return; seen.add(p); \
        const file = `js/${p}/package.json`; if (!fs.existsSync(file)) return; \
        const j = JSON.parse(fs.readFileSync(file)); \
        Object.keys({ ...j.dependencies, ...j.peerDependencies }).filter((n) => n.startsWith("@moq/")).forEach((n) => visit(n.slice(5))); \
        order.push(p); \
      }; \
      visit("watch"); console.log(order.join(" "));'); \
    echo "Paquetes @moq/* que se compilan: $pkgs"; \
    for p in $pkgs; do \
      if [ "$p" = libav ]; then \
        mkdir -p js/libav/dist && cp js/libav/index.d.ts js/libav/dist/ && \
        echo 'throw new Error("@moq/libav vacío en el banco (web/Dockerfile): el polyfill de audio no se usa en Chrome");' > js/libav/dist/libav-opus-aac-af.mjs && \
        echo '@moq/libav vacío en el banco (web/Dockerfile): sin worker ni wasm' > js/libav/dist/libav-vacio.wasm.txt && \
        bun -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("js/libav/package.json")); \
          fs.writeFileSync("js/libav/dist/package.json", JSON.stringify({ name: p.name, version: p.version, type: "module", license: p.license, \
            exports: { ".": { types: "./index.d.ts", default: "./libav-opus-aac-af.mjs" } }, dependencies: p.dependencies }, null, 2));'; \
      else \
        (cd js/$p && bun run build); \
      fi; \
      test -f js/$p/dist/package.json; \
      (cd js/$p/dist && bun pm pack --destination /pkgs); \
    done; \
    if [ "${MOQ_WATCH_PATCHES}" = 1 ]; then suffix=+switching; else suffix=; fi; \
    printf 'git@%.7s%s' "${MOQ_WATCH_COMMIT}" "$suffix" > /pkgs/label

FROM moqwatch-${MOQ_WATCH_FROM} AS moqwatch

FROM node:22-alpine AS build

ARG MOQ_WATCH_VERSION=latest
ARG DASHJS_VERSION=latest
ARG MEDIASOUP_CLIENT_VERSION=latest

WORKDIR /app

COPY package*.json ./
# Con MOQ_WATCH_FROM=git, los @moq/* apuntan a los paquetes compilados (también los que llegan como
# dependencia, con overrides). En modo release (o para dash.js / mediasoup-client), por defecto se instala
# la última versión salvo que se fije una concreta en el .env; si todo coincide con package.json se usa el lockfile.
COPY --from=moqwatch /pkgs ./moq-pkgs
RUN set -e; \
    node -e ' \
      const fs = require("fs"); \
      const p = JSON.parse(fs.readFileSync("package.json")); \
      let changed = false; \
      const tgz = fs.existsSync("moq-pkgs") ? fs.readdirSync("moq-pkgs").filter((f) => f.endsWith(".tgz")) : []; \
      if (tgz.length > 0) { \
        const file = (n) => "file:moq-pkgs/" + tgz.find((f) => f.startsWith(n.slice(1).replace("/", "-") + "-") && /^[0-9]/.test(f.slice(n.length))); \
        const names = tgz.map((f) => "@" + f.replace(/-[0-9][^-]*\.tgz$/, "").replace("-", "/")); \
        p.overrides = Object.fromEntries(names.map((n) => [n, file(n)])); \
        p.dependencies["@moq/watch"] = file("@moq/watch"); \
        changed = true; \
        console.log(p.overrides); \
      } else if (process.env.MOQ_WATCH_VERSION && process.env.MOQ_WATCH_VERSION !== p.dependencies["@moq/watch"]) { \
        p.dependencies["@moq/watch"] = process.env.MOQ_WATCH_VERSION; \
        changed = true; \
      } \
      for (const [pkg, env] of [["dashjs", "DASHJS_VERSION"], ["mediasoup-client", "MEDIASOUP_CLIENT_VERSION"]]) { \
        const v = process.env[env]; \
        if (v && v !== p.dependencies[pkg]) { p.dependencies[pkg] = v; changed = true; } \
      } \
      if (changed) { \
        fs.writeFileSync("package.json", JSON.stringify(p, null, 2)); \
        fs.rmSync("package-lock.json", { force: true }); \
      }' && \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY <<EOF /etc/nginx/conf.d/default.conf
server {
    listen 80;
    server_name localhost;

    # Habilitar Cross-Origin Isolation para permitir SharedArrayBuffer en AudioWorklet
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;

    # La construcción que se sirve: los trabajadores de campañas la comparan con la suya en cada latido
    location = /build.json {
        root /usr/share/nginx/html;
        add_header Cache-Control "no-store" always;
        add_header Cross-Origin-Opener-Policy same-origin always;
        add_header Cross-Origin-Embedder-Policy require-corp always;
    }

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
