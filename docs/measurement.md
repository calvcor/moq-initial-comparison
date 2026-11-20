# Measurement method

The main metrics are obtained the same way in the three branches (LL-DASH, MoQ, WebRTC): **by reading pixels of what each player paints**. This document lists every metric, how it is computed, the validity indicators, the per-second CSV, the per-stage latency breakdown, component versions, page settings and the experimental parameters of the control panel. QoE scoring (VMAF + LL-GABR) is in [qoe.md](qoe.md); campaign outputs (`runs.csv`, `ip.csv`, summaries) are in [campaigns.md](campaigns.md).

## Glass-to-glass latency

The source burns into every frame a binary Gray-code timecode with the server wall clock in ms (modulo 2²⁰), as a row of black and white cells at the bottom left. The browser synchronises its clock with the server (`GET /api/time`, NTP style, lowest-RTT probe, every 10 s). On every screen refresh, `GlassMeter` (`web/src/lib/glass.ts`) takes the frame each player is showing, copies only two rows of the timecode strip asynchronously (`VideoFrame.copyTo`) and computes `latency = server time − timecode`. The full description (layout per rendition, clock sync, error sources, how players schedule frames) is in [latency-measurement.md](latency-measurement.md).

The value includes encoding, packaging, network, player buffer, decoding and painting. It excludes composition and display delay (1-2 refreshes), which is the same for all branches.

> [!WARNING]
> **The meter must not alter what it measures.** The MoQ player (`@moq/watch`) paints on the page main thread, which it shares with dash.js, the meter and the dashboard. A meter that reads the whole image (canvas + `getImageData`) saturates that thread with three players and makes MoQ fall behind, stop reading from the network and push back on the publisher. Any new browser instrumentation must be cheap and asynchronous. The main-thread load is recorded in every row (see below).

## Metrics

When there is no measurement the dashboard shows `--` and the CSV cell is empty; nothing is filled in with assumed values.

