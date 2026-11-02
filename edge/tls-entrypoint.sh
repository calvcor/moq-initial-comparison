#!/bin/sh
# edge con docker-compose.tls.yml: sirve el puerto 80 desde el arranque y, cuando hay certificado para
# DASH_HOST, también el 443. Comprueba el certificado cada minuto: lo activa en cuanto aparece y recarga
# nginx al renovarse.
CERT="/certs/certificates/${DASH_HOST}.crt"
KEY="/certs/certificates/${DASH_HOST}.key"
TLS_CONF=/etc/nginx/tls/edge.conf
mkdir -p /etc/nginx/tls
rm -f "$TLS_CONF"

nginx -g 'daemon off;' &
NGINX=$!
# Hasta que nginx no ha escrito su PID no admite recargas
while [ ! -s /run/nginx.pid ] && kill -0 "$NGINX" 2>/dev/null; do sleep 0.2; done

last=""
while kill -0 "$NGINX" 2>/dev/null; do
    if [ -s "$CERT" ] && [ -s "$KEY" ]; then
        stamp=$(stat -c %Y "$CERT")
        if [ "$stamp" != "$last" ]; then
            sed -e "s|__HOST__|${DASH_HOST}|g" -e "s|__CERT__|${CERT}|g" -e "s|__KEY__|${KEY}|g" \
                /etc/nginx/tls.conf.template > "$TLS_CONF"
            if nginx -t 2>/dev/null && nginx -s reload; then
                echo "HTTPS activo con el certificado de ${DASH_HOST}"
                last=$stamp
            else
                rm -f "$TLS_CONF"
                echo "No se pudo activar el certificado de ${DASH_HOST}; se reintentará" >&2
            fi
        fi
    fi
    sleep 60
done
