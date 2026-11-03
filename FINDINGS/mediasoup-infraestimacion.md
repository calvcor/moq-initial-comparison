# Por qué mediasoup infrautiliza el enlace en el banco de pruebas

Con la rama WebRTC en `RTC_SERVER=mediasoup`, a 8 o 5 Mbit/s de bajada mediasoup se queda casi siempre en 360p (unos 790 kbit/s), aunque 1080p (unos 4,4 Mbit/s) cabe. Es una infraestimación del ancho de banda, y tiene dos causas distintas que se suman. Investigado el 2-11-2026, en local (Mac), con mediasoup 3.32.1 y la escalera 1080p@4000, 720p@2000 y 360p@700.

## Resumen

| Causa | Qué pasa | Cómo se sabe |
| :--- | :--- | :--- |
| **1. Bloqueo tras una pérdida** | En el estado "limitado por pérdidas", la estimación solo sube hasta 1,5 × lo confirmado (1,2 × si está en espera). Lo confirmado es bajo porque la propia estimación deja a mediasoup en una capa baja, así que no sale de ahí | Medido: quitar ese tope, solo en laboratorio, multiplica el envío por tres |
| **2. Sobreuso por las ráfagas de keyframes** | Sin ninguna pérdida, el estimador por retardo detecta sobreuso unas 80 veces en 2 min y se queda muy por debajo del enlace | Medido en parte: un GOP de 4 s lo reduce, pero no lo elimina. Lo que queda está sin explicar |

Las pérdidas que disparan la causa 1 vienen de las ráfagas, y esto está medido paquete a paquete. Se capturó en el router a la entrada y a la salida de la cola (`tcpdump` en `eth0`, `-Q in` y `-Q out`, una pasada de 90 s a 8 Mbit/s y 100 ms; la cabecera RTP va en claro) y se cruzó por SSRC y número de secuencia:

- Se pierden 558 de 32 564 paquetes (1,7 %): 557 de vídeo, en solo 21 frames, y 1 de sondeo. Retransmisiones, ninguno.
- Los 21 frames son grandes, de 27 a 126 paquetes, y 20 de ellos llegan en el mismo punto de cada segundo, el compás del GOP: son keyframes. Es deducción por tamaño y periodo, porque el contenido va cifrado. Ningún frame normal (mediana de 5 paquetes) pierde nada.
- Cada uno de esos frames llega al router en menos de 1 ms, tal como lo reenvía mediasoup, sin ritmo de envío.
- Cuando el frame va solo, sobreviven unos 69 paquetes, los 67 de la cola más lo poco que sale en ese tiempo: por ejemplo, 126 entran y se pierden 57, 119 y 50, 116 y 50.

Son mayores de lo que daba una grabación anterior: hasta 157 kB y 126 paquetes entre los que perdieron algo, frente a un máximo de 93 kB en aquella.

### Las otras ramas, con el mismo enlace

Una pasada de 60 s por rama, tras 30 s de calentamiento, con un solo reproductor activo, la escalera de tres calidades y 8 Mbit/s con cola de 100 ms (67 paquetes), el 3-11-2026 en local. Se capturó a la entrada y la salida de la cola de bajada de cada protocolo y se leyeron sus descartes de `tc` cada 50 ms. La "tanda" son paquetes que entran con menos de 1 ms de separación.

| Rama | Calidad | Entrada | Descartes | Mayor tanda | Pico en 10 ms | Mayor descarte de una vez |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| LL-DASH (TCP, CUBIC) | 1080p | 4328 kbit/s | 8 (0,03 %) | 95 kB en 0,2 ms | 83 Mbit/s | 1 paquete |
| MoQ (QUIC, BBRv3) | 720p y 1080p | 4492 kbit/s | 77 (0,26 %) | 18 kB en 4 ms | 26 Mbit/s | 11 paquetes |
| mediasoup | 360p y 720p | 1062 kbit/s | 298 (3,4 %) | 188 kB en 1 ms | 150 Mbit/s | 83 paquetes |
| MediaMTX | 1080p | 4933 kbit/s | 4506 (12,5 %) | 214 kB en 2,3 ms | 171 Mbit/s | 154 paquetes |

