#!/bin/sh
# Certificado de Let's Encrypt para SERVER_HOST, con acme.sh y un reto DNS: no hace falta abrir ningún puerto ni que el
# servidor sea accesible desde Internet. ACME_DNS es el nombre de la API DNS de acme.sh (dns_duckdns, dns_cf...), y
# sus variables (DuckDNS_Token, CF_Token...) llegan del .env tal cual. La cuenta se registra sin correo electrónico.
# Lo usan nginx-web, nginx-dash, el relay de MoQ y la señalización del SFU; cada uno toma el renovado por su cuenta.
if [ -z "$SERVER_HOST" ]; then
    echo "Sin SERVER_HOST (despliegue local): no se pide certificado."
    exec sleep infinity
fi
if [ -z "$ACME_DNS" ]; then
    echo "Falta ACME_DNS en el .env (p. ej. dns_duckdns o dns_cf): no se pide certificado." >&2
    exec sleep infinity
fi
ACME="acme.sh --config-home /certs/acme"
CERT="/certs/${SERVER_HOST}.crt"
KEY="/certs/${SERVER_HOST}.key"

until [ -s "$CERT" ]; do
    # 120 s de espera tras crear el registro TXT: alguna API DNS (DuckDNS) tarda en propagarlo
    $ACME --issue --server letsencrypt --dns "$ACME_DNS" --dnssleep 120 -d "$SERVER_HOST" --keylength ec-256
    # 0: emitido; 2: ya había uno válido. En ambos casos se copia a donde lo buscan los demás.
    case $? in
        0|2) $ACME --install-cert -d "$SERVER_HOST" --ecc --fullchain-file "$CERT" --key-file "$KEY" ;;
        *) echo "No se pudo obtener el certificado; se reintenta en 10 minutos" >&2; sleep 600 ;;
    esac
done

# Renovación: acme.sh solo renueva cuando faltan menos de 30 días, y al hacerlo vuelve a copiarlo
while true; do
    sleep 43200
    $ACME --cron
done
