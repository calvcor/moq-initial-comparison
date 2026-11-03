#!/usr/bin/env bash
# Instala un trabajador independiente de campañas (README 4.8, trabajadores independientes) en una máquina con
# Debian o Ubuntu (amd64) y systemd, p. ej. un LXC: Node 22, Google Chrome (fijado con apt-mark hold, como todo
# lo demás del banco), el script del trabajador descargado del propio orquestador y un servicio de systemd que lo
# arranca con la máquina y lo reinicia si cae. Con --display, también un Xvfb para la ventana en quiosco.
#
# Con --desktop, para un PC con su propia pantalla: se ejecuta con el usuario de la sesión gráfica (no como root;
# pide sudo solo para instalar lo que falte) y el trabajador queda como servicio de ese usuario (systemctl --user),
# que arranca con su sesión gráfica y abre Chrome en su pantalla.
#
# El orquestador sirve este fichero en /api/worker/install.sh, con su dirección ya puesta:
#   curl -fsSL https://moq-dash.mininet.duckdns.org/api/worker/install.sh | bash -s -- --name lxc-moq
#   curl -fsSL https://moq-dash.mininet.duckdns.org/api/worker/install.sh | bash -s -- --name portatil --desktop
# Volver a ejecutarlo actualiza el script del trabajador y la configuración del servicio.
#
# Opciones:
#   --name NOMBRE    nombre con el que se anuncia (obligatorio): letras, cifras, punto, guion y guion bajo
#   --url URL        orquestador (por defecto, el que sirvió este instalador)
#   --desktop        PC con pantalla: servicio del usuario que lo ejecuta, en su sesión gráfica (sin root)
#   --display        instala Xvfb y le da pantalla a Chrome, para poder abrirlo en una ventana en quiosco
#   --screen AxB     tamaño de esa pantalla virtual (por defecto 1920x1080; al menos el de la calidad más alta)
#   --insecure       el orquestador va por IP sin HTTPS (Chrome lo trata entonces como origen seguro)
#   --no-sandbox     Chrome sin su sandbox: solo si no arranca en un LXC sin privilegios y sin nesting=1
#   --port PUERTO    puerto de depuración de Chrome, local (por defecto 9400)
set -euo pipefail

URL="__ORCHESTRATOR_URL__"
NAME=""
WITH_DISPLAY=0
DESKTOP=0
SCREEN="1920x1080"
INSECURE=0
NO_SANDBOX=0
PORT=""
DIR=/opt/moq-worker
USER_NAME=moq-worker
XVFB_DISPLAY=":99"

die() { echo "Error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    --url) URL="${2:-}"; shift 2 ;;
    --display) WITH_DISPLAY=1; shift ;;
    --desktop) DESKTOP=1; shift ;;
    --screen) SCREEN="${2:-}"; shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    --no-sandbox) NO_SANDBOX=1; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "opción desconocida: $1 (--help para verlas)" ;;
  esac
done

