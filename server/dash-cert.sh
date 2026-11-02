#!/bin/sh
# Certificado de Let's Encrypt para el puerto directo de DASH (y, con docker-compose.tls.yml, también para
# el panel y el relay), con acme.sh y un reto DNS de DuckDNS o de Cloudflare: no necesita abrir ningún
# puerto ni que el servidor sea accesible desde Internet. La cuenta se registra sin correo electrónico. Se
# renueva solo; nginx-dash y edge detectan el certificado nuevo y se recargan.
if [ -z "$DASH_HOST" ] || { [ -z "$DUCKDNS_TOKEN" ] && [ -z "$CF_Token" ]; }; then
    echo "Sin DASH_HOST o sin token de DNS: DASH sigue pasando por el punto de entrada y no se pide certificado."
    exec sleep infinity
fi
if [ -n "$CF_Token" ]; then
    DNS_API=dns_cf
    DNS_SLEEP=30
else
    export DuckDNS_Token="$DUCKDNS_TOKEN"
    DNS_API=dns_duckdns
    DNS_SLEEP=120
fi
ACME="acme.sh --config-home /certs/acme"
CERT="/certs/certificates/${DASH_HOST}.crt"
KEY="/certs/certificates/${DASH_HOST}.key"
mkdir -p /certs/certificates

until [ -s "$CERT" ]; do
    $ACME --issue --server letsencrypt --dns "$DNS_API" --dnssleep "$DNS_SLEEP" -d "$DASH_HOST" --keylength ec-256
    # 0: emitido; 2: ya había uno válido. En ambos casos se copia a donde lo busca nginx-dash.
    case $? in
        0|2) $ACME --install-cert -d "$DASH_HOST" --ecc --fullchain-file "$CERT" --key-file "$KEY" ;;
        *) echo "No se pudo obtener el certificado; se reintenta en 10 minutos" >&2; sleep 600 ;;
    esac
done

# Renovación: acme.sh solo renueva cuando faltan menos de 30 días, y al hacerlo vuelve a copiarlo
while true; do
    sleep 43200
    $ACME --cron
done
