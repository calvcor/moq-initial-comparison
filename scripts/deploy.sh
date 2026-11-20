#!/usr/bin/env bash
# Despliega la rama main local en un servidor por SSH (docs/deployment.md, «Updating a server»), sin que el servidor
# necesite acceso al repositorio remoto: envía los commits que le faltan en un git bundle, avanza su checkout y
# reconstruye o reinicia solo los servicios cuyos ficheros han cambiado.
#
#   scripts/deploy.sh root@testbed.example.org [ruta del checkout]     (por defecto /opt/moq-initial-comparison)
#
# Se niega a desplegar si hay una campaña en marcha (un despliegue a mitad la contamina) o si el checkout del servidor
# tiene cambios sin confirmar o commits que main no tiene. La configuración de la emisión y si estaba parada se guardan
# en media/ y sobreviven a los reinicios.
set -euo pipefail

DEST="${1:-}"
DIR="${2:-/opt/moq-initial-comparison}"
[ -n "$DEST" ] || { sed -n '2,10p' "$0"; exit 1; }
cd "$(git rev-parse --show-toplevel)"

die() { echo "Error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }
remote() { ssh -o BatchMode=yes "$DEST" "cd '$DIR' && $1"; }

status_summary() {
  remote "curl -fsS http://localhost/api/status" | python3 -c '
import json, sys
s = json.load(sys.stdin)
ladder = ", ".join("%sp@%s" % (r.get("height"), r.get("bitrate_kbps")) for r in (s.get("config") or {}).get("renditions", []))
running = "en marcha" if s["processes"]["pipeline"] else "parada"
campaign = s.get("campaign")
print("emisión %s; %s; campaña: %s" % (running, ladder, campaign["name"] if campaign else "ninguna"))
sys.exit(3 if campaign else 0)
'
}

step "Estado de $DEST"
set +e
status_summary
code=$?
set -e
[ "$code" = 3 ] && die "hay una campaña en marcha: no se despliega hasta que termine"
[ "$code" = 0 ] || echo "(la API no responde: se despliega igualmente)"

old=$(remote "git rev-parse HEAD")
new=$(git rev-parse main)
[ -z "$(remote 'git status --porcelain --untracked-files=no')" ] || die "el checkout del servidor tiene cambios sin confirmar"
git merge-base --is-ancestor "$old" "$new" 2>/dev/null || die "el servidor está en ${old:0:7}, que main no contiene (git fetch o revisa a mano)"
if [ "$old" = "$new" ]; then
  echo "Ya está en ${new:0:7}: nada que desplegar"
  exit 0
fi

step "Commits ${old:0:7}..${new:0:7}"
git log --oneline "$old..$new"
bundle=$(mktemp -t deploy.XXXXXX).bundle
trap 'rm -f "$bundle"' EXIT
git bundle create -q "$bundle" "$old..main"
scp -q "$bundle" "$DEST:/tmp/deploy.bundle"
remote "git pull -q --ff-only /tmp/deploy.bundle main && rm -f /tmp/deploy.bundle"

# Qué hay que reconstruir (imagen) y qué reiniciar (ficheros montados), según los ficheros cambiados
changed=$(git diff --name-only "$old" "$new")
# Listas separadas por espacios (el bash de macOS es el 3.2: sin namerefs ni arrays vacíos con set -u)
build="" restart="" compose=0
has() { [[ " $1 " == *" $2 "* ]]; }
while read -r f; do
  case "$f" in
    docker-compose.yml) compose=1 ;;
    web/*) has "$build" web || build="$build web" ;;
    server/app/*) has "$restart" orchestrator || restart="$restart orchestrator" ;;
    server/*) has "$build" orchestrator || build="$build orchestrator" ;;
    relay/*) has "$build" moq-relay || build="$build moq-relay" ;;
    router/*) has "$build" router || build="$build router" ;;
    sfu/*) has "$build" sfu || build="$build sfu" ;;
    mediamtx/*) has "$build" mediamtx || build="$build mediamtx" ;;
    nginx/entrypoint.sh) for n in nginx-web nginx-dash; do has "$restart" $n || restart="$restart $n"; done ;;
    nginx/web*) has "$restart" nginx-web || restart="$restart nginx-web" ;;
    nginx/dash*) has "$restart" nginx-dash || restart="$restart nginx-dash" ;;
    cert/*) has "$restart" cert || restart="$restart cert" ;;
  esac
done <<< "$changed"

if [ "$compose" = 1 ]; then
  # Compose recrea los servicios cuya definición cambió, reconstruye las imágenes y retira los que ya no existen
  step "docker-compose.yml cambió: docker compose up -d --build --remove-orphans"
  remote "docker compose up -d --build --remove-orphans"
elif [ -n "$build" ]; then
  step "Reconstruir:$build"
  # --no-deps: sin él, Compose recrea también el orquestador
  remote "docker compose up -d --build --no-deps$build"
fi
# Los ficheros montados no los ve un contenedor que no se reinicia; los recién reconstruidos ya arrancaron con ellos
todo=""
for s in $restart; do
  if [ "$compose" = 1 ] || ! has "$build" "$s"; then todo="$todo $s"; fi
done
if [ -n "$todo" ]; then
  step "Reiniciar:$todo"
  remote "docker compose restart$todo"
fi

step "Hecho: ${DEST} en ${new:0:7}"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  status_summary 2>/dev/null && exit 0
  sleep 5
done
echo "La API aún no responde: revisa docker compose ps en el servidor"