| Metric | How it is obtained |
| :--- | :--- |
| Glass-to-glass latency | See above. Columns `*_g2g_ms` |
| Presented frames (fps) | Distinct timecodes seen per second, averaged over the last 2 s. `*_fps` |
| Freezes | Periods of 150 ms or more without a new timecode, whether or not there is an image on screen (a `<video>` with `readyState < 2`, an empty MSE buffer, a seek or a player being recreated also count), from the moment the player is mounted (start-up counts). Count and duration; the ongoing freeze already adds up. `*_stalls`, `*_stall_ms`; exact intervals in `*_stall_spans` (`"start-end;..."` in server-clock ms, each freeze in the row of the second it ended) and `*_stall_open_since_ms` (start of the freeze still open). MoQ and WebRTC keep the last image when frozen; DASH may show no image at all |
| Content progress and content not played | From the timecode of every painted frame, identical for the three branches. **Progress** (`*_content_speed`): source ms advanced per real ms (1 = real time; above 1 the player is catching up by skipping or speeding up; below 1 it is falling behind; 0 during a freeze). **Not played** (`*_content_skipped_ms`): source ms never painted. For each new frame, the timecode advance in frames is compared with the refreshes elapsed since the previous one: two frames in one refresh is a skip; two in two refreshes is not (the meter reads asynchronously and may miss a frame that was painted); one in two is not either (the player held it). After a freeze, refreshes are not discounted: what the content advanced while frozen was not painted (jump to live); if the player resumes where it stopped it advances one frame and there is no skip. Frame duration is estimated from normal timecode steps (works with the file loop and the camera). An advance of more than 10 s or backwards is a discontinuity (player recreated, stream restarted) and is ignored. Panel: progress over the last 2 s and skipped since the player started; CSV: exact since the previous row |
| Time on screen of each frame | From the painting of one frame (new timecode) to the next, with the same meter. Card: standard deviation and p95 of the last second; CSV: `*_frametime_sd_ms`, `*_frametime_p95_ms`, `*_frametime_max_ms`; chart: every frame of the last 10 s (**Time on screen** tab). Quantised in display refreshes (16.7 ms at 60 Hz), so it depends on display and browser as well as on the protocol; a frame the meter misses (previous read unfinished, illegible timecode) counts as one of double duration. Freezes (≥ 150 ms) are excluded here and counted under Freezes |
| Received video bitrate | Video bytes downloaded over a 10 s window (dash.js: completed segments; MoQ: decoder `bytesReceived`; WebRTC: inbound-rtp `bytesReceived` from `getStats()`). `*_kbps` |
| Total download | Application level and in different layers, so the comparison is indicative. DASH: transferred size of all requests (video, audio, manifest, with HTTP response headers) from the Resource Timing API. MoQ: `WebTransport.getStats()` where implemented; Chrome lacks it, so the payload of the downloaded tracks is summed. WebRTC: transport `bytesReceived`. Detail on hover. `*_net_kbps`. Muted, `@moq/watch` does not download audio while dash.js always does: about 130 kbps of the difference comes from that |
| IP traffic at the router | IP bytes forwarded per protocol and direction, with headers and retransmissions, the same layer for all branches: the rigorous network-consumption figure. Counted before emulation, so the downlink includes packets netem drops afterwards (drops separately in `*_down_dropped` / `*_up_dropped`, since the last network profile was applied). Panel and `*_ip_down_kbps` / `*_ip_up_kbps`: mean of the last 10 s, from a counter the browser reads every 2 s with the status, not a per-second value. These browser-written columns cover the whole queue of each protocol; with parallel runs they would mix runs and are left empty. In campaigns the orchestrator reads the counters itself at every second (`ip.csv`, see [campaigns.md](campaigns.md)); each read takes about 16 ms and is timestamped at the middle of the request |
| Source lag | How far FFmpeg is behind real time. Each frame's timecode is the time FFmpeg draws it, and its PTS is frame number × frame duration (`setpts=N/fps`): if FFmpeg stalls X ms, the following frames carry a mark X ms later with the usual PTS. The three players paint by PTS and see X ms *less* latency, simultaneously; MoQ, whose playback reference only moves down (`sync.ts` of `@moq/watch`), spends that much buffer until the source catches up, and with X above its target it paints each frame on arrival without a freeze. The orchestrator knows the mark and number of every frame (the timecode filter writes them to the FFmpeg log, `trace.py`): a frame's lag is mark − number × frame duration, relative to the minimum since the source started (0 when on pace); for an interval, the most delayed frame of any rendition, or, if none arrived, the lag the next due frame already has. For 1-2 s after the source starts it reads a few hundred ms (FFmpeg reads the start of the file at once). `/api/status` (`source_lag_ms`, last 2 s), panel (next to DASH drift), column `source_lag_ms`; per second in campaigns. Validated by freezing FFmpeg (`SIGSTOP`): 300 and 900 ms freezes read as 290 and 899 ms, and all three players dropped their latency at once. **Check it before interpreting a latency below the target**: with the three-rendition ladder the server source has been observed to fall behind at times |
| Main-thread load | Passive measures of what the page does on its main thread (`web/src/lib/mainThread.ts`), since the previous row. **Missed refreshes** (`main_refreshes_missed`): display refreshes in which a timestamp-only `requestAnimationFrame` did not run (N refreshes between two callbacks = N−1 missed; the refresh period is the 10th percentile of the last 120 intervals, so it works at 60 or 120 Hz), with the largest gap (`main_raf_gap_max_ms`). **Long frames** (`main_long_frames`, `main_long_frame_ms`, `main_long_frame_max_ms`): frames of 50 ms or more from start of work to paint, from Chrome's Long Animation Frames API (empty without it; delivered by an observer, so one near a second boundary may land in the next row). Not counted with the tab hidden. It says when the thread was busy, not which code. Panel: last second next to source lag, and the **Main thread** chart tab. Checked with headless Chrome and three players: 0 missed refreshes and 0 ms of long frames without extra load; blocking the thread 200 ms per second gave 10 missed refreshes and 204-206 ms of long frames per second |
| Player-reported latency | What each player declares (`getCurrentLiveLatency()` in dash.js, sync delay in `@moq/watch`), only as contrast. `dash_reported_ms`, `moq_reported_ms` |
| Local buffer (DASH) | Seconds of video downloaded ahead of the playhead (`getBufferLength('video')`). `dash_buffer_s` |
| Playback rate (DASH) | The `playbackRate` dash.js sets on the `<video>`: above 1× to reach the target (catch-up) and, with LoL+, below 1× to refill the buffer when under `playbackBufferMin`. Tracked through `ratechange` events, not sampled, so short changes are not lost. Per row: `dash_playback_rate` (time-weighted mean since the previous row), `dash_playback_rate_min`, `dash_playback_rate_max`, `dash_playback_slow_ms`, `dash_playback_fast_ms` (time below and above 1×). It is the requested rate, not that of painted frames: stalled it does not advance even at 1×. MoQ (paints without `<video>`, recovers latency by dropping or waiting for frames) and WebRTC (the browser adjusts its jitter buffer internally) have no equivalent; their cells are empty |
| Jitter buffer (MoQ and WebRTC) | Mean time each frame is held in the player. WebRTC: `jitterBufferDelay / jitterBufferEmittedCount` from `getStats()`, from first packet to output to the decoder. MoQ: from when `@moq/watch` reads the frame from the network until it hands it over for painting; includes decoding. `moq_jitter_buffer_s`, `rtc_jitter_buffer_s` |
| Quality and adaptation | Painted height (`*_height`, `videoHeight`), height chosen by the ABR and being downloaded (`*_selected_height`; with mediasoup, the layer it sends), nominal bitrate of the rendition (`*_rendition_kbps`), quality switches (`*_quality_switches`; WebRTC: height changes of what arrives), each protocol's own bandwidth estimate (`*_bw_estimate_kbps`; MoQ: the relay estimate; WebRTC: mediasoup towards the viewer) and mode (`*_quality_mode`: `auto` or manual). See [adaptation-and-experiments.md](adaptation-and-experiments.md) |

