# WebRTC

How the WebRTC branch works, from the ingest to `RTCPeerConnection` in the browser. The default server is **mediasoup** (an SFU with simulcast, `RTC_SERVER=mediasoup`); **MediaMTX** (`RTC_SERVER=mediamtx`) serves a single rendition without adaptation. Shared concepts are in [README.md](README.md); deployment of either server is in [../deployment.md](../deployment.md) and [../architecture.md](../architecture.md).

## 1. The idea

WebRTC was born for video calls: **interactive** communication, where arriving late is worse than arriving with defects. It works neither with files nor with reliable streams, but with **individual packets over UDP**, and prefers showing a degraded picture to waiting.

It is not one protocol but a stack of several, all mandatory:

```
┌──────────────────────────────────────────────┐
│ Signalling (outside WebRTC): WebSocket / WHEP │  agree the session
├──────────────────────────────────────────────┤
│ RTP / RTCP                                    │  media and feedback
├──────────────────────────────────────────────┤
│ SRTP                                          │  media encryption
├──────────────────────────────────────────────┤
│ DTLS                                          │  key exchange
├──────────────────────────────────────────────┤
│ ICE (STUN / TURN)                             │  find a network path
├──────────────────────────────────────────────┤
│ UDP                                           │
└──────────────────────────────────────────────┘
```

## 2. Setting up the session

**Signalling.** Both ends must agree codecs, addresses and keys before sending anything. WebRTC does not say how to carry that exchange; each server does it its own way:

- **mediasoup (default).** mediasoup is a library that does not speak SDP. The page uses `mediasoup-client` with the testbed's own signalling (`sfu/server.mjs`) over a **WebSocket** connection straight to the SFU on **8189/tcp**, through the emulation router (not through `nginx-web`), so signalling suffers the same network profile as the video. From an HTTPS page it uses `wss://` with the `SERVER_HOST` certificate; from an HTTP page, `ws://` to the page's address (`rtc_signal_port` and `rtc_tls_host` in `GET /api/status`). **The session lives as long as that connection**: when the page reloads, the player is unmounted or the browser dies, the SFU closes the session at once.
- **MediaMTX.** Uses **WHEP** (*WebRTC-HTTP Egress Protocol*), the standard way to play: a single HTTP `POST` with an SDP **offer** in the body and the SDP **answer** in the response, to `<host>:8189/<path>/whep`, straight to MediaMTX through the emulation router (HTTPS with the `SERVER_HOST` certificate, plain HTTP in local mode), so like mediasoup's it suffers the network profile. Only signalling goes over HTTP; media then goes over UDP.

**ICE.** The procedure to find a network path between the two ends. Each gathers **candidates** (IP addresses and ports at which it could be reached), exchanges them, and tries combinations until one works. Usually **STUN** servers (to discover the public IP) and **TURN** servers (to relay when there is no direct path) are needed. Here it is simpler: the server has a reachable address and announces it directly as its candidate (mediasoup's `announcedAddress`, the IP that `SERVER_HOST` resolves to or `SERVER_IP`; MediaMTX's `MTX_WEBRTCADDITIONALHOSTS`, `SERVER_IP` or `SERVER_HOST`; `127.0.0.1` in local mode). There is no STUN or TURN. All media traffic uses a single UDP port, 8189 (mediasoup's `WebRtcServer`, or MediaMTX's local UDP address), so the router and its queues are the same for both servers.

**DTLS and SRTP.** Over the chosen path a **DTLS** handshake (TLS adapted to UDP) produces the keys. Media is encrypted with **SRTP**. The certificate fingerprint travels in the signalling, so no certificate authority is needed.

## 3. How media travels

**RTP.** Each packet carries a header with a **sequence number** (to detect losses and reorder), a **timestamp** (to know when it is shown) and a stream identifier (**SSRC**).

A video frame does not fit in one UDP packet (about 1200 useful bytes), so it is **split**. A 1080p keyframe can take dozens of packets (more than a hundred at 4 Mbit/s). The frame can only be decoded when all of them have arrived.

**RTCP.** The return channel. The receiver tells the sender what it is getting:

| Message | Function |
| :--- | :--- |
| *Receiver report* | Statistics: losses, jitter. |
| **NACK** | "Packet N is missing": requests a specific retransmission. |
| **PLI** / FIR | "I have lost the reference": requests a new keyframe. |
| **TWCC** / REMB | Packet arrival times, from which the sender estimates bandwidth. |