- Las dos ramas de WebRTC reenvían cada keyframe de golpe y desbordan la cola. MediaMTX lo hace mucho más, porque siempre envía 1080p: 58 tandas mayores que la cola en 60 s, y el 90 % de los descartes en cuatro décimas consecutivas de cada segundo, el compás del GOP. Esto afecta a las medidas anteriores de MediaMTX con límite de caudal.
- DASH también llega a ráfagas (CUBIC sin ritmo, y la captura ve superpaquetes GRO de hasta 64 kB), y llena la cola a ratos (5,5 % de las lecturas), pero pierde paquetes sueltos y repartidos: es TCP buscando la capacidad, y los retransmite.
- MoQ envía con ritmo (tandas de 18 kB como máximo). Pierde poco, en grupos de hasta 11, y algo concentrados en una parte del segundo (70 de 77 en 0,3 s); que coincidan con las keyframes es compatible, no demostrado. QUIC los retransmite.
- Es una sola pasada por rama, y la calidad que eligió cada una cambia la carga: no son cifras para la tesis, sino el orden de magnitud.

## Cómo elige mediasoup

La capa de cada espectador sale de dos pasos (`worker/src/RTC/BWE/`): un objetivo de bitrate y un reparto entre capas. El objetivo lo marca el estimador por retardo (tipo GCC) o, si hay pérdidas, `LossBasedController`, que manda sobre él. Para subir a una capa, el objetivo debe cubrir su bitrate medido más un 20 % (`HysteresisFactor`). Para 1080p hacen falta unos 5,3 Mbit/s, y para 720p, unos 2,5.

## Causa 1: el bloqueo

En `LossBasedController::UpdateBitrateEstimate`, mientras está limitado por pérdidas y subiendo:

```cpp
rampupFactor = bitrateRampupUpperBoundFactor; // 1,5; o 1,2 en espera (bitrateRampupUpperBoundFactorInHold)
lossLimitedBitrate = max(actual, min(mejorCandidato, acknowledgedBitrate * rampupFactor));
```

Para volver al estado normal, el valor tendría que alcanzar la estimación por retardo, y este tope lo impide. El círculo es este: una pérdida lleva al estado limitado, el objetivo baja de lo que cuesta 720p, mediasoup envía 360p, lo confirmado baja a unos 800 kbit/s y el tope queda por debajo del objetivo, que ya no sube.

No es falta de sondeos: esa fue la primera hipótesis y era falsa. Los sondeos salen cada pocos segundos y aciertan, y la estimación por retardo sí sube, pero el objetivo no los sigue. Ejemplo de una pasada a 8 Mbit/s, en estado estable: objetivo 2356 kbit/s, estimación por retardo ~3500, sondeos pedidos a 3535 (1,5 × objetivo, `lossLimitedProbeScale`) y medidos a ~3500, confirmado ~750.

Es deducción, no medida, por qué no se ve así en otros usos: este controlador viene de libwebrtc, donde el codificador sigue al objetivo y lo confirmado crece con él. Un SFU con capas ya codificadas no puede.

### Prueba

Worker recompilado con un interruptor que solo quita ese tope. 120 s a 8 y 5 Mbit/s, cola de 100 ms, alternando. Datos de la segunda mitad de cada pasada:

| Bajada | Worker | Tiempo en 360p / 720p / 1080p | Objetivo | Confirmado | Envío | Limitado por pérdidas | Cambios de calidad |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 8 Mbit/s | Original | 100/0/0 y 73/24/3 % | 2168 y 1952 | 807 y 867 | 758 y 826 | 100 y 94 % | 6 y 12 |
| 8 Mbit/s | Sin tope | 20/62/18 y 20/59/21 % | 2728 y 2968 | 2573 y 2472 | 2325 y 2371 | 61 y 60 % | 33 y 34 |
| 5 Mbit/s | Original | 74/6/0 (19 % sin vídeo) y 100/0/0 % | 1726 y 1493 | 871 y 805 | 719 y 758 | 94 y 100 % | 6 y 5 |
| 5 Mbit/s | Sin tope | 58/40/2 y 63/35/2 % | 1979 y 1839 | 1225 y 1154 | 1306 y 1214 | 50 y 54 % | 25 y 21 |

Quitar el tope saca a mediasoup de 360p, pero no lo lleva a 1080p, oscila más y se para algo más: es una prueba de la causa, no una solución. El tope también sirve para algo.

