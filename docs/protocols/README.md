# How the three delivery mechanisms work: LL-DASH, Media over QUIC and WebRTC

These documents explain, end to end, how video travels in each of the three branches of the testbed. Statements about the concrete behaviour of the testbed are read from the source code of the installed libraries and from the project configuration, or measured on the testbed; where something is a deduction and not a direct check, it says so.

## Index

| Document | Contents |
| :--- | :--- |
| This page | What the three branches share, prior concepts, side-by-side comparison, what each panel control does, glossary |
| [ll-dash.md](ll-dash.md) | LL-DASH: MPD, CMAF, chunked transfer, the `dash.js` player and its ABR rules |
| [moq.md](moq.md) | Media over QUIC: moq-lite, relay, publisher, catalog, groups, `@moq/watch` |
| [webrtc.md](webrtc.md) | WebRTC: signalling, RTP/RTCP, jitter buffer, mediasoup and MediaMTX, `RTCPeerConnection` |
| [mpd-reference.md](mpd-reference.md) | The LL-DASH manifest, field by field |
| [moq-catalog-reference.md](moq-catalog-reference.md) | The MoQ catalog, field by field |
| [mpeg-ts.md](mpeg-ts.md) | MPEG-TS, the intermediate format inside the server |

How latency is measured (burnt-in timecode, clock sync, per-stage breakdown) is in [../latency-measurement.md](../latency-measurement.md). The confounders to declare when comparing the branches are in [../limitations.md](../limitations.md).

## Versions the descriptions apply to

All third-party components are pinned; nothing updates on its own. The versions in use appear in the dashboard header and are recorded in the CSV (see [../deployment.md](../deployment.md) for how to select them).

| Component | Pinned version | Where it is set |
| :--- | :--- | :--- |
| MoQ relay (`moqdev/moq-relay`) | 0.17.9 (published image); or built from commit `c19c723` with `MOQ_RELAY_FROM=git` | `docker-compose.yml`, `relay/Dockerfile` |
| MoQ publisher (`moq-cli`) | 0.14.7 (published); or built from a commit with `MOQ_CLI_FROM=git` (default commit `bc64b9c`) | `server/Dockerfile` |
| MoQ player (`@moq/watch` / `@moq/net` / `@moq/hang`) | 0.6.3 / 0.4.4 / 0.5.3 (npm lockfile); or built from a commit with `MOQ_WATCH_FROM=git` (default commit `bc64b9c`, with the patches in `web/patches/`) | `web/package-lock.json`, `web/Dockerfile` |
| DASH player (`dashjs`) | 5.2.1 | `web/package.json` |
| WebRTC server, default (`mediasoup` / `mediasoup-client`) | 3.32.1 / 3.26.0 | `sfu/package.json`, `web/package.json` |
| WebRTC server with `RTC_SERVER=mediamtx` (`bluenviron/mediamtx`) | 1.21.3 | `docker-compose.yml` |
| Encoder | FFmpeg with libx264, from the Debian package of the `python:3.12-slim` base image (not pinned separately) | `server/Dockerfile` |

The MoQ components built from `main` (`c19c723`) behave differently from the published releases in several respects (bandwidth estimate sent by the relay, how the player picks a rendition); [moq.md](moq.md) says which build each description applies to. Measurements with different MoQ builds are not comparable with each other.

The source encodes audio as **Opus**, so all three branches can carry the same audio track (`opus` in the MPD, a `.opus` track in the MoQ catalog).

---

## 1. What the three branches share

The three branches receive **exactly the same encoded video**. A single FFmpeg process (the "master source") reads Big Buck Bunny (or Tears of Steel at 24 fps, or an RTSP camera; see [../architecture.md](../architecture.md)) in real time, burns in the timecode and the rendition label, encodes with x264 and fans the result out to local UDP ports. From there nobody re-encodes: each branch only **repackages** the same H.264 bytes into its own format.

```
                          ┌─ UDP 5001 ─ tsgate ─ ffmpeg (-f dash) ─ PUT ─▶ in-memory origin ─▶ nginx ─▶ router ─▶ browser (dash.js)
File ─▶ FFmpeg ───────────┼─ UDP 5002 ─ tsgate ─ moq import ts ─ QUIC ───▶ moq-relay ────────────────────▶ router ─▶ browser (@moq/watch)
(x264, 1 to 5 renditions) └─ UDP 5003 ─ tsgate ─ FFmpeg (RTP) ─ rtprelay ─▶ mediasoup ───────────────────▶ router ─▶ browser (RTCPeerConnection)
                                                 (or MPEG-TS over UDP ─▶ MediaMTX, with RTC_SERVER=mediamtx)
```

