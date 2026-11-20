#!/bin/sh
# Arranque común de nginx-web y nginx-dash. Sin SERVER_HOST (en local) solo sirven HTTP. Con SERVER_HOST, sirven HTTP
# desde el arranque, activan TLS en cuanto el contenedor cert ha dejado el certificado y recargan nginx cada 12 h
# para tomar el renovado (Let's Encrypt renueva con 30 días de margen).
CERT="/certs/${SERVER_HOST}.crt"
KEY="/certs/${SERVER_HOST}.key"
TLS_CONF=/etc/nginx/tls/tls.conf
mkdir -p /etc/nginx/tls
rm -f "$TLS_CONF"

nginx -g 'daemon off;' &
NGINX=$!
# Sin esto, docker stop esperaría 10 s: el shell, como PID 1, no termina con SIGTERM
trap 'nginx -s quit; wait "$NGINX"; exit 0' TERM INT

if [ -n "$SERVER_HOST" ]; then
    until [ -s "$CERT" ] && [ -s "$KEY" ]; do
        echo "Esperando el certificado de ${SERVER_HOST} (contenedor cert)"
        sleep 10 & wait $!
    done
    # Hasta que nginx no ha escrito su PID no admite recargas
    while [ ! -s /run/nginx.pid ]; do sleep 0.2; done
    sed -e "s|__HOST__|${SERVER_HOST}|g" -e "s|__CERT__|${CERT}|g" -e "s|__KEY__|${KEY}|g" \
        /etc/nginx/tls.conf.template > "$TLS_CONF"
    nginx -s reload && echo "TLS activo con el certificado de ${SERVER_HOST}"
    while kill -0 "$NGINX" 2>/dev/null; do
        sleep 43200 & wait $!
        nginx -s reload
    done
fi
wait "$NGINX"