## 4. Loss recovery

Unlike TCP and QUIC, retransmission here is **selective and has a deadline**:

1. A packet is missing. The receiver sends a NACK.
2. If the retransmission arrives in time to show the frame, nothing is noticed.
3. If not, the frame is discarded. The following ones depend on it, so the picture freezes.
4. The receiver sends a PLI to request a keyframe. In a video call the encoder produces one immediately and the picture returns.

In this testbed step 4 has a limitation: **neither server encodes; they only forward**. Nobody can produce a keyframe on request, so the receiver has to wait for the next keyframe of the stream, which comes once per GOP (1 s by default). With mediasoup, the SFU sends keyframe requests upstream, and the ingest relay (`server/app/rtprelay.py`) reads and discards them. With MediaMTX the ingest is a gate (or an FFmpeg that only copies), so nobody can serve them either. This is a declared confounder ([../limitations.md](../limitations.md)).

## 5. The jitter buffer

Packets arrive with irregular spacing and sometimes out of order. The **jitter buffer** holds them just long enough to reorder them, wait for retransmissions and deliver frames at a steady pace.

It is **adaptive and managed by the browser**: it measures the variation of arrival times and continuously adjusts its size. With a good network it drops to tens of milliseconds; if the network worsens, it grows on its own.

The page can only **suggest** a minimum with `jitterBufferTarget` (the **Target buffer** slider). The browser treats it as a hint, not an order. In "auto" nothing is requested.

## 6. Congestion control and adaptation

In a video call, the sender estimates bandwidth from TWCC feedback (the **GCC** algorithm, *Google Congestion Control*) and **tells the encoder to change bitrate** on the fly. Adaptation happens in the encoder, not by choosing among ready-made versions. To serve many viewers, **simulcast** is used (the sender emits several qualities and a server picks which to forward to each viewer) or **SVC** (one layered stream).

**In this testbed, with mediasoup: simulcast.** The SFU receives every rendition of the ladder as a simulcast layer, estimates the bandwidth towards each viewer and chooses which layer to forward, with its default settings: the testbed sets no preferred layers, no limits and no `initialAvailableOutgoingBitrate`. A layer switch takes effect at the next keyframe of the new layer. The encoder receives no feedback: it neither changes bitrate nor serves keyframe requests. If the estimate falls below the bitrate of the lowest layer, mediasoup stops sending video and the picture freezes until the player's watchdog recreates the connection (measured).

**With `RTC_SERVER=mediamtx`: no adaptation.** It sends a single rendition, the highest, without re-encoding. If the link cannot carry it, there is no lower rendition to fall back to: packets are lost and the picture freezes.

Known behaviour of mediasoup's estimator, measured on the testbed: it underestimates the link and stays on low layers, recovering very slowly once a limit is removed; the result depends on the router queue and the GOP. Details and conditions in [../adaptation-and-experiments.md](../adaptation-and-experiments.md) and [../limitations.md](../limitations.md).

## 7. The path in this testbed

**With mediasoup (default):**

```
FFmpeg -> UDP 5003 -> tsgate -> FFmpeg (-c copy, one RTP output per rendition) -> rtprelay.py (one socket) -> mediasoup -> router -> browser
```

1. **Ingest.** In the packager process (not in the master source), an FFmpeg copies the ladder without re-encoding into one RTP output per rendition. FFmpeg's RTP muxer uses one socket per track, and mediasoup's `PlainTransport` accepts a single source (comedia), so `rtprelay.py` forwards RTP and RTCP unchanged over one socket. The Sender Reports are essential: without them mediasoup does not switch layers. Optionally, the **Pacer on the WebRTC ingest** (`rtc_pacing`, a declared experiment, off by default) spreads the RTP of each rendition over time at 2.5 times its nominal bitrate (`RTC_PACING_FACTOR`), imitating a WebRTC publisher that paces its output; it delays what waits in its queue, keyframes above all, and that delay enters glass-to-glass and not the server stages ([../adaptation-and-experiments.md](../adaptation-and-experiments.md)).
2. **Server.** `sfu/server.mjs` is a minimal application around the mediasoup library: one worker, ingest on `/ingest` (internal network only), viewer signalling over WebSocket, one UDP port (8189). Diagnostics at `GET /health` on its internal HTTP port, layer changes in `docker logs testbed-sfu`, and, with `SFU_TRACE=1`, the estimate and probes in the same log.
3. **Browser.** `mediasoup-client` creates a receive transport and consumes the video (and audio) producers; underneath it is an `RTCPeerConnection` that receives, reorders, decodes and paints into a `<video>`.

