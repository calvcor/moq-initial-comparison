# CLAUDE.md

Instrucciones para trabajar en este repositorio. El detalle técnico está en `README.md` (puesta en
marcha, arquitectura, método de medida, API) y en `PROTOCOLOS.md` (cómo funciona cada protocolo, con
anexos sobre el MPD, el catálogo de MoQ, MPEG-TS y la medida de latencia). Este fichero recoge lo que
no se deduce del código: cómo se trabaja aquí y qué errores no repetir.

## El proyecto

Banco de pruebas de una tesis doctoral (Carlos Alventosa, UPV) que compara la entrega de vídeo en
directo de baja latencia con **LL-DASH**, **Media over QUIC** y **WebRTC**. Una única fuente FFmpeg
codifica Big Buck Bunny 1080p60 y reparte el mismo flujo a las tres ramas; el navegador las reproduce a
la vez y mide la latencia leyendo un timecode quemado en la imagen.

## Idioma y estilo

- **Responde siempre en español.** Comentarios de código, mensajes de commit y documentación, también
  en español, con el tono de lo que ya hay.
- Commits en español, con un título descriptivo ("DASH: umbral de búfer vacío configurable") y cuerpo
  explicando el porqué cuando no es obvio. Se suben directamente a `main`.
- La interfaz web es bilingüe (Ajustes → Idioma; README, 4.4c): **todo texto visible nuevo va como
  `t('español', 'English')`** (`web/src/lib/i18n.ts`); igual las frases nuevas del análisis y las comparaciones del
  orquestador (`server/app/i18n.py`; el español no debe cambiar). Columnas del CSV, campos de la API y comentarios, sin traducir.

## Principios de medida (lo más importante)

1. **Se observa el protocolo; no se le hace funcionar bien.** Nunca modifiques el comportamiento de un
   reproductor, del relay o del publicador para mejorar los resultados (p. ej. un ABR propio para MoQ:
   se hizo y se revirtió). Se mide lo que hacen las implementaciones tal como vienen. Si hace falta
   aislar un mecanismo, es un experimento aparte y declarado, nunca el comportamiento por defecto.
2. **El medidor no debe alterar lo que mide.** Un lector de timecode que copiaba la imagen entera
   saturó el hilo principal y degradó MoQ; todas las medidas anteriores al 9-10-2026 quedaron
   invalidadas. Cualquier instrumentación nueva en el navegador debe ser barata y asíncrona.
   El tiempo parado anterior al 28-10-2026 no contaba los tramos sin imagen en el `<video>` e infravaloraba
   mucho a DASH con pérdidas (README, tabla de métricas): no se mezcla con el posterior.
3. **No rellenes con valores supuestos.** Sin medida se muestra `--` y en el CSV queda vacío.
4. **Declara las variables de confusión** en vez de ocultarlas: BBRv3 (relay) frente a CUBIC (DASH),
   WebRTC sin adaptación con `RTC_SERVER=mediamtx` y con adaptación del SFU, de aplicación propia e ingesta RTP, con mediasoup (README, 3.4c), con o sin el pacer de la ingesta (`rtc_pacing`, experimento declarado: retrasa las keyframes), sin audio salvo con `rtc_audio` (el vídeo se sincroniza con el búfer del audio: poco con el bucle,
   100-200 ms más con la cámara) y sin
   codificador que atienda sus peticiones de keyframe, qué reproductor tiene el sonido (MoQ solo baja el
   audio con él), bitrate del catálogo de MoQ (máximo medido) frente al del MPD
   (nominal), sliders de latencia que significan cosas distintas en cada rama, red del cliente, que sin límite de red la
   estimación de caudal de dash.js sigue al bitrate descargado y no a la red (README, sección 6), que con fragmentos
   CMAF de 1 frame la sobrestima también con límite (1,6-2 veces el enlace) y que L2A no sale de su arranque con
   objetivos de menos de 1,5 s y en su fase estable tiene un fallo de unidades en dash.js 5 (README, sección 6; la opción L2A (bugfix), `l2afix`, es el
   experimento con ese fallo corregido), que leer el MPEG-TS retiene 1 frame en MediaMTX, 2 en el publicador de MoQ y 3 en FFmpeg, y solo en DASH cae en la etapa de entrada (PROTOCOLOS, 6.4), y que
   el jitter de netem desordena los paquetes (castiga casi solo a QUIC: README, sección 5), con Tears of Steel, que cambian a la vez contenido y cadencia (24 fps: frames de 41,7 ms; README, 3.1a), y con la
   cámara como fuente, que el contenido no se repite y la latencia no incluye el tramo cámara → servidor, que las pruebas en paralelo comparten servidor (relay, SFU, publicador y CPU) aunque cada una tenga su cola en el router, y si el relay usa certificado autofirmado con huella o uno de Let's Encrypt (`docker-compose.tls.yml`; README, sección 1).
