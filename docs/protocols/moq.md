# Media over QUIC (MoQ)

This document explains how the MoQ branch of the testbed works: the protocol, the data model, how the session is set up, how the video is mapped onto QUIC, what happens when the network cannot carry everything, how quality adaptation works and how the player buffers. Shared concepts (frames, GOP, reliable vs unreliable transport, congestion control) are in [the protocols overview](README.md); the catalog field by field is in [moq-catalog-reference.md](moq-catalog-reference.md).

## Software versions

The MoQ branch uses three pieces from the `moq.dev` project, each pinned and selectable at build time (see [deployment.md](../deployment.md)):

| Piece | Role | Published (default) | Built from a commit |
| :--- | :--- | :--- | :--- |
| `moq-relay` | Relay | `moqdev/moq-relay` 0.17.9 (`MOQ_RELAY_VERSION`) | `MOQ_RELAY_FROM=git`, `MOQ_RELAY_COMMIT` (default `c19c723`) |
| `moq-cli` (`moq import ts`) | Publisher | 0.14.7 (`MOQ_CLI_VERSION`) | `MOQ_CLI_FROM=git`, `MOQ_CLI_COMMIT` (default `bc64b9c`) |
| `@moq/watch` and its `@moq/*` dependencies | Browser player | 0.6.3 from npm (`web/package-lock.json`) | `MOQ_WATCH_FROM=git`, `MOQ_WATCH_COMMIT` (default `bc64b9c`) |

Two combinations of `moq.dev` main are used for measurements, and this document describes their behaviour **by version** wherever it differs:

- **Published relay 0.17.x with `moq-cli` and `@moq/watch` built from `bc64b9c`.** The build shows as `git@bc64b9c` (or `git@bc64b9c+switching` with the patches of `web/patches/`, see [adaptation-and-experiments.md](../adaptation-and-experiments.md)).
- **Relay, `moq-cli` and `@moq/watch` all built from `c19c723`** (with `MOQ_WATCH_BUN=1.4.4` and `MOQ_WATCH_PATCHES=0`).