**With MediaMTX:**

1. **Ingest.** The gate sends the MPEG-TS over UDP straight to MediaMTX, with only the first (highest) video rendition and, with `rtc_audio`, the audio, rewriting the PMT to announce only those tracks; packets pass untouched. There are two fixed paths, `liveudp` (video only) and `liveudpa` (video and audio), because MediaMTX fixes the tracks of a UDP path the first time it reads it. The CSV records it in `rtc_ingest` (`udp`).
2. **Server.** MediaMTX splits the H.264 into RTP packets and sends them to each connected browser.
3. **Browser.** `RTCPeerConnection` receives, reorders, decodes and paints.

**Audio (both servers).** Off by default. With **WebRTC audio** (`rtc_audio`), the source Opus audio is added without re-encoding. The browser then synchronises audio and video: the video jitter-buffer target rises to that of the audio (measured with `getStats()`). With the looped file, the audio asks for about 40 ms and latency rises little; with the camera, whose audio arrives with more jitter, it asks for 225-315 ms and latency rises by 100-200 ms (measured with MediaMTX). A connection opened in the first seconds of the stream also stays 45-55 ms higher for the whole session (measured); that is why the dashboard waits until the stream has been published for 8 s before connecting.

That the source uses no B-frames (`zerolatency`) matters here: WebRTC in browsers does not handle them well.

## 8. Where its latency comes from

- **Ingest**: milliseconds. Reading the MPEG-TS holds back about 1 frame in MediaMTX, and more in the FFmpeg of the mediasoup ingest; in WebRTC that cost falls inside the "publication and transport" stage ([mpeg-ts.md](mpeg-ts.md), [../limitations.md](../limitations.md)).
- **Network**: UDP direct, no waiting for order.
- **Jitter buffer**: tens of milliseconds, adaptive.

Locally, with one rendition (1080p, 4 Mbit/s) and no network limit, glass-to-glass was 48-50 ms with MediaMTX and 60-72 ms with mediasoup (measured, alternating runs): mediasoup adds 12-22 ms. It is the branch with the lowest latency and also the one with the least margin.

## 9. The player: `RTCPeerConnection` inside

In this branch **there is no playback library**. The player is the browser itself, through the standard `RTCPeerConnection` API. The page only sets up the session and connects the result to a `<video>` element (`web/src/lib/rtcSession.ts`, `web/src/components/RtcPlayer.tsx`).

This is the underlying difference from the other two branches:

| Branch | Where the playback logic lives | How much control the page has |
| :--- | :--- | :--- |
| DASH | In JavaScript (`dash.js`), until the bytes are handed over | A lot: what to request, quality, rate. |
| MoQ | In JavaScript (`@moq/watch`), down to painting each frame | Total: every frame goes through page code. |
| WebRTC | In the browser, entirely | Almost none: a buffer hint and read-only statistics. |

**What the browser does on its own**, without the page intervening:

```
UDP ─▶ ICE ─▶ DTLS/SRTP ─▶ RTP ─▶ jitter buffer ─▶ decoder ─▶ <video> ─▶ screen
              (decrypts)    │      (reorders, waits     (H.264)
                            │       for retransmissions)
                            └─▶ RTCP to the server: NACK, PLI, TWCC, receiver reports
```

It receives packets, decrypts them, rebuilds each frame from its pieces, requests missing retransmissions, decides how long to hold each frame, decodes and paints it.

**What the page does with mediasoup**, step by step:

1. **Opens the WebSocket** to the SFU and asks for a `session`: the SFU creates a WebRTC transport and returns its router RTP capabilities, ICE parameters, ICE candidates and DTLS parameters.
2. **Loads a `mediasoup-client` `Device`** with those capabilities and creates a receive transport.
3. **Connects**: when the transport needs it, sends its DTLS parameters (`connect`).
4. **Consumes**: sends its own RTP capabilities (`consume`, with or without audio) and creates one consumer per producer offered; the video receiver is kept to apply `jitterBufferTarget`.
5. **Resumes** the consumers (`resume`) and attaches the tracks to the `<video>`.
6. **Polls the SFU** once per second (`stats`) for the estimate towards this viewer and the layer being sent (`rtc_bw_estimate_kbps`, `rtc_selected_height`).