5. **Distingue medida de deducción** al informar. Si algo sale del código y no de una prueba, dilo.

## Arquitectura en una línea por pieza

| Pieza | Dónde | Notas |
| :--- | :--- | :--- |
| Fuente FFmpeg | `server/app/main.py` (`ensure_master_source`), vídeos en `server/app/source.py` | Big Buck Bunny (60 fps) o Tears of Steel (24 fps, con bandas; README, 3.1a) en bucle, o cámara RTSP (`CAMERA_RTSP_URL` en el `.env`); una calidad o escalera de hasta 5; tee MPEG-TS a UDP 5001-5004 y, con la cámara, referencia para el VMAF en 5005 |
| Compuertas | `server/app/tsgate.py` | Arrancan en un IDR, vigilan continuidad y anotan horas por PTS |
| Origen LL-DASH | `server/app/origin.py` | En memoria; recalibra `availabilityStartTime` y reescribe `UTCTiming` al origen de la página |
| Publicador MoQ | `moq import ts` (moq-cli) en el orquestador | El **publicador**; no confundir con el relay |
| Relay MoQ | contenedor `moq-relay`, `relay/Dockerfile` | Solo reparte; el catálogo lo escribe el publicador. Imagen publicada o, con `MOQ_RELAY_FROM=git`, compilado desde `MOQ_RELAY_COMMIT` |
| WebRTC | `sfu/` (mediasoup) y `server/app/rtprelay.py`; o MediaMTX | `RTC_SERVER` en el `.env`. `mediasoup` (por defecto): FFmpeg pasa la escalera a RTP sin recodificar, el relay la junta en un socket y el SFU elige la capa (README, 3.4c). `mediamtx` (versión anterior): una sola calidad por WHEP; lee el MPEG-TS por UDP de la compuerta, y `RTC_INGEST=rtsp` vuelve al FFmpeg + RTSP (README, 3.4b) |
| Router | `router/agent.py` (reenvío, tc y perfiles) y `router/api.py` (agente HTTP, contadores) | DNAT + tc/netem, una cola por protocolo y sentido, con 8 plazas por cliente (marca por IP) que solo usan las pruebas en paralelo (README, sección 5) |
| Entrada HTTP | `edge/nginx.conf` | Único puerto HTTP (80): página, API y huella del relay. DASH no pasa por aquí desde el 12-11-2026: va directo al router (8443 con `DASH_HOST`, 8080 sin él) |
| Dashboard | `web/` (React + Vite) | Reproductores (cada uno se puede apagar; el CSV registra los activos en `players`), medidor, esquema de etapas, CSV |
| Campañas | `server/app/campaign.py`, `web/src/components/Campaign*.tsx`, `scripts/campaign-worker.mjs` | Baterías desatendidas; el servidor lleva red y emisión, el navegador (la página o Chrome headless con el script) es el trabajador (README, 4.8). Con `workers` en el plan, un trabajador independiente por reproductor (`--name`), headless o en quiosco, con la ventana de la calidad más alta (README 4.8, trabajadores independientes); con `parallel` y `worker_pool`, cada prueba toma uno libre y se miden a la vez las de la misma emisión, cada trabajador con su red en su propia cola del router (por IP: dos con la misma no van a la vez); sin ellos, todo como antes. Cada prueba guarda su trabajador. Mientras corre, la API manual responde 409 |
| Versiones | `server/app/versions.py`, `web/src/components/VersionsPanel.tsx` | Instalado frente a última publicada |