## Causa 2: el sobreuso sin pérdidas

Con una cola de 1 s a 8 Mbit/s no hay descartes y el controlador por pérdidas no interviene (0 % del tiempo), así que la causa 1 desaparece. Aun así, la estimación se queda muy lejos de los 8 Mbit/s y la capa oscila. El GOP cambia el resultado, sin tocar el código, en pasadas alternadas de 120 s:

| GOP | Tiempo en 360p / 720p / 1080p | Objetivo | Muestras en sobreuso (de ~245) | Recuperaciones de sobreuso | Cambios de calidad |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 s | 8/52/40 y 8/55/37 % | 3659 y 4013 | 25 y 43 | 90 y 83 | 52 y 56 |
| 4 s | 3/31/65 y 0/55/45 % | 4774 y 4747 | 15 y 11 | 35 y 31 | 13 y 16 |

Es compatible con que las keyframes, sincronizadas y sin ritmo de envío, se vean como congestión, pero el objetivo sigue por debajo de los 5,3 Mbit/s de 1080p. El resto puede venir del tamaño variable de los demás frames o de cómo mide el estimador; no está medido.

Con la cola de 100 ms, un GOP de 4 s es inestable: una pasada acaba en 1080p (objetivo 4589) y otra atrapada en 360p (objetivo 1544), según caiga o no en el bloqueo. Además se para bastante más (24-39 % de las muestras), porque nadie atiende las peticiones de keyframe y cada recuperación puede esperar hasta 4 s.

## Con la cola de 300 ms

La misma batería de campañas que con 100 ms (README, 3.4c), repetida el 3-11-2026 en local con la cola de 300 ms, la de RFC 8867, que es ya la de por defecto: tres rondas alternando mediasoup y MediaMTX, la escalera 1080p@4000, 720p@2000 y 360p@700, 15 s de calentamiento y 40 s de medida, sin audio. Las 36 pruebas fueron válidas (la tercera ronda se repitió entera porque el trabajador perdió su pestaña). Cifras de las tres pruebas de cada condición:

| Bajada | Servidor | Cola | Altura media | Envío (kbit/s) | Parado | Cambios de calidad | Descartes en la cola |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 8 Mbit/s | mediasoup | 100 ms | 378, 783, 396 | 1089, 2517, 1053 | 0, 21, 0 % | 1, 10, 1 | 19, 595, 30 |
| 8 Mbit/s | mediasoup | 300 ms | 918, 801, 864 | 3067, 2539, 2899 | 2,4, 4,6, 10,5 % | 16, 13, 13 | 5, 16, 136 |
| 8 Mbit/s | MediaMTX | 100 ms | 1080 | 3826-4020 | 36, 15, 27 % | 0 | 2495-3276 |
| 8 Mbit/s | MediaMTX | 300 ms | 1080 | 3768-4023 | 3,4, 0,5, 5,3 % | 0 | 98, 0, 48 |
| 5 Mbit/s | mediasoup | 100 ms | 360 | 743-853 | 0 % | 0 | 0 |
| 5 Mbit/s | mediasoup | 300 ms | 558, 396, 621 | 1380, 839, 1649 | 10, 5, 0 % | 16, 5, 16 | 211, 72, 0 |
| 5 Mbit/s | MediaMTX | 100 ms | 1080 | 3750-3844 | 71, 70, 44 % | 0 | 17716-24770 |
| 5 Mbit/s | MediaMTX | 300 ms | 1080 | 3297-3780 | 54, 49, 52 % | 0 | 21039-40644 |
| 3 Mbit/s | mediasoup | 100 ms | 360-379 | 584-690 | 59, 20, 3 % | 1-2 | 46-194 |
| 3 Mbit/s | mediasoup | 300 ms | 378-462 | 831-940 | 9, 11, 37 % | 2-10 | 0-264 |
| 1,5 Mbit/s | mediasoup | 100 ms | 360 | 125-162 | 92, 91, 90 % | 0 | 28-43 |
| 1,5 Mbit/s | mediasoup | 300 ms | 360-378 | 158-545 | 87, 85, 54 % | 0-2 | 0-142 |