A fourth output, UDP 5004, goes to no branch: `recorder.py` records it during QoE tests to compute VMAF against the video as it left the encoder ([../qoe.md](../qoe.md)).

Instead of the file, the source can read an **RTSP camera**. Everything downstream is unchanged: same ladder, same timecode, same outputs. There is then a fifth output, UDP 5005, with each frame as it enters the ladder, almost lossless, which serves as the VMAF reference because there is no file to compare with. With the camera the stream runs at the camera's frame rate, the content does not repeat between tests, and the measured latency starts, as always, when the timecode is burnt in: it does not include the camera-to-server leg.

Consequences for the comparison:

- **Encoding is not a variable.** Same codec (H.264 Constrained Baseline, `ultrafast`, `zerolatency`, no B-frames), same GOP, same bitrate. Latency differences between branches come from packaging, transport and player.
- **Ingest is not degraded.** The encoder-to-server leg of every branch runs on the internal Docker network. The router that emulates the network acts only between the end servers and the browser ([../network-emulation.md](../network-emulation.md)).
- **`tsgate.py`** is a gate that lets the MPEG-TS stream through to each packager starting exactly at a keyframe, and records when each frame left the encoder. It does not alter the data.
- **Latency is measured the same way in all three**, by reading a timecode burnt into the picture ([../latency-measurement.md](../latency-measurement.md)).

The intermediate format between the source and the packagers is **MPEG-TS**: a container of fixed 188-byte packets designed for broadcast, which lets a receiver join the stream at any moment. It exists only inside the server; no branch sends it to the browser. See [mpeg-ts.md](mpeg-ts.md).

---

## 2. Prior concepts

Four ideas that appear in all three branches.

### 2.1. Frames, keyframes and GOP

Compressed video does not store every picture in full. Every so often it stores a whole picture (a **keyframe**, or IDR frame) and, in between, only the differences from the previous one (**delta** frames, or P-frames). A keyframe plus all the delta frames that depend on it is a **GOP** (*Group of Pictures*).

Two consequences that shape everything else:

- **Decoding can only start at a keyframe.** A receiver that arrives mid-GOP must wait for the next keyframe or receive the GOP from its start.
- **If a frame is lost, the following frames of the same GOP are useless**, because they depend on it. What is lost is not recovered until the next keyframe (or until it is retransmitted).

The default GOP here is 60 frames at 60 fps: one keyframe per second.

### 2.2. Reliable and unreliable transport

- **TCP** delivers every byte, in order. If a packet is lost, everything behind it waits for the retransmission, even if it has already arrived. That is **head-of-line blocking**.
- **UDP** delivers individual packets without guarantees: they may be lost or arrive out of order, and nobody waits for anybody.
- **QUIC** runs over UDP and offers **many independent streams** inside one connection. Each stream is reliable and ordered internally, but a loss in one stream does not stop the others. It also allows **cancelling** a stream (stop retransmitting it) and **prioritising** some streams over others.

This is the underlying difference between the three branches: DASH uses a single reliable stream (TCP), WebRTC individual packets (UDP with selective retransmission) and MoQ many cancellable reliable streams (QUIC).

### 2.3. Congestion control

The algorithm with which the **sender** decides how fast it can send without saturating the network. Each branch uses a different one, and that affects the result as much as the protocol does:

| Branch | Who runs it | Algorithm |
| :--- | :--- | :--- |
| DASH | The Linux kernel of the server (TCP) | CUBIC, loss-based |
| MoQ | The relay (QUIC) | BBRv3 by default (`--quic-congestion-control delay`); alternative `loss` |
| WebRTC | mediasoup (default) | Bandwidth estimate from TWCC towards each viewer and choice of simulcast layer, without changing the encoder. With `RTC_SERVER=mediamtx`: no send-side adaptation, the stream is forwarded as it arrives |

With 1 % loss, CUBIC shrinks its window on every loss and stays below the video bitrate; BBR estimates the actual bandwidth and barely reacts. This is a confounder: part of what is observed "in MoQ" versus "in DASH" under loss is BBR versus CUBIC.

