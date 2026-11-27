# SFU de la rama WebRTC. Debian y no Alpine: mediasoup descarga un worker precompilado para glibc y, si no lo hay para
# la arquitectura, lo compila (por eso python3, make y g++).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ARG MEDIASOUP_VERSION=latest
COPY package.json package-lock.json ./
RUN set -e; \
    pinned=$(node -p 'require("./package.json").dependencies.mediasoup'); \
    if [ -n "$MEDIASOUP_VERSION" ] && [ "$MEDIASOUP_VERSION" != "$pinned" ]; then \
        node -e 'const fs = require("fs"), p = JSON.parse(fs.readFileSync("package.json")); p.dependencies.mediasoup = process.argv[1]; fs.writeFileSync("package.json", JSON.stringify(p, null, 2));' "$MEDIASOUP_VERSION"; \
        rm -f package-lock.json; \
        npm install --omit=dev; \
    else \
        npm ci --omit=dev; \
    fi
COPY server.mjs ./

CMD ["node", "server.mjs"]
