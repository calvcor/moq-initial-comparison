# SFU de la rama WebRTC. Debian y no Alpine: mediasoup descarga un worker precompilado para glibc y, si no lo hay para
# la arquitectura, lo compila (por eso python3, make y g++).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./

CMD ["node", "server.mjs"]
