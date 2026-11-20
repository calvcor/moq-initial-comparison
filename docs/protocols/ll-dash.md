# LL-DASH

How the LL-DASH branch works, from the packager to the `dash.js` player (version 5.2.1). Shared concepts (GOP, transport, congestion control, buffer) are in [README.md](README.md); the manifest field by field is in [mpd-reference.md](mpd-reference.md).

## 1. The idea

DASH (*Dynamic Adaptive Streaming over HTTP*) treats video as a **collection of small files** served by an ordinary web server. The player downloads an index, works out which file is due at each moment and requests it over HTTP. All the intelligence is in the client; the server only serves files. That is why it scales so well with CDNs: any HTTP cache will do.

The price is latency. In classic DASH a file (a **segment**) cannot be requested until it is complete, and the player needs several ahead. With 2-6 s segments, latencies of 10-30 s result. **LL-DASH** (*Low-Latency DASH*) is the set of techniques that reduce that without leaving HTTP.

## 2. The pieces

**The manifest (MPD).** An XML document that describes the content. Its hierarchy:

- **Period**: a time span of the content. There is only one here.
- **AdaptationSet**: a component (video, audio). It groups mutually interchangeable versions.
- **Representation**: one concrete version (one **rendition**): resolution, bitrate and codec.
- **SegmentTemplate**: the template from which segment URLs are built.

**The segments.** Two kinds of file per Representation:

- **Initialization segment** (`init-stream0.m4s`): headers (`ftyp` + `moov`) with the decoder configuration. Downloaded once.
- **Media segments** (`chunk-stream0-00042.m4s`): the video itself, numbered. Each one starts with a keyframe.

**CMAF** (*Common Media Application Format*) is the format of those files: fragmented MP4. What matters for low latency is that a CMAF segment is made of **chunks** (here called **fragments**): `moof` + `mdat` pairs, each with a few frames and decodable as soon as it arrives, without waiting for the rest of the segment.

```
2 s segment  =  [moof][mdat] [moof][mdat] [moof][mdat] ... (20 fragments of 100 ms)
                 └ fragment ┘
```

## 3. What low latency adds

Three mechanisms, which must all be present:

1. **Fragmented encoding.** The packager closes a fragment every `frag_duration` and emits it immediately, instead of waiting for the whole segment.
2. **Chunked transfer.** The server serves a segment **while it is still being written**: the HTTP response declares no length and releases fragments as they exist (`Transfer-Encoding: chunked`). The player requests the segment in progress and receives it as a trickle.
3. **Early availability announcement.** The manifest tells the player it may request a segment before it is complete.

In the manifest this comes down to three fields:

| Field | Meaning |
| :--- | :--- |
| `availabilityStartTime` | Wall-clock time at which the stream started. With it and the segment duration, the player **computes** which segment is due at each moment, without downloading any list. |
| `availabilityTimeOffset="1.900"` | The segment may be requested 1.9 s before it is complete: as soon as its first fragment exists (2 s − 0.1 s). |
| `availabilityTimeComplete="false"` | Warns that what is served may be incomplete. It is the low-latency signal. |

Because addresses are computed from the clock, **if the player's clock or the start time is wrong, the player requests segments that do not exist yet, or runs further behind than it thinks**. That is why the manifest also says where to get the time from (`UTCTiming`), and the testbed origin recalibrates the start time by measuring when each segment actually opens. The full manifest, with every field and worked calculations, is in [mpd-reference.md](mpd-reference.md).

## 4. The path in this testbed

1. **Packaging.** `ffmpeg -f dash -streaming 1 -ldash 1` reads the MPEG-TS ([mpeg-ts.md](mpeg-ts.md)), copies the video without re-encoding and produces CMAF fragments. The relevant options:
   - `-seg_duration` and `-frag_duration` (with `-frag_type duration`): the two panel controls. With the "1 frame" option `-frag_type every_frame` is used instead: one fragment per frame.
   - `-use_template 1 -use_timeline 0`: URLs computed by number, no segment list. This is a precondition for the manifest to announce `availabilityTimeOffset`.
   - `-adaptation_sets "id=0,streams=v id=1,streams=a"`: all video renditions in one AdaptationSet, so the player can switch between them.
   - `-method PUT -http_persistent 1`: uploads each file by chunked HTTP PUT as it is generated.