### Why presented frames drop below 60

Measured with headless Chrome and a probe that counts, every second, what arrives, what is decoded and what is painted in each player (`requestVideoFrameCallback` and `getVideoPlaybackQuality` on `<video>`, `getStats` in WebRTC, and in MoQ the decoder `frameCount` and the changes of `decoder.out.frame` and `renderer.out.frame`), 1080p single rendition. There are three distinct causes:

1. **The client network when the three players run at once.** Over a VPN tunnel giving about 21 Mbit/s on one TCP connection, the three flows (about 12.5 Mbit/s plus DASH start-up bursts) collapsed the HTTP RTT from ~50 ms to 1.2-5.9 s; arrivals fell to 0-30 fps in all three branches at once and then came in bursts, while the server trace showed the encoder at 60 fps without gaps. Without players the RTT stayed below 138 ms.
2. **Painting 60 fps on a 60 Hz display without aligning frames to the refresh.** With arrival and decoding at 60 fps: **WebRTC** paints about 52-53 (the browser discards ~7 decoded frames per second when two fall in the same refresh; with `--disable-frame-rate-limit` it paints 59; independent of load and meter). **MoQ** paints 45-56 depending on the session: `@moq/watch` releases each frame at its presentation time and, if two are released before the next refresh, draws only the last (mechanism below). **DASH** paints 57-60: the `<video>` with MSE presents at the pace of its playback clock.
3. **The meter itself.** The timecode read (`VideoFrame.copyTo`) takes about 21.5 % of the main thread with three players (~1.3 ms synchronous per read). Switching it off in alternate 8 s windows took the main thread from 40 % to 10 % busy and MoQ from 44.9 to 47.3 fps; DASH and WebRTC did not change. The meter costs MoQ about 2-3 fps; the main-thread columns let you check this in every run.

What the meter reports matches what each player paints (less than 1 fps difference): the drop is real, not a counting error. A 120 Hz display should reduce cause 2; not measured. On a local network (testbed and browser on the same machine, one rendition), arrival was 60 fps every second and painted frames were 59.8-59.9 (DASH), 56.4-59.8 (MoQ) and 58.8-59.8 (WebRTC) with the three at once. The source's own frame jitter depends on the encoding machine (SD 1.3 ms, p99 20 ms on one machine; SD 5.7 ms, p99 35 ms on another). Separately, publisher input stalls on keyframes can leave MoQ alone without frames for a few seconds with some `moq-cli` versions ([limitations.md](limitations.md)).

### Why MoQ time on screen is irregular

Measured with headless Chrome, MoQ only, one fixed 1080p rendition and a probe that records, without changing the player, when each frame arrives (`sync.received`), is released (`video.out.frame`), is painted (`renderer.out.frame`) and when each `requestAnimationFrame` runs; with `@moq/watch` 0.6.3 against a remote server over Wi-Fi and with `@moq/watch` built from commit `bc64b9c` locally, in 25-30 s runs alternating the buffer.

**Mechanism** (read from the source of both versions and confirmed by the data): each decoded frame waits in a `setTimeout` until its presentation time (timestamp + a reference fixed by the earliest arrival + the buffer) and is published. The renderer then requests a `requestAnimationFrame` to draw it; if another frame is published before that callback runs, it cancels and draws only the new one. **A frame is lost exactly when the next one is released before the `requestAnimationFrame` that should paint it**: this predicted every unpainted frame of each run (e.g. 305 of 305). Each lost frame leaves the previous one two refreshes on screen. The `<video>` of DASH and WebRTC instead picks the frame in the compositor, aligned to the refresh.

The next frame comes early for two reasons:

1. **It arrives late and is released without waiting.** A frame arriving later than the buffer is released as soon as it is decoded and bunches with the next. Over Wi-Fi to a remote server, arrival delay relative to the fastest frame had p95 of 85-390 ms (5-9 ms locally); with `delay: auto` the buffer was 43 ms and 18-37 % of frames left without waiting.
2. **Phase of the release clock relative to the refresh.** The release clock is not tied to the display refresh; its phase is set per session when the reference is anchored and changes on every page load. If releases fall right where `requestAnimationFrame` runs (1-3 ms after the refresh mark), `setTimeout` jitter is enough to put two consecutive frames in the same refresh, even if all arrive on time.

With a fixed 300 ms buffer (no late frames except one run):