### 2.4. Buffer and live edge

The **live edge** is the most recent instant of content that already exists. The player always runs somewhat behind it, and that distance is media already received and not yet shown: the **buffer**. It is the cushion against network irregularities and, at the same time, most of the latency.

---

## 3. Side-by-side comparison

### 3.1. Design

| | LL-DASH | Media over QUIC | WebRTC |
| :--- | :--- | :--- | :--- |
| Model | Files over HTTP; the client pulls | Publish/subscribe; the server pushes | Point-to-point session; the server pushes |
| Transport | TCP | QUIC (over UDP) | RTP over UDP |
| Unit sent | CMAF fragment (one frame to a few hundred ms) | Frame | RTP packet (piece of a frame) |
| Unit dropped | None: everything arrives | Group (one GOP) | Packet; in practice, until the next keyframe |
| Reliability | Full | Full within a group; the group can be cancelled | Selective retransmission with a deadline |
| Head-of-line blocking | Across the whole stream | Only within a group | None |
| Encryption | TLS (with HTTPS) | TLS 1.3, mandatory in QUIC | DTLS + SRTP, mandatory |
| Scales with | Any HTTP CDN | MoQ relays | SFU servers |
| State on the server | None | Per subscription | Per connection, with continuous feedback |

### 3.2. Playback

| | LL-DASH | Media over QUIC | WebRTC |
| :--- | :--- | :--- | :--- |
| Browser API | MSE + `<video>` | WebTransport + WebCodecs + canvas | `RTCPeerConnection` + `<video>` |
| Who manages the buffer | `dash.js` | `@moq/watch` (Sync) | The browser |
| How it is set | `liveDelay` (Target latency slider) | `delay` (Target latency slider) | Automatic; a hint with `jitterBufferTarget` (Target buffer slider) |
| Typical buffer | Close to the target latency | Close to the target latency | Tens of milliseconds, adaptive |
| If the network stalls | The buffer empties and playback stops; then it speeds up or seeks to live | Playback stops and skips to the next group | Freezes until the next keyframe |