**What the page does with MediaMTX (WHEP)**, step by step:

1. **Creates the connection**, without STUN or TURN servers: `new RTCPeerConnection()`.
2. **Declares what it wants to receive**: one receive-only video transceiver (`addTransceiver('video', { direction: 'recvonly' })`), plus one for audio with `rtc_audio`.
3. **Generates the SDP offer** and waits for the browser to gather its ICE candidates, up to 2 s.
4. **Sends it by WHEP**: a `POST` to `<host>:8189/<path>/whep` (`liveudp`, or `liveudpa` with audio; the path is given by `rtc_path` in `GET /api/status`) with the offer in the body (`Content-Type: application/sdp`).
5. **Applies the SDP answer** returned by MediaMTX.
6. **Connects the video**: when the browser signals that the track is arriving, assigns it to the `<video>` (`video.srcObject`).

From step 5 on, the browser and MediaMTX complete ICE and DTLS on their own and video starts arriving.

**WHEP in detail.** A minimal protocol: all signalling is one request and its response.

```
POST /liveudp/whep
Content-Type: application/sdp

v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
...                                  ← the offer: "I want to receive video, I accept these codecs,
                                        these are my candidates and my DTLS fingerprint"

201 Created
Content-Type: application/sdp

v=0
...                                  ← the answer: "I am sending you H.264, this is my candidate
                                        (the server address, UDP port 8189) and my fingerprint"
```

The testbed uses the **non-trickle** variant: instead of sending ICE candidates as they appear, it waits until it has them all and sends them inside the offer. It is simpler and costs at most those 2 s when connecting. On close, the page closes the connection without telling MediaMTX over HTTP; the server considers it finished when it stops receiving traffic.

**What is negotiated with MediaMTX.** In a MediaMTX answer captured in a test, H.264 video was agreed with these feedback mechanisms:

| Mechanism | What it allows |
| :--- | :--- |
| `nack` | The browser requests retransmission of specific packets. |
| `nack pli` | It requests a new keyframe. |
| `transport-cc` | It reports arrival times, for bandwidth estimation. |

The playout-delay extension, with which a server can impose a minimum or maximum buffer on the receiver, was not negotiated. The buffer is left entirely to the browser. The codecs registered in the SFU are H.264 Constrained Baseline (`profile-level-id` `42e01f`, `packetization-mode` 1) and Opus, and its ingest producer declares `nack pli` and `ccm fir` feedback so mediasoup requests keyframes as it does by default.

**The available control.** Only one has an effect on playback:

| Control | Default | Here | Effect |
| :--- | :--- | :--- | :--- |
| `RTCRtpReceiver.jitterBufferTarget` | Unset | **Target buffer** slider: auto, or 50 to 2000 ms | Suggests a jitter-buffer size to the browser. A hint, not an order. |

There is no rendition selector nor ABR in the page: with MediaMTX the server sends one stream, and with mediasoup the server chooses the layer.

**What the page can read.** `getStats()` returns the browser's internal statistics. The testbed queries them every 500 ms and uses these:

| Statistic | Used for |
| :--- | :--- |
| `bytesReceived` (of the video `inbound-rtp`) | Received video bitrate. |
| `bytesReceived` (of the `transport`) | Total download, including RTCP and retransmissions. |
| `jitterBufferDelay`, `jitterBufferEmittedCount` | Mean time each frame spent in the jitter buffer since the previous sample. |
| `frameHeight` | Received resolution, and quality switches when it changes. |
| `packetsLost` | Lost packets. |

Others the browser offers that help diagnosis: `nackCount` and `pliCount` (how many retransmissions and keyframes it requested), `jitter`, `totalDecodeTime` and `framesDecoded`.

**What the testbed adds around it:**

- **Join delay.** The player waits until the stream has been published for 8 s before connecting (see audio in [section 7](#7-the-path-in-this-testbed)).
- **Retry.** If negotiation fails, typically just after a start because the server does not have the stream yet, it is retried every 1.5 s.
- **Watchdog.** As in the other branches: 10 s without a new picture (after a 20 s grace period) and the connection is recreated (`rtc_player_restarts`). With mediasoup, a closed signalling connection ends the session, and the watchdog then recreates it.
- **Measurement.** The timecode is read from the `<video>`. The arrival time of each frame is given by the browser with each presented frame; the split between "transport" and "buffer" in the per-stage breakdown is not reliable in this branch ([../latency-measurement.md](../latency-measurement.md)).