| Release phase within the refresh | Painted frames | Lost to phase | Lost to late arrival |
| :--- | :--- | :--- | :--- |
| 0.6-0.8 (remote and local) | 60.0 fps | 0-1 | 0 |
| 0.3-0.4 (remote) | 59.7 fps | 21 in 25 s | 0 |
| 0.0-0.2 (remote and local) | 47.8-50.5 fps | 234-301 in 25 s | 0-4 |
| 0.8-0.9, arrivals up to 509 ms late (remote) | 56.7 fps | 13 | 87 |

With `auto` against the remote server both causes add up: 45.7 fps (181 frames lost to late arrival and 253 to phase in 30 s). Locally with `auto` (20 ms) and no Wi-Fi, 59.7-59.9 fps.

Consequences for measurement:

- **MoQ's frame pacing changes on page reload** even if nothing else changes (session phase): comparing MoQ time on screen or painted frames needs several sessions per condition.
- **A larger buffer only fixes the first cause.**
- **The meter's cost may matter more than it seems**: delaying the main thread delays timers and `requestAnimationFrame`, which decide which frame is lost. Not measured separately.
- This is the library's stock behaviour and is measured as such; the player is not modified.

## Validity indicators

The panel shows, and the CSV records:

- **Clock uncertainty** (± RTT/2 of the synchronisation): `clock_offset_ms`, `clock_rtt_ms`.
- **Ingest anomalies** (`ingest_anomalies`): continuity jumps or corrupt packets between the source and each packager. Any non-zero value invalidates the comparison of that session.
- **DASH availability drift** (`dash_availability_drift_ms`): offset of each segment from the schedule announced by the manifest.
- **Source lag** (`source_lag_ms`) and **main-thread load** (`main_*`), described above.
- **Automatic restarts**: `pipeline_restarts` (supervisor restarts of source + DASH + MoQ) and `*_player_restarts` (player recreated by the watchdog).
- **Hidden tab** (`tab_hidden`): in the background the browser pauses video and sampling.

## Statistics and export

Each card shows n, mean, σ, p50, p95, minimum and maximum of glass-to-glass latency, discarding the first 10 s after every start (`elapsed_s` < 10) and samples taken with the tab hidden.

**Export CSV** downloads one row per second with the active configuration, all metrics of every branch and the validity indicators. `epoch` increments on every reconfiguration of the pipeline or the network, and when a player is switched on or off; `elapsed_s` counts from the start of the epoch.

### CSV columns (`SampleRow`, `web/src/types.ts`)

`*` stands for `dash`, `moq` or `rtc`.

| Group | Columns |
| :--- | :--- |
| Row and context | `time_iso`, `epoch`, `elapsed_s`, `players` (active players, e.g. `dash\|moq`), `web_build` (build time of the web bundle, or `dev`), `fullscreen` (player in fullscreen, or empty), `audio` (unmuted player, or empty), `tab_hidden`, `versions` (deployed third-party components, e.g. `moq-relay=…;moq-cli=…`) |
| Stream | `source` (`file`, `tos` or `camera`), `fps`, `gop_size`, `ladder` (e.g. `1080p@4000\|720p@2000`), `seg_duration`, `frag_duration` (0 = 1 frame) |
| WebRTC server options | `rtc_server` (`mediasoup` or `mediamtx`), `rtc_ingest` (`rtp` with mediasoup, `udp` with MediaMTX), `rtc_audio`, `rtc_pacing` |
| DASH path | `dash_path` (`direct`: the browser connects straight to the router, through the emulated network) |
| Common per player | `*_g2g_ms`, `*_kbps`, `*_net_kbps`, `*_fps`, `*_frametime_sd_ms`, `*_frametime_p95_ms`, `*_frametime_max_ms`, `*_stalls`, `*_stall_ms`, `*_content_speed`, `*_content_skipped_ms`, `*_stall_spans`, `*_stall_open_since_ms`, `*_player_restarts`, `*_target_ms`, `*_height`, `*_selected_height`, `*_rendition_kbps`, `*_quality_switches`, `*_bw_estimate_kbps`, `*_quality_mode` |
| DASH only | `dash_reported_ms`, `dash_buffer_s`, `dash_playback_rate`, `dash_playback_rate_min`, `dash_playback_rate_max`, `dash_playback_slow_ms`, `dash_playback_fast_ms`, `dash_max_drift_s`, `dash_playback_buffer_min_s`, `dash_abr` (`default`, `l2a`, `l2afix` or `lolp`) |
| MoQ only | `moq_reported_ms`, `moq_jitter_buffer_s`, `moq_switching` (`seamless`, `cancel` or `priority`; empty without the patch), `moq_abr` (`watch`, `probe` or `probe2`), `moq_probing` (1 if a probe was running), `moq_probe_capacity_kbps`, `moq_probe_spans` (`"start-end-result;..."`, result `up`, `stay`, `cut` or `abort`), `moq_probe_open_since_ms`, `moq_probe_count`, `moq_probe_cuts` (cumulative). Probing: [adaptation-and-experiments.md](adaptation-and-experiments.md) |
| WebRTC only | `rtc_jitter_buffer_s`, `rtc_packets_lost`. With MediaMTX, `rtc_selected_height`, `rtc_rendition_kbps` and `rtc_bw_estimate_kbps` are empty and `rtc_quality_switches` is 0 |
| Stage breakdown (ms) | `dash_stage_encode_ms`, `dash_stage_ingest_ms`, `dash_stage_package_ms`, `dash_stage_deliver_ms`, `dash_stage_player_ms`; `moq_stage_encode_ms`, `moq_stage_ingest_ms`, `moq_stage_transport_ms`, `moq_stage_player_ms`; `rtc_stage_encode_ms`, `rtc_stage_ingest_ms`, `rtc_stage_transport_ms`, `rtc_stage_player_ms` |
| Validity | `clock_offset_ms`, `clock_rtt_ms`, `ingest_anomalies`, `dash_availability_drift_ms`, `source_lag_ms`, `pipeline_restarts` |
| Network profile | `net_down_rate_kbit`, `net_down_delay_ms`, `net_down_jitter_ms`, `net_down_loss_pct`, `net_down_queue_ms`, `net_down_shaper` (`tbf` or `netem`), and the same six with `net_up_`. See [network-emulation.md](network-emulation.md) |
| Router traffic | `dash_ip_down_kbps`, `dash_ip_up_kbps`, `moq_ip_down_kbps`, `moq_ip_up_kbps`, `rtc_ip_down_kbps`, `rtc_ip_up_kbps`, `dash_down_dropped`, `dash_up_dropped`, `moq_down_dropped`, `moq_up_dropped`, `rtc_down_dropped`, `rtc_up_dropped` |
| Main thread | `main_refreshes_missed`, `main_raf_gap_max_ms`, `main_long_frames`, `main_long_frame_ms`, `main_long_frame_max_ms` |

