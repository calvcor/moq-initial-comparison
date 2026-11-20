#!/bin/sh
# Relay de MoQ. Con SERVER_HOST, el certificado de Let's Encrypt del contenedor cert (espera a que exista; el relay
# toma solo el renovado). Sin él (en local), un certificado autofirmado que el navegador fija por su huella, servida
# en /certificate.sha256 desde el puerto 8081.
set -e
if [ -n "$SERVER_HOST" ]; then
    CERT="/certs/${SERVER_HOST}.crt"
    KEY="/certs/${SERVER_HOST}.key"
    until [ -s "$CERT" ] && [ -s "$KEY" ]; do
        echo "Esperando el certificado de ${SERVER_HOST} (contenedor cert)"
        sleep 10
    done
    set -- --listen-tls-cert "$CERT" --listen-tls-key "$KEY"
else
    set -- --listen-tls-generate localhost
fi
exec /bin/moq-relay --listen 0.0.0.0:4433 "$@" --web-http-listen 0.0.0.0:8081 --auth-public 'anon/**'
