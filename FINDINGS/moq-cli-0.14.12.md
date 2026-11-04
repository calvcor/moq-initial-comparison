# moq-cli 0.14.12: el publicador publicado sigue sin dar abasto con varias calidades

El 4 de noviembre de 2026 se probó el servidor con las últimas versiones publicadas de todo: relay 0.17.12, publicador `moq-cli` 0.14.12 (ambos del 3-11-2026), `@moq/watch` 0.6.6 y dash.js 5.3.0. Con una calidad, el publicador de MoQ va bien. Con la escalera de tres calidades no da abasto: sin espectadores ya hace esperar a los frames cientos de milisegundos en su entrada, y con un espectador se queda segundos atrás, pierde paquetes y entrega una tercera parte de los frames. Es el mismo cuello de botella de la 0.14.7 descrito en [moq-versiones-main.md](moq-versiones-main.md), que `main` no tiene. Con esta versión, una medida de MoQ con varias calidades mide sobre todo ese límite del publicador y no el protocolo.

## Qué se probó y cómo

| Pieza | Antes (en uso) | En la prueba |
| :--- | :--- | :--- |
| Publicador (`moq-cli`) | `git@bc64b9c` (`main`) | 0.14.12 publicada (`MOQ_CLI_FROM=release`, `MOQ_CLI_VERSION=0.14.12`) |
| Relay | 0.17.9 | 0.17.12 (`MOQ_RELAY_VERSION`) |
| Reproductor (`@moq/watch`) | `git@bc64b9c+switching` | 0.6.6 publicada (`MOQ_WATCH_FROM=release`, rama `ultimas-versiones`) |
| dash.js | 5.2.1 | 5.3.0 (rama `ultimas-versiones`) |
| MediaMTX, mediasoup, mediasoup-client | 1.21.3, 3.32.1, 3.26.0 | Las mismas (ya eran las últimas) |

En el servidor (`phd-testing`), con Big Buck Bunny en bucle, GOP de 60, 60 fps y sin límite de red. Espectador: Chrome headless desde el Mac del usuario por NPM, con los tres reproductores a la vez. La entrada del publicador se mide con `POST /api/trace` sobre los últimos 21 s (marcas cada 4 ms): por frame, la llegada a la compuerta de MoQ (`encoded_ms`) y su entrega al publicador (`forwarded_ms`). La diferencia es lo que el frame espera porque el publicador no lee su entrada. DASH se lee de la misma fuente a la vez y hace de control.

Antes de nada se comprobó que la 0.14.12 acepta la misma línea de órdenes que usa el orquestador (`--connect … --connect-tls-insecure --broadcast live.hang import ts`): su interfaz cambió bastante, pero esas opciones siguen.

## Resultados

Espera de cada frame en la entrada del publicador, calidad más alta (las otras dan lo mismo). En 21 s deberían entregarse unos 1.200 frames por calidad.

| Escenario | Frames entregados en 21 s | Espera p50 | Espera p95 | Espera máxima | DASH, p95 / máx. |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Una calidad (1080p, 4 Mbit/s), sin espectador | 1.157 | 0 ms | 2 ms | 70 ms | 1 / 10 ms |
| Una calidad, con espectador, a los 30 s | 1.201 | 0 ms | 3 ms | 90 ms | 1 / 7 ms |
| Una calidad, con espectador, a los 55 s | 1.200 | 0 ms | 2 ms | 63 ms | 1 / 9 ms |
| Escalera 4000/2000/700, sin espectador | 1.158 | 22 ms | 422 ms | 539 ms | 2 / 14 ms |
| Escalera, con espectador, a los 30 s | 385 | 4,8 s | 9,7 s | 10,5 s | 3 / 29 ms |
| Escalera, con espectador, a los 60 s | 445 | 6,4 s | 8,2 s | 8,3 s | 3 / 13 ms |
| Escalera, primera pasada, justo al cerrar el espectador | 41-50 | 17-19 s | 19 s | 19,5 s | 3-5 / 10-16 ms |

Además, con la escalera y el espectador:

