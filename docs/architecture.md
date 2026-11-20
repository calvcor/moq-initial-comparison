# Architecture

One FFmpeg process encodes the source once and hands the same H.264 bitstream to three delivery branches: **LL-DASH** (CMAF over HTTP/1.1 chunked transfer), **Media over QUIC** (WebTransport) and **WebRTC**. No branch re-encodes: the packagers copy the stream (`-c copy`). The browser plays the three side by side and measures them with the same method (see [measurement.md](measurement.md)). Between the browser and the servers sits a router that emulates the network, one queue per protocol and direction (see [network-emulation.md](network-emulation.md)). How to deploy it is in [deployment.md](deployment.md); how each protocol works, in [protocols/README.md](protocols/README.md).

## Overview

```
                 ┌──────────────────────────────────────────────────────┐
                 │ Master source (FFmpeg, x264 ultrafast zerolatency)   │
                 │ BBB 1080p60 or ToS 1080p24 in a loop, or RTSP camera │
                 │ + text clock + burnt-in binary timecode, 1-5 rungs   │
                 └───────┬─────────────────┬─────────────────┬──────────┘
            MPEG-TS/UDP  │ :5001           │ :5002           │ :5003     (:5004 QoE recorder, :5005 camera reference)
                         ▼                 ▼                 ▼
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐
                 │ tsgate.py    │  │ tsgate.py    │  │ tsgate.py                │
                 └──────┬───────┘  └──────┬───────┘  └──────┬───────────────────┘
                        ▼                 ▼                 ▼
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐
                 │ FFmpeg       │  │ moq import ts│  │ mediasoup: FFmpeg → RTP  │
                 │ -f dash CMAF │  │ (publisher)  │  │ → rtprelay.py → SFU      │
                 └──────┬───────┘  └──────┬───────┘  │ MediaMTX: MPEG-TS/UDP    │
         HTTP PUT chunked                 │ QUIC     │                          │
                        ▼                 ▼          └──────┬───────────────────┘
                 ┌──────────────┐  ┌──────────────┐         │
                 │ origin.py    │  │ moq-relay    │         │
                 │ (in memory)  │  │ :4433/udp    │         │
                 └──────┬───────┘  └──────┬───────┘         │
                        ▼                 │                 │
                 ┌──────────────┐         │                 │
                 │ nginx-dash   │         │                 │
                 │ unbuffered   │         │                 │
                 └──────┬───────┘         │                 │
                        ▼                 ▼                 ▼
                 ┌──────────────────────────────────────────────────────┐
                 │ Emulation router (iptables DNAT + tc/netem)          │
                 │ 8443, 8080/tcp → DASH · 4433/udp → relay ·           │
                 │ 8189/udp+tcp → WebRTC server                         │
                 └───────┬─────────────────┬─────────────────┬──────────┘
            HTTP/1.1     │    WebTransport │     ICE/DTLS/SRTP│
                         ▼                 ▼                 ▼
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
                 │ dash.js      │  │ @moq/watch   │  │ RTCPeerConn. │
                 │ <video>+MSE  │  │ WebCodecs    │  │ <video>      │
                 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
                        └─────────────────┼─────────────────┘
                                          ▼
                 ┌──────────────────────────────────────────────────────┐
                 │ React dashboard (served by nginx-web, 80 / 443)      │
                 │ timecode read from pixels · statistics · CSV export  │
                 └──────────────────────────────────────────────────────┘
```

## Containers

| Container | Image | Published ports | Role |
| :--- | :--- | :--- | :--- |
| `testbed-nginx-web` | `nginx:alpine` | 80/tcp, 443/tcp (server mode) | Page and control path, not through the router: dashboard (`/`), API (`/api`, `/docs`, `/openapi.json`), relay certificate fingerprint (`/certificate.sha256`). No media or WebRTC signalling passes through it |
| `testbed-router` | Alpine + `tc` + `iptables` + Python agent | 8443/tcp, 8080/tcp, 4433/udp, 8189/udp, 8189/tcp | The only way from the browser to the media servers. Forwards at the IP level (DNAT) and emulates the network: one queue per protocol and direction, with per-client slots for parallel tests. HTTP agent on 9000 for the orchestrator |
| `testbed-orchestrator` | Python 3.12 + FastAPI + FFmpeg (Debian package) + moq-cli + vmaf | none | Master source, packagers and publishers, in-memory LL-DASH origin, supervisor, control and measurement API, campaigns, QoE |
| `testbed-nginx-dash` | `nginx:alpine` | none | LL-DASH, reached only through the router: forwards `/media/dash/` to the origin with `proxy_buffering off`; TLS on 443 in server mode, plain HTTP on 80 in local mode. HTTP/1.1 only |
| `testbed-cert` | `neilpang/acme.sh` | none | Obtains and renews the Let's Encrypt certificate for `SERVER_HOST` (DNS challenge with `ACME_DNS`). Idle in local mode |
| `testbed-moq-relay` | `moqdev/moq-relay` or built from a commit (`relay/Dockerfile`) | none | MoQ relay: fans out what the publisher sends. Certificate of `SERVER_HOST` in server mode; self-signed in local mode, with its fingerprint on 8081 |
| `testbed-sfu` | `sfu/` (Node + mediasoup) | none | Default WebRTC server (`RTC_SERVER=mediasoup`): receives every rendition over RTP and picks each viewer's layer |
| `testbed-mediamtx` | the `bluenviron/mediamtx` binary on Alpine (`mediamtx/Dockerfile`, which adds the TLS start-up) | none | Alternative WebRTC server (`RTC_SERVER=mediamtx`): receives the top rendition over UDP and serves it over WHEP |
| `testbed-web` | React 19 + Vite + Tailwind, served by nginx | none | Dashboard, with COOP/COEP headers for `SharedArrayBuffer` |

