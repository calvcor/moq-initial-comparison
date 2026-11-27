# MediaMTX, el servidor WebRTC alternativo (RTC_SERVER=mediamtx): el binario de la imagen publicada, sin cambios, con
# un arranque que activa TLS en su señalización WHEP solo con SERVER_HOST (mediamtx/entrypoint.sh). La imagen
# publicada no tiene shell para hacerlo, y el valor de MTX_WEBRTCENCRYPTION no puede quedar vacío.
ARG MEDIAMTX_VERSION=latest
FROM bluenviron/mediamtx:${MEDIAMTX_VERSION} AS mediamtx

FROM alpine:3.22
COPY --from=mediamtx /mediamtx /mediamtx
COPY --from=mediamtx /mediamtx.yml /mediamtx.yml
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