## Desarrollo local

- `docker compose up -d --build` levanta todo en `http://localhost`. El vídeo fuente se descarga solo
  la primera vez en `media/` (no se sube al repositorio).
- Tras cambiar `server/app/*.py`: `docker compose restart orchestrator` (está montado, sin recarga
  automática). Tras cambiar `web/`: reconstruir la imagen `web`.
- Comprobaciones: `cd web && npx tsc -b`; `python3 -m py_compile` para el servidor.

## Verificar en el navegador

- **No uses el panel de navegador integrado para medir**: está oculto, el vídeo se pausa y
  `requestAnimationFrame` va estrangulado.
- Usa Chrome headless por CDP desde un script de Node (Node 22 tiene `WebSocket` global):
  `--headless=new --use-angle=metal --enable-gpu --ignore-gpu-blocklist --autoplay-policy=no-user-gesture-required`,
  con un `--user-data-dir` desechable. Abre la pestaña con `about:blank` y navega después con
  `Page.navigate` (abrir directamente la URL en `/json/new` ha dado pestañas sin el reproductor MoQ).
- Contra el servidor, por NPM (`https://moq-dash.mininet.duckdns.org`) no hacen falta banderas. Por IP
  sin HTTPS: `--unsafely-treat-insecure-origin-as-secure=http://10.20.40.90`.
- **Cierra cada Chrome headless por su PID y comprueba que no queda ninguno** (`pgrep -f <user-data-dir>`).
  Lanzado con `&` desde el shell de las herramientas, `kill %1` no lo cierra: el 23-10-2026 quedaron
  ocho reproduciendo durante una hora, contra el servidor y el local, compartiendo la cola de emulación
  con el usuario y con las medidas siguientes (todas invalidadas). Un navegador por pasada, o cierra la
  pestaña al terminar: un script que abre pestaña nueva cada vez deja la anterior reproduciendo. Antes
  de medir con límite de red, comprueba en `GET /api/status` que el contador del protocolo no sube.
- Los objetos `window.dashPlayer` y `window.moqPlayer` están expuestos para inspeccionar.
- Las cifras absolutas dependen de la red del cliente (Wi‑Fi o VPN meten ráfagas). Para comparar
  versiones o ajustes, alterna las variantes en la misma sesión y usa WebRTC como control.

## Servidor desplegado

- `root@10.20.40.90` (LXC `phd-testing`, 8 vCPU), checkout en `/opt/moq-dash-initial-comparison`,
  accesible por SSH con clave desde el Mac del usuario (red local o VPN WireGuard).
- Actualizar: el servidor no tiene credenciales de GitHub, así que `git pull` falla; el código llega con un
  `git bundle` copiado por scp (`git pull --ff-only /tmp/x.bundle main`). Después, reconstruir **solo lo que haya cambiado**:
  - web: `docker compose up -d --build --no-deps web` (**sin `--no-deps` también recrea el
    orquestador**). Los trabajadores de campañas recargan solos entre pruebas al ver otra `/build.json`, y el
    orquestador no les da pruebas mientras tanto; uno cargado antes del 6-11-2026 no lo hace y hay que reiniciarlo
    (README 4.8, «La web, al día»: hasta entonces medían días con un bundle viejo);
  - orquestador: `docker compose up -d --build --no-deps orchestrator`.
- Cualquier salida nueva de la fuente maestra comparte proceso con la escalera y puede frenarla: FFmpeg
  hace avanzar todas las salidas a la par. Mide el retraso del codificador (`POST /api/trace`) con y sin
  ella, alternando (la referencia de la cámara sin `-tune zerolatency` lo subía de 6 a ~80 ms).