- El registro del publicador (`/tmp/ffmpeg_moq.log` en el orquestador) se llena de `continuity check failed` en todos los PID (vídeo, PAT, PMT): le faltan paquetes TS. Con una calidad, ninguno. Es deducción, no medida, que los paquetes se pierdan en la cola UDP de la compuerta, que se desborda mientras el publicador no lee.
- En el reproductor de MoQ, el lienzo pasó por 1080p, 720p y 360p en muestras consecutivas cada 5 s durante los 50 s de la primera pasada. DASH y WebRTC reprodujeron con normalidad.

Con una calidad, la espera máxima (63-90 ms) es la del keyframe y queda muy por debajo de los 665 ms de la 0.14.7 en el servidor. Pero ese dato de la 0.14.7 es de otro día y otra carga, no de una pasada alternada.

## Por qué: la 0.14.12 no viene de `main`

Según el historial de GitHub (medido con su API de comparación, no deducido):

- La etiqueta `moq-cli-v0.14.12` sale de la rama `release` de moq (a un commit de su punta del 3-11-2026), no de `main`.
- `release` se separó de `main` el 10-10-2026 (commit `d0b086e`) y desde entonces recibe retroportes: de la 0.14.7 a la 0.14.12 hay 123 commits.
- El commit `bc64b9c` de `main` que usa el servidor es del 21-10-2026, posterior a esa separación. Las notas de la 0.14.12 solo citan tres cambios: la propia publicación, la ocultación de credenciales en los diagnósticos y un banco de pruebas retroportado.

Así que es esperable que la 0.14.12 no traiga la corrección del rendimiento de entrada que tiene `main`. Esto último es deducción: no se ha buscado qué commit concreto de `main` lo corrige ni se ha comprobado que no se haya retroportado. Las medidas dicen lo mismo: la 0.14.12 se comporta como la 0.14.7 o peor.

## Qué no se ha medido

- **No se alternó con `git@bc64b9c` en la misma sesión.** La comparación con `main` es contra sus medidas del 21-10-2026 ([moq-versiones-main.md](moq-versiones-main.md)), con otra escalera (2000/1000/350 en el servidor, frente a 4000/2000/700 aquí). Para afirmar que la 0.14.12 es peor que la 0.14.7, y no solo igual de mala, habría que alternar ambas con la misma escalera.
- **No se aisló el relay.** Relay y publicador cambiaron a la vez (0.17.9 → 0.17.12). Que el problema esté en el publicador lo indica `forwarded_ms`, que mide la lectura de su entrada antes de que nada llegue al relay. Pero un relay que reciba más despacio podría frenar al publicador por contrapresión, y eso no se ha descartado alternando relays.
- **No se midió la latencia de MoQ ni los congelados** con el medidor del dashboard: solo la entrada del publicador y si cada reproductor avanzaba.
- Una sola pasada por escenario, de 20-75 s.

## Qué implica

- Con estas versiones publicadas, **MoQ solo es medible con una calidad**. Con la escalera, lo que se mida de MoQ (latencia, cambios de calidad, congelados) estará dominado por la cola del publicador, que no es del protocolo. Si se mide así de todos modos, hay que declararlo y separar esas medidas en el CSV por `moq_cli`.
- La decisión de [moq-versiones-main.md](moq-versiones-main.md) sigue en pie: mientras la versión publicada no traiga la corrección de `main`, el servidor debería usar `main` para el publicador.
- Cuando salga una versión nueva de `moq-cli`, la prueba rápida es la de este documento: la escalera de tres calidades con un espectador y `POST /api/trace` a los 30 y 60 s. Si los frames entregados no llegan a ~1.200 en 21 s o la espera p95 pasa de unos pocos ms, tiene el mismo problema.

## Cómo volver a lo de antes en el servidor

Antes de la prueba se guardó en `/root/antes-ultimas/` el `.env`, la configuración de la emisión y las imágenes del orquestador y de la web (etiqueta `:antes-ultimas`). Los pasos están en `/root/antes-ultimas/VOLVER.md`: restaurar el `.env`, `git checkout main`, volver a las imágenes etiquetadas y recrear relay, orquestador y web, sin recompilar. El servidor no tiene credenciales de GitHub: el código le llega con `git push` por SSH desde el Mac.