The player API changes between the two `@moq/watch` commits. `web/src/components/MoqPlayer.tsx` works with both (and with the npm release); `web/src/lib/moqApi.ts` only translates how the player is connected and how its outputs are read, without changing what it does (see [Player API differences](#player-api-differences-between-versions)). The panel and the CSV record the installed version of each piece.

## What MoQ is

MoQ is a **publish/subscribe** protocol over QUIC for live media. It does not describe files or point-to-point calls: it describes **named tracks** that clients subscribe to, and lets intermediate servers (**relays**) fan them out to many subscribers without understanding the payload.

Its central idea: **each independent piece of media travels on its own QUIC stream**, so when the network falls short new data can be prioritised and **old data abandoned** without blocking it. Instead of accumulating delay (TCP) or corrupting the picture (raw UDP), MoQ drops complete, decodable units.

## Two protocols with the same name

- **MoQ Transport (MoQT)**: the IETF draft (`draft-ietf-moq-transport`), large and still changing. The installed library recognises drafts 14 to 22.
- **moq-lite**: a simplified subset maintained by `moq.dev` (the project behind the relay, publisher and player used here), with fewer messages and options, designed to be forward compatible with MoQT.

The session negotiates which one is used. **In this testbed it is `moq-lite-06`**, both publisher ↔ relay and relay ↔ browser (checked in the relay log). Everything below describes moq-lite unless stated; [the MoQT mapping](#mapping-to-moq-transport-ietf) gives the equivalent terms.

On top of the transport sits **hang**, the media format of the same project. It defines the **catalog** (which tracks exist and how to decode them) and the **container** (how each frame is packed). The transport knows nothing about video; hang gives it meaning.

```
┌──────────────────────────────────────────────┐
│ hang: catalog + container (what the media is)│
├──────────────────────────────────────────────┤
│ moq-lite: broadcasts, tracks, groups, frames │
├──────────────────────────────────────────────┤
│ WebTransport (session over HTTP/3)           │
├──────────────────────────────────────────────┤
│ QUIC (streams, congestion control, TLS)      │
├──────────────────────────────────────────────┤
│ UDP                                          │
└──────────────────────────────────────────────┘
```

## Data model

Four levels, from largest to smallest:

| Term | What it is | Here |
| :--- | :--- | :--- |
| **Broadcast** | A set of tracks under one name (a path). | `live.hang` |
| **Track** | A sequence of groups of one kind. Each quality is a separate track. | `0.avc3` (video), `1.aac` or `1.opus` (audio), `catalog.json` |
| **Group** | A segment of the track that is **decodable on its own**, with an increasing sequence number. | One GOP: a keyframe and its delta frames |
| **Frame** | A block of bytes with a timestamp; the smallest unit. | One encoded video frame |

The rules that make this useful:

- **A group always starts at an entry point** (a keyframe for video), so any group can be decoded without the previous ones.
- **Within a group, frames are ordered and reliable**; a frame depends on the earlier frames of its group.
- **There is no dependency between groups**, so a whole group can be skipped without breaking anything.

This gives the mapping that is the heart of the protocol:

> **One group = one unidirectional QUIC stream.**

The frames of a group travel one after another on its stream. Different groups use different streams and do not block each other. Cancelling a stream discards a group.

Above all this is the **origin**: the table of broadcasts a connection knows about and can serve or consume (`connection.origin` in the code).

## Actors

- **Publisher**: produces the tracks. Here, `moq --connect https://moq-relay:4433/anon --broadcast live.hang import ts`, run by the orchestrator.
- **Subscriber**: consumes them. Here, `@moq/watch` in the browser.
- **Relay**: subscriber upstream and publisher downstream. Here, `moq-relay`.

Roles are **per track, not per connection**: one session can publish some tracks and subscribe to others. The relay does not interpret media; it only moves groups and frames. Two relay properties matter:

- **On-demand subscription.** The relay does not receive media from the publisher until someone asks for it. When a browser subscribes to `0.avc3`, the relay in turn subscribes to the publisher, with the same parameters the browser asked for (priority and *max age*), as seen in the publisher log.
- **Fan-out and cache.** Several subscribers of the same track share a single upstream subscription. The relay keeps recent groups to serve late joiners.

## The session: from URL to first frame

1. **Connection.** The browser opens a **WebTransport** session to `https://<host>:4433/anon`. WebTransport is the browser API for QUIC: an HTTP/3 session that exposes QUIC streams and datagrams. `/anon` is the path where the relay lets anyone subscribe without authentication; publishing there needs the publisher's JWT (see [architecture.md](../architecture.md)).
2. **Certificate.** QUIC requires TLS. In local mode the relay generates a self-signed certificate at start-up (`--listen-tls-generate`) and serves its SHA-256 fingerprint over HTTP at `/certificate.sha256`. The player downloads it and passes it to WebTransport as `serverCertificateHashes`, so the browser accepts that specific certificate without a certificate authority. Browsers accept this only for short-lived certificates (two weeks at most). In server mode the relay uses the Let's Encrypt certificate of `SERVER_HOST` instead (`--listen-tls-cert`, `--listen-tls-key`) and reloads it on renewal (see [deployment.md](../deployment.md)). Which of the two is used is a confounder to declare.
3. **Negotiation.** Client and server agree the protocol version through the WebTransport subprotocol (`moq-lite-06`). Each end also opens a unidirectional stream with a single **SETUP** message declaring its capabilities, including the **PROBE** level it supports (see [Bandwidth estimation](#bandwidth-estimation-probe)).
4. **Discovery (ANNOUNCE).** The subscriber opens an announce stream and sends an **ANNOUNCE_REQUEST** with a path prefix. The relay replies with the active broadcasts under that prefix and keeps reporting additions and removals while the stream lives. This is how the player learns that `live.hang` exists before asking for anything.
5. **Catalog.** The player subscribes to the broadcast's `catalog.json` track, which lists the media tracks.
6. **Media subscription (SUBSCRIBE).** Having chosen a quality, the player opens a bidirectional stream with a **SUBSCRIBE** message: broadcast, track name, **priority** and ***max age***. In the publisher log:

```
Subscribe { id: 16, broadcast: "live.hang", track: "catalog.json", priority: 100, max_age: 0ns  }
Subscribe { id: 17, broadcast: "live.hang", track: "0.avc3",       priority: 60,  max_age: … }
```

The video *max age* is the player's `delay + buffer` (see [The `buffer` option](#the-buffer-option)).

7. **Data.** For each group the publisher opens a new unidirectional stream. It starts with a header (subscription and group sequence number) followed by the frames, each with its size and timestamp.

Each control message travels on its own bidirectional stream, by type:

| Control stream | Purpose |
| :--- | :--- |
| Announce | Discover broadcasts under a prefix and follow additions and removals. |
| Subscribe | Request a track and update its parameters (`SUBSCRIBE_UPDATE`) without reopening it. |
| Track | Query a track's fixed properties (`TRACK_INFO`): timescale, publisher *max age*. |
| Fetch | Request a specific past group. |
| Probe | Receive the other end's network estimates. |
| Goaway | Ask the peer to reconnect to another server. |

Closing a subscription's stream unsubscribes; there is no separate message.

## The catalog

The catalog is just another track (`catalog.json`), updated whenever something changes. Its essential part, for one quality:

```json
{
  "video": { "renditions": {
    "0.avc3": { "codec": "avc3.42c02a", "codedWidth": 1920, "codedHeight": 1080,
                "bitrate": 7573296, "framerate": 60.0, "container": { "kind": "legacy" } } } },
  "audio": { "renditions": {
    "1.aac":  { "codec": "mp4a.40.2", "sampleRate": 48000, "numberOfChannels": 2,
                "bitrate": 165007, "description": "1190",
                "container": { "kind": "legacy" }, "jitter": 43 } } }
}
```

A **rendition** is one version of the same content: each video quality is a rendition, and its key in the map is the name of the track to subscribe to. With a ladder, `0.avc3`, `1.avc3`, etc. appear.

The fields that drive player behaviour:

| Field | Effect |
| :--- | :--- |
| `bitrate` | The figure the automatic adaptation uses to decide whether a rendition fits. |
| `stalled` | The publisher recommends avoiding that rendition for now. `@moq/watch` 0.6.x excludes it from automatic selection; in `bc64b9c` the catalog schema no longer has the field and the selection ignores it. |
| `jitter` | Irregularity with which the publisher sends frames. The player adds it to its buffer. |
| `delay` | Delay of a rendition relative to the earliest one. Also added to the buffer. |

The rest configures the decoder (`codec`, `description`, resolution) and describes the frame packing (`container`). The full catalog, every section and field with examples, is in [moq-catalog-reference.md](moq-catalog-reference.md).

## The container

The container defines the bytes inside each MoQ frame. hang supports three:

| Container | Content of each frame |
| :--- | :--- |
| `legacy` | A timestamp in microseconds followed by the encoded frame as is. |
| `cmaf` | A CMAF fragment (`moof` + `mdat`); the initialisation segment is in the catalog. |
| `loc` | *Low Overhead Container*, the IETF draft format. |

**This testbed uses `legacy`**, which is what `moq import ts` produces. So **the MoQ branch has no CMAF, segments or fragments**: the panel's segment and fragment controls only affect DASH. Each video frame is one MoQ frame and is sent as soon as it leaves the encoder.

## How video becomes groups

The publisher (`moq import ts`) reads the MPEG-TS stream (see [mpeg-ts.md](mpeg-ts.md)) and:

- Turns each elementary stream into a MoQ track (`0.avc3`; audio as `1.aac`, or `1.opus` when the source audio is Opus).
- **Opens a new group at each keyframe**, so **group = GOP**.
- Writes each frame into the open group and sends it immediately.

`@moq/watch` only subscribes to the audio track when sound is on: with the player muted, audio does not travel (checked: `audio.out.stats` shows no bytes until unmuted). DASH, by contrast, always downloads audio.

With a GOP of 60 at 60 fps there is one group per second with 60 frames each. **Video does not arrive "in groups"**: the group is the unit of *discard* and *entry*, not of *sending*. Frames arrive one by one, every 16.7 ms, on the current group's stream, and latency is not floored by the GOP duration. What the GOP size does determine in MoQ:

- **Start-up and the initial jump.** A new subscriber receives the current group from its keyframe: joining mid-group, it gets the frames already emitted in a burst and then the rest in real time.
- **Discard granularity.** If the network stalls, a whole group is skipped: with a 1 s GOP, a jump loses up to 1 s of picture.
- **Quality switching**, which can only complete from a keyframe of the new track.

A shorter GOP makes all of this finer, at the cost of more bitrate (keyframes are large).

## Priority, max age and what happens when the network falls short

This is the mechanism that sets MoQ apart. It has three parts.

**Priority between tracks.** Each subscription carries a priority; higher is sent first. The values used by hang (`Catalog.PRIORITY`):

| Track | Priority |
| :--- | :--- |
| Catalog | 100 |
| Text / subtitles | 90 |
| Audio | 80 |
| Video | 60 |

If the link cannot carry everything, audio goes before video. (In `c19c723` the track API changes and priorities range from −128 to 127.)

**Order between groups of one track: newest first.** When several groups are pending (because the network is behind), the publisher favours the most recent. In moq-lite-06 this is fixed: the field that used to allow another order has been removed. Under congestion the backlog is sacrificed, not the live edge. Both criteria become the **QUIC stream send priority**: track priority first, then group position.

***Max age*: when a group is given up.** The maximum age a group that is no longer the latest may reach before it is skipped. The subscriber sets it in SUBSCRIBE and can change it with SUBSCRIBE_UPDATE. With 0, an old group is abandoned as soon as a newer one exists. When a group exceeds its *max age* its stream is cancelled: QUIC stops retransmitting it and the bandwidth goes to the next group. The player sets *max age* to its total buffer (see [The player](#the-player-moqwatch)): there is no point waiting for a group longer than the player is willing to lag behind live.

**Visible result.** With a tight network MoQ does not accumulate delay indefinitely:

1. Frames of the current group start arriving late; while they fit in the buffer, nothing shows.
2. If the buffer runs out, the picture freezes.
3. The next keyframe opens a new group, which has precedence; the old one is abandoned.
4. The picture jumps forward and latency recovers.

In the metrics this shows as short stalls with latency returning to its value, rather than a growing latency.

**Head-of-line blocking still exists within a group.** A QUIC stream is reliable and ordered: if a packet is lost, the following frames *of that group* wait for the retransmission. MoQ prevents this from affecting other groups and tracks. For the same reason, netem jitter, which reorders packets, penalises the QUIC branches almost exclusively (see [network-emulation.md](../network-emulation.md)).

**Datagrams.** Since moq-lite-05 a single-frame group can be sent as a QUIC datagram, with no reliability, useful for media where each unit is independent (audio, for example). The video here, with multi-frame groups, uses streams.

## Bandwidth estimation (PROBE)

In DASH the client estimates the network from its downloads. In MoQ the **sender** knows the network, because it runs congestion control. The **PROBE** message carries that knowledge to the receiver: the relay periodically sends its estimated **send bitrate** and smoothed **RTT**. In the library they are `connection.probe`, with fields `estimatedRecvRate` and `rtt`. This is what the panel shows as MoQ's bandwidth estimate and what goes to the CSV (`moq_bw_estimate_kbps`; see [measurement.md](../measurement.md)). The testbed keeps an observer on `connection.probe` so the PROBE channel stays open (and the estimate keeps reaching the panel) even when a quality is pinned by name; observing it does not change which quality is chosen or how the relay sends.

The PROBE level is declared in SETUP: none, **Report** (inform only) or **Increase** (may also send padding to probe for more capacity). A congestion controller only discovers capacity it tries to use: if video takes 4 Mbit/s on a 100 Mbit/s link, the estimate need not reflect the 100.

**What the figure is depends on the relay version** (read from the source and measured in the testbed):

- **Published relay (0.17.9 to 0.17.16).** The "send bitrate" is not a measured rate: the `web-transport-moq` 1.3.5 transport computes it as `cwnd × 8 / RTT`, BBRv3's congestion window over the RTT. BBR keeps a window of about twice the bandwidth-delay product, so the estimate comes out at about 1.7-1.9 times the link with 20 ms of delay, and tens or hundreds of times the link with LAN RTT (`delay_ms: 0`) and an empty queue (measured locally: 300 Mbit/s median on a 10 Mbit/s link). With this relay, automatic adaptation picks 1080p where it does not fit.
- **Relay built from `c19c723`.** The figure is BBR's own bandwidth estimate (`max_bw`). With a base delay of 2.5 ms or more it matches the link. Without base delay it inflates (about 3 times the link at 2 Mbit/s, with selected renditions that are never painted, `moq_selected_height` ≠ `moq_height`): the router's `tbf` shaper lets a lone packet through without waiting after an idle period and, with BBR's minimum RTT at about 0.1 ms, its filter does not discard that sample (measured inside the relay). With the experimental `netem rate` shaper it does not inflate without delay either (measured: 1.1 times the link at 2 Mbit/s, 1.0 at 10 Mbit/s).

**Confounders to declare:** the relay version, the network's base delay (or that there is none) and the shaper (`net_down_shaper`, `net_up_shaper`; see [network-emulation.md](../network-emulation.md)). The relay's congestion control (BBRv3 by default, versus CUBIC for DASH) is also a confounder (see [limitations.md](../limitations.md)).

## Quality adaptation

The testbed lets the library's own adaptation act unmodified. It differs between the two `@moq/watch` commits.

**`@moq/watch` `bc64b9c` (and the npm 0.6.x).** Read from the code (`js/watch/src/video/source.ts`, `#runSelected`):

1. Discard renditions the browser cannot decode and those the catalog marks `enabled: false` (no frames). In 0.6.x, also those marked `stalled`.
2. Keep those with the highest `preference` (a compatibility transcode has −1).
3. Take the relay estimate (`estimatedRecvRate`, from PROBE) and apply an **80 % margin**.
4. Choose the rendition with the **highest bitrate that fits** that budget, according to the catalog's `bitrate`. If none fits, the lowest.
5. With no estimate, choose the best by order: largest picture, then highest bitrate.

There is no hysteresis, timer, buffer or history: the selection is recomputed whenever the estimate changes, and the only damping is the 80 % margin. It is a pure throughput rule, like dash.js's `throughputRule`, using the sender's estimate instead of the client's.

**`@moq/watch` `c19c723`.** The player no longer receives the relay estimate directly. Like the official `<moq-watch>` element of that version, it reserves a share of the connection's estimate (`viewer: { viewers: connection.viewers }`), chooses the quality with what it is granted (capped by the catalog), and the connection, with the sum of what the players request, asks the relay how far to probe (PROBE). The estimate that goes to the CSV is still `connection.probe` (`estimatedRecvRate`).

**The bitrate it compares against.** It is written by the publisher. In `moq-cli` `bc64b9c`, per the comments in `rs/moq-mux`, it is measured over 1 s windows and the peak is retained: set by the first window, raised when another exceeds it, never lowered. Measured in the testbed: 7.4-7.5 Mbit/s for 1080p at 4000 kbit/s nominal and 3.6 Mbit/s for 720p at 2000, about 1.85 times nominal. With the 80 % margin, holding 1080p needs an estimate above 9.3 Mbit/s. This catalog bitrate (measured peak) versus the MPD bitrate (nominal) is a confounder to declare.

**Target.** The player accepts a `target` that restricts the choice: by track name, pixels, maximum width or height, or maximum bitrate. The panel's *Rendition* selector uses only the name, and only when a quality is pinned by hand; in automatic it passes nothing.

**Track switching.** There is no "switch quality" message: each quality is a separate track, so switching means **subscribing to the new one and unsubscribing from the old**. The player does it seamlessly:

1. Subscribe to the new track without dropping the old; both are downloaded for a while.
2. Keep painting the old one until the new one has reached the same playback point (100 ms tolerance).
3. Promote the new one and close the old.

Two measurable consequences:

- **During a switch two qualities are downloaded at once**, exactly when the network is worst. If the old one fills the link, the new one never catches up: both have the same priority (`Catalog.PRIORITY.video`, 60), no option changes this and no timeout drops the old track (read from the `bc64b9c` code). Measured with `bc64b9c`, ladder 1080p@4000 / 720p@2000 / 540p@1200 and 2 Mbit/s downlink: over 60 s the selection was 540p in 58 of 60 samples while the painted frame was 1080p in all 60, with 10 s frozen.
- **The selected and painted quality can differ** for a while, or indefinitely if the new track never catches up. The testbed records both separately (`moq_selected_height` and `moq_height`).

Two declared experiments modify this behaviour, only with `@moq/watch` `bc64b9c` (selectors *Switching* and *ABR*, recorded in the CSV; with `c19c723` and with the npm release they are shown disabled and `moq_abr` records `watch`): releasing the old track or prioritising the new one when switching down, and replacing the relay estimate with probing at minimum priority. See [adaptation-and-experiments.md](../adaptation-and-experiments.md). By default, the library behaves as published.

## Publisher ingest and the `stalled` marks

The publisher sets `stalled` on a rendition when more than 50 ms pass without it delivering a frame of that rendition (see [moq-catalog-reference.md](moq-catalog-reference.md)). Whether this affects adaptation depends on the player version (above); whether it happens depends on the publisher version:

- **`moq-cli` 0.14.7 (published).** It processes at most about 2 MB/s of input (about 0.3 µs of CPU per byte, mostly in the kernel), regardless of viewers, congestion control or `import ts` vs `import avc3`. A ~100 kB keyframe takes about 50 ms to get in and the next frame waits behind it: one delivery gap per group with one quality. With a three-rendition ladder it saturates (p95 input wait 0.6-0.7 s), which causes most `stalled` marks and, with `@moq/watch` 0.6.x, quality changes several times per second unrelated to the network (halving the ladder bitrate removes two thirds of them). With this publisher and a ladder, **MoQ's quality changes do not measure network adaptation**, and its queue adds hundreds of ms of latency.
- **`moq-cli` built from `bc64b9c` or later.** No such limit (measured: 200-730 MB/s of input, versus 1.9-2.0 MB/s for 0.14.7 built with the same settings). A keyframe waits 0.2-0.3 ms at the gate, and with the three-rendition ladder there were no quality changes or delivery gaps in 40 s. The published 0.14.12 still has the limit with the ladder.

The per-frame wait at the publisher input is measured with `POST /api/trace` (see [api.md](../api.md) and [latency-measurement.md](../latency-measurement.md)). Reading MPEG-TS retains 2 frames in the MoQ publisher (see [mpeg-ts.md](mpeg-ts.md)).

## The player: `@moq/watch`

The player is **`@moq/watch`**, the JavaScript library of `moq.dev`, built on browser APIs:

| Who | What it does |
| :--- | :--- |
| **WebTransport** | Access to the QUIC streams of the connection to the relay. |
| `@moq/watch` | Speaks MoQ, reads the catalog, chooses the quality, orders frames, decides when each is shown and draws it. |
| **WebCodecs** (`VideoDecoder`) | Decodes each compressed frame, usually in hardware. |
| **`<canvas>`** | The surface the library draws each picture on. |

There is no `<video>` element and no MSE: unlike DASH, **every frame passes through page code**, which decides exactly when to draw it. This lets it skip a whole group, show a frame as soon as it arrives, or switch quality seamlessly. The price is that this work runs on the page's main thread: if the page is busy the player falls behind, unlike a `<video>` painted by the browser. Any in-browser instrumentation must therefore be cheap and asynchronous (see [latency-measurement.md](../latency-measurement.md)).

`@moq/watch` also holds its buffer as decoded frames (about 280 MB at 1080p with a 1.5 s buffer). On machines with little RAM this can push the browser into swap and stall the main thread, only on MoQ and only at 1080p with targets of 1.5 s or more; see [limitations.md](../limitations.md).

The testbed uses the programmatic interface (`Watch.Player`) on its own `<canvas>`, not the `<moq-watch>` web component the library also offers, connected the same way as that element. The `@moq/watch` chain, with its names in the code:

```
Connection ─▶ Broadcast ─▶ Source ─▶ Decoder ─────────────────────────▶ Renderer
(WebTransport)  (announce,    (chooses   (SUBSCRIBE, Consumer, WebCodecs,   (canvas, on each
                 catalog)     rendition)  waits for Sync)                    screen refresh)
                                              ▲
                                            Sync (common clock for video, audio and subtitles)
```

- **Consumer** (from hang): receives the subscription's groups, orders them by sequence and delivers frames; skips a group older than *max age*.
- **Decoder**: passes each frame to a WebCodecs `VideoDecoder`.
- **Sync**: decides *when* to show each decoded frame. It is the buffer.
- **Renderer**: draws the latest frame on the canvas with `requestAnimationFrame`.

### How Sync works

Sync does not hold a fixed amount of data: it keeps a **time reference**.

- For each received frame it computes `arrival time − frame timestamp`. The **smallest** value seen is the *reference*: the frame that arrived fastest, the best estimate of live.
- Each frame is shown when `now = reference + timestamp + delay`; until then it waits, decoded.
- **`delay`** is therefore the distance kept from live: the cushion against arrival irregularity.

The effective `delay` is the sum of two parts:

| Part | Source |
| :--- | :--- |
| Configured jitter | The player's `delay` option (below). |
| Rendition jitter | The catalog's `jitter` field or, if absent, one frame interval (17 ms at 60 fps). The largest among the active tracks. |

The three modes of the `delay` option:

| Value | Behaviour |
| :--- | :--- |
| `"auto"` (library default) | Computed by the library; the algorithm depends on the version (below). |
| A duration | Fixed value. **This is what the testbed slider sets** (*Target latency*, 50 to 2000 ms in 50 ms steps); at page load it is at `auto`, its left end, shown as `auto (RTT)`. |
| `"instant"` | No buffer or wait: each frame is painted as soon as it is decoded. Disables audio. |

The slider is the jitter buffer of `@moq/watch`, not the total latency: a constant network delay adds on top. It means something different from the DASH and WebRTC latency sliders (see [the protocols overview](README.md)).

### `auto` in `@moq/watch` 0.6.3 (npm): fixed for the session

`delay` is 1.25 × the minimum RTT reported by the relay, with a 20 ms floor (the margin for one retransmission); 100 ms without RTT. **It does not rise during the session** (read from the 0.6.3 code and measured): the minimum RTT is kept as a running minimum, so it can only fall, and the sync reference only moves backwards. If the network gets slower with the page open, frames arrive "late" relative to the reference and are painted as soon as they are decoded: latency rises by what the network adds, but with no buffer left against jitter. On reload, the new connection measures the RTT with the delay in place and the buffer comes out much larger. Measured locally, no jitter:

| | Library `delay` | Relay RTT | Actual latency |
| :--- | :--- | :--- | :--- |
| No network delay | 88 ms | 1 ms | 119 ms |
| Same session after adding 150 ms per direction | 88 ms | 301 ms | 268 ms |
| New session with 150 ms per direction | 444 ms | 301 ms | 625 ms |

With 150 ms per direction and 1 % loss, the session that kept the 88 ms buffer painted 23 fps median; the reloaded one (444 ms) painted 60 fps, at 633 ms instead of 277 ms. With this version, **whether the page was reloaded after a network change is a confounder**.

### `auto` in `@moq/watch` built from main (measured with `bc64b9c`): adaptive

The RTT computation is replaced by an estimator modelled on NetEq (WebRTC's audio jitter buffer): it measures how late each frame arrives and takes the 95th percentile of a histogram of 20 ms buckets, which rises quickly and decays with a 20 s half-life, with a ceiling of about 2 s (described in moq's `doc/concept/audio-jitter.md`). A retransmitted frame counts as late, so loss also raises it. Measured locally in one session without reload, alternating twice with 0.6.3:

| | 0.6.3: target / latency / painted | main: target / latency / painted |
| :--- | :--- | :--- |
| Unrestricted | 88 ms / 116-123 ms / 60 fps | 20 ms / 49-59 ms / 54-60 fps |
| 150 ms per direction | 88 ms / 189-265 ms / 60 fps | 160 ms / 342-348 ms / 58-60 fps |
| 150 ms and 1 % loss | 88 ms / 264-271 ms / 24-28 fps | 340 ms / 514-524 ms / 47-60 fps |

**It measures jitter, not latency.** Each frame's lateness is counted relative to the fastest of roughly the last 2 s, so a constant delay, however large, needs no buffer. After a step from 0 to 1000 ms of downlink delay (measured): frames briefly appear 1 s late, so the target jumps to about 1 s and latency to about 2 s; about 27 s later the target drops abruptly to tens of ms and latency to about 1.1 s. The drop is sudden because the 95th percentile does not move until the weight of the high observations falls below 5 %.

### The `buffer` option

Distinct from `delay` and easily confused with it (named `lookahead` in `c19c723`). It sets how much media "ahead" is tolerated before the reference is repositioned:

- With `buffer = 0` (library default), as soon as a frame arrives earlier than expected the reference moves and playback **sticks to live** as far as `delay` allows.
- With `buffer > 0`, up to that amount of media may accumulate ahead without jumping.

The *max age* sent in SUBSCRIBE is `delay + buffer`.

The testbed leaves `buffer` at 0. On subscribing, the player receives the current group's already-emitted frames in a burst; with `buffer > 0` that lead is kept instead of discarded and playback sits further behind live than the slider says, by an amount that depends on the instant of connection (read from the code; in one measurement, 150 ms of `buffer` added about 90 ms). With 0, latency is determined by the slider. With the slider at 200 ms the library resolves:

```
effective delay = 200 ms (slider) + 46 ms (rendition jitter, the catalog's audio) = 246 ms
max age         = 246 ms + 0 ms (buffer)                                         = 246 ms
```

The measured glass-to-glass latency is then about 300 ms (headless Chrome, unrestricted network); the remainder is encoding, publisher, relay, network, decoding and painting. The rendition jitter is a floor the slider does not control.

### Visibility

By default the library stops downloading video when the canvas leaves the screen or the tab goes to the background (`visible: "20%"`). The testbed sets `"always"` so measurement is not interrupted when scrolling, like the other two players.

### What the testbed adds around the library

Without changing the library:

- **Certificate fingerprint.** Before connecting it downloads `/certificate.sha256` and passes it to WebTransport (see [the session](#the-session-from-url-to-first-frame)).
- **Wait for the announce.** `announced: true` (`follow` in `c19c723`): right after a publisher restart the broadcast does not exist yet and a blind subscription would be rejected without retry.
- **Mute.** With the player muted, `@moq/watch` does not download the audio track. Which player has sound is a confounder to declare.
- **Watchdog.** 10 s without a new picture (after a 20 s grace period from start) and the player is recreated (`moq_player_restarts`).
- **Pinned quality.** The *Rendition* selector passes the track name in `target`; in automatic it passes nothing.
- **Measurement.** The timecode is read from the frame the library has just drawn, and timings from the signals it exposes (see [latency-measurement.md](../latency-measurement.md)).

The player is available in the browser console as `window.moqPlayer`.

### Player API differences between versions

`web/src/lib/moqApi.ts` hides these differences; it changes nothing the player does:

| Aspect | `@moq/watch` 0.6.3 / `bc64b9c` | `@moq/watch` `c19c723` |
| :--- | :--- | :--- |
| Adaptation input | `probe: connection.probe` (relay estimate, 80 % rule) | `viewer: { viewers: connection.viewers }` (share of the connection's estimate) |
| Wait for announce | `announced: true` | `follow: true` (the old name throws) |
| Canvas, visibility, target, mute | Top-level `canvas`, `visible`, `target`, `muted` | Inside `video` (`canvas`, `visible`, `target`) and `audio` (`muted`) |
| Times (delay, timestamps) | Milliseconds (a number) | `Duration` |
| Last painted frame | `renderer.out.frame` | `renderer.painted` (same frame) |
| Last decoded frame | `video.out.frame` | `video.out.frame` (internal) |
| Ahead-of-live tolerance | `buffer` | `lookahead` |
| `switching` patch, probing experiment | Available with `git@bc64b9c+switching` | Not available |

## Options and configuration

**Player (`Watch.Player` / `<moq-watch>`)**

| Option | Library default | Here | Effect |
| :--- | :--- | :--- | :--- |
| `delay` | `auto` | Slider: `auto` (at load) or 50 to 2000 ms | Distance to live. |
| `buffer` (`lookahead` in `c19c723`) | `0ms` | `0ms` (default) | Media ahead tolerated before repositioning. |
| `target` | unrestricted | Only when a quality is pinned | Restricts the chosen rendition. |
| `announced` (`follow` in `c19c723`) | `true` | `true` | Wait until the broadcast is announced before subscribing. |
| `visible` | `20%` | `always` | When to download video depending on canvas visibility. |
| `muted` | `false` | Follows the panel's audio setting (muted unless that player has sound) | Mute; also stops downloading audio. |
| `paused` | `false` | — | Pause. |
| `catalogFormat` | detected from the name suffix | `.hang` → hang | Catalog format: `hang`, `hangz` (compressed), `msf` or `manual`. |

**Connection (`Net.Connection`)**

| Option | Effect |
| :--- | :--- |
| `url` | Relay address, including the auth path (`/anon`). |
| `webtransport.serverCertificateHashes` | Fingerprint of the self-signed certificate. |
| `websocket` | WebSocket fallback (over TCP) when WebTransport is unavailable or takes more than 500 ms; over TCP the QUIC advantages are lost. Only the UDP port is published, so this path does not reach the relay. |

**Relay (`moq-relay`)**, options that affect what is measured. The testbed runs it with `--listen 0.0.0.0:4433 --listen-tls-generate localhost --web-http-listen 0.0.0.0:8081 --auth-url unix:///run/moq-auth/auth.sock` (with `--listen-tls-cert`/`--listen-tls-key` in server mode; `relay/entrypoint.sh`); everything else is at its default.

| Option | Default | Effect |
| :--- | :--- | :--- |
| `--quic-congestion-control` | `delay` (BBRv3) | `loss` uses a loss-based algorithm. The variable to equalise or declare against DASH's CUBIC. |
| `--listen-version` | all | Restricts accepted versions; can force `moq-transport-NN` instead of moq-lite. |
| `--quic-max-streams` | 10 000 | Concurrent streams per connection. MoQ opens one per group. |
| `--quic-mtu-discovery` | off | Path MTU discovery. |
| `--quic-gso` | on | Batches UDP sends (GSO). This is why the router puts a `tbf` in front of `netem` (see [network-emulation.md](../network-emulation.md)). |
| `--quic-receive-window`, `--quic-send-window` | 64 MiB | Flow-control windows. |
| `--cache-duration`, `--cache-capacity` | unlimited | How much the relay keeps for late joiners. |
| `--auth-public`, `--auth-url` | — | Static anonymous grant, or the authorisation server asked for every session. The testbed uses `--auth-url` with `moq auth serve --public-subscribe anon/**`: anonymous sessions may only subscribe. |
| `--cluster-*` | — | Chain several relays. |
| `--quic-qlog` | — | Dump QUIC qlog traces, useful to analyse loss and congestion window. |

**Publisher (`moq`)**

| Option | Effect |
| :--- | :--- |
| `--connect` | Relay URL. Accepts WebTransport (`https`), raw QUIC (`moql`, `moqt`), WebSocket and others. The orchestrator also passes `--connect-tls-insecure` (internal connection to the relay). |
| `--connect-version` | Forces a protocol version. |
| `--broadcast` | Broadcast name (`live.hang`). |
| `import ts` | Reads MPEG-TS on standard input. Other sources and sinks via `import` and `export`. |
| `fetch <track>` | Dumps one group of a track; useful to inspect the catalog. |

## Mapping to MoQ Transport (IETF)

For reading the IETF drafts or comparing with other implementations. Exact names change between drafts, so treat this as orientation and check the specific draft cited.

| moq-lite | MoQ Transport | Notes |
| :--- | :--- | :--- |
| Broadcast (a path) | *Track namespace* | In MoQT a track is identified by namespace + name. |
| Track | Track | |
| Group | Group | |
| Frame | **Object** | MoQT calls the smallest unit an object. |
| (none) | **Subgroup** | MoQT can split a group into subgroups, each on its own stream, for layers (SVC): drop the upper layers without losing the base. |
| ANNOUNCE | PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE | ANNOUNCE and SUBSCRIBE_ANNOUNCES in older drafts. |
| SUBSCRIBE | SUBSCRIBE (and PUBLISH, publisher-initiated) | MoQT adds filters on where to start. |
| FETCH | FETCH | For past content. |
| Priority + *max age* | *Subscriber priority*, *publisher priority*, *group order*, *delivery timeout* | MoQT has more controls; moq-lite fixes "newest first". |
| PROBE | No direct transport equivalent | |
| One control stream per request | A single control stream | Structural difference: in MoQT control messages share a stream. |
| hang catalog | MSF / WARP catalog; LOC or CMSF container | IETF media formats. The library understands `msf` and `loc`. |

## Where its latency comes from

- **Ingest.** A few milliseconds for a normal frame with `moq-cli` from main. With `moq-cli` 0.14.7, keyframes are delayed by its input limit (about 50 ms per ~100 kB keyframe, more on a loaded machine; see [Publisher ingest](#publisher-ingest-and-the-stalled-marks)), which reaches the relay as one jerk per group, visible only if the player buffer is smaller. Reading MPEG-TS also retains 2 frames in the publisher.
- **Network.** QUIC. A loss delays only the following frames of that group.
- **Buffer.** `delay` + rendition jitter (plus anything `buffer` retains, here 0). It is the largest share: about 200 ms of ~300 ms in the testbed's measurements with the slider at 200 ms.

The non-buffer part adds a few tens of milliseconds. MoQ's latency here is almost entirely a player configuration choice. The per-stage breakdown is described in [latency-measurement.md](../latency-measurement.md).
