#!/bin/sh
# MediaMTX. Su señalización WHEP escucha en 8189/tcp y el navegador llega a ella por el router, como a la de mediasoup.
# Con SERVER_HOST, por HTTPS con el certificado del contenedor cert (espera a que exista; MediaMTX vuelve a leer el
# renovado por su cuenta); sin él (en local), por HTTP.
set -e
if [ -n "$SERVER_HOST" ]; then
    CERT="/certs/${SERVER_HOST}.crt"
    KEY="/certs/${SERVER_HOST}.key"
    until [ -s "$CERT" ] && [ -s "$KEY" ]; do
        echo "Esperando el certificado de ${SERVER_HOST} (contenedor cert)"
        sleep 10
    done
    export MTX_WEBRTCENCRYPTION=yes MTX_WEBRTCSERVERCERT="$CERT" MTX_WEBRTCSERVERKEY="$KEY"
else
    export MTX_WEBRTCENCRYPTION=no
fi
exec /mediamtx