Metrics of a player that is switched off are empty.

## Component versions

Results depend on the exact version of each third-party piece (two consecutive relay releases can ship different QUIC implementations). All are **pinned**, shown in the dashboard header and written to the `versions` CSV column.

| Component | Where the version is pinned | Default |
| :--- | :--- | :--- |
| `moq-relay` | `relay/Dockerfile` and `docker-compose.yml`, `MOQ_RELAY_VERSION` (published image). With `MOQ_RELAY_FROM=git`, built from `MOQ_RELAY_COMMIT`, reported as `git@<commit>` | 0.17.9; commit `c19c723` |
| MediaMTX | `docker-compose.yml`, `MEDIAMTX_VERSION` | 1.21.3 |
| mediasoup | `sfu/package.json` (and `MEDIASOUP_VERSION` in `docker-compose.yml`, which must match) | 3.32.1 |
| `moq-cli` (publisher) | `server/Dockerfile`, `MOQ_CLI_VERSION` (published release; overridable in `.env`). With `MOQ_CLI_FROM=git`, built from `MOQ_CLI_COMMIT`, reported as `git@<commit>` | 0.14.7; commit `bc64b9c` |
| `@moq/watch`, `dashjs` | `web/package.json` and `web/package-lock.json`. With `MOQ_WATCH_FROM=git`, `@moq/watch` and its `@moq/*` dependencies are built from `MOQ_WATCH_COMMIT`, reported as `git@<commit>` (plus `+switching` when patches apply). That mode drops the lockfile, which is why `dashjs` is pinned to an exact version in `package.json` | 0.6.3 (lockfile), dash.js 5.2.1; commit `bc64b9c` |
| FFmpeg | Debian package of the orchestrator image; not checked for updates | |
| `vmaf` (QoE only) | `server/Dockerfile`, `VMAF_VERSION`; not shown in the dashboard, stored in each VMAF result | 3.0.0 |

**Building from a commit.** `moq-cli` and `moq-relay` are compiled with cargo (thin LTO; with older commits only the QUIC transport feature, chosen automatically by `MOQ_CLI_FEATURES=auto` if the commit defines it), keeping Cargo caches between builds; the build stage is only built with `git`, and an unchanged commit comes from the Docker cache (`docker builder prune` frees it). Compiling needs several GB of RAM; the relay takes about 8 minutes the first time on 8 vCPU. The relay image is Debian slim with the binary at `/bin/moq-relay`, the same entrypoint as the published one. For `@moq/watch`, `web/Dockerfile` builds with bun (`MOQ_WATCH_BUN`, default 1.3.5; newer commits such as `c19c723` need 1.4.4) the `@moq/*` packages the commit's `package.json` files require, in dependency order, and the web uses them instead of npm ones (also as indirect dependencies, via `overrides`). `@moq/libav` (the audio polyfill of `@moq/hang`) is replaced by an empty module that errors if loaded: it is only loaded when the browser lacks `AudioDecoder`/`AudioEncoder`, which Chrome has. Patches in `web/patches/` apply with `MOQ_WATCH_PATCHES=1` (default); a patch that does not apply fails the build. `web/.dockerignore` keeps the host `node_modules` out of the image.