- **Reiniciar el orquestador pierde la configuración de la emisión**: vuelve a la escalera por defecto
  de tres calidades. Restáurala después con `POST /api/config` (normalmente el usuario usa una sola
  calidad: `{"gop_size":60,"fps":60,"seg_duration":2.0,"frag_duration":0.1,"renditions":[{"height":1080,"bitrate_kbps":4000}]}`).
  Comprueba siempre el estado con `GET /api/status` antes y después. **`POST /api/config` arranca la
  emisión**: si estaba parada, haz `POST /api/stop` justo después (la configuración se queda en memoria).
- Es un servidor doméstico: **no dejes la emisión en marcha si el usuario la tenía detenida**
  (`POST /api/stop` para la fuente también). Sin permisos para subir prioridades (`renice` a 0 falla).
- Tras traer `sfu/`, la primera vez hay que construir el SFU y el router (`docker compose up -d --build --no-deps sfu router`). Cambiar `RTC_SERVER` después no reconstruye nada (README, 3.4c).
- Puertos: 80/tcp (página por NPM), 8443/tcp (DASH directo; DASH no pasa nunca por NPM ni por el punto de entrada), 8080/tcp (DASH directo sin TLS: solo sin `DASH_HOST` y desde páginas HTTP), 4433/udp (MoQ), 8189/udp (WebRTC), 8189/tcp (señalización WebSocket de mediasoup, con `wss://` y el certificado de `DASH_HOST`).
- `.env` del servidor (permisos 600, nunca en el repositorio): `MOQ_HOST`, `DASH_HOST`
  (`phd-testing.duckdns.org`), `DUCKDNS_TOKEN`. El certificado de DASH vive en `certs/dash/` y lo
  renueva `dash-cert` (acme.sh, sin correo). Si se borra esa carpeta, reinicia `nginx-dash`.
- Sin acceso a Nginx Proxy Manager (10.20.40.7) ni al anfitrión Proxmox.

## Versiones de terceros

- Todo va fijado: relay y MediaMTX en `docker-compose.yml`, moq-cli en `server/Dockerfile`, librerías
  del navegador en `web/package-lock.json`. Nada se actualiza solo. Ojo: con `MOQ_WATCH_FROM=git` el lockfile
  se descarta al construir y mandan los rangos de `web/package.json`; por eso `dash.js` va con la versión exacta.
- moq-cli se puede compilar desde un commit con `MOQ_CLI_FROM=git` y `MOQ_CLI_COMMIT` en el `.env`
  (README, 4.4b); el panel y el CSV lo muestran como `git@<commit>`. Compilar necesita varios GB de RAM.
  Igual `@moq/watch` y sus `@moq/*` con `MOQ_WATCH_FROM=git` y `MOQ_WATCH_COMMIT`; desde el 22-10-2026,
  también en el servidor (`git@bc64b9c`, construir la web tarda unos 2 min). Con `git`, `web/Dockerfile`
  aplica los parches de `web/patches/` (hoy, la opción `switching` del experimento de README 6.1, que por
  defecto no cambia nada) y la versión sale como `git@bc64b9c+switching`. Si se cambia el commit, hay que
  rehacer el parche: está hecho para ese y la construcción falla si no aplica.
- **Antes de dar por buena una actualización de moq-cli, mide la entrada del publicador con un
  espectador conectado.** La 0.14.4 acumula retraso sin parar y la 0.14.5 se queda atrás con un
  espectador; la 0.14.7 (desplegada del 19 al 21-10-2026) no tiene ese problema. Desde el 21-10-2026 el
  servidor usa moq-cli compilado desde `main` (`git@bc64b9c`, `MOQ_CLI_FROM=git` en su `.env`). La versión desplegada y
  sus medidas están anotadas en `server/Dockerfile`. Del 4 al 5-11-2026 el servidor estuvo en prueba en la rama
  `ultimas-versiones` (relay 0.17.12, `@moq/watch` 0.6.6 y dash.js 5.3.0 publicados, moq-cli `git@ffcb7cd`); el
  5-11-2026 volvió a `main` con las versiones de antes, las mismas que el segundo servidor (`/root/antes-ultimas/`
  guarda los dos `.env` y las imágenes). Al probar un commit nuevo de moq-cli, mira también que arranque
  (`restarts.moq` en `GET /api/status`): `ffcb7cd` rechazaba las variables `MOQ_*` del orquestador.
