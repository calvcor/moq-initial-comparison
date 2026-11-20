# CLAUDE.md

Instrucciones para trabajar en este repositorio. El detalle técnico está en `README.md` y en `docs/` (en inglés):
despliegue, arquitectura, medida, campañas, emulación de red, adaptación y experimentos, limitaciones, API y, en
`docs/protocols/`, cómo funciona cada protocolo, con referencias del MPD, el catálogo de MoQ y MPEG-TS. Este fichero
recoge lo que no se deduce del código: cómo se trabaja aquí y qué errores no repetir.

## El proyecto

Banco de pruebas de una tesis doctoral (Carlos Alventosa, UPV) que compara la entrega de vídeo en
directo de baja latencia con **LL-DASH**, **Media over QUIC** y **WebRTC**. Una única fuente FFmpeg
codifica Big Buck Bunny 1080p60 y reparte el mismo flujo a las tres ramas; el navegador las reproduce a
la vez y mide la latencia leyendo un timecode quemado en la imagen. Se publicará como ciencia abierta: al
cerrar una versión, se publica solo esa instantánea en un repositorio nuevo.

## Idioma y estilo

- **Responde siempre en español.** Comentarios de código y mensajes de commit, también en español, con el tono de lo
  que ya hay. **La documentación (`README.md` y `docs/`) va en inglés.**
- Commits en español, con un título descriptivo ("DASH: umbral de búfer vacío configurable") y cuerpo
  explicando el porqué cuando no es obvio. Se suben directamente a `main`.
- La interfaz web es bilingüe (Ajustes → Idioma; docs/measurement.md): **todo texto visible nuevo va como
  `t('español', 'English')`** (`web/src/lib/i18n.ts`); igual las frases nuevas del análisis y las comparaciones del
  orquestador (`server/app/i18n.py`; el español no debe cambiar). Columnas del CSV, campos de la API y comentarios, sin traducir.

## Principios de medida (lo más importante)

1. **Se observa el protocolo; no se le hace funcionar bien.** Nunca modifiques el comportamiento de un
   reproductor, del relay o del publicador para mejorar los resultados (p. ej. un ABR propio para MoQ:
   se hizo y se revirtió). Se mide lo que hacen las implementaciones tal como vienen. Si hace falta
   aislar un mecanismo, es un experimento aparte y declarado, nunca el comportamiento por defecto.
2. **El medidor no debe alterar lo que mide.** Un lector de timecode que copiaba la imagen entera
   saturó el hilo principal y degradó MoQ, y todas las medidas tomadas con él quedaron invalidadas. Cualquier
   instrumentación nueva en el navegador debe ser barata y asíncrona. El tiempo parado de las primeras versiones no
   contaba los tramos sin imagen en el `<video>` e infravaloraba mucho a DASH con pérdidas: no se mezcla con el
   actual (el análisis lo avisa; las fechas de corte están en `server/app/compare.py`).