**Two `@moq/watch` APIs.** `MoqPlayer.tsx` works with the published version and with both default commits; what differs is translated in `web/src/lib/moqApi.ts`, which only changes how the player is connected and how its outputs are read, never what it does. With `c19c723` the player no longer receives the relay estimate (`probe`): like the official `<moq-watch>` element of that version it reserves a share of the connection estimate (`viewer.viewers`) and picks the quality with what it is granted; option names change (`announced` → `follow`; `canvas`, `visible`, `target`, `muted` move under `video` and `audio`), times become `Duration`, and the painted frame is `renderer.painted` instead of `renderer.out.frame`. The estimate written to the CSV is still `connection.probe` (`estimatedRecvRate`). The `switching` patch and the probing experiment depend on the `bc64b9c` API and are disabled there (the selector shows them disabled and `moq_abr` reads `watch`). See [protocols/moq.md](protocols/moq.md).

The orchestrator checks the latest published version of each component every 6 hours (Docker Hub, GitHub releases, npm registry) and the dashboard marks in amber those with a newer one. **It is only a notice: nothing updates itself.** To update, change the pinned version and redeploy ([deployment.md](deployment.md)); measurements taken with different versions are not comparable. Before accepting a new `moq-cli`, measure the publisher input with a viewer connected and check that it starts (`restarts.moq` in `GET /api/status`; [limitations.md](limitations.md)).

## Page settings: language, screenshots and workers

The **Settings** button in the header (dashboard and `/campaign`) opens a dialog with three sections:

- **Language.** Spanish (default) or English for the whole interface, result tables and charts included. Stored in `localStorage` (`testbed.lang`); changing it reloads the page, so dashboard players reconnect and unexported samples of the current stretch are lost. Campaign analyses and comparisons of two runs or two campaigns are written by the orchestrator in the requested language (`?lang=en` on `GET /api/campaigns/{id}/analysis`, `/api/compare` and `/api/campaigns-compare`; Spanish without it), cached per language (`analysis.en.json` next to `analysis.json`; `comparisons/A__B.en.json`). In English numbers use a decimal point and thousands comma. Not translated: CSV column and API field names (data), campaign events and invalid-run reasons (stored as text when they happen), network and target labels of plans (written by the campaign author) and server error messages. Campaign workers have no preference and always run in Spanish: language changes nothing that is measured or uploaded. In code every string is `t('español', 'English')`, in the web (`web/src/lib/i18n.ts`) and the orchestrator (`server/app/i18n.py`).
- **Screenshots.** Background of images produced by the chart and block capture buttons ([campaigns.md](campaigns.md)): **Transparent** (default) or **White**, both with dark text and print colours, or **Interface blue**, as seen on the page. Stored in `localStorage` (`testbed.captureBackground`), effective from the next capture without reloading.
- **Workers.** Status and setup of independent campaign workers: how many are registered, connected and measuring, the command to add one, and the list with their state and Chrome mode ([campaigns.md](campaigns.md)).

## Per-stage latency breakdown

The **Path of a frame and latency measured at each stage** panel splits glass-to-glass latency among the stages of the path, using measurements only, no estimates. It follows specific frames (about five per second per branch) and records the time at every point where they can be observed:

| Measurement point | Where and how |
| :--- | :--- |
| Origin mark | FFmpeg, when burning the timecode, writes the exact mark, frame number and rendition to its log (`print()` in the filter expression); the orchestrator reads it and can later identify any frame by its timecode |
| Encoder output | `tsgate.py`: time the kernel receives the frame's last packet (`SO_TIMESTAMPNS`) |
| Delivery to the packager | `tsgate.py`: time it reads that packet and writes it to the branch's packager (FFmpeg for DASH and for mediasoup, `moq import` for MoQ). Delayed if the packager does not drain the pipe |
| Complete fragment (DASH) | `origin.py` follows `moof`/`mdat` boxes as they arrive and records when each fragment completes |
| Arrival at the player | DASH: first instant `video.buffered` contains the frame (polled every 20 ms). MoQ: when `@moq/watch` reads it from the connection, before decoding. WebRTC: `receiveTime` given by the browser with each frame, a few ms imprecise |
| Painting | The same timecode reader as the glass-to-glass meter |

Each stage is the difference between two consecutive points (UI labels in bold):

- **LL-DASH:** **Encoding** → **Packager ingest** → **CMAF packaging** → **Delivery** → **Buffer and rendering**.
- **MoQ:** **Encoding** → **Publisher ingest** → **Publishing and transport** → **Buffer and rendering** (jitter buffer and painting).
- **WebRTC:** **Encoding** → **Packager ingest** → **Publishing and transport** → **Buffer and rendering**.

