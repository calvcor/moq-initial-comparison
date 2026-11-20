# Network emulation

The router container (`router/`) sits between the browser and the three delivery servers (the LL-DASH Nginx, the MoQ relay and the WebRTC server). It forwards the browser's ports at the IP level with DNAT, without terminating any connection, and degrades that traffic with Linux `tc` in both directions. Each protocol and direction has its own queue, and inside each queue there is one slot per client for parallel campaign tests. The orchestrator drives it over HTTP on port 9000.

Ingest (orchestrator → Nginx, relay or SFU) uses the internal network and does not cross the router: emulation affects only the server–browser leg, in the same way for the three branches.

The emulation is controlled from the **Network emulation (an identical link per protocol)** panel of the dashboard, from the network conditions of a campaign ([campaigns.md](campaigns.md)) or with `POST /api/network` ([api.md](api.md)). Every sample row records the active profile ([measurement.md](measurement.md)).

## Link profile

A profile has one link per direction: **downlink** is server → browser, **uplink** is browser → server. Each link has these fields (defaults from `EMPTY` in `router/agent.py`; validation ranges from `LinkProfile` in `server/app/main.py`):

| Field | Panel label | Default | Range | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `rate_kbit` | Bandwidth | `null` (no limit) | 100-1,000,000 | Bottleneck rate in kbit/s |
| `delay_ms` | Delay | 0 | 0-2000 | One-way delay; the RTT is the sum of downlink and uplink |
| `jitter_ms` | Jitter | 0 | 0-500 | Delay variation (±), with a fixed 25 % correlation between consecutive packets. Must not exceed `delay_ms` (the orchestrator answers 422). **It reorders packets heavily** ([below](#jitter-reorders-packets)) |
| `loss_pct` | Loss | 0 | 0-50 | Random loss, independent per packet |
| `queue_ms` | Queue | 300 | 10-5000 | Bottleneck buffer; only acts with a bandwidth limit. 300 ms is the value of RFC 8867 (the IETF RMCAT congestion-control test cases) |
| `shaper` | Limiter | `tbf` | `tbf` or `netem` | How the rate is enforced; only acts with a bandwidth limit. `netem` is a declared experiment ([below](#rate-limiter-tbf-or-netem-rate)) |

Properties of the emulation:

- **One identical link per protocol.** DASH, MoQ and WebRTC each get their own queue with the same profile, so they do not compete with each other: a 5 Mbit/s limit means 5 Mbit/s for each protocol. The testbed has no shared-link mode.
- **One queue per protocol, not per viewer.** Outside parallel campaign tests, two tabs playing the same protocol share its queue and disturb each other. To measure with a bandwidth limit, use a single tab (or the per-client slots of parallel tests).
- **Hot change.** Applying a profile does not restart the players, but it opens a new measurement segment so that statistics never mix conditions.
- **Validation is in the orchestrator.** The router does not check the profile (jitter vs delay, ranges); `set_network` and `LinkProfile` in `server/app/main.py` do.

### Presets

The panel offers these presets (`PRESETS` in `web/src/components/NetworkPanel.tsx`). Fields not listed take the defaults above:

| Preset | Downlink | Uplink |
| :--- | :--- | :--- |
| Unrestricted | — | — |
| RTT 100 ms | 50 ms delay | 50 ms delay |
| Loss 1 % | 20 ms delay, 1 % loss | 20 ms delay, 1 % loss |
| Mobile | 10,000 kbit/s, 30 ± 5 ms, 0.2 % loss, 200 ms queue | 5000 kbit/s, 30 ± 5 ms, 0.2 % loss, 200 ms queue |
| Saturated link (3 Mbit) | 3000 kbit/s, 30 ms delay, 200 ms queue | 30 ms delay |

## Ports and forwarding

| Browser port | Destination | Use |
| :--- | :--- | :--- |
| 8443/tcp | `nginx-dash:443` | LL-DASH with TLS (with `DASH_HOST`) |
| 8080/tcp | `nginx-dash:80` | LL-DASH without TLS (without `DASH_HOST`, from HTTP pages) |
| 4433/udp | `moq-relay:4433` | MoQ over QUIC (WebTransport) |
| 8189/udp | `RTC_IP:8189` | WebRTC: ICE, DTLS and SRTP |
| 8189/tcp | `RTC_IP:8189` | mediasoup WebSocket signalling; it goes through the WebRTC queue and suffers its profile |

`RTC_IP` is `SFU_IP` with `RTC_SERVER=mediasoup` (default) and `MEDIAMTX_IP` with `RTC_SERVER=mediamtx`. MediaMTX does not use 8189/tcp: it negotiates over WHEP through the HTTP entry point.

Each port has a DNAT rule in `nat`/`PREROUTING`, and a single `MASQUERADE` rule in `nat`/`POSTROUTING` covers everything that went through a DNAT (`--ctstate DNAT`), so the server answers to the router and conntrack undoes both translations on the way back. The container needs `NET_ADMIN` and `net.ipv4.ip_forward=1` (`docker-compose.yml`).

## The tc tree

`setup()` builds the tree once, when the container starts, on every `eth*` interface (the same tree on each). It is never torn down while the router runs: profiles only add or remove the limiter and the `netem` of each slot.

```
1:  prio, 7 bands (priomap: everything to 1:7)
├─ 1:1  LL-DASH down ─── 100: prio, 9 bands
│                         ├─ 100:1 … 100:8  client slots (by mark)
│                         └─ 100:9          general slot (unmarked)
│                              └─ 190: tbf (rate)
│                                   └─ 191: netem (delay, jitter, loss and queue)
├─ 1:2  LL-DASH up ───── 200: …
├─ 1:3  MoQ down ─────── 300: …
├─ 1:4  MoQ up ───────── 400: …
├─ 1:5  WebRTC down ──── 500: …
├─ 1:6  WebRTC up ────── 600: …
└─ 1:7  all other traffic, no emulation
```

Handles are generated by `handles(queue, slot)` from the queue number (`QUEUES`) and the slot number (1-8, or 9 for the general slot):

| Piece | Pattern | Example: general slot of MoQ down |
| :--- | :--- | :--- |
| Root band | `1:<queue>` | `1:3` |
| Queue `prio` | `<queue>00:` | `300:` |
| Slot band | `<queue>00:<slot>` | `300:9` |
| Limiter (`tbf`) | `<queue><slot>0:` | `390:` |
| `netem` | `<queue><slot>1:` | `391:`, attached to `390:1` |

Every `prio` has a 16-entry `priomap` that only decides where an unclassified packet goes: 6 everywhere at the root (band `1:7`) and 8 everywhere in each queue (the general slot). The ToS of the packets therefore has no influence. `prio` bands are served in strict priority, but each slot has its own limiter, so the queues do not share a common link. Since the root is also a `prio`, its band order would become a strict priority order if the physical interface ever saturated (DASH uplink before MoQ downlink, for example); with rates of a few Mbit/s against Gbit/s interfaces this should not matter (deduction, not measured).

### Classification

Two levels of `u32` filters:

1. **At the root (`parent 1:`), by protocol and port (`FILTERS`).** On the downlink the filter looks at the source port (the public one, already restored by conntrack); on the uplink, at the destination container IP and port, already translated by DNAT (the egress qdisc runs after `PREROUTING`).

   | Queue | Matches |
   | :--- | :--- |
   | `dash_down` (`1:1`) | tcp, source :8080 or :8443 |
   | `dash_up` (`1:2`) | tcp, destination `NGINX_IP`:80 or :443 |
   | `moq_down` (`1:3`) | udp, source :4433 |
   | `moq_up` (`1:4`) | udp, destination `RELAY_IP`:4433 |
   | `rtc_down` (`1:5`) | udp or tcp, source :8189 |
   | `rtc_up` (`1:6`) | udp or tcp, destination `RTC_IP`:8189 |

2. **In each queue (`parent n00:`), by firewall mark.** `match mark s` → `flowid n00:s` for s = 1…8. Unmarked traffic goes to the general slot through the `priomap`.

### Applying a profile to a slot

`apply_queue(queue, profile, slot)` works on every interface:

- **No restriction** (no rate, delay, jitter or loss): it deletes the limiter, and with it the `netem`. The slot's traffic passes untouched, not through a very high limiter.
- **With restrictions**, it adds or changes two qdiscs:
  - `tbf rate <rate> burst 1600 latency 1s`: a one-packet bucket. Besides enforcing the rate, it splits GSO/TSO super-packets, which `netem` would otherwise drop whole, falsifying the loss rate. Without a rate limit but with other restrictions, the `tbf` runs at 1 Gbit/s.
  - `netem limit <packets> [rate <rate>] [delay <delay> [<jitter> 25%]] [loss <loss>%]`. Its `limit` is the bottleneck queue, with tail drop.
- **`netem` limit in packets:** `max(20, ceil(rate × hold / 12000 bit))`, capped at 100,000, where `hold = delay + jitter + queue_ms` (or `delay + jitter + 1000 ms` without a rate limit). It must hold both the packets waiting for their delay and the requested queue. It assumes 1500-byte packets, so the real duration of the queue is approximate.

### Rate limiter: `tbf` or `netem rate`

The `shaper` field of each link chooses how the rate is enforced. It is selectable per direction in the dashboard (column **Limiter**), in campaigns (in the sweep and in the conditions table, for both directions of a condition), and in `POST /api/network` (`{"down": {"rate_kbit": 2000, "shaper": "netem"}, ...}`).

| `shaper` | How the rate is enforced | Status |
| :--- | :--- | :--- |
| `tbf` | The one-packet token bucket sets the pace. The average never exceeds the rate, but after an idle period a single packet leaves without waiting for its transmission time | Default |
| `netem` | The `tbf` runs at 10 Gbit/s only to split GSO super-packets, and `netem rate` delays every packet by its transmission time at the configured rate, whether or not there was traffic before, like a serial link | Declared experiment |

`netem rate` exists to isolate one effect: with `tbf` and no base delay, the isolated packets that leave an idle bucket without waiting inflate the BBR bandwidth estimate of the MoQ relay built from moq `main` (commit `c19c723`), whose minimum RTT is then about 0.1 ms ([limitations.md](limitations.md#moq-bandwidth-estimate)). Measured with no base delay, MoQ alone and relay `c19c723`: at 2 Mbit/s the relay estimate goes from 3.1× the link (median) with `tbf` to 1.1× with `netem`, and the share of time with a selected rendition that is never painted from 66 % to 0; at 10 Mbit/s, from 1.2× to 1.0×. DASH and WebRTC have not been measured with `netem`. The limiter changes the network of all three branches, so measurements with one and the other are not comparable. It is recorded in every CSV row and in `runs.csv` (`net_down_shaper`, `net_up_shaper`); the network panel shows **Limiter: netem rate (experiment)**, the router layout marks it on each slot and the campaign editor warns when a condition uses it. When the limiter of a slot changes, the router recreates that slot's qdiscs, because a `tc qdisc change` of `netem` keeps the previous `rate` if it is not given.

## Per-client slots

Inside the queue of each protocol and direction, a `prio` with 9 bands holds 8 slots for clients with their own profile plus the general slot, which carries the profile of `POST /api/network` and everything else. Only parallel campaign tests use the client slots ([campaigns.md](campaigns.md)): the scheduler gives each worker of a batch the network of its test (`POST /clients` on the router agent, with all IPs at once) and removes them when the batch ends, on pause, when a preview opens and when the orchestrator starts. Without them, all traffic goes through the general slot.

`set_clients` gives each new IP the lowest free slot and adds two rules in `mangle`/`FORWARD`: `-s IP -j MARK --set-mark <slot>` and `-d IP -j MARK --set-mark <slot>`. Marking happens in `FORWARD` because the client IP is visible there in both directions: on the uplink before `MASQUERADE` replaces the source, on the downlink after conntrack restores the destination. The mark does not encode the protocol; the root filter has already chosen the queue. The IPs are those the router sees, i.e. the client addresses after any NAT in front of it: two workers behind the same IP cannot have separate slots. Per-client slots need the `xt_mark` kernel module.

## Counters

The router reports, per queue and per client slot (`stats` in the agent state; `network.stats` and `stats.clients` in `GET /api/status`):

- **Packets and bytes in (`packets`, `bytes`):** `filter`/`FORWARD` rules with one comment per queue (`COUNTED`), read with `iptables-save -c`. They count forwarded IP bytes (headers and retransmissions included) before emulation, at the same layer for all protocols. DASH and WebRTC have two rules per direction (HTTP and HTTPS; UDP and TCP), which are added. Each client slot has its own rules (`<queue>@<IP>`); the general slot is the difference. They are cumulative since the router started: whoever reads them computes the rate between two readings.
- **Packets and bytes out (`out_packets`, `out_bytes`):** sent by the qdisc attached to the slot's band, the `tbf` or, without restrictions, the invisible `pfifo` the kernel puts in its place (hence `tc -s -j qdisc show dev <if> invisible`). tc counts Ethernet headers; 14 bytes per packet are subtracted to match the iptables layer. They are cumulative since that qdisc was created. With a rate limit, at most that rate leaves; the excess is dropped or queued.
- **TCP super-packets (DASH).** iptables counts before emulation and sees GSO super-packets as they come from Nginx; tc counts after the `tbf` splits them. Measured on DASH segment downloads: 2.4 to 4 segments per super-packet, so in DASH the iptables packet count is 2-4 times lower than the real one, and the bytes out exceed the bytes in by about 2.7 % (each segment carries its own IP and TCP headers). Not measured on the UDP branches. Campaigns therefore compute the drop percentage with `out_packets` ([campaigns.md](campaigns.md)).
- **Drops and queue (`dropped`, `queued`):** `drops` and `qlen` of each `netem` (`tc -s -j qdisc show`), summed over interfaces (the `tbf` counters would count the same packets again). Drops include random loss and queue overflow; `queued` is the current backlog. **Drops are counted since the last profile applied to the slot**: after each `POST /` the agent stores the drop counter of the general slot of the six queues as a baseline, and after each `POST /clients`, those of slots 1-8; reads subtract it (`since_reset`). They therefore reset when the network is changed in the dashboard and at the start of every campaign test. tc is not touched, because recreating `netem` would flush its queue. If the kernel counter is below the baseline (the `netem` was recreated), counting restarts from zero.

The panel shows the IP rate per protocol and direction (**IP traffic at the router**), the drops and the queued packets.

### Router layout panel

Below the network panel, and on the campaigns page while a campaign runs, the collapsible **Router layout (tc)** panel draws the tree as the agent built it: the root, one column per protocol with its two queues and, for each queue, its `prio` with the general slot and the client slots (with their IP). For each slot it shows the limiter and `netem` (or that it passes untouched), the applied profile with the `netem` limit in packets, the rate entering the slot (iptables) and leaving it (tc) between two readings, the drops since the last profile and the current backlog. Free slots are grouped unless **Show free slots** is ticked. The description comes from the agent's own record of what it applied (`tree` in `GET /api/router` and in `network` of `GET /api/status`), not from parsing `tc qdisc show`; drops and backlog do come from `tc -s`. It is collapsed by default (remembered in the browser). When open, the dashboard redraws it with each status reading and the campaigns page polls `GET /api/router` every 2 s; it is not shown in a tab that is also a campaign worker, so as not to load the page that measures.

## Router agent API (`:9000`)

Only the orchestrator uses it (`ROUTER_URL`, default `http://172.30.50.2:9000`), over the internal `core` network; the browser cannot reach it.

| Method | Effect | Called by |
| :--- | :--- | :--- |
| `GET /` | Returns the state | `GET /api/status` (`network`), `GET /api/router`, campaign counters |
| `POST /` | Applies `{"down": link, "up": link}` to the general slot of the six queues (`set_profile`) | `POST /api/network`, campaigns |
| `POST /clients` | Leaves exactly these clients with their own slot: `{"IP": {"down": link, "up": link}, …}` (`set_clients`) | Campaigns with parallel tests |

Both `POST` return the state, or `400` with `{"error": "…"}`; without emulation any `POST` returns `400`.

- `POST /` only touches the general slot: it does not change client slots, marks or the tree, and it resets the general slot's drops. A missing direction counts as unrestricted (`{"down": {…}}` clears the uplink), and missing fields take their defaults.
- `POST /clients` always receives the full list (at most 8 IPs). It removes the iptables rules and empties the slot of IPs no longer present, gives new IPs the lowest free slot, applies each client's profile on the six queues and resets the drops of slots 1-8. `{}` removes all clients.
- To return to the start state: `POST /clients {}` and `POST / {"down": {}, "up": {}}`. iptables counters only reset when the container restarts.

State returned:

```jsonc
{
  "profile": {"down": {…}, "up": {…}},       // profile of the general slot
  "clients": {"10.0.0.5": {"down": {…}, "up": {…}}},
  "stats": {
    "moq_down": {"packets": 0, "bytes": 0, "out_packets": 0, "dropped": 0, "queued": 0},   // one entry per queue
    "clients": {"10.0.0.5": {"moq_down": {…}, …}}
  },
  "tree": {"root": "1:", "interfaces": ["eth0", "eth1"], "bands": [ … ]},  // null without emulation
  "emulation_error": null
}
```

`tree` lists each root band with its queue, its `prio` handle, what the root sends there (`match`, from `FILTERS`) and its 9 slots; each slot gives its band, whether it is the general slot or which client owns it, the handles of its limiter and `netem` (`null` when it passes untouched), the applied link plus its `limit`, and its counters (`packets`, `bytes`, `out_packets`, `out_bytes`, `dropped`, `queued`). The last band is `1:7`, the unemulated rest.

## Without emulation

Emulation needs `sch_prio`, `sch_tbf`, `sch_netem` and `cls_u32` in the kernel. In an LXC container whose host lacks them, `setup()` fails to build the tree; the router then removes what it had set up and stores the reason in `emulation_error`. Forwarding (DNAT, MASQUERADE and counters) keeps working, `tree` is `null` and every `POST` returns `400`. The panel shows **Emulation not available on this server**.

## Environment variables

| Variable | Use |
| :--- | :--- |
| `NGINX_IP` | `nginx-dash` container (DNAT of 8443 and 8080; DASH filters and counters) |
| `RELAY_IP` | `moq-relay` container |
| `RTC_SERVER` | `mediasoup` (default) or `mediamtx`: selects `RTC_IP` |
| `SFU_IP`, `MEDIAMTX_IP` | SFU and MediaMTX containers; both are required even if only one is used |

The IPs are fixed on the `core` network (`docker-compose.yml`); the router is `172.30.50.2`. Changing `RTC_SERVER` only needs the router to be recreated, not rebuilt. Restarting the router loses the applied profiles (the network goes back to unrestricted) and resets the counters; the stream configuration belongs to the orchestrator and is kept.

## Inspecting by hand

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

They show the tree, its counters, the root filters, the filters of one queue, the client marks, the DNAT rules, the iptables counters and the full state through the orchestrator. After changing `router/`: `docker compose up -d --build --no-deps router`.

## Known effects of the emulation

### Jitter reorders packets

`netem` gives every packet its own random delay within ±jitter and releases packets in order of their release time, so two packets sent together can arrive up to 2×jitter apart and in reverse order. The 25 % correlation is fixed in the router (the value of the classic `netem` example, not chosen by measurement): each random value mixes 75 % of fresh randomness with 25 % of the previous one, so the distribution is not uniform but concentrated towards the centre, with a standard deviation of about 77 % of the uniform one (deduced from `get_crandom` in the kernel's `sch_netem.c`).

Measured with a numbered test flow through the MoQ downlink queue (bursts of 6 packets every 16.7 ms):

| Profile | Packets arriving out of order | Overtaken by 3 or more later packets |
| :--- | :--- | :--- |
| 150 ms, no jitter | 0 % | 0 % |
| 150 ± 20 ms | 69 % | 39 % (max 12) |
| 150 ± 50 ms | 79-80 % | 60 % (max 27) |

The effect on each protocol, measured with 150 ± 50 ms and a single rendition:

- **MoQ collapses.** QUIC (RFC 9002) declares a packet lost when a packet 3 numbers later is acknowledged. The relay's QUIC stack (`noq` 1.3.0) uses that fixed threshold without adapting it to reordering, and its BBRv3 cuts the window as soon as loss in a round exceeds 2 %. In a qlog trace of the relay with one viewer, 36 % of the packets were declared lost, all by `reordering_threshold` and all acknowledged later (none was actually lost); the median congestion window was 17 kB against 433 kB without reordering, and the relay sent 0.54 Mbit/s for a ~4.3 Mbit/s video. MoQ received 7-8 fps.
- **DASH is barely affected.** Linux TCP (CUBIC with RACK) adapts its reordering threshold with DSACKs (`tcp_max_reordering` = 300): with the same profile it detected 4234 reorderings, retransmitted 6 of 17,543 segments and DASH received 60 fps.
- **WebRTC** neither retransmits nor cuts its rate on reordering: its jitter buffer reorders.

With the same 150 ± 50 ms but preserving order (`netem … rate 1gbit`: each packet leaves no earlier than the previous one), MoQ received 60 fps and painted 52-58, without freezes. That variant also narrows the delay distribution (p5-p95 of 44-79 ms against 6-95 ms), so 150 ± 20 ms serves as a control with a similar distribution and reordering: MoQ suffers (45-59 fps painted, 2-10 s frozen) but does not collapse. The damage grows with the depth of reordering. With a ladder, MoQ drops to 360p because the relay estimate falls to 0.2-0.9 Mbit/s, and even that rendition does not fit.

**Consequence:** the testbed's jitter parameter mixes delay variation with deep reordering, and the second penalises almost only QUIC. On real networks delay varies mostly in queues, which do not reorder. Any MoQ result with jitter must be read this way.

### DASH target latency does not follow network delay

The DASH target-latency slider sets dash.js `liveDelay` (0.3 s on page load), and dash.js chases it as is: with a slow network it speeds playback up to reach it, empties the buffer, stalls and, beyond `maxDrift`, seeks to the live edge. dash.js 5.2.1 fixes `liveDelay` at start-up and only changes it on a manual seek (read from the code). WebRTC sizes its buffer from the jitter it measures and MoQ in `auto` from the RTT reported by the relay, so both raise their latency on their own. Measured with DASH alone, 150 ms per direction without jitter, 45 s after a 15 s warm-up, with dash.js's default catch-up mode (not LoL+):

| DASH target | Frames painted | Freezes | Seeks to live | Mean speed | Real latency |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 0.3 s | 42.3 fps | 17 (14.2 s) | 3 | 1.3× | 564 ms |
| 0.5 s | 53.2 | 3 (0.9 s) | 0 | 1.0× | 556 ms |
| 0.7 s | 59.8 | 2 (0.6 s) | 0 | 1.0× | 757 ms |
| 1.0 s | 59.8 | 0 | 0 | 1.0× | 1048 ms |
| 0.3 s, no network delay | 59.8 | 0 | 0 | 1.0× | 339 ms |

Freezes count from page load and include start-up. None of the `liveCatchup` settings tried (`maxDrift` 0, `playbackBufferMin` 1 s, `liveThreshold` 0.3 s) kept DASH at the latency the network allows: without seeks it stays at 1.0-2.3 s, the latency reached through the start-up freezes. With an unreachable target dash.js does not settle at a sustainable latency; it accelerates towards the target and stalls. Comparing DASH with the other two at equal network profile therefore requires choosing its target for that profile and declaring it; an alternative is to measure, per profile, the minimum target without freezes.

## Limitations of the emulation

- **On macOS (Docker Desktop), the client's TCP endpoint is Docker Desktop's proxy**, not the browser. For DASH the degraded connection is proxy–Nginx; the server-side congestion control is the real one. QUIC and WebRTC are not affected. On a Linux host this does not happen.
- **The queue is sized in packets** assuming 1500-byte packets, so its real duration is approximate.
- **Queue length is a condition.** With a short queue, keyframe bursts overflow it: with a 100 ms queue at 8 Mbit/s, WebRTC lost 12.5 % of packets with MediaMTX and 3.4 % with mediasoup, against 0.26 % for MoQ and 0.03 % for DASH. The CSV records it (`net_down_queue_ms`, `net_up_queue_ms`); the Mobile and Saturated link presets use 200 ms.
- **Static profiles only.** There are no time-varying profiles (traces or scheduled steps) and no shared-link mode for studying competition between protocols.

All the confounders of the testbed are listed in [limitations.md](limitations.md).