Because each branch has a buffer default of a different order, comparing latencies is to a large extent comparing buffer configurations; the three latency sliders mean different things ([section 4](#4-what-each-panel-control-does)).

### 3.3. Quality adaptation

| | LL-DASH | Media over QUIC | WebRTC (mediasoup, default) | WebRTC (MediaMTX) |
| :--- | :--- | :--- | :--- | :--- |
| Who decides | The client | The client | The server (SFU) | Nobody |
| With what information | Throughput of its own downloads and buffer level | Bandwidth estimate from the relay's congestion control (PROBE) | Bandwidth estimate towards the viewer (TWCC) | — |
| Algorithm | `dash.js` rules (throughput by default; L2A or LoL+ selectable) | Highest bitrate that fits a share of the estimate ([moq.md](moq.md)) | mediasoup's layer selection, default settings | — |
| How it switches | Requests the next segment from another Representation | Subscribes to another track, with overlap | Forwards another simulcast layer from its next keyframe | — |
| Granularity | One segment (2 s by default) | One group (1 s by default) | One GOP (1 s by default) | — |

### 3.4. Confounders

The differences between branches that are not the protocol itself (congestion control, who adapts, audio, buffer defaults, implementations measured, encoding designed for broadcast rather than interactive WebRTC, cost of reading MPEG-TS in each branch) are listed in [../limitations.md](../limitations.md).

---

## 4. What each panel control does

| Control | LL-DASH | Media over QUIC | WebRTC |
| :--- | :--- | :--- | :--- |
| **GOP** | How often there is a keyframe; segments must be multiples of it | Duration of each group: granularity of dropping and of start-up | How often the picture can recover after a loss, and how often mediasoup can switch layer |
| **DASH segment** (`-seg_duration`) | Size of each file and granularity of quality switching | No effect | No effect |
| **CMAF fragment** | How often the packager emits media | No effect | No effect |
| **Rendition ladder** | Representations `dash.js` chooses from | Tracks `@moq/watch` chooses from | mediasoup: simulcast layers it chooses from. MediaMTX: only the highest is used |
| **Target latency** / **Target buffer** | `liveDelay` | `delay` of Sync | `jitterBufferTarget` (a hint) |
| **Minimum buffer** | `liveCatchup.playbackBufferMin` (LoL+ catch-up) | — | — |
| **Seek to live** | `liveCatchup.maxDrift` | — | — |
| **ABR** | Rule set: default, L2A, L2A (bugfix), LoL+ | — | — |
| **Rendition** | Fixes the Representation and disables ABR | Fixes the track (`target.name`) | — (cannot be fixed) |
| **Emulated network** | Own queue in the router | Own queue in the router | Own queue in the router |
| **WebRTC audio** | — | — | Adds the source Opus track (`rtc_audio`); the browser then syncs video to the audio jitter buffer |
| **Pacer on the WebRTC ingest** | — | — | mediasoup only: paces the RTP of each rendition (`rtc_pacing`, declared experiment) |
| **Active players** | Off: does not download nor use the network | Off: does not download nor use the network | Off: does not download nor use the network |

---

## 5. Glossary

**ABR** (*Adaptive Bitrate*). Choosing the quality according to the state of the network.

**ANNOUNCE**. In MoQ, the mechanism by which available broadcasts are discovered.

**AST** (*availabilityStartTime*). In DASH, the wall-clock time at which the stream started.

**BBR**. Congestion control that estimates bandwidth and delay instead of reacting to losses.

**Broadcast**. In MoQ, a stream: a set of tracks under one name.

**Catalog**. In MoQ, the track that describes the other tracks of the broadcast.

**Chunk / CMAF fragment**. A `moof` + `mdat` pair: the smallest part of a segment that can be decoded.

**CMAF**. Fragmented MP4 format common to DASH and HLS.

**CUBIC**. Default TCP congestion control in Linux, loss-based.

**DTLS**. TLS adapted to UDP; in WebRTC it is used to agree the keys.

**Frame**. One encoded picture. In MoQ, also the smallest unit of the transport.

**GCC**. Google Congestion Control, the congestion control of WebRTC in browsers.

**GOP**. A keyframe and the frames that depend on it.

**Group**. In MoQ, a part of a track that can be decoded on its own; it travels in its own QUIC stream.

**hang**. Media format (catalog and container) of the `moq.dev` project.

**Head-of-line blocking**. A lost piece of data holding up the ones behind it even if they have already arrived.

**ICE**. WebRTC procedure to find a network path between two endpoints.

**Jitter**. Variation in packet arrival times.

**Keyframe / IDR**. A complete frame, decodable without any other.

**Live edge**. The most recent instant of content already available.

**Max age**. In MoQ, the maximum age of a group before it is skipped.

**MoQT**. *MoQ Transport*, the IETF draft.

**moq-lite**. A simplified subset of MoQT; the protocol this testbed negotiates.

**MPD**. The DASH manifest.

**MSE**. Browser API for feeding media to a `<video>` from JavaScript.

**NACK**. In WebRTC, a request to retransmit a specific packet.

**Object**. In MoQT, what moq-lite calls a frame.

**Origin**. In MoQ, the table of broadcasts a connection can serve or consume.

**PLI**. In WebRTC, a request for a new keyframe.

**PROBE**. In moq-lite, the message with which the sender reports its bitrate estimate and RTT.

**QUIC**. Transport protocol over UDP with independent streams, encryption and congestion control.

**Relay**. MoQ server that subscribes upstream and publishes downstream.

**Rendition**. One version of a content (one quality). DASH calls it a Representation.

**RTP / RTCP**. Real-time media transport protocol and its feedback channel.

**RTT**. Round-trip time of a packet.

**SDP**. Text format with which two WebRTC endpoints describe the session.

**Segment**. In DASH, each of the media files.

**SFU**. Selective Forwarding Unit: a WebRTC server that forwards streams (or one of several simulcast layers) to each viewer without re-encoding.

**Simulcast**. Sending several encodings of the same video at once so a server can pick one per viewer.

**SRTP**. Encrypted RTP.

**Track**. In MoQ, a sequence of groups of the same kind.

**TWCC**. Transport-wide congestion control feedback: per-packet arrival times sent back by the receiver, used to estimate bandwidth.

**WebCodecs**. Browser API to encode and decode frame by frame.

**WebTransport**. Browser API for QUIC streams and datagrams, over HTTP/3.

**WHEP**. Standard HTTP signalling for playing a WebRTC stream.