How to read it:

- **The figures belong to one real frame**, the one with median total latency among those followed in the last second, so the stages add up exactly to its latency.
- **Resolution is that of the measurement points, not of each box in the diagram.** How time splits inside a stage is unknown; in MoQ, publisher, relay and network go together because the relay is a third-party binary.
- **Uncertainty:** stages with both timestamps on the server are exact to the millisecond; those crossing to the browser add the clock-sync error (shown) and, in DASH, the 20 ms buffer poll. In WebRTC the split between transport and buffer is not reliable (`receiveTime`).
- **Frame 0 PTS** is obtained by starting the gates before the source. If a measurement does not fit (encoding outside 0-1 s) it is discarded rather than shown.
- **Ingest is comparable across branches**: in all three it is the time the frame waits in `tsgate.py`. Reading the MPEG-TS falls in **CMAF packaging** for DASH and in **Publishing and transport** for the other two.
- **DASH packaging does not go below about 50 ms at 60 fps**, even with 1-frame fragments (median 50-51 ms measured). That is 3 frames: FFmpeg holds each frame 2 frames when reading MPEG-TS (33.5 ms, measured in isolation) and one more when writing and sending the fragment. Audio and interleaving have no effect. It is a cost of FFmpeg and the intermediate format, not of the protocol. The other branches read the same MPEG-TS with less retention (MediaMTX 1 frame, the MoQ publisher about 2). See [protocols/mpeg-ts.md](protocols/mpeg-ts.md).

Animated dots travel each lane at real speed: they spend in each stage the measured time. Stages also go to the CSV (`dash_stage_*_ms`, `moq_stage_*_ms`, `rtc_stage_*_ms`).

First observation with this panel (headless Chrome, unrestricted network): in MoQ, with the library default buffer, about 200 of ~300 ms are spent in the player buffer and only 15-40 ms in publisher, relay and network; in DASH, about 2.8 of ~3.06 s are buffer (DASH target 3 s).

## Reference values

Measured in headless Chrome on the same machine as the testbed, DASH target 3.0 s and MoQ target 200 ms:

| GOP / segment / fragment / bitrate | DASH measured | DASH reported | MoQ measured | MoQ reported |
| :--- | :--- | :--- | :--- | :--- |
| 60 / 2 s / 0.2 s / 4000k | 3.06 s | 3.01 s | 463 ms | 268 ms |
| 120 / 4 s / 0.5 s / 8000k | 3.06 s | 3.00 s | 466 ms | 268 ms |
| 15 / 0.5 s / 0.1 s / 2000k | 3.06 s | 3.01 s | 467 ms | 268 ms |
| 30 / 1 s / 0.2 s / 6000k | 3.06 s | 3.00 s | 462 ms | 268 ms |