- **Desde el 18-11-2026 justbytes usa relay, moq-cli y `@moq/watch` compilados desde el mismo commit de `main`, `c19c723`**
  (su `.env`: `MOQ_RELAY_FROM=git`, los tres `*_COMMIT`, `MOQ_WATCH_BUN=1.4.4`, `MOQ_WATCH_PATCHES=0`; el `.env` anterior y
  las imágenes, en `/root/antes-main/` y con la etiqueta `antes-main`). phd-testing sigue igual. La API del reproductor
  cambia y `web/src/lib/moqApi.ts` traduce entre las dos versiones: cualquier cambio en `MoqPlayer.tsx` debe compilar con
  las dos (en local, la publicada de npm; para `c19c723`, construir la web con esos argumentos). Con `c19c723` no hay
  parche `switching` ni experimento de sondeo (README, 4.4b, 6.1 y 6.3). Un commit nuevo de moq puede romper otra vez la
  construcción (lockfile, paquetes, opciones): pruébalo antes en un directorio aparte del servidor.
- La medida: `POST /api/trace` con marcas cada 4 ms de los últimos 20 s devuelve, por frame, la llegada
  a la compuerta (`encoded_ms`) y la entrega al empaquetador (`forwarded_ms`). Si los huecos en la
  entrega crecen y en la llegada no, el empaquetador no está leyendo su entrada.
- Cada cambio de versión se anota en la nota de versiones del principio de `PROTOCOLOS.md`.

## Documentación

- Mantén actualizados `README.md` y `PROTOCOLOS.md` con cada cambio de comportamiento, parámetro o
  hallazgo. Si una afirmación de `PROTOCOLOS.md` resulta falsa, corrígela y dilo.
- `CONTEXT_SUMMARY.md` es un resumen histórico; no hace falta reescribirlo con cada cambio.
- Los hallazgos y decisiones razonadas van en documentos propios **fuera del repositorio**, en `../FINDINGS/` (por ejemplo, `moq_main_vs_releases.md`: por qué se usa `main` de moq), con un índice en `../FINDINGS/README.md` que hay que mantener. Un tema, un documento: si un hallazgo nuevo amplía uno existente, va en ese. Cada uno se entiende solo: nombre en snake_case, resumen al principio y dónde y cuándo se midió. Desde el repositorio se citan como `../FINDINGS/<fichero>`.
- En `README.md` y `PROTOCOLOS.md`, cada párrafo, elemento de lista o cita va en una sola línea, sin cortes
  manuales: algunos visores muestran esos cortes como saltos de línea.
- Nuevas métricas o parámetros: van al panel, al CSV (`SampleRow` en `web/src/types.ts`) y a la tabla
  correspondiente del README.

## Problemas abiertos conocidos

- mediasoup infraestima el enlace en la rama WebRTC y se queda en capas bajas: bloqueo de su controlador por pérdidas y sobreuso por las ráfagas de keyframes (`../FINDINGS/mediasoup_link_underestimation.md`). El resultado depende de la cola del router y del GOP: decláralos. Desde el 3-11-2026 la señalización va por WebSocket y la sesión se cierra con la conexión (antes, al recargar, la anterior seguía enviando ~29 s).

