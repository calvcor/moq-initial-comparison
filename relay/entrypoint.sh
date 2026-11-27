#!/bin/sh
# Relay de MoQ. Con SERVER_HOST, el certificado de Let's Encrypt del contenedor cert (espera a que exista; el relay
# toma solo el renovado). Sin él (en local), un certificado autofirmado que el navegador fija por su huella, servida
# en /certificate.sha256 desde el puerto 8081.
set -e
# Anota la versión real del binario para que el orquestador la lea sin depender del .env
if [ -d /run/versions ]; then
    if [ -s /usr/local/share/moq-relay-build ]; then
        cat /usr/local/share/moq-relay-build > /run/versions/moq_relay
    else
        /bin/moq-relay --version 2>/dev/null | awk '{print $2}' > /run/versions/moq_relay || true
    fi
fi
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
# Autorización: el relay pregunta por cada sesión al servidor del orquestador (server/app/moqauth.py), que deja a
# cualquiera suscribirse a anon/** y publicar solo al publicador, con su token. Mientras no responde, no admite a nadie.
exec /bin/moq-relay --listen 0.0.0.0:4433 "$@" --web-http-listen 0.0.0.0:8081 --auth-url unix:///run/moq-auth/auth.sock