In DASH the gap between measured and reported (~55 ms) is encoding, packaging and painting time. In MoQ ~200 ms remain unattributed in this table (publisher, relay, or the headless browser's software decoding).

## Experimental parameters

From the control panel (UI labels in English):

| Parameter | Values | Effect |
| :--- | :--- | :--- |
| **Source** | Big Buck Bunny loop, Tears of Steel loop or **RTSP camera** | With a file, its own fps (60 or 24); with the camera, set by the server (the camera's) and a reference output for VMAF exists. CSV: `source` (`file`, `tos`, `camera`) and `fps`. See [architecture.md](architecture.md) |
| GOP | 0.25, 0.5, 1 or 2 s, in frames at the current rate (15 to 120 frames at 60 fps) | Size of the MoQ group (1 keyframe = 1 new MoQ group ID) and lower bound of the DASH segment |
| **Rendition ladder** | 1 to 5; height 1080/720/540/480/360/240 and free bitrate | What the source encodes. With a single one there is no adaptation |
| Quality (per player) | Auto or a fixed rendition | Auto uses each player's adaptation; fixing one disables it |
| Active players | Any combination of LL-DASH, MoQ and WebRTC, at least one | A player switched off is unmounted: it closes its connection and downloads nothing, so it does not compete for the network or the browser. Remembered in the browser; every change opens a new epoch. CSV: `players`; metrics of inactive players are empty |
| Sound | None (on open), LL-DASH, MoQ or WebRTC: one at a time | Unmutes that player. DASH and WebRTC download audio anyway; **MoQ does not**: `@moq/watch` only subscribes to the audio track when sound is on. Measured with the camera at 15 fps, alternating with None: no visible effect in WebRTC and DASH; in MoQ, equal in three windows (85-91 vs 83-89 ms) and higher in two (127 and 157 ms). Headless Chrome plays to a null output. CSV: `audio` |
| WebRTC server | `mediasoup` (default) or `mediamtx` | `RTC_SERVER` in `.env`, not a panel control: SFU with the layer chosen by mediasoup, or a single rendition without adaptation. Changing it recreates the router and the orchestrator. CSV: `rtc_server`, and with mediasoup `rtc_rendition_kbps`, `rtc_quality_switches`, `rtc_bw_estimate_kbps`, `rtc_quality_mode`. See [protocols/webrtc.md](protocols/webrtc.md) |
| **WebRTC audio** | Off (default) or on | The source Opus, not re-encoded. Raises WebRTC latency to the audio jitter buffer: little with the file loop, 100-200 ms with the camera. CSV: `rtc_audio` |
| **Pacer on the WebRTC ingest** | Off (default) or on | mediasoup only: the relay spreads each rendition's RTP at 2.5× its bitrate instead of releasing each frame at once. A declared experiment, common to all viewers; it delays keyframes. CSV: `rtc_pacing` |
| Fullscreen (per player) | Button at the top right of the video (on hover) or double click; Esc to exit | Enlarges the video area with its notices. Only scales the image: the timecode is read from the decoded frame and the MoQ player keeps drawing even when its canvas is covered (`visible: 'always'`); the other players keep measuring behind (checked in headless Chrome). CSV: `fullscreen` |
| **DASH segment** | 0.5, 1, 2, 4 s | `-seg_duration`; must be ≥ GOP |
| **CMAF fragment** | 1 frame, 100 (default), 200, 500, 1000 ms | `-frag_duration`, the chunked delivery unit. 1 frame is `-frag_type every_frame` (16.7 ms at 60 fps) and is 0 in the API and the CSV. Measured without a link limit and target 0.3 s: DASH latency does not drop (394-410 vs 390 ms with 100 ms; dash.js's buffer sets it) but its throughput estimate does (16-18 vs 40-50 Mbit/s). With a limited link the opposite: with 1 frame dash.js overestimates more (1.6-1.7× the link vs 1.2× with 100 ms at 4 Mbit/s). See [adaptation-and-experiments.md](adaptation-and-experiments.md) |
| DASH target latency | 0.05 to 2.0 s (0.3 s on open) | `liveDelay` of dash.js, with LoL+ catch-up. CSV: `dash_target_ms` |
| DASH minimum buffer | 0 to 2 s; 0 on open (do not slow down for buffer); dash.js default is 0.5 s | `liveCatchup.playbackBufferMin`: below it, LoL+ slows down to refill the buffer and does not chase the target until above it. Since latency is never lower than the buffer, it acts as a floor: with a target below it, latency stays above the target ([protocols/ll-dash.md](protocols/ll-dash.md)). CSV: `dash_playback_buffer_min_s` |
| DASH ABR | Default (on open), L2A, L2A (bugfix) or LoL+ | dash.js adaptation rules in Auto: factory rules, or one of its low-latency rules alone. L2A (bugfix) is an experiment: L2A with its dash.js 5 unit bug fixed. Changing it recreates the player. CSV: `dash_abr` |
| DASH jump to live | 0 (off) to 10 s, default 1.5 s | `liveCatchup.maxDrift`: drift over the target beyond which it jumps to live instead of correcting with playback rate. The jump aborts downloads and opens cold TCP connections; with high network delay it can chain jumps and stalls. CSV: `dash_max_drift_s` |
| MoQ target latency | auto (on open), or 50 to 2000 ms | `delay` of `@moq/watch`. In auto (its default) the library computes it from the RTT the relay reports (1.25 × the minimum, floor 20 ms). In both cases it adds the catalog track jitter; the effective value is shown next to the slider. In auto `moq_target_ms` is empty. **In auto it does not rise during the session**: after changing the network profile, reload to recompute it ([protocols/moq.md](protocols/moq.md)) |
| MoQ ABR (experiment) | Library (default), Probing or Probing v2 | Who decides the quality: `@moq/watch` or the priority-probing controller. Only with Quality in Auto and with the `bc64b9c` API. Remembered in the browser. CSV: `moq_abr`, `moq_probing`, `moq_probe_capacity_kbps` |
| MoQ switching (experiment) | Seamless (default), Cancel or Priority | What `@moq/watch` does with the previous rendition when switching down. Only with the `web/patches/` patch. Remembered in the browser. CSV: `moq_switching` |
| WebRTC target latency | auto (on open), or 50 to 2000 ms | `jitterBufferTarget` of the receiver; in auto nothing is requested and the browser decides (read from `RtcPlayer.tsx`). CSV: `rtc_target_ms` |

Source, GOP, ladder, segment and fragment require **Apply changes**; sliders act immediately and their value is in the CSV (`dash_target_ms`, `dash_playback_buffer_min_s`, `dash_max_drift_s`, `moq_target_ms`, `rtc_target_ms`), as is the DASH ABR selector (`dash_abr`). The latency sliders mean different things in each branch: declare it when comparing ([limitations.md](limitations.md)).

`window.dashPlayer` and `window.moqPlayer` are exposed in the browser console for inspection.