- El publicador de MoQ deja de leer su entrada a ratos con varias calidades (picos de hasta 1-2 s, con
  0.14.3 y con 0.14.7). Provoca las marcas `stalled` del catálogo y los cambios continuos de calidad
  con varias calidades. Localizado en parte (21-10-2026): `moq-cli` 0.14.7 no pasa de ~2 MB/s de
  entrada (0,3 µs de CPU por byte, casi todo en el núcleo), igual con `import ts` que con `import avc3`
  y sin espectadores, así que cada keyframe (~100 kB) lo frena unos 50 ms y con la máquina cargada
  mucho más. Con una calidad hay un hueco por grupo (45 ms en local, hasta 665 ms en el servidor).
  Con la escalera de tres calidades se satura (espera p95 de 0,6-0,7 s en local) y es la causa de la
  mayoría de las marcas `stalled` y de los cambios de calidad: con la mitad de bitrate caen dos tercios
  (PROTOCOLOS, final de 4.10).
  Dentro de `moq-cli` no se ha llegado a la función: el binario no trae símbolos. **La rama principal
  de moq ya no lo tiene** (commit `bc64b9c`, 21-10-2026: 200-730 MB/s, sin cambios de calidad con la
  escalera); cuando salga una versión nueva de `moq-cli`, medirla con el procedimiento de arriba y,
  si se confirma, desplegarla. La 0.14.12 (3-11-2026) **no lo resuelve** con la escalera: medida el 4-11-2026
  en el servidor; `main` en `ffcb7cd` sí (`../FINDINGS/moq_cli_publisher_ingest_limit.md`, fuera del repositorio).
- `@moq/watch` retiene su búfer como frames decodificados (~280 MB a 1080p con 1,5 s): los trabajadores LXC de justbytes
  (1 GB de RAM y 512 MB de swap) paginan al swap y el hilo principal se detiene, solo en MoQ y solo con 1080p y objetivos de
  1,5 s o más (8-11-2026, reproducido en local con esos límites; `../FINDINGS/moq_watch_decoded_frames_memory.md`). Esas
  pruebas de MoQ no son fiables; la solución es dar más memoria a los trabajadores, no invalidar por carga del hilo principal.
- La estimación de MoQ (`moq_bw_estimate_kbps`, la que usa `@moq/watch` para elegir) es `cwnd/RTT` de BBRv3 en el relay publicado
  (0.17.9 a 0.17.16): ~2 veces el enlace con retardo realista y decenas o cientos de veces con `delay_ms: 0` y el enlace holgado,
  así que elige 1080p donde no cabe. Viene del relay, no de cómo lo usamos; `main` de moq-dev ya usa la estimación de BBR
  (`../FINDINGS/moq_relay_probe_cwnd_overestimate.md`). Declara el retardo base de la red en cada comparación. Con el relay
  de `main` (justbytes, `c19c723`) la cifra es `max_bw` de BBR: con retardo base de 2,5 ms o más coincide con el enlace,
  y solo sin retardo se infla (3 veces el enlace a 2 Mbit/s, con calidades elegidas que nunca se pintan,
  `moq_selected_height` ≠ `moq_height`): el limitador `tbf` del router deja pasar sin esperar un paquete suelto tras un rato
  ocioso y, con el RTT mínimo de BBR en 0,1 ms, su filtro no descarta esa muestra (medido dentro del relay el 19-11-2026,
  sección 6 de ese documento). Con `ROUTER_SHAPER=netem` (limitador experimental, `netem rate`; README, sección 5) tampoco
  se infla sin retardo. Con MoQ de `main`, usa retardo base o declara que no lo hay; y declara el limitador (`net_shaper`).
- En WebRTC, el reparto del desglose entre "transporte" y "búfer" no es fiable (`receiveTime`).
- La configuración de la emisión no persiste entre reinicios del orquestador.
- Con la escalera de tres calidades, la fuente del servidor se queda a ratos por detrás del tiempo real y los
  tres reproductores lo ven como menos latencia (campaña del 29-10-2026; no reproducido a voluntad el 30-10-2026).
  Desde el 30-10-2026 se mide en cada segundo (`source_lag_ms`, README, tabla de métricas): revísalo antes de
  interpretar una latencia por debajo del objetivo.
