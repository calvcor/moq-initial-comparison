# Router de emulación de red

El router está entre el navegador y los servidores finales (Nginx de DASH, relay de MoQ, servidor de WebRTC). Reenvía a nivel IP los puertos del navegador, sin terminar conexiones, y degrada ese tráfico con `tc` en los dos sentidos. Cada protocolo y sentido tiene su propia cola, y dentro de cada una hay una plaza por cliente para las pruebas en paralelo. El orquestador lo controla por HTTP en el puerto 9000.

La ingesta (orquestador → Nginx, relay o SFU) va por la red interna y no pasa por aquí: la emulación solo afecta al tramo servidor–navegador, igual para las tres ramas. El uso desde el panel, los parámetros y lo medido con cada perfil están en la sección 5 del [README principal](../README.md#5-emulación-de-red).

## Ficheros

| Fichero | Contenido |
| :--- | :--- |
| `agent.py` | Reenvío (DNAT y MASQUERADE), árbol de tc, plazas de los clientes y aplicación de los perfiles: `setup`, `handles`, `apply_queue`, `client_rules`, `set_clients` y `set_profile`. Guarda el estado (`profile`, `clients`, `applied`, `shaped`, `emulation_error`) |
| `api.py` | Agente HTTP (`:9000`) y lectura de contadores: `qdisc_counters`, `stats`, `describe`, `tree` y la clase `Agent`. Es el que se ejecuta (`CMD` del `Dockerfile`): llama a `setup()` y arranca el servidor. Usa `agent.py` como `router.<nombre>`, para leer siempre el estado actual |
| `Dockerfile` | Alpine con Python, `iproute2-tc` e `iptables` |

Hasta el 12-11-2026 todo estaba en `agent.py`; la separación no cambió el funcionamiento.

## Puertos y reenvío

| Puerto del navegador | Destino | Uso |
| :--- | :--- | :--- |
| 8443/tcp | `nginx-dash:443` | LL-DASH directo con TLS (con `DASH_HOST`) |
| 8080/tcp | `nginx-dash:80` | LL-DASH directo sin TLS (sin `DASH_HOST`, desde páginas HTTP) |
| 4433/udp | `moq-relay:4433` | MoQ sobre QUIC |
| 8189/udp | `RTC_IP:8189` | WebRTC: ICE, DTLS y SRTP |
| 8189/tcp | `RTC_IP:8189` | Señalización WebSocket de mediasoup; va en la cola de WebRTC |

`RTC_IP` es `SFU_IP` con `RTC_SERVER=mediasoup` (por defecto) y `MEDIAMTX_IP` con `RTC_SERVER=mediamtx`. Con MediaMTX el 8189/tcp no se usa: negocia por WHEP a través del punto de entrada.

Cada puerto tiene una regla de DNAT en `nat`/`PREROUTING`, y una sola de `MASQUERADE` en `nat`/`POSTROUTING` para todo lo que ha pasado por un DNAT (`--ctstate DNAT`). Así el servidor responde al router y conntrack deshace las dos traducciones en la vuelta. El contenedor necesita `NET_ADMIN` y `net.ipv4.ip_forward=1` (`docker-compose.yml`).

## Árbol de tc

`setup()` lo monta una vez, al arrancar el contenedor, en todas las interfaces `eth*` (el mismo en cada una). Mientras el router está en marcha no se desmonta: los perfiles solo ponen o quitan el `tbf` y el `netem` de cada plaza.

```
1:  prio, 7 bandas (priomap: todo a 1:7)
├─ 1:1  LL-DASH bajada ── 100: prio, 9 bandas
│                         ├─ 100:1 … 100:8  plazas de los clientes (por marca)
│                         └─ 100:9          general (sin marca)
│                              └─ 190: tbf (caudal)
│                                   └─ 191: netem (retardo, jitter, pérdida y cola)
├─ 1:2  LL-DASH subida ── 200: …
├─ 1:3  MoQ bajada ────── 300: …
├─ 1:4  MoQ subida ────── 400: …
├─ 1:5  WebRTC bajada ─── 500: …
├─ 1:6  WebRTC subida ─── 600: …
└─ 1:7  resto del tráfico, sin emulación
```

Hasta el 12-11-2026 las colas eran `dash_down` 1, `moq_down` 2, `dash_up` 3 y `moq_up` 4; desde entonces, cada protocolo con su bajada y su subida seguidas (`QUEUES`).

### Nombres (handles)

Los genera `handles(cola, plaza)` con la cifra de la cola (`QUEUES`) y la de la plaza (1 a 8, o 9 para la general):

| Pieza | Patrón | Ejemplo: plaza general de MoQ bajada |
| :--- | :--- | :--- |
| Banda de la raíz | `1:<cola>` | `1:3` |
| `prio` de la cola | `<cola>00:` | `300:` |
| Banda de la plaza | `<cola>00:<plaza>` | `300:9` |
| `tbf` | `<cola><plaza>0:` | `390:` |
| `netem` | `<cola><plaza>1:` | `391:`, colgado de `390:1` |

Para tc son solo etiquetas; el patrón sirve para saber a simple vista de qué cola y plaza es cada pieza.

### Priomap

Cada `prio` tiene un `priomap` de 16 posiciones, una por prioridad del paquete (derivada del ToS si nadie la fija). Solo decide adónde va un paquete que no coincide con ningún filtro. Las bandas se numeran desde 0 en el `priomap`:

- en la raíz vale 6 en todas las posiciones: la séptima banda, `1:7`;
- en cada cola vale 8 en todas: la novena banda, la plaza general.

Así la prioridad que traigan los paquetes no influye en nada. Las bandas de un `prio` se sirven con prioridad estricta (la 1 antes que la 2…), pero cada plaza lleva su propio `tbf`, así que las colas no compiten por un enlace común: cada una ve el suyo.

## Clasificación

Dos niveles de filtros `u32`, cada uno con su `flowid` (la clase a la que manda el paquete si coincide):

1. **En la raíz (`parent 1:`), por protocolo y puerto (`FILTERS`):** el sentido y el protocolo.
   - En la bajada se mira el puerto de origen, el público, ya restaurado por conntrack.
   - En la subida, la IP del contenedor y el puerto de destino, ya traducidos por el DNAT (la qdisc de salida va después de `PREROUTING`).

   | Cola | Coincide con |
   | :--- | :--- |
   | `dash_down` (`1:1`) | tcp, origen :8080 o :8443 |
   | `dash_up` (`1:2`) | tcp, destino `NGINX_IP`:80 o :443 |
   | `moq_down` (`1:3`) | udp, origen :4433 |
   | `moq_up` (`1:4`) | udp, destino `RELAY_IP`:4433 |
   | `rtc_down` (`1:5`) | udp o tcp, origen :8189 |
   | `rtc_up` (`1:6`) | udp o tcp, destino `RTC_IP`:8189 |

2. **En cada cola (`parent n00:`), por marca:** el cliente. `match mark s` → `flowid n00:s`, para s = 1…8. Lo que no tiene marca va a la general por el `priomap`.

### Marca de los clientes con plaza

`set_clients` da a cada IP nueva la plaza libre más baja y añade en `mangle`/`FORWARD` dos reglas: `-s IP -j MARK --set-mark <plaza>` y `-d IP -j MARK --set-mark <plaza>`. Se marca en `FORWARD` porque ahí la IP del cliente se ve en los dos sentidos: en la subida, antes de que `MASQUERADE` cambie el origen por la del router; en la bajada, después de que conntrack devuelva el destino al cliente. La marca no dice el protocolo: es la misma para todo el tráfico de esa IP, y la cola ya la eligió el filtro de la raíz.

Las IP son las que ve el router, es decir, las de los clientes tras la NAT de Docker en el anfitrión (README principal, sección 5).

## Perfil de un enlace

Un perfil por sentido, con los campos de `EMPTY`:

| Campo | Por defecto | Efecto |
| :--- | :--- | :--- |
| `rate_kbit` | `null` | Caudal del `tbf`; `null` = sin límite (el `tbf` se pone a 1 Gbit/s si hay otras restricciones) |
| `delay_ms` | 0 | Retardo de `netem` |
| `jitter_ms` | 0 | Variación del retardo (±), con correlación del 25 % entre paquetes seguidos, fija: cada valor mezcla un 75 % de azar nuevo con un 25 % del anterior. El reparto no es uniforme sino más concentrado hacia el centro (desviación típica de ~77 % de la uniforme; deducido de `get_crandom` en `sch_netem.c`). Desordena los paquetes (README principal, sección 5) |
| `loss_pct` | 0 | Pérdida aleatoria por paquete |
| `queue_ms` | 300 | Cola del cuello de botella; solo cuenta con `rate_kbit` |

`apply_queue(cola, perfil, plaza)` aplica un perfil a una plaza de una cola, en todas las interfaces:

- **Sin restricciones** (sin caudal, retardo, jitter ni pérdida): borra el `tbf` (y con él el `netem`). El tráfico de la plaza pasa tal cual, no por un limitador muy alto.
- **Con restricciones:** pone (`add`) o cambia (`change`) las dos piezas:
  - `tbf rate <caudal> burst 1600 latency 1s`: ráfaga de un paquete. Además de fijar el caudal, trocea los superpaquetes GSO/TSO, que `netem` descartaría enteros y falsearían la pérdida.
  - `netem limit <paquetes> [delay <retardo> [<jitter> 25%]] [loss <pérdida>%]`: su límite hace de cola del cuello de botella, con descarte por la cola (tail drop).
- **Límite de la cola de `netem`, en paquetes:** `max(20, ceil(caudal · espera / 12000 bits))`, con un máximo de 100 000. La espera es `retardo + jitter + cola`, o `retardo + jitter + 1000 ms` sin límite de caudal. Tienen que caber los paquetes que esperan su retardo y los de la cola pedida. Supone paquetes de 1500 bytes, así que la duración real de la cola es aproximada.

El router no valida el perfil (que el jitter no supere el retardo, los rangos): lo hace el orquestador antes de llamarlo (`LinkProfile` y `set_network` en `server/app/main.py`).

## API (`:9000`)

Solo la usa el orquestador (`ROUTER_URL`, por defecto `http://172.30.50.2:9000`), por la red interna `core`. El navegador no llega a ella.

| Método | Qué hace | Lo llama |
| :--- | :--- | :--- |
| `GET /` | Devuelve el estado | `GET /api/status` (`network`), `GET /api/router`, contadores de las campañas |
| `POST /` | Aplica `{"down": perfil, "up": perfil}` a la plaza general de las 6 colas (`set_profile`) | `POST /api/network`, campañas |
| `POST /clients` | Deja exactamente esos clientes con plaza propia: `{"IP": {"down": perfil, "up": perfil}, …}` (`set_clients`) | Campañas con pruebas en paralelo (`router_clients`) |

Los dos `POST` devuelven el estado, como `GET /`, o `400` con `{"error": "…"}`. Sin emulación (ver abajo), cualquier `POST` responde `400`.

**`POST /`** solo toca la plaza general:

- No cambia las plazas de los clientes, sus marcas ni la estructura del árbol.
- Pone a cero los descartes de la plaza general (ver Contadores).
- Un sentido que falta en el cuerpo cuenta como vacío: `{"down": {…}}` deja la subida sin restricciones.
- Dentro de un perfil, los campos que faltan toman su valor por defecto.

**`POST /clients`** recibe siempre la lista completa (como mucho 8 IP):

- A las IP que ya no están les quita las reglas de iptables y vacía la plaza.
- A las nuevas les da la plaza libre más baja y pone sus reglas.
- A todas les aplica su perfil en las 6 colas.
- `{}` quita a todos.
- Pone a cero los descartes de las plazas 1 a 8.

**Dejarlo todo limpio**, como al arrancar: `POST /clients {}` y `POST / {"down": {}, "up": {}}`. Los contadores de iptables solo vuelven a cero al reiniciar el contenedor; los descartes, con cada `POST`.

### Estado

```jsonc
{
  "profile": {"down": {…}, "up": {…}},       // perfil de la plaza general
  "clients": {"10.0.0.5": {"down": {…}, "up": {…}}},
  "stats": {
    "moq_down": {"packets": 0, "bytes": 0, "out_packets": 0, "dropped": 0, "queued": 0},   // una entrada por cola
    "clients": {"10.0.0.5": {"moq_down": {…}, …}}
  },
  "tree": {"root": "1:", "interfaces": ["eth0", "eth1"], "bands": [ … ]},  // null sin emulación
  "emulation_error": null
}
```

`tree` describe el árbol para el esquema del dashboard (panel **Esquema del router (tc)**): cada banda de la raíz con su cola, su `prio`, qué tráfico manda ahí la raíz (`match`, sacado de `FILTERS`) y sus 9 plazas. Para cada plaza da su banda, si es la general o de qué cliente es, los handles de su `tbf` y su `netem` (`null` si pasa sin restricciones), el perfil aplicado con su `limit` y sus contadores: lo que entra (`packets`, `bytes`, de iptables), lo que sale (`out_packets`, `out_bytes`, de tc), los descartes y la cola. Al final va `1:7`, el resto.

## Contadores

- **Paquetes y bytes:** reglas de `filter`/`FORWARD` con un comentario por cola (`COUNTED`), leídas con `iptables-save -c`. Son bytes IP reenviados (cabeceras y retransmisiones incluidas), antes de la emulación. DASH y WebRTC tienen dos reglas por sentido (HTTP y HTTPS; UDP y TCP), que se suman.
  - Las de cada cola cuentan todo su tráfico, con plaza o sin ella.
  - Cada cliente con plaza tiene además las suyas, con el comentario `<cola>@<IP>`.
  - La general del árbol es la diferencia entre las dos.
  - Son acumulados desde que arrancó el router: el caudal lo calcula quien los lee, entre dos lecturas.
- **Lo que sale de cada plaza** (desde el 18-11-2026): bytes y paquetes enviados por la qdisc colgada de la banda de la plaza, el `tbf` o, sin restricciones, la `pfifo` que pone el kernel al quitarlo. Esa `pfifo` es invisible: por eso se lee con `tc -s -j qdisc show dev <interfaz> invisible`. tc cuenta los bytes con la cabecera Ethernet; se restan 14 por paquete para que estén en la misma capa que los de iptables (medido: 142 bytes en tc por paquete IP de 128). Son acumulados desde que se montó esa qdisc: si se vuelve a crear, ese intervalo sale vacío en el esquema. Con límite de caudal, sale como mucho ese caudal; lo que entra de más se descarta o espera en la cola.
- **Superpaquetes en TCP (DASH).** iptables cuenta antes de la emulación y ve los superpaquetes GSO tal como llegan de Nginx; tc, después de que el `tbf` los trocee (y la `pfifo` los cuenta por segmentos). Medido en local el 18-11-2026, descargando segmentos de DASH por la plaza general: entraron 1071 paquetes de 5923 bytes de media y salieron 4367 de 1492, unos 4 segmentos por superpaquete. En una segunda descarga, con un 2 % de pérdida, fueron 2,4 segmentos por superpaquete: varía. Así que en DASH los paquetes de iptables son entre 2 y 4 veces menos que los reales, y los bytes que salen superan a los que entran en un 2,7 %: cada segmento lleva sus propias cabeceras IP y TCP. En las ramas UDP no se ha medido. Por eso `stats` da también `out_packets`, de tc, por cola y por cliente: las campañas calculan con ellos el porcentaje de descartes (README principal, sección 4.8).
- **Descartes y paquetes en cola:** `drops` y `qlen` de cada `netem` (`tc -s -j qdisc show`), sumados en todas las interfaces. No se suman los del `tbf`, que vuelve a contar los mismos. Incluyen la pérdida aleatoria y la cola llena. `qlen` es lo que hay en la cola ahora.
- **Los descartes se cuentan desde el último perfil aplicado a la plaza** (desde el 12-11-2026; antes, desde que se montó cada `netem`). Tras cada `POST /`, `api.py` guarda el contador de los `netem` de la plaza general de las seis colas (`reset_drops`), y tras cada `POST /clients`, los de las plazas 1 a 8. Al leer, lo resta (`since_reset`). Así vuelven a cero al cambiar la red en el dashboard y, en una campaña, al empezar cada prueba, que aplica siempre las dos. No se toca tc: borrar y volver a crear el `netem` vaciaría la cola y tiraría lo que hubiera dentro. Si el contador del kernel está por debajo de la base (el `netem` se volvió a crear), se cuenta desde cero. Los paquetes y bytes de iptables siguen acumulados.

## Sin emulación

La emulación necesita en el kernel `sch_prio`, `sch_tbf`, `sch_netem` y `cls_u32`. En un contenedor LXC cuyo anfitrión no los tiene cargados, `setup()` falla al montar el árbol. Entonces:

- borra lo que haya puesto y guarda el motivo en `emulation_error`;
- el reenvío (DNAT, MASQUERADE y contadores) sigue funcionando;
- `tree` vale `null` y los `POST` responden `400`.

## Variables de entorno

| Variable | Uso |
| :--- | :--- |
| `NGINX_IP` | Contenedor `nginx-dash` (DNAT de 8443 y 8080; filtros y contadores de DASH) |
| `RELAY_IP` | Contenedor `moq-relay` |
| `RTC_SERVER` | `mediasoup` (por defecto) o `mediamtx`: elige `RTC_IP` |
| `SFU_IP`, `MEDIAMTX_IP` | Contenedores del SFU y de MediaMTX. Hacen falta las dos aunque solo se use una |

Las IP son fijas en la red `core` (`docker-compose.yml`), y el router es `172.30.50.2`. Cambiar `RTC_SERVER` solo necesita recrear el router, no reconstruirlo.

## Inspeccionar a mano

```bash
docker exec testbed-router tc qdisc show dev eth0
docker exec testbed-router tc -s qdisc show dev eth0
docker exec testbed-router tc filter show dev eth0 parent 1:
docker exec testbed-router tc filter show dev eth0 parent 300:
docker exec testbed-router iptables -t mangle -S FORWARD
docker exec testbed-router iptables -t nat -S
docker exec testbed-router iptables-save -c -t filter
curl -s localhost/api/router
```

Las seis primeras miran el árbol, sus contadores, los filtros de la raíz, los de una cola, las marcas y el DNAT. Las dos últimas leen los contadores de iptables y el estado completo, este a través del orquestador.

Tras cambiar `router/`: `docker compose up -d --build --no-deps router`. Reiniciar el router pierde los perfiles aplicados (la red vuelve a quedar sin restricciones) y pone a cero los contadores. La configuración de la emisión no se pierde, porque es del orquestador.