3. **No rellenes con valores supuestos.** Sin medida se muestra `--` y en el CSV queda vacío.
4. **Declara las variables de confusión** en vez de ocultarlas. La lista completa, mantenida, está en
   `docs/limitations.md`; cualquier factor nuevo se añade allí. Entre ellos: BBRv3 (relay) frente a CUBIC (DASH),
   WebRTC sin adaptación con `RTC_SERVER=mediamtx` y con la del SFU con mediasoup, con o sin el pacer de la ingesta
   (`rtc_pacing`), sin audio salvo con `rtc_audio`, sin codificador que atienda las peticiones de keyframe, qué
   reproductor tiene el sonido, bitrate del catálogo de MoQ (máximo medido) frente al del MPD (nominal), sliders de
   latencia que significan cosas distintas en cada rama, red del cliente, la estimación de caudal de dash.js (sigue al
   bitrate descargado sin límite de red, y la sobrestima con fragmentos de 1 frame), L2A (arranque y fallo de unidades;
   `l2afix` es el experimento corregido), el coste de leer el MPEG-TS (1, 2 y 3 frames; en DASH cae en el empaquetado
   CMAF), el jitter de netem que desordena (castiga casi solo a QUIC), Tears of Steel (24 fps), la cámara como fuente,
   las pruebas en paralelo que comparten servidor y el certificado del relay (autofirmado o Let's Encrypt).
5. **Distingue medida de deducción** al informar. Si algo sale del código y no de una prueba, dilo.

## Arquitectura en una línea por pieza

| Pieza | Dónde | Notas |
| :--- | :--- | :--- |
| Fuente FFmpeg | `server/app/main.py` (`ensure_master_source`), vídeos en `server/app/source.py` | Big Buck Bunny (60 fps) o Tears of Steel (24 fps, con bandas) en bucle, o cámara RTSP (`CAMERA_RTSP_URL` en el `.env`); una calidad o escalera de hasta 5; tee MPEG-TS a UDP 5001-5004 y, con la cámara, referencia para el VMAF en 5005 |
| Compuertas | `server/app/tsgate.py` | Arrancan en un IDR, vigilan continuidad y anotan horas por PTS |
| Origen LL-DASH | `server/app/origin.py` | En memoria; recalibra `availabilityStartTime` y reescribe `UTCTiming` al origen de la página |
| Publicador MoQ | `moq import ts` (moq-cli) en el orquestador | El **publicador**; no confundir con el relay |
| Relay MoQ | contenedor `moq-relay`, `relay/Dockerfile` | Solo reparte; el catálogo lo escribe el publicador. Imagen publicada o, con `MOQ_RELAY_FROM=git`, compilado desde `MOQ_RELAY_COMMIT` |
| WebRTC | `sfu/` (mediasoup) y `server/app/rtprelay.py`; o MediaMTX | `RTC_SERVER` en el `.env`. `mediasoup` (por defecto): FFmpeg pasa la escalera a RTP sin recodificar, el relay la junta en un socket y el SFU elige la capa. `mediamtx`: una sola calidad por WHEP; lee el MPEG-TS por UDP de la compuerta. La señalización de los dos (WebSocket o WHEP) va por el router, 8189/tcp |
| Router | `router/agent.py` (reenvío, tc y perfiles) y `router/api.py` (agente HTTP, contadores) | DNAT + tc/netem, una cola por protocolo y sentido, con 8 plazas por cliente (marca por IP) que solo usan las pruebas en paralelo (docs/network-emulation.md) |
| nginx-web | `nginx/web*.conf` | Página, API y huella del relay (80, y 443 con `SERVER_HOST`), sin pasar por el router. DASH no pasa por aquí |
| nginx-dash | `nginx/dash*.conf` | LL-DASH, solo a través del router: 8443 con TLS y `SERVER_HOST`; 8080 sin TLS en local |
| Certificado | `cert/entrypoint.sh` (contenedor `cert`, acme.sh) | Let's Encrypt para `SERVER_HOST` por reto DNS (`ACME_DNS`); lo usan los dos nginx, el relay y la señalización de WebRTC (SFU y MediaMTX). En local no hay: el relay usa uno autofirmado fijado por huella |
| Dashboard | `web/` (React + Vite) | Reproductores (cada uno se puede apagar; el CSV registra los activos en `players`), medidor, esquema de etapas, CSV |
| Campañas | `server/app/campaign.py`, `web/src/components/Campaign*.tsx`, `scripts/campaign-worker.mjs` | Baterías desatendidas; el servidor lleva red y emisión, el navegador (la página o Chrome headless con el script) es el trabajador (docs/campaigns.md). Con `workers` en el plan, un trabajador independiente por reproductor (`--name`), headless o en quiosco, con la ventana de la calidad más alta; con `parallel` y `worker_pool`, cada prueba toma uno libre y se miden a la vez las de la misma emisión, cada trabajador con su red en su propia cola del router (por IP: dos con la misma no van a la vez); sin ellos, un único trabajador. Cada prueba guarda su trabajador. Mientras corre, la API manual responde 409 |
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
- Contra un servidor por `https://<SERVER_HOST>` no hacen falta banderas. Por IP sin HTTPS:
  `--unsafely-treat-insecure-origin-as-secure=http://<IP>`. Las direcciones de los servidores, en `CLAUDE.local.md`.
- **Cierra cada Chrome headless por su PID y comprueba que no queda ninguno** (`pgrep -f <user-data-dir>`).
  Lanzado con `&` desde el shell de las herramientas, `kill %1` no lo cierra: una vez quedaron ocho reproduciendo
  durante una hora, contra el servidor y el local, compartiendo la cola de emulación con el usuario y con las medidas
  siguientes (todas invalidadas). Un navegador por pasada, o cierra la pestaña al terminar: un script que abre
  pestaña nueva cada vez deja la anterior reproduciendo. Antes de medir con límite de red, comprueba en
  `GET /api/status` que el contador del protocolo no sube.
- Los objetos `window.dashPlayer` y `window.moqPlayer` están expuestos para inspeccionar.
- Las cifras absolutas dependen de la red del cliente (Wi‑Fi o VPN meten ráfagas). Para comparar
  versiones o ajustes, alterna las variantes en la misma sesión y usa WebRTC como control.

## Servidores desplegados

- Los servidores concretos (direcciones, accesos, `.env`, versiones de cada uno) están en `CLAUDE.local.md`, que no
  se sube al repositorio. **Nada propio de los despliegues va en un fichero del repositorio**: ni nombres, IP, rutas o
  dominios, ni alias que solo entienda quien los conoce. Se escribe para alguien de fuera: se describe la configuración
  (versiones, recursos) en vez del servidor, y si hace falta una dirección, un ejemplo genérico (`testbed.example.org`).
- Dos modos (docs/deployment.md): local, sin `.env`, en `http://localhost`; y servidor, con `SERVER_HOST` (un nombre
  que resuelve al servidor), `ACME_DNS` y su token, en `https://<SERVER_HOST>`. No hay modo con proxy delante: los
  medios tienen que ir al propio servidor y con un solo nombre basta.
- Actualizar: `scripts/deploy.sh <ssh-destino>`. El servidor no tiene credenciales de GitHub; el script le manda un
  `git bundle`, avanza su checkout y reconstruye o reinicia **solo lo que haya cambiado** (siempre con `--no-deps`: sin
  él, Compose recrea también el orquestador). Se niega si hay una campaña en marcha. Los trabajadores de campañas recargan
  solos entre pruebas al ver otra `/build.json`; uno que no anuncia su construcción no lo hace y hay que reiniciarlo
  (docs/campaigns.md). Los cambios del `.env` no viajan con él: `docker compose up -d` en el servidor.
- **No despliegues mientras corre una campaña** (compruébalo en `GET /api/status`).
- Cualquier salida nueva de la fuente maestra comparte proceso con la escalera y puede frenarla: FFmpeg
  hace avanzar todas las salidas a la par. Mide el retraso del codificador (`POST /api/trace`) con y sin
  ella, alternando (la referencia de la cámara sin `-tune zerolatency` lo subía de 6 a ~80 ms).
- La configuración de la emisión se guarda en `media/stream-config.json` y sobrevive a los reinicios del orquestador
  (la última aplicada, también por una campaña). Normalmente el usuario usa una sola calidad:
  `{"gop_size":60,"fps":60,"seg_duration":2.0,"frag_duration":0.1,"renditions":[{"height":1080,"bitrate_kbps":4000}]}`.
  Comprueba siempre el estado con `GET /api/status` antes y después. **`POST /api/config` arranca la
  emisión**: si estaba parada, haz `POST /api/stop` justo después.
- Son servidores domésticos: **no dejes la emisión en marcha si el usuario la tenía detenida**
  (`POST /api/stop` para la fuente también). Sin permisos para subir prioridades (`renice` a 0 falla).
- La primera vez que se trae `sfu/` hay que construir el SFU y el router (`docker compose up -d --build --no-deps sfu router`). Cambiar `RTC_SERVER` después no reconstruye nada.
- Puertos, fijos: 80/tcp y 443/tcp (página, nginx-web), 8443/tcp (DASH con TLS, por el router; DASH no pasa nunca por nginx-web), 8080/tcp (DASH sin TLS: solo en local), 4433/udp (MoQ), 8189/udp (WebRTC), 8189/tcp (señalización de WebRTC: WebSocket de mediasoup o WHEP de MediaMTX, con TLS y el certificado de `SERVER_HOST`).
- `.env` del servidor (permisos 600, nunca en el repositorio; plantilla en `.env.template`). El certificado vive en
  `certs/` (`<SERVER_HOST>.crt` y `.key`, y el estado de acme.sh en `certs/acme/`) y lo renueva el contenedor `cert`;
  los dos nginx recargan cada 12 h. El SFU anuncia en ICE la IP a la que resuelve `SERVER_HOST` desde el contenedor
  (`SERVER_IP` la fuerza).

## Versiones de terceros

- Todo va fijado: relay y MediaMTX en `docker-compose.yml`, moq-cli en `server/Dockerfile`, librerías
  del navegador en `web/package-lock.json`. Nada se actualiza solo. Ojo: con `MOQ_WATCH_FROM=git` el lockfile
  se descarta al construir y mandan los rangos de `web/package.json`; por eso `dash.js` va con la versión exacta.
- moq-cli se puede compilar desde un commit con `MOQ_CLI_FROM=git` y `MOQ_CLI_COMMIT` en el `.env`
  (docs/measurement.md); el panel y el CSV lo muestran como `git@<commit>`. Compilar necesita varios GB de RAM.
  Igual `@moq/watch` y sus `@moq/*` con `MOQ_WATCH_FROM=git` y `MOQ_WATCH_COMMIT` (construir la web tarda unos
  2 min). Con `git`, `web/Dockerfile` aplica los parches de `web/patches/` (hoy, la opción `switching` del
  experimento de docs/adaptation-and-experiments.md, que por defecto no cambia nada) y la versión sale como
  `git@bc64b9c+switching`. Si se cambia el commit, hay que rehacer el parche: está hecho para ese y la construcción
  falla si no aplica.
- **Antes de dar por buena una actualización de moq-cli, mide la entrada del publicador con un
  espectador conectado.** La 0.14.4 acumula retraso sin parar y la 0.14.5 se queda atrás con un
  espectador; la 0.14.7 no tiene ese problema, pero no pasa de ~2 MB/s de entrada (ver abajo). Las medidas de cada
  versión están anotadas en `server/Dockerfile`. Al probar un commit nuevo de moq-cli, mira también que arranque
  (`restarts.moq` en `GET /api/status`): `ffcb7cd` rechazaba las variables `MOQ_*` del orquestador.
- **Hay dos combinaciones de moq en uso** (cuál tiene cada servidor, en `CLAUDE.local.md`): relay publicado con
  moq-cli y `@moq/watch` desde `bc64b9c`, y relay, moq-cli y `@moq/watch` compilados desde el mismo commit de `main`,
  `c19c723` (`.env`: `MOQ_RELAY_FROM=git`, los tres `*_COMMIT`, `MOQ_WATCH_BUN=1.4.4`, `MOQ_WATCH_PATCHES=0`). La API
  del reproductor cambia y `web/src/lib/moqApi.ts` traduce entre las dos versiones: cualquier cambio en `MoqPlayer.tsx`
  debe compilar con las dos (en local, la publicada de npm; para `c19c723`, construir la web con esos argumentos). Con
  `c19c723` no hay parche `switching` ni experimento de sondeo. Un commit nuevo de moq puede romper otra vez la
  construcción (lockfile, paquetes, opciones): pruébalo antes en un directorio aparte del servidor.
- La medida: `POST /api/trace` con marcas cada 4 ms de los últimos 20 s devuelve, por frame, la llegada
  a la compuerta (`encoded_ms`) y la entrega al empaquetador (`forwarded_ms`). Si los huecos en la
  entrega crecen y en la llegada no, el empaquetador no está leyendo su entrada.
- Cada cambio de versión se refleja en las tablas de versiones de `docs/measurement.md` y `docs/protocols/README.md`,
  y se anota con su fecha en `local/HISTORIA.md`.

## Documentación

- `README.md` (corto) y `docs/` describen **la herramienta tal como es ahora**, en inglés, para un lector de fuera:
  sin fechas, sin relato de desarrollo ("desde", "antes", "se cambió"), sin nombres de campañas ni de servidores.
  Mantenlos al día con cada cambio de comportamiento, parámetro o hallazgo; si una afirmación resulta falsa,
  corrígela y dilo. El código manda: si la documentación y el código no coinciden, comprueba el código.
- **Las fechas y la historia van solo en local**: `local/HISTORIA.md` (en `.gitignore`), por día, con el origen de cada
  entrada. `local/archivo-2026-11-20/` guarda la documentación anterior completa (README y PROTOCOLOS en español).
  Igual en los comentarios del código: el porqué sí, el cuándo no.
- Los hallazgos y decisiones razonadas van en documentos propios **fuera del repositorio**, en `../FINDINGS/` (por
  ejemplo, `moq_main_vs_releases.md`: por qué se usa `main` de moq), con un índice en `../FINDINGS/README.md` que hay
  que mantener. Un tema, un documento: si un hallazgo nuevo amplía uno existente, va en ese. Cada uno se entiende
  solo: nombre en snake_case, resumen al principio y dónde y cuándo se midió. **Desde el repositorio no se citan**
  (no se publican): la conclusión que necesite un usuario va resumida en `docs/` (normalmente en `docs/limitations.md`).
- En `README.md` y `docs/`, cada párrafo, elemento de lista o cita va en una sola línea, sin cortes manuales: algunos
  visores muestran esos cortes como saltos de línea.
- Nuevas métricas o parámetros: van al panel, al CSV (`SampleRow` en `web/src/types.ts`) y a su tabla en
  `docs/measurement.md` (o `docs/campaigns.md` si son de las campañas).

## Problemas abiertos conocidos

Su descripción para el lector está en `docs/limitations.md`; aquí, lo que importa al trabajar.

- mediasoup infraestima el enlace en la rama WebRTC y se queda en capas bajas: bloqueo de su controlador por pérdidas
  y sobreuso por las ráfagas de keyframes (`../FINDINGS/mediasoup_link_underestimation.md`). El resultado depende de
  la cola del router y del GOP: decláralos.
- El publicador de MoQ con `moq-cli` 0.14.x no pasa de ~2 MB/s de entrada (0,3 µs de CPU por byte, casi todo en el
  núcleo), igual con `import ts` que con `import avc3` y sin espectadores: cada keyframe (~100 kB) lo frena unos 50 ms
  y con la máquina cargada mucho más. Con la escalera de tres calidades se satura y causa la mayoría de las marcas
  `stalled` del catálogo y de los cambios de calidad. La 0.14.12 no lo resuelve; `main` (desde `bc64b9c`) sí
  (`../FINDINGS/moq_cli_publisher_ingest_limit.md`). Cuando salga una versión nueva, medirla con el procedimiento de
  arriba y, si se confirma, desplegarla.
- `@moq/watch` retiene su búfer como frames decodificados (~280 MB a 1080p con 1,5 s): trabajadores con 1 GB de RAM y
  512 MB de swap paginan al swap y el hilo principal se detiene, solo en MoQ y solo con 1080p y objetivos de 1,5 s o
  más (`../FINDINGS/moq_watch_decoded_frames_memory.md`). Esas pruebas de MoQ no son fiables; la solución es dar más
  memoria a los trabajadores, no invalidar por carga del hilo principal.
- La estimación de MoQ (`moq_bw_estimate_kbps`, la que usa `@moq/watch` para elegir) es `cwnd/RTT` de BBRv3 en el
  relay publicado (0.17.9 a 0.17.16): ~2 veces el enlace con retardo realista y decenas o cientos de veces con
  `delay_ms: 0` y el enlace holgado (`../FINDINGS/moq_relay_probe_cwnd_overestimate.md`). Con el relay de `main`
  (`c19c723`) es `max_bw` de BBR: con retardo base de 2,5 ms o más coincide con el enlace, y solo sin retardo y con el
  limitador `tbf` se infla (con `netem rate` no). Con MoQ de `main`, usa retardo base o declara que no lo hay; y declara
  el limitador (`net_down_shaper`, `net_up_shaper`).
- En WebRTC, el reparto del desglose entre "transporte" y "búfer" no es fiable (`receiveTime`).
- Con la escalera de tres calidades, la fuente se queda a ratos por detrás del tiempo real y los tres reproductores
  lo ven como menos latencia (no reproducido a voluntad). Se mide en cada segundo (`source_lag_ms`): revísalo antes de
  interpretar una latencia por debajo del objetivo.
- `scripts/l2a-units-experiment.mjs` no pasa `node --check` (comillas invertidas sin escapar en la línea 71).