URL="${URL%/}"
[ -n "$NAME" ] || die "falta --name (p. ej. --name lxc-moq)"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$ ]] || die "--name no válido: $NAME"
[[ "$URL" =~ ^https?://[^/]+$ ]] || die "--url no válida: $URL (p. ej. https://moq-dash.mininet.duckdns.org)"
[[ "$SCREEN" =~ ^[0-9]+x[0-9]+$ ]] || die "--screen no válido: $SCREEN"
[ -z "$PORT" ] || [[ "$PORT" =~ ^[0-9]+$ ]] || die "--port no válido: $PORT"
command -v apt-get > /dev/null || die "solo Debian o Ubuntu (apt-get)"
[ "$(dpkg --print-architecture)" = amd64 ] || die "Google Chrome para Linux solo se publica para amd64"
[ -d /run/systemd/system ] || die "hace falta systemd para el servicio"
if [ "$DESKTOP" = 1 ]; then
  [ "$(id -u)" != 0 ] || die "con --desktop, ejecútalo con tu usuario, sin sudo: el servicio será de ese usuario y usará su pantalla"
  [ "$WITH_DISPLAY" = 0 ] || die "--desktop usa la pantalla del equipo: no hace falta --display (Xvfb)"
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || die "con --desktop, ejecútalo desde una terminal de la sesión gráfica (no hay DISPLAY ni WAYLAND_DISPLAY)"
  systemctl --user show-environment > /dev/null 2>&1 || die "no responde el systemd de tu usuario (systemctl --user)"
  # Lo que necesita root (paquetes), con sudo
  as_root() { sudo "$@"; }
  command -v sudo > /dev/null || die "con --desktop hace falta sudo para instalar los paquetes"
else
  [ "$(id -u)" = 0 ] || die "hay que ejecutarlo como root (en un LXC, desde su consola; si no, con sudo). En un PC con pantalla, usa --desktop con tu usuario"
  as_root() { "$@"; }
fi

export DEBIAN_FRONTEND=noninteractive

step "Paquetes base"
as_root apt-get update -q
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q curl ca-certificates gnupg fonts-liberation fonts-dejavu-core

step "Node 22"
if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2> /dev/null; then
  echo "Ya está: $(node --version)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash -
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
fi
NODE=$(command -v node)

step "Google Chrome"
if command -v google-chrome > /dev/null; then
  echo "Ya está: $(google-chrome --version)"
else
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  chmod 755 "$tmp" && chmod 644 "$tmp/chrome.deb"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$tmp/chrome.deb"
  rm -rf "$tmp"
fi
# Como el resto del banco, sin actualizaciones solas (CLAUDE.md, versiones de terceros): el panel de trabajadores
# muestra la versión de cada uno. Para actualizarlo: apt-mark unhold google-chrome-stable && apt-get install ...
as_root apt-mark hold google-chrome-stable > /dev/null
CHROME=$(command -v google-chrome)

if [ "$WITH_DISPLAY" = 1 ]; then
  step "Xvfb (pantalla virtual $SCREEN)"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q xvfb
fi

ARGS="--url $URL --name $NAME"
[ "$INSECURE" = 1 ] && ARGS="$ARGS --insecure"
[ "$NO_SANDBOX" = 1 ] && ARGS="$ARGS --no-sandbox"
[ -n "$PORT" ] && ARGS="$ARGS --port $PORT"
curl_flags=(-fsSL)
[ "$INSECURE" = 1 ] && curl_flags+=(-k)

if [ "$DESKTOP" = 1 ]; then
  DIR="$HOME/.local/share/moq-worker"
  UNIT_DIR="$HOME/.config/systemd/user"
  step "Script del trabajador, de $URL"
  mkdir -p "$DIR" "$UNIT_DIR"
  curl "${curl_flags[@]}" -o "$DIR/campaign-worker.mjs.part" "$URL/api/worker/campaign-worker.mjs"
  mv "$DIR/campaign-worker.mjs.part" "$DIR/campaign-worker.mjs"
  "$NODE" --check "$DIR/campaign-worker.mjs"
  [ ! -f /etc/systemd/system/moq-worker.service ] || echo "Aviso: también hay un trabajador como servicio del sistema (moq-worker); serían dos navegadores en este equipo."

  step "Servicio de tu usuario (systemctl --user)"
  # Arranca con la sesión gráfica y toma de ella DISPLAY / WAYLAND_DISPLAY: los entornos de escritorio los pasan al
  # systemd del usuario al iniciar sesión (GNOME y KDE lo hacen; en otros, puede hacer falta import-environment)
  cat > "$UNIT_DIR/moq-worker.service" << EOF
[Unit]
Description=Trabajador de campañas moq-dash ($NAME, $URL), en la pantalla de este equipo
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Environment=CHROME=$CHROME
ExecStart=$NODE $DIR/campaign-worker.mjs $ARGS
Restart=always
RestartSec=5
# El script cierra su Chrome al recibir SIGTERM; lo que quede lo cierra systemd con el resto del grupo
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=graphical-session.target
EOF
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY 2> /dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable moq-worker.service > /dev/null
  systemctl --user restart moq-worker.service

  step "Hecho"
  echo "Trabajador $NAME instalado contra $URL, en la pantalla de este equipo ($($CHROME --version), Node $($NODE --version))."
  echo "Arranca con tu sesión gráfica. Aparecerá en el panel Trabajadores de $URL/campaign en unos segundos."
  echo "Registro:  journalctl --user -u moq-worker -f"
  echo "Parar:     systemctl --user stop moq-worker     Quitar: systemctl --user disable --now moq-worker"
  exit 0
fi

step "Usuario $USER_NAME"
# Chrome no arranca como root sin --no-sandbox: el trabajador va con un usuario propio
if ! id "$USER_NAME" > /dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/moq-worker --shell /usr/sbin/nologin "$USER_NAME"
fi

step "Script del trabajador, de $URL"
install -d -m 755 "$DIR"
curl "${curl_flags[@]}" -o "$DIR/campaign-worker.mjs.part" "$URL/api/worker/campaign-worker.mjs"
mv "$DIR/campaign-worker.mjs.part" "$DIR/campaign-worker.mjs"
"$NODE" --check "$DIR/campaign-worker.mjs"

step "Servicios de systemd"
if [ "$WITH_DISPLAY" = 1 ]; then
  cat > /etc/systemd/system/moq-worker-xvfb.service << EOF
[Unit]
Description=Pantalla virtual del trabajador de campañas moq-dash ($SCREEN)

[Service]
User=$USER_NAME
# Xvfb crea su socket en /tmp/.X11-unix, que como usuario normal no puede crear (el + lo ejecuta como root)
ExecStartPre=+/bin/sh -c 'mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix'
ExecStart=$(command -v Xvfb) $XVFB_DISPLAY -screen 0 ${SCREEN}x24 -nolisten tcp
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  AFTER="network-online.target moq-worker-xvfb.service"
  REQUIRES="Requires=moq-worker-xvfb.service"
  ENV_DISPLAY="Environment=DISPLAY=$XVFB_DISPLAY"
else
  # Sin pantalla: si quedó de una instalación anterior con --display, se retira
  if [ -f /etc/systemd/system/moq-worker-xvfb.service ]; then
    systemctl disable --now moq-worker-xvfb.service 2> /dev/null || true
    rm -f /etc/systemd/system/moq-worker-xvfb.service
  fi
  AFTER="network-online.target"
  REQUIRES=""
  ENV_DISPLAY=""
fi

cat > /etc/systemd/system/moq-worker.service << EOF
[Unit]
Description=Trabajador de campañas moq-dash ($NAME, $URL)
Wants=network-online.target
After=$AFTER
$REQUIRES

[Service]
User=$USER_NAME
WorkingDirectory=/var/lib/moq-worker
Environment=CHROME=$CHROME
$ENV_DISPLAY
ExecStart=$NODE $DIR/campaign-worker.mjs $ARGS
Restart=always
RestartSec=5
# El script cierra su Chrome al recibir SIGTERM; lo que quede lo cierra systemd con el resto del grupo:
# un Chrome huérfano seguiría reproduciendo y compartiría la cola de emulación con las medidas (CLAUDE.md)
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
if [ "$WITH_DISPLAY" = 1 ]; then
  systemctl enable moq-worker-xvfb.service > /dev/null
  systemctl restart moq-worker-xvfb.service
fi
systemctl enable moq-worker.service > /dev/null
systemctl restart moq-worker.service

step "Hecho"
echo "Trabajador $NAME instalado contra $URL ($($CHROME --version), Node $($NODE --version)$([ "$WITH_DISPLAY" = 1 ] && echo ", pantalla $SCREEN"))."
echo "Aparecerá en el panel Trabajadores de $URL/campaign en unos segundos."
echo "Registro:  journalctl -u moq-worker -f"
echo "Parar:     systemctl stop moq-worker     Quitar: systemctl disable --now moq-worker"