- **La cola de 100 ms explicaba buena parte de la infrautilización de mediasoup.** A 8 Mbit/s envía casi el triple (2,5-3,1 Mbit/s frente a ~1,1 en dos de tres pruebas) y pasa la mayor parte del tiempo en 720p o 1080p. A 5 Mbit/s ya no se queda siempre en 360p.
- **No la explicaba toda.** No se estabiliza en 1080p a 8 Mbit/s, cambia de calidad 13-16 veces en 40 s y se para algo más que con 100 ms. Es lo esperable si queda la causa 2: con menos pérdidas, el controlador por pérdidas suelta antes y el estimador por retardo hace oscilar la capa.
- **A MediaMTX también le cambia mucho.** A 8 Mbit/s pasa del 15-36 % de tiempo parado al 0,5-5 %, porque sus keyframes de 1080p ya caben. A 5 y 3 Mbit/s no cambia: 1080p no cabe y la cola se llena igual.
- **La latencia apenas cambia.** La mediana de mediasoup a 8 Mbit/s sigue en 108-124 ms, y la de MediaMTX en 78-91 ms: la cola más profunda casi no se llena en estado estable.
- **Sin límite de caudal y con RTT de 50 ms y 1 % de pérdida, la cola no actúa**, y las cifras son iguales que con 100 ms dentro de lo que varían entre pruebas. Esa variación sirve de referencia: MediaMTX pasó de un 3-19 % a un 0-3 % de tiempo parado con RTT de 50 ms sin que cambiara nada que le afecte.
- **Variable de confusión:** entre las dos baterías, la señalización de mediasoup pasó a WebSocket. Con la de 100 ms, una sesión anterior pudo seguir enviando hasta ~29 s por la misma cola al cambiar de prueba; no se sabe si pasó, y lo haría peor, no mejor, a esa batería.

## Qué significa para las medidas

- Es comportamiento de mediasoup con nuestra fuente, sin ajustar nada (principio de medida 1). El banco sigue usando el worker original: los interruptores solo existieron en una imagen de laboratorio, ya borrada.
- Las cifras dependen mucho de la cola del router, del GOP y del momento de la primera pérdida. Una campaña tiene que fijar y declarar los dos primeros, y varias repeticiones por condición, porque los resultados son bimodales.
- No se puede generalizar a "WebRTC infrautiliza el enlace". Tampoco a mediasoup con otro publicador: Chrome envía con ritmo y sin keyframes periódicas, y ni el paper de `../../COMM/webrtc-lldash-comparative` usa esta versión (3.27.1 frente a 3.32.1).

## Límites de esta investigación

Son pocas pasadas (dos por variante), en un Mac y solo a 8 y 5 Mbit/s. La columna de tiempo en cada capa es de lecturas cada 0,5 s. Los contadores de descartes del router se reinician al cambiar la red, así que no hay descartes por pasada fiables en estas tablas: la ausencia de descartes con cola de 1 s sale de pasadas sin reinicio dentro de la medida. No se ha probado un relay con ritmo de envío, que comprobaría directamente la parte de las ráfagas.

## Cómo repetirlo

`SFU_TRACE=1` en el `.env` deja en `docker logs testbed-sfu` la estimación y los sondeos, y `GET http://172.30.50.13:8890/health` da, desde la red interna, el estado de cada espectador. El estado interno (objetivo, estimación por retardo, confirmado, estado del controlador de pérdidas, ALR, sondeos) exige recompilar el worker con trazas en `SenderTransportCongestionController::Process`: `make mediasoup-worker` dentro de `node_modules/mediasoup/worker`, unos 2 min.

## Problema aparte: sesiones que siguen vivas

Si la página se recarga o Chrome muere, `sfu/server.mjs` mantiene la sesión unos **29 s** (medido dos veces), hasta que mediasoup da ICE por perdido, y sigue enviando vídeo por la cola de WebRTC del router. Eso puede contaminar la medida siguiente. No se ha comprobado si afectó a la batería de campañas.

**Resuelto el 3-11-2026:** la señalización pasó a una conexión WebSocket directa al SFU (8189/tcp, por el router), y la sesión se cierra al cerrarse esa conexión, como en la aplicación del paper. Medido en local: al recargar nunca hay dos sesiones, y al matar Chrome la sesión y el tráfico de WebRTC caen a cero en menos de 1,2 s.