2. **Origin.** An in-memory server inside the orchestrator (`origin.py`) receives those PUTs and serves the GETs. If a GET arrives while the PUT is still open, it forwards the bytes as they come in.
3. **Delivery.** nginx forwards without buffering (`proxy_buffering off`). The browser always connects directly, over HTTP/1.1, to the server through the emulation router, which forwards to the DASH nginx; the browser's own TCP connection crosses the emulated network, as in MoQ and WebRTC:
   - **With `DASH_HOST`**: over HTTPS to port 8443.
   - **Without `DASH_HOST`**, only from HTTP pages: over HTTP to port 8080. From an HTTPS page there is no path and DASH does not play.
4. **Playback.** `dash.js` downloads with `fetch`, reading the body in pieces, and appends each fragment to an MSE `SourceBuffer` (*Media Source Extensions*). From there the browser decodes and paints the `<video>` element ([section 8](#8-the-player-dashjs-inside)).

This branch makes one HTTP request per segment and per component: one for video and one for audio every segment duration (2 s by default). The data of each request arrive spread over those 2 s.

## 5. The player: target latency and buffer

`dash.js` does not play the latest thing it has; it places itself at a fixed distance from the live edge:

- **`liveDelay`** (the **Target latency** slider, 0.3 s on page load) is that distance. Everything between the playhead and the live edge is buffer.
- **Catch-up** (`liveCatchup`). If the actual latency drifts from the target, `dash.js` corrects it **by changing the playback rate**: up to 50 % faster or slower by default. Here it runs in LoL+ mode (`liveCatchupModeLoLP`): if the buffer drops below `playbackBufferMin` (the **Minimum buffer** slider: 0 on page load, 0.5 s as the library default), it slows down to refill it, more the less buffer there is (with a 0.5 s minimum, 0.77× with 0.3 s of buffer and 0.58× when empty), and does not chase the target until the buffer is above it again; otherwise it corrects according to latency (1× when within 2 % of the target). Since latency is never smaller than the buffer, the minimum acts as a floor: with a target below it, the buffer never exceeds it, playback slows down almost all the time and latency stays above the target (deduced from the code, not measured). With the minimum at 0 it never slows down for the buffer.
- **`maxDrift`** (the **Seek to live** slider, 1.5 s here; the library default is 12 s; 0 disables it). If the drift exceeds this threshold, it stops correcting with the rate and **seeks** to the live edge. The seek aborts the downloads in progress and opens new requests.
- **"Empty" buffer.** If the buffer drops below a threshold (0.3 s by default; `lowLatencyStallThreshold` in low-latency mode, `stallThreshold` otherwise), `dash.js` declares it empty. That **does not stop the video** nor lower the quality: its metrics record a rebuffering and, in the default catch-up mode (not in LoL+, which uses `playbackBufferMin`), catch-up stops speeding up. With LoL+ and this MPD it does not change playback: the other things that react to it (BOLA, the insufficient-buffer rule, the synthetic stall, CMCD) are inactive here, so it is left at its default. The video only truly freezes when the browser runs out of data (`dash.js` can stop it at the threshold, but that option, `syntheticStallEvents`, is disabled by default). With a 0.3 s target, the buffer oscillates right around this threshold.

With very low target latencies the buffer is almost nil: any delay of a fragment empties it. That is why DASH needs on the order of seconds of buffer to be stable.

## 6. Quality adaptation (ABR)

**Only the client** decides. `dash.js` measures how fast it downloads and the state of its buffer, and chooses the Representation. The rules active by default in this version:

| Rule | What it looks at |
| :--- | :--- |
| `throughputRule` | Throughput measured over recent downloads. |
| `bolaRule` | Buffer level (BOLA algorithm). |
| `insufficientBufferRule` | Lowers quality if the buffer is draining. **Does not act here**: it is skipped in low-latency mode. |
| `switchHistoryRule` | Avoids oscillating between qualities. |
| `abandonRequestsRule` | Abandons a download in progress if it is too slow. |

In practice, with the testbed MPD, **the throughput rule decides** (read from the dash.js 5.2.1 code). The MPD declares `availabilityTimeComplete="false"`, so dash.js runs in low-latency mode, and in that mode `insufficientBufferRule` is not executed. BOLA only takes over from the throughput rule with 12 s of buffer or more (`hybridSwitchBufferTime`; it hands back below 6 s), more than the maximum of the latency slider. The throughput rule chooses the highest rendition whose nominal bitrate does not exceed 0.9 times the estimated throughput, with no hysteresis, before requesting each segment. Each rule proposes a quality and the lowest wins. The player's "How it works" tab summarises this for the selected options.

The low-latency rules (`l2ARule`, `loLPRule`) exist but are off by default. The **ABR** selector in the panel enables one of them: dash.js documents that they were tested on their own, so the testbed enables only the chosen one and switches the others off, as its low-latency sample does. By default the stock rules are kept. Recorded in the CSV as `dash_abr`.

| Option | Active rules |
| :--- | :--- |
| Default | Those in the table above (`droppedFramesRule`, off by default, stays off). |
| L2A | Only `l2ARule` (*Learn2Adapt*, online learning over throughput, with a buffer model). |
| L2A (bugfix) | Only `l2ARule`, from a copy of dash.js with the unit bug in its steady phase fixed (`l2afix`). It is an experiment, not dash.js as shipped ([../adaptation-and-experiments.md](../adaptation-and-experiments.md)). |
| LoL+ | Only `loLPRule` (*Low-on-Latency+*, which weighs quality, latency, buffer and switches). |

Changing the option recreates the player: dash.js does apply a rule change on the fly, but its low-latency sample asks for a reload, because both rules keep state from start-up.

**How L2A and LoL+ decide** (read from the dash.js 5.2.1 code):

- **L2A** starts in a start-up phase in which it picks the highest rendition that fits in 90 % of the estimated throughput, like the throughput rule, and only moves to its own algorithm when the buffer reaches 1.5 s (`B_target`, fixed). **With targets below 1.5 s it never leaves that start-up phase.** In the steady phase it keeps a probability distribution over the renditions and adjusts it each segment with a Lagrangian descent step: it penalises renditions whose `rate × bitrate` exceeds the last throughput sample (one download) and picks the one closest to the weighted mean. It moves up at most one step, and only if its nominal bitrate fits in that throughput, with no margin. It looks at neither latency nor buffer. In dash.js 5.x its steady phase mixes bit/s and kbit/s in `Q` and in the cautious step-up, and stops learning: it picks the highest rendition that fits the last throughput sample. Forced into the steady phase with 4 Mbit/s and a 0.5 s target (measured), it does not hold it either: it goes up to 1080p, which does not fit, stalls, drops to 720p and repeats every 12-15 s, stalled 25 % of the time.
- **LoL+** chooses with a self-organising map (one neuron per rendition, with throughput, latency, stall and switch) whose weights it picks each segment by maximising a QoE model (reward for bitrate, penalty for stalls, latency and rate other than 1×). Before that it applies a safety step-down: if `buffer − bitrate × segment duration / throughput < 0.3 s` (`DWS_BUFFER_MIN`), it steps down, and at the lowest rendition it stays. With 2 s segments and a 0.3 s target this always holds: LoL+ does not leave the lowest rendition, with or without a network limit. With a 6 s target, locally and unlimited, it went up to 1080p as soon as the buffer exceeded about 1.5-3 s (measured, three runs).

The quality switch happens **at a segment boundary**: the next segment is requested from another Representation. With 2 s segments, that is the reaction granularity.

**Measuring throughput under low latency.** A segment served as a trickle takes the segment duration to download **by definition**, however good the network, so "bytes / time" gives the video bitrate, not the link capacity. `dash.js` compensates by measuring each fragment separately (`moofParsing` mode, the ACTE idea), but it accumulates fragments arriving within 1 ms or less until the interval exceeds 1 ms, and that interval includes the gap to the next fragment. Measured on the testbed: with a fast network (no limit) the estimate follows the downloaded bitrate (1.65 Mbit/s with 360p and no limit) rather than the network; with the network limited to 20 Mbit/s it gave 18.7-21 Mbit/s; with 1-frame fragments it overestimates even with a limit (1.6-2 times the link at 4 Mbit/s, against 1.2 with 0.1 s fragments). These are confounders to declare ([../limitations.md](../limitations.md); details in [../adaptation-and-experiments.md](../adaptation-and-experiments.md)).

## 7. Where its latency comes from

- **Input**: the time the frame waits at the gate before reaching the packager. Reading the MPEG-TS holds back about 3 frames in FFmpeg, and in DASH that cost falls in the packaging stage ([mpeg-ts.md](mpeg-ts.md), [../limitations.md](../limitations.md)).
- **Packaging**: up to one `frag_duration`, the time it takes to close the fragment containing the frame.
- **Network**: TCP. A loss holds up everything behind it until the retransmission.
- **Buffer**: `liveDelay`. By far the largest share.

## 8. The player: `dash.js` inside

The player of this branch is **`dash.js`** 5.2.1, the DASH Industry Forum reference implementation. It is a JavaScript library: everything it does happens in the page, not in the browser.

**What the browser provides and what the library provides.** A browser cannot play DASH. It can play an MP4 handed to it, and offers an API to hand it over piece by piece from JavaScript: **MSE** (*Media Source Extensions*). The division of labour:

| Who | What it does |
| :--- | :--- |
| `dash.js` | Downloads and parses the manifest, computes which segment is due, downloads it, chooses the quality, decides how far from live to play and corrects the rate. |
| MSE (`MediaSource`, `SourceBuffer`) | Receives the MP4 pieces `dash.js` passes it and makes them available to the `<video>`. |
| `<video>` element | Decodes, syncs video and audio and paints. Done by the browser, out of reach of JavaScript. |

```
manifest.mpd ─▶ dash.js ─▶ fetch (trickled segment) ─▶ SourceBuffer ─▶ <video> ─▶ screen
                  │                                     (MSE)          (decodes and paints)
                  └─ decides: what to request, which quality, what playback rate
```

This makes an important difference from MoQ: **`dash.js` does not see the frames**. It hands bytes to the browser and from then on can only act on the `<video>` with the controls it offers: position (`currentTime`) and rate (`playbackRate`). It cannot decide when a particular frame is painted nor skip one. That is why its way of correcting latency is to speed up, slow down or seek.

**The playback cycle:**

1. **Manifest.** Downloads and parses it ([mpd-reference.md](mpd-reference.md)). Synchronises its clock with the server through `UTCTiming`.
2. **Initialization.** Creates a `MediaSource`, attaches it to the `<video>` and opens one `SourceBuffer` for video and one for audio. Downloads the initialization segment of each.
3. **Scheduling.** Computes from the clock which segment is in progress and requests it.
4. **Trickle download.** Uses `fetch` and reads the response body as it arrives, without waiting for the end. Each complete CMAF fragment (`moof` + `mdat`) it recognises is passed to the `SourceBuffer`.
5. **Playback.** The `<video>` advances. `dash.js` watches latency and buffer level and adjusts the rate.
6. **Next segment.** When the response ends, it requests the next one, of the same quality or another if ABR so decides.

**Low-latency mode** has no switch in this version: `dash.js` turns it on by itself when the manifest announces `availabilityTimeComplete="false"`. That is what makes it read the response as a trickle in step 4 instead of waiting for the complete segment.

**Internal components**, for those reading its code or logs:

| Component | Function |
| :--- | :--- |
| `ManifestLoader`, `DashAdapter` | Download and parse the MPD. |
| `TimeSyncController` | Synchronise the clock with `UTCTiming`. |
| `ScheduleController` | Decide when to request the next segment. |
| `FragmentLoader` | Download; in low latency it uses `fetch` with progressive reading. |
| `BufferController` | Feed the `SourceBuffer` and watch its level. |
| `AbrController` and its rules | Choose the quality ([section 6](#6-quality-adaptation-abr)). |
| `PlaybackController` | Control the `<video>` and compute latency. |
| `CatchupController` | Correct latency with the rate or with a seek ([section 5](#5-the-player-target-latency-and-buffer)). |

**Configuration.** `dash.js` is configured with a settings tree (`updateSettings`). The settings the testbed touches:

| Setting | `dash.js` default | Here | Effect |
| :--- | :--- | :--- | :--- |
| `streaming.delay.liveDelay` | Unset; derived from the manifest | **Target latency** slider, 0.05 to 2 s (0.3 s on page load); in campaigns it can be left unset | Distance to the live edge. |
| `streaming.liveCatchup.enabled` | Automatic | `true` | Enables latency correction. |
| `streaming.liveCatchup.mode` | `liveCatchupModeDefault` | `liveCatchupModeLoLP` | Catch-up algorithm. LoL+ looks at latency and also at the buffer. |
| `streaming.liveCatchup.playbackBufferMin` | 0.5 s | **Minimum buffer** slider, 0 to 2 s (0 on page load) | Buffer below which LoL+ slows down and does not chase the target. Floor of latency. |
| `streaming.liveCatchup.maxDrift` | 12 s | **Seek to live** slider, 0 to 10 s (1.5 s on page load) | Drift beyond which it seeks to live instead of correcting with the rate. |
| `streaming.retryAttempts` | Fewer | 15 for manifest, initialization and media segments | Retries on a download failure. |
| `streaming.retryIntervals` | — | 1000 ms for manifest and media segments | Wait between retries. |
| `streaming.abr.autoSwitchBitrate.video` | `true` | `true`, or `false` when a rendition is fixed | Enables or disables ABR. |
| `streaming.abr.rules` | See [section 6](#6-quality-adaptation-abr) | Stock rules (on page load), or only `l2ARule` or only `loLPRule` | Which ABR rules are active (**ABR** selector). |

And the ones left at their defaults that still affect what is measured:

| Setting | Value | Effect |
| :--- | :--- | :--- |
| `streaming.liveCatchup.playbackRate` | −0.5 to +0.5 | How much it can slow down or speed up: between 0.5× and 1.5×. |
| `streaming.buffer.stallThreshold`, `lowLatencyStallThreshold` | 0.3 s | Below this buffer it declares it empty and records it in its metrics (in the default catch-up mode it also stops speeding up). Does not lower quality nor stop the video. With LoL+ it does not change playback. |
| `streaming.utcSynchronization.enabled` | `true` | Clock synchronisation with the server. |

Three of the testbed's choices depart from stock `dash.js` and should be declared: the LoL+ catch-up mode, the `playbackBufferMin` of 0 on page load (with it, LoL+ does not slow down for the buffer and only corrects latency) and the `maxDrift` of 1.5 s.

**What the testbed adds around it**, without touching the library:

- **Waiting for the manifest.** Before creating the player it checks that the manifest exists. The origin does not publish it until it has calibrated the start time, a few seconds after each start.
- **Muting.** The `<video>` is muted so the browser allows autoplay, unless DASH is the player chosen to carry the sound. `dash.js` downloads the audio anyway.
- **Watchdog.** If the picture has not changed for 10 s (after a 20 s grace period), the player is destroyed and a new one created. It counts as a restart in the metrics (`dash_player_restarts`).
- **Fixed rendition.** The **Rendition** selector calls `setRepresentationForTypeById` and disables ABR.
- **Measurement.** The timecode is read from the `<video>`, and the downloaded bytes from the library's events and the browser's Resource Timing API ([../measurement.md](../measurement.md)).

The player is reachable in the browser console as `window.dashPlayer`.
