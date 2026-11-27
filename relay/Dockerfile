# Relay de MoQ. "release" (por defecto): la imagen publicada moqdev/moq-relay:MOQ_RELAY_VERSION, sin cambios.
# "git": compilado desde el commit MOQ_RELAY_COMMIT de moq-dev/moq, para medir versiones aún no publicadas
# (la rama principal envía por PROBE la estimación de ancho de banda de BBR y no cwnd/RTT, como la 0.17.9;
# docs/limitations.md). Docker solo construye la etapa que se elige, así que con
# "release" no se compila nada. Se pasa desde docker-compose.yml (variables del .env).
ARG MOQ_RELAY_FROM=release
ARG MOQ_RELAY_VERSION=latest

FROM moqdev/moq-relay:${MOQ_RELAY_VERSION} AS relay-release

# Compilado con cargo, como moq-cli en server/Dockerfile, y no con el Dockerfile de moq-dev, que construye con
# Nix. Toolchain: la de rust-toolchain.toml de moq en ese commit. Perfil release con LTO thin, como moq-cli. Sin
# features extra: las de por defecto del relay. Las cachés de Cargo persisten entre construcciones.
FROM rust:1.98.1-bookworm AS relay-build
ARG MOQ_RELAY_COMMIT=c19c723d90c6e8df60c9a656cc2a4d92ee358295
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /src && curl -fsSL "https://codeload.github.com/moq-dev/moq/tar.gz/${MOQ_RELAY_COMMIT}" | tar -xz -C /src --strip-components=1
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/target-relay \
    cd /src && CARGO_TARGET_DIR=/target-relay CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    cargo build --release --locked -p moq-relay && \
    install -m 755 /target-relay/release/moq-relay /usr/local/bin/moq-relay && \
    mkdir -p /usr/local/share && printf 'git@%.7s' "${MOQ_RELAY_COMMIT}" > /usr/local/share/moq-relay-build

# Mismo punto de entrada que la imagen publicada (/bin/entry.sh ejecuta /bin/moq-relay con los argumentos)
FROM debian:bookworm-slim AS relay-git
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=relay-build /usr/local/bin/moq-relay /bin/moq-relay
COPY --from=relay-build /usr/local/share/moq-relay-build /usr/local/share/moq-relay-build
ENTRYPOINT ["/bin/moq-relay"]

FROM relay-${MOQ_RELAY_FROM}
# Elige el certificado (el de SERVER_HOST o uno autofirmado) y arranca el relay (relay/entrypoint.sh)
COPY entrypoint.sh /relay-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/relay-entrypoint.sh"]