Exact versions are in [Pinned versions](#pinned-versions).

## Networks

There are two Docker networks, so the path has two segments:

- **`default`** (browser side). The host's published ports land here: `nginx-web` and the router. The orchestrator is also attached, for downloads and to reach the outside.
- **`core`** (`172.30.50.0/24`, internal). The media servers, the orchestrator and one leg of the router live here. Ingest (orchestrator → nginx-dash, relay, SFU, MediaMTX) runs over this network and is never degraded.

The browser reaches the media servers only through the router, which rewrites the destination (DNAT) to the server's fixed address in `core` and masquerades the source, so replies come back through it and cross the emulation in both directions. The page and the API go through `nginx-web` and are not degraded. The WebRTC signalling (mediasoup's WebSocket or MediaMTX's WHEP) goes through the router (8189/tcp, in the WebRTC queue) and is degraded like the media.

The media servers have fixed addresses in `core`. Only the router needs them: its forwarding (iptables DNAT) and its classification into queues (tc filters) match packet addresses, are set up once at start, and would silently point to nothing if a server came back with another address. Everything else (the orchestrator, `nginx-web`) reaches the services by their Compose name. Automatic addresses come from `172.30.50.128/25`, so they never take a fixed one:

| Address | Service |
| :--- | :--- |
| `172.30.50.2` | router (agent on `:9000`) |
| `172.30.50.10` | nginx-dash |
| `172.30.50.11` | moq-relay |
| `172.30.50.12` | MediaMTX |
| `172.30.50.13` | SFU |

The router's internals (tc tree, classification, profiles, counters) are in [network-emulation.md](network-emulation.md).

## Ports

Published ports and what crosses the router are in [deployment.md](deployment.md#ports). Internal ports:

| Port | Where | Use |
| :--- | :--- | :--- |
| 5001-5004/udp | orchestrator (loopback) | Master source outputs: DASH, MoQ, WebRTC, QoE recorder |
| 5005/udp | orchestrator (loopback) | Camera reference for VMAF (camera source only) |
| 5010/udp | orchestrator (loopback) | Frame timestamps from the TS gates to `trace.py` |
| 5020+/udp | orchestrator (loopback) | RTP and RTCP of each rendition, FFmpeg → `rtprelay.py` (mediasoup) |
| 8000/tcp | orchestrator | API and LL-DASH origin (FFmpeg publishes to `127.0.0.1:8000/media/dash/`) |
| 4433/udp, 8081/tcp | moq-relay | QUIC; certificate fingerprint over HTTP |
| 8189/udp+tcp, 8890/tcp | SFU | WebRTC (`WebRtcServer`) and signalling; ingest and diagnostics (`/ingest`, `GET /health`, internal only) |
| 8189/udp+tcp, 5003/udp, 5013/udp | MediaMTX | WebRTC and WHEP (HTTPS in server mode); MPEG-TS ingest without and with audio |
| 9000/tcp | router | Agent API, used only by the orchestrator (`ROUTER_URL`, `http://router:9000`) |

## Media pipeline

### Master source

A single FFmpeg reads the source in real time and sends it to every branch:

```bash
ffmpeg -re -stream_loop -1 -i <video> -re -stream_loop -1 -i <video> \
  -filter_complex "[0:v]setpts=N/(60*TB),drawtext=<clock>,split=N[s0]..[sN]; \
                   [s0]scale=1920:1080,drawtext=<rendition label>,<binary timecode>[v0]; ..." \
  -filter_complex "[1:a:0]asetpts=N/(SR*TB)[a]" \
  -map [v0] ... -map [vN] -map [a] \
  -c:v libx264 -preset ultrafast -tune zerolatency -threads 4 -x264opts repeat-headers=1 \
  -b:v:0 <kbps>k -maxrate:v:0 <1.2 x kbps>k -bufsize:v:0 <kbps>k ... \
  -g <gop> -keyint_min <gop> -sc_threshold 0 -r 60 -c:a libopus -ac 2 -b:a 128k -max_interleave_delta 1 \
  -f tee "[f=mpegts:pes_payload_size=0]udp://127.0.0.1:5001?pkt_size=1316|...5002|...5003|...5004"
```

- **Two inputs of the same file**, one for video and one for audio. The MP4 interleaves both in 0.5 s blocks; with a single real-time input the audio arrives in bursts and the muxer holds the video back.
- **Audio in its own filter graph, and `-max_interleave_delta 1`.** In the same graph FFmpeg advances the video at the pace of the file's audio frames and the muxer holds each video frame until it has later audio, so video leaves in bursts. With both settings the inter-frame spacing at the output matches the no-audio case (measured: p95 24 ms, no gap above 50 ms, against p95 45 ms and one gap above 50 ms per second without them) and the encoding stage drops from about 30 to about 10 ms. Detail in [protocols/mpeg-ts.md](protocols/mpeg-ts.md).
- **`pes_payload_size=0`**: one PES per audio frame. By default MPEG-TS groups about 180 ms of audio, which delays the video downstream.
- **Audio in Opus**, the only codec all three branches carry without transcoding: DASH in CMAF (`audio/mp4`, `codecs="opus"`), MoQ as track `1.opus`, WebRTC as is when its audio is enabled. Alternating AAC and Opus made no measurable difference to encoder delay or to any branch's latency.
- **Rendition ladder**: 1 to 5 renditions encoded live (default 1080p@4000, 720p@2000 and 360p@700 kbps), all at the source frame rate and with the same GOP so their keyframes align. They travel as several video streams of one MPEG-TS.
- **Rate cap**: each rendition has `-maxrate` at 120 % and a 1 s VBV, so the nominal bitrate is a reliable reference for adaptation and network emulation.
- **Rendition label** burnt in at the top right (`720p 2000 kbps`), to see at a glance which one is playing.
- **Binary timecode** burnt into each rendition after scaling; it is what the dashboard reads (see [latency-measurement.md](latency-measurement.md)).
- **Outputs**: UDP 5001 (DASH), 5002 (MoQ), 5003 (WebRTC) and 5004, which is only listened to while a QoE test records (see [qoe.md](qoe.md)); with nobody listening, the kernel drops its packets. With the camera there is a fifth output, 5005 (camera reference).

Changing the GOP, the ladder or the source restarts the source; changing segment or fragment duration only restarts the packagers. **Stop pipeline** also stops the source, which is what uses CPU, and leaves the server idle; the stop survives container and host restarts (marker `media/.stopped`).

Any new output of the master source shares the process with the ladder and can slow it down, because FFmpeg advances all outputs together. Measure the encoder delay (`POST /api/trace`, see [api.md](api.md)) with and without it.

### Tears of Steel

The source can also loop *Tears of Steel* (`source: "tos"` in `POST /api/config`; "Tears of Steel in a loop (24 fps)" in the panel and the campaign editor), a live-action short with computer graphics, with more grain, camera motion and cuts than an animation. It is downloaded from Blender as `tears_of_steel_1080p.mov.zip` (H.264 Main 1920x800 at 24 fps, MP3 stereo at 44.1 kHz, 734 s). It is handled like Big Buck Bunny (two inputs, `-re`, `setpts=N`) with three differences:

- **Emitted at its own 24 fps.** Converting to 60 would duplicate frames (which x264 encodes almost for free, making the content look easier than it is) and frame n of the stream would no longer be frame n of the original, which VMAF relies on. The server forces `fps` to 24 with this source, and the panel keeps the GOP duration in seconds when switching (60 frames at 60 fps become 24 at 24 fps).
- **Black bars up to 1920x1080** (`pad`, no scaling), added before the clock and the timecode. The clock falls in the top bar. The bars count in VMAF and PSNR like the rest of the picture; the original is compared with the same bars.
- **Audio resampled to 48 kHz** (`aresample=48000`) before Opus, which does not accept 44.1 kHz.

Confounders against Big Buck Bunny (deduced from the change, not measured): content and frame rate change together. A frame lasts 41.7 ms, so latency is measured at that resolution and a "1 frame" CMAF fragment lasts 41.7 ms; each frame gets 2.5 times more bits at the same bitrate; the same GOP in frames lasts 2.5 times longer; the input stage of each branch, which holds 1-3 frames ([protocols/mpeg-ts.md](protocols/mpeg-ts.md)), holds 2.5 times longer; and the meter's stall threshold (150 ms without a new picture) equals 3.6 frames instead of 9. In the CSV, `source` is `tos` and `fps` is 24.

### RTSP camera

With **Source: RTSP camera** (`"source": "camera"` in `POST /api/config`), the master source reads the camera at `CAMERA_RTSP_URL` instead of the file (configuration in [deployment.md](deployment.md#environment-variables)). Everything after the input is the same: ladder, clock, timecode, x264 with the same GOP, the same UDP outputs. The input changes:

```bash
ffmpeg -rtsp_transport tcp -timeout 5000000 -fflags nobuffer -flags low_delay -i <camera> \
  -filter_complex "[0:v]fps=<fps>,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2, \
                   setsar=1,setpts=N/(<fps>*TB),split=2[reference][base];[base]drawtext=<clock>,split=N[s0]..[sN]; ..." \
  -filter_complex "[0:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[a]" \
  -filter_complex "anullsrc=r=48000:cl=stereo,asetpts=N/(SR*TB)[reference_audio]" \
  <ladder, as with the loop> -f tee "...5001|...5002|...5003|...5004" \
  -map [reference] -map [reference_audio] -c:v libx264 -preset ultrafast -tune zerolatency -qp 10 -threads 4 \
  -g <gop> -keyint_min <gop> -sc_threshold 0 -c:a libopus -muxdelay 0 -muxpreload 0 -f mpegts udp://127.0.0.1:5005
```

- **No `-re`**: the camera delivers at its own pace.
- **Frame rate**: the camera's announced fps, rounded. The server probes it with `ffprobe` when starting with the camera and replaces the configured `fps`; the panel shows it next to the selector. `CAMERA_FPS` overrides it. The `fps` filter yields a constant rate on the camera's own timestamps: a lost camera frame repeats the previous one. The GOP stays in frames, so its duration depends on the fps; the panel offers the same durations (0.25 to 2 s) in frames of the current rate.
- **1920x1080**: each frame is brought to 1080p (with bars if the camera is not 16:9) before the ladder.
- **Audio**: the camera's, resampled to 48 kHz stereo and encoded in Opus, on the camera's timestamps (`aresample=async=1`); generated silence if the camera has no microphone. Measured: it does not slow the ladder (encoder delay p50 5.6-6.2 ms with camera audio against 5.6-7.0 with silence, p95 10-11 ms in both), and audio and video stay aligned within 13 ms in the recorded stream.
- **VMAF reference (UDP 5005)**: there is no stored original, so the source emits each frame as it enters the ladder, before anything is drawn on it, encoded almost losslessly (`-qp 10`). It is only recorded during QoE tests; otherwise nobody listens and the kernel drops it. It shares the process with the ladder; with `-tune zerolatency` it does not hold it back (measured with the camera at 15 fps, one 1080p rendition, no viewers: encoder delay p50 5.4-5.7 ms with the reference against 5.8-5.9 ms without it; without `zerolatency`, x264's frame threading raised it to 76-106 ms).
- **Failures**: if the camera stops answering for 5 s, FFmpeg exits and the supervisor relaunches the source, at least 3 s apart.

The URL is never exposed: `GET /api/camera` and `/api/status` give only the host, what the camera announced (codec, resolution, fps, audio) and the last error. FFmpeg does write it to its log inside the container (`/tmp/ffmpeg_master.log`).

Confounders of the camera source:

- **Latency starts at the same point**, when the timecode is burnt in, which is after receiving and decoding the camera. It does not include camera → server (sensor, camera encoder, network).
- **The content does not repeat.** A nearly still scene encodes well below the nominal bitrate, with different keyframes, and scores higher VMAF. Camera tests are not comparable with loop tests nor with each other; within one test the three branches see exactly the same thing.
- **The input is irregular.** Camera network jitter reaches the three branches through the `fps` filter. WebRTC sees it as arrival jitter (measured with `getStats()`: 19-27 ms on video and 27-28 ms on audio with the test camera, against 0-2 and 5-7 ms with the loop), its jitter buffer grows accordingly, and WebRTC latency without audio went from 59-71 ms with the loop to 244-329 ms with the camera (MediaMTX).
- **Clock drift**: the rate follows the camera's timestamps; if its clock drifts from the server's, it shows in `dash_availability_drift_ms`.

### TS gate

Every branch reads its UDP port through `server/app/tsgate.py`, which:

- drops everything up to the first video keyframe and prepends the PAT/PMT, so audio and video start together in every branch (otherwise FFmpeg, with `-c copy`, would keep earlier audio and the video would start up to one GOP off the DASH segment grid);
- watches the MPEG-TS continuity counters and logs any jump (loss in the internal UDP fan-out), which the orchestrator counts as an ingest anomaly;
- records two times per video frame (by PTS) and sends them to `trace.py` for the per-stage latency breakdown: when its last packet reached the kernel (`SO_TIMESTAMPNS`, the "encoder output") and when the gate read and forwarded it. The gate writes to a pipe and blocks if the packager does not drain it, so the difference is how long the frame waited for the packager.

With `--udp HOST:PORT` the output goes over UDP (datagrams of up to 7 TS packets) instead of stdout; with `--first-video` only the first video stream (the top rendition) passes, plus the audio with `--audio`, and the PMT is rewritten to announce only those tracks. Packets of the kept tracks pass untouched. This is how MediaMTX reads the WebRTC stream.

Reading MPEG-TS holds frames back at the entry of each packager (1 frame in MediaMTX, 2 in the MoQ publisher, 3 in FFmpeg), and only in DASH does it fall in the input stage; see [protocols/mpeg-ts.md](protocols/mpeg-ts.md).

### LL-DASH branch

```bash
python3 tsgate.py 5001 dash | ffmpeg -analyzeduration 1000000 -i pipe:0 \
  -map 0:v -map 0:a:0 -c:v copy -c:a copy -tag:v avc1 -b:v:0 <kbps>k ... \
  -f dash -dash_segment_type mp4 -adaptation_sets "id=0,streams=v id=1,streams=a" -seg_duration <seg> \
  -frag_type duration -frag_duration <frag> \
  -streaming 1 -ldash 1 -use_template 1 -use_timeline 0 -utc_timing_url /media/dash/utc \
  -window_size <30 s in segments> -extra_window_size <same> \
  -method PUT -http_persistent 1 http://127.0.0.1:8000/media/dash/manifest.mpd
```

- **HTTP PUT to the in-memory origin** (`server/app/origin.py`). Each segment is served to clients while FFmpeg is still writing it, fragment by fragment, with chunked transfer encoding. Writing to disk, FFmpeg would only expose a segment once complete.
- **All renditions in one AdaptationSet**, so dash.js can switch; the bitrate is declared (`-b:v:N`) because with `-c copy` FFmpeg does not know it.
- **`-use_timeline 0`** makes the manifest announce `availabilityTimeOffset`, which lets dash.js request the segment in progress.
- **`-frag_type duration`** is needed for `-frag_duration` to take effect. The **1 frame** option (`frag_duration` = 0 in the API and the CSV) uses `-frag_type every_frame` instead: one fragment per frame, 16.7 ms at 60 fps (120 per 2 s segment; Opus audio, one per 20 ms frame). The manifest then announces an `availabilityTimeOffset` of 1.983 s on video.
- **`-dash_segment_type mp4`**: with Opus, FFmpeg would otherwise put the audio track in WebM.
- **Calibrated `availabilityStartTime`**: the origin replaces the one FFmpeg writes (late by its input probing) with the one deduced from the real instant each segment is opened. The manifest is not published until it has it, a few seconds after each start.
- **`UTCTiming`** is `/media/dash/utc`, served by the origin. The URL is relative to the manifest, so dash.js syncs its clock through the router, over the same emulated path as the media.
- **`nginx-dash`** forwards `/media/dash/` to the origin with buffering and caching off, adds `Timing-Allow-Origin` (so the dashboard can read transfer sizes via the Resource Timing API). The browser's `Origin` header reaches the origin as sent, which the `UTCTiming` rewrite relies on. The browser reaches it directly through the router; see [deployment.md](deployment.md#why-dash-goes-direct).

The segment cannot be shorter than the GOP; backend and frontend both validate it. The MPD is described in [protocols/mpd-reference.md](protocols/mpd-reference.md) and the branch in [protocols/ll-dash.md](protocols/ll-dash.md).

### MoQ branch

```bash
python3 tsgate.py 5002 moq | moq --connect https://moq-relay:4433/anon --connect-tls-insecure \
  --broadcast live.hang import ts
```

Two different components, not to be confused:

- **The publisher** is `moq import ts` (moq-cli), run by the orchestrator. It reads the MPEG-TS, builds the broadcast `live.hang` and **writes the catalog** (tracks, codecs, bitrates). Each GOP becomes a MoQ group on its own QUIC stream. It is started without the orchestrator's `MOQ_*` environment variables, which some moq-cli builds reject.
- **The relay** (`moq-relay` container) only fans out: it accepts the publisher's connection over the internal network and serves subscribers. It does not write the catalog. It allows anonymous access under `anon/**`.

The browser connects to `https://<SERVER_HOST or page host>:4433/anon` through the router; in local mode it pins the relay's self-signed certificate by its SHA-256 fingerprint (fetched from `/certificate.sha256`), in server mode it validates the certificate chain, and subscribes to `live.hang` with `@moq/watch`. The relay uses BBRv3 congestion control while DASH runs over the server's TCP CUBIC: a confounder to declare. See [protocols/moq.md](protocols/moq.md) and [protocols/moq-catalog-reference.md](protocols/moq-catalog-reference.md).

### WebRTC branch

`RTC_SERVER` selects the server. Both are always running; only the router's UDP/TCP 8189 forwarding and the player change. The CSV records `rtc_server` and `rtc_ingest`; measurements with the two servers must not be mixed. See [protocols/webrtc.md](protocols/webrtc.md).

#### With mediasoup (default)

```
FFmpeg → UDP 5003 → tsgate → FFmpeg (-c copy, one RTP output per rendition) → rtprelay.py (one socket) → mediasoup → router → browser
```

- **No re-encoding and no new output on the source.** It reads the same UDP 5003; the RTP conversion runs in the packager process, not in the master source. Each rendition is a separate FFmpeg RTP output (`pkt_size=1200`); in a single output the muxer would hold packets to interleave them.
- **Relay (`server/app/rtprelay.py`).** FFmpeg's RTP muxer opens one socket per track (and another for RTCP), while mediasoup's `PlainTransport` accepts a single source (comedia). The relay forwards RTP and RTCP untouched through one socket. The Sender Reports are essential: without them mediasoup does not switch layers. What mediasoup sends back (RTCP with keyframe requests) is read and discarded: the encoder does not serve them. If mediasoup stops listening (container restart), the relay exits and the supervisor rebuilds the ingest.
- **Application (`sfu/server.mjs`).** mediasoup is a library, so a minimal custom application handles ingest (`/ingest`, internal network only) and viewer signalling over WebSocket, direct to the SFU through the router on **8189/tcp**. A session lives as long as its connection: on reload, unmount or browser exit the SFU closes it immediately. On an HTTPS page it uses `wss://` with the `SERVER_HOST` certificate; on HTTP, `ws://` to the page's address (`rtc_signal_port` and `rtc_tls_host` in `/api/status`). The signalling, including the layer and estimate query every 2 s, crosses the router's WebRTC queue. It sets no preferred layers, no limits and no `initialAvailableOutgoingBitrate`: layer selection is mediasoup's, with its defaults. One worker and one UDP port (8189, `WebRtcServer`). Diagnostics: `GET http://sfu:8890/health` from the internal network; layer changes in `docker logs testbed-sfu`; `SFU_TRACE=1` adds the estimate and probes.
- **Player**: `mediasoup-client` (`web/src/lib/rtcSession.ts`) on a `<video>`; the rest of the meter is shared. The quality cannot be fixed by hand.
- **Ingest pacer (`rtc_pacing`, declared experiment, off by default).** With **Pacer on the WebRTC ingest (mediasoup only)** in the panel, or **Pacer in WebRTC** on each stream of a campaign (`rtc_pacing` in `POST /api/config` and in the plan's `streams`), the relay paces each rendition's RTP at 2.5 times its nominal bitrate (`RTC_PACING_FACTOR`, the default multiplier of libwebrtc's pacer), with a 5 ms burst after an idle period; what does not fit waits in its queue, in order. RTCP and audio pass without waiting. It imitates a WebRTC publisher such as Chrome, which paces: without it FFmpeg releases each frame at once and mediasoup forwards it the same way. It does not touch mediasoup or the player, but it changes the input for every viewer and delays what waits in the queue, above all keyframes (a 150 kB keyframe at 4 Mbit/s × 2.5 takes about 120 ms), and that delay appears in glass-to-glass latency and not in the server stages. No effect with MediaMTX. CSV column `rtc_pacing`. Measured locally (three tests per network, 300 ms queue): at 5 Mbit/s it removes queue drops and nearly all stall time (from 5-26 % to 0-0.4 %), but mediasoup stays at 360p most of the time with an estimate of 1.3-1.6 Mbit/s; at 3 Mbit/s it helps less; without a network limit it costs about 30 ms of latency (58 against 88 ms).

Observed behaviour of mediasoup, as shipped (single local passes and one local campaign; nothing was tuned):

- With one rendition (1080p, 4 Mbit/s) and no network limit it adds 12-22 ms over MediaMTX (60-72 against 48-50 ms).
- With the default ladder and no limit it delivers 1080p at 60 fps, about 66 ms.
- It **underestimates the link** and settles on low layers: at 3-8 Mbit/s with a 100 ms queue it stays mostly at 360p (estimate 1.2-3.4 Mbit/s), and after a limit is removed it climbs back very slowly or not at all. Two causes were identified: after a loss its loss-based controller only lets the estimate rise to 1.5 × the acknowledged rate, which at 360p is low; and even without losses the keyframe bursts appear to trigger overuse in its delay-based estimator (the second is a deduction). A 500 ms queue reduces but does not remove the oscillation. Declare the router queue and the GOP with any mediasoup result.
- **If the estimate falls below the bitrate of the lowest layer, mediasoup stops sending video** (frozen) until the player's watchdog recreates the connection after about 11 s; stall time then includes the testbed's recovery.

Confounders of this variant:

- The application is custom, although the layer decision is mediasoup's, and the ingest is RTP, not WHIP as would be usual with an SFU.
- Nobody serves keyframe requests: every layer switch and recovery waits for the next IDR, up to 1 s with the default GOP. With Chrome as publisher this would not happen.
- Reading MPEG-TS with FFmpeg holds more frames than MediaMTX ([protocols/mpeg-ts.md](protocols/mpeg-ts.md)); this is part of the 12-22 ms above and cannot be separated from the server without instrumenting it.
- Keyframes of all renditions arrive at the same time and unpaced, because the source is a broadcast encoder, unless the ingest pacer is on.

#### With MediaMTX (`RTC_SERVER=mediamtx`)

```bash
python3 tsgate.py 5003 rtc --udp mediamtx:5003 --first-video          # no audio: path liveudp
python3 tsgate.py 5003 rtc --udp mediamtx:5013 --first-video --audio  # with rtc_audio: path liveudpa
```

- MediaMTX receives the **top rendition only**, without re-encoding, and serves it over WebRTC. **No adaptation.** The browser negotiates via WHEP (`<host>:8189/<path>/whep` through the router, like mediasoup's signalling; the path is `rtc_path` in `/api/status`) and receives the media directly over UDP 8189, also through the router.
- **Direct UDP ingest.** MediaMTX listens for MPEG-TS on two paths set in `docker-compose.yml`: `liveudp` (port 5003, video only) and `liveudpa` (5013, video and audio). MediaMTX cannot select tracks, so the gate passes only the first video (and the audio with `rtc_audio`) and rewrites the PMT. Two paths, because MediaMTX fixes a UDP path's tracks the first time it reads it.
- **Player**: an `RTCPeerConnection` on a `<video>`, with no settings: the browser decides the jitter buffer. A slider can request a specific one (`jitterBufferTarget`); in "auto" nothing is requested. Metrics come from `getStats()` (bitrate, jitter buffer, lost packets); WebRTC declares no latency relative to live, so that card stays empty.

#### WebRTC audio (`rtc_audio`)

By default WebRTC carries video only. **WebRTC audio (Opus from the source, not re-encoded)** in the panel (`rtc_audio` in `POST /api/config`, CSV column `rtc_audio`) adds the source's Opus track, copied. It is off by default because it changes what is measured: the browser synchronises the two tracks and **delays the video to the audio's jitter buffer**. Measured with MediaMTX in headless Chrome, `jitterBufferTargetDelay` from `getStats()`, no sound on any player:

| Source and connection time | Glass-to-glass WebRTC | Video target buffer | Audio target buffer |
| :--- | :--- | :--- | :--- |
| Loop, no audio | 59-71 ms | 15-20 ms | — |
| Loop, audio, connecting right as the stream starts | 142-151 ms | 76-134 ms | 40-51 ms |
| Loop, audio, connecting to a running stream | 79-149 ms | 34-92 ms | 40-48 ms |
| Camera, no audio | 244-329 ms | 130-143 ms | — |
| Camera, audio | 330-557 ms | 154-336 ms | 225-315 ms |

- With audio, the video target buffer rises to the audio's in every measured connection. How much depends on the audio: with the loop it arrives regularly (jitter 5-7 ms) and asks for about 40 ms, so the rise is small; with the camera it arrives irregularly (27-28 ms) and asks for 225-315 ms, so the rise is 100-200 ms.
- Connecting in the first seconds of a stream leaves the video 45-55 ms higher for the whole session (that client receives the last second of media at once; what sends it in a burst is not located). **The dashboard's WebRTC player therefore waits** until the stream has been published for 8 s (since its packager started, on the server-synchronised clock) before connecting, showing "Waiting until the stream has been published for a few seconds". This is what any viewer joining a running stream experiences; it changes nothing in the protocol.

## Automatic recovery

The platform recovers from restarts and crashes without reloading the tab:

- **Stream identifier.** Every time a packager starts, its `stream_id` in `/api/status` changes. Any open dashboard remounts that player when it sees it, whoever caused the restart (that tab, another one, the API or the supervisor). The WebRTC player still waits 8 s after its packager starts before connecting.
- **Supervisor in the orchestrator.** Every second it checks the source and the three packagers and relaunches what has died, at least 3 s after the previous start; DASH also when it has published nothing to the origin for `max(10 s, 3 × segment)`. A dead source relaunches the whole pipeline; each packager is relaunched separately so the other branches are not interrupted. It does nothing while the stream is stopped on purpose.
- **Watchdog in each player.** If 10 s pass without a new picture (after a 20 s grace period from the player's start), the player is recreated. Freeze counters are kept.
- **Backend down.** After three failed status requests the dashboard shows "Disconnected" and reconnects when the backend returns.

Restarts are visible in the panel ("Restarts: server · DASH · MoQ · WebRTC") and in the CSV (`pipeline_restarts`, `dash_player_restarts`, `moq_player_restarts`, `rtc_player_restarts`): a session with restarts is not a clean measurement.

| Induced incident | Observed recovery |
| :--- | :--- |
| Reconfiguration from another tab or the API | about 5 s |
| MoQ publisher, DASH FFmpeg or source dies | about 5 s; the other branches are unaffected (except for the source, which restarts all) |
| Orchestrator restart | 5-10 s; **the stream configuration is lost** and goes back to the default ladder |
| nginx restart | no visible effect |
| Router restart | about 10 s; **the network profile is lost** and goes back to unrestricted |
| Relay restart | 10-15 s on MoQ (recovered by the player watchdog) |
| Badly degraded network and back to normal | about 5 s |

On a deliberately broken network, the watchdog may recreate a player that has been frozen for more than 10 s; it shows in the restart columns.

## Pinned versions

Nothing updates on its own. Defaults (the variables that override them are in [deployment.md](deployment.md#third-party-versions)):

| Component | Version | Where it is pinned |
| :--- | :--- | :--- |
| MoQ relay | `moqdev/moq-relay:0.17.9`, or built from commit `c19c723` with `MOQ_RELAY_FROM=git` | `docker-compose.yml`, `relay/Dockerfile` |
| MoQ publisher (moq-cli) | 0.14.7, or built from commit `bc64b9c` with `MOQ_CLI_FROM=git` | `docker-compose.yml`, `server/Dockerfile` |
| `@moq/watch` | 0.6.3 (npm lockfile), or built from commit `bc64b9c` with `MOQ_WATCH_FROM=git` | `web/package-lock.json`, `web/Dockerfile` |
| dash.js | 5.2.1 | `web/package.json` (exact) |
| mediasoup | 3.32.1 | `sfu/package.json`, `sfu/package-lock.json` |
| mediasoup-client | 3.26.0 | `web/package.json` |
| MediaMTX | 1.21.3 | `docker-compose.yml` |
| vmaf | 3.0.0 (model `vmaf_v0.6.1` built in) | `server/Dockerfile` |
| acme.sh | 3.1.1 | `docker-compose.yml` |
| FFmpeg | Debian package of the `python:3.12-slim` base image | `server/Dockerfile` |

The panel's versions view and the CSV show what is installed (see [measurement.md](measurement.md)).

## Project layout

```text
moq-initial-comparison/
├── README.md
├── docs/                         # This documentation
├── docker-compose.yml
├── .env.template                 # .env for server mode (local mode needs none)
├── media/                        # Source videos (downloaded), campaigns, QoE recordings; not versioned
├── certs/                        # Let's Encrypt certificate and ACME account; not versioned
├── nginx/
│   ├── entrypoint.sh             # Shared by nginx-web and nginx-dash: TLS once the certificate exists, reload every 12 h
│   ├── web.conf                  # nginx-web: page, API, relay fingerprint; one server for ports 80 and 443
│   ├── web-tls.conf.template     # nginx-web port 443 and certificate, added to that server in server mode
│   ├── dash.conf                 # nginx-dash: unbuffered proxy to the origin; one server for ports 80 and 443
│   └── dash-tls.conf.template    # nginx-dash port 443 and certificate, added to that server in server mode
├── cert/
│   └── entrypoint.sh             # acme.sh: issue and renew the certificate of SERVER_HOST
├── router/
│   ├── Dockerfile
│   ├── agent.py                  # IP forwarding, tc tree and network profiles
│   └── api.py                    # HTTP agent (:9000): profiles, counters, tree for the diagram
├── mediamtx/
│   ├── Dockerfile                # Published MediaMTX binary on Alpine, for the start-up script
│   └── entrypoint.sh             # WHEP over HTTPS with the certificate of SERVER_HOST, plain HTTP in local mode
├── relay/
│   ├── Dockerfile                # MoQ relay: published image or built from a commit
│   └── entrypoint.sh             # Certificate of SERVER_HOST, or self-signed in local mode
├── sfu/
│   ├── Dockerfile
│   └── server.mjs                # mediasoup application: RTP ingest and WebSocket signalling
├── scripts/
│   ├── campaign-worker.mjs       # Campaign worker in headless Chrome
│   ├── deploy.sh                 # Updates a server over SSH (git bundle, rebuilds what changed)
│   ├── install-worker.sh         # Installer of an independent worker
│   └── l2a-units-experiment.mjs  # Declared dash.js L2A experiment, outside the dashboard
├── server/
│   ├── Dockerfile                # Orchestrator: Python, FFmpeg, moq-cli, vmaf
│   ├── requirements.txt
│   └── app/
│       ├── main.py               # Control API, process lifecycle, supervisor
│       ├── source.py             # Source video download
│       ├── tsgate.py             # MPEG-TS gate: IDR start, continuity, frame times
│       ├── origin.py             # In-memory LL-DASH origin, AST calibration, UTCTiming rewrite
│       ├── rtprelay.py           # RTP relay to mediasoup, optional pacer
│       ├── trace.py              # Per-frame stage times for the latency breakdown
│       ├── recorder.py           # MPEG-TS recorder (UDP 5004 and camera reference 5005)
│       ├── qoe.py                # QoE: recording, indexing, matching with the original, VMAF
│       ├── campaign.py           # Campaigns: plan, scheduler, validity, summaries
│       ├── samples_index.py      # Index of campaign rows for analysis and comparison
│       ├── analysis.py           # Text analysis of a campaign
│       ├── compare.py            # Text comparison of two tests
│       ├── campaign_versus.py    # Text comparison of two campaigns
│       ├── i18n.py               # Language of the orchestrator's texts
│       └── versions.py           # Installed and latest published third-party versions
└── web/
    ├── Dockerfile                # Vite build + nginx with COOP/COEP; optional @moq/watch from git
    ├── patches/                  # Patches applied to @moq/watch built from git
    └── src/
        ├── App.tsx               # Global state, sample log, CSV export
        ├── main.tsx              # Dashboard or, at /campaign, the campaigns page
        ├── types.ts              # Includes SampleRow, the CSV row
        ├── lib/                  # Clock sync, timecode reader (glass.ts), samples, trace, i18n, DASH URL,
        │                         # mediasoup session, MoQ API adapter, QoE, capture
        └── components/           # Players (DashPlayer, MoqPlayer, RtcPlayer), panels, pipeline diagram,
                                  # metrics, campaign pages, QoE, settings, versions, workers
```
