# Latency measurement

This document explains how the testbed obtains its two latency measurements: the total (*glass-to-glass*) latency and its breakdown into stages, and in particular how each timestamp taken along the path is known to belong to the same frame. The other metrics (frame rate, stalls, buffers, QoE) are in [measurement.md](measurement.md) and [qoe.md](qoe.md).

The principle: **all three branches are measured the same way, from what is shown on screen**. Player-reported latencies are not used: each defines it differently and none covers the whole path.

## The burned-in timecode

Before encoding, the source draws on every frame the time at which it processes it, as a row of white and black squares in the bottom-left corner that survives compression.

```
┌─────┬─────┬─────┬─────┬─────┬─────┬────┬─────┬─────┐
│white│black│ b19 │ b18 │ b17 │ ... │ b0 │black│white│
└─────┴─────┴─────┴─────┴─────┴─────┴────┴─────┴─────┘
 references      20 cells: one bit each      references
```

| Property | Value | Reason |
| :--- | :--- | :--- |
| What it encodes | The server wall clock in milliseconds, modulo 2²⁰ | The common reference for the whole path. |
| Bits | 20 | One cycle is 2²⁰ ms = 17.5 minutes, far more than any latency. |
| Cell size | 32 px; 16 px when the rendition is narrower than 26 × 32 = 832 px | Aligned to compression blocks so it survives encoding. |
| Position | x = 2 cells from the left; y about 2.5 cells above the bottom, rounded down to a multiple of 16 rows | Inside the picture, away from the edge. |
| End cells | Fixed white and black | Give the reading threshold and reveal a picture with no timecode. |
| Background | A black box with half a cell of padding | Bits are white cells drawn on black. |
| Encoding | Gray code | See below. |

The filter is built by `timecode_filter(timecode_layout(width, height), stream)` in `server/app/main.py`: one FFmpeg `drawbox` per cell, each bit enabled by an expression on `time(0)`, the wall clock when FFmpeg evaluates it. Each rendition gets its own timecode, drawn after scaling (a downscaled 1080p timecode would be unreadable at 360p). `GET /api/status` publishes each layout in `timecodes` (`bits`, `cell`, `x`, `y`, `width`, `height`), and the reader uses the one matching the height it shows.

**Why Gray code.** In binary, 7 → 8 flips four bits (`0111` → `1000`) and a misread cell at that moment can give any number; in Gray code consecutive values differ in **one bit**, so the error is at most 1 ms. Each bit uses its own clock reading, with the same 1 ms bound.

**Why only 20 bits.** The full millisecond time needs about 41 bits; the browser rebuilds the high bits from its synchronised clock, which it knows far better than 17.5 minutes.

```
server time when the frame is read:  1 791 554 900 123 ms   → its 20 low bits are 938 139
value read from the timecode:                                                     937 839
difference within the cycle:         938 139 − 937 839 = 300 ms
instant it was burned:               1 791 554 900 123 − 300 = 1 791 554 899 823 ms
```

**Frame log.** The expression of the last bit also calls FFmpeg's `print()` with the exact millisecond burned and the frame number and rendition (`n*10 + stream`); the orchestrator reads it from FFmpeg's log, so any frame can later be identified by its timecode (used by the stage breakdown).

## Reading the timecode cheaply

**The meter must not disturb what it measures.** The MoQ player paints on the page's main thread; a reader copying whole frames to the CPU on every refresh saturates it, the player falls behind and stops reading from the network. `GlassMeter` (`web/src/lib/glass.ts`) is therefore cheap and asynchronous:

1. On every `requestAnimationFrame` it posts itself a message (`MessageChannel`) and samples in that later task, so it sees what this refresh handed to the compositor whatever the order of the players' callbacks.
2. It takes the shown frame as a `VideoFrame`: `new VideoFrame(video)` for DASH and WebRTC (`readyState` ≥ 2); for MoQ, a clone of the frame `@moq/watch` just drew on its canvas.
3. It copies **only two pixel rows** through the middle of the timecode strip with the asynchronous `VideoFrame.copyTo` (even coordinates for 4:2:0) into a reused buffer; while a read is pending, refreshes are skipped.
4. It decodes: luma is the first plane (NV12, I420) or the mean of R, G, B (packed formats); each cell is the mean of its 2 × 2 central pixels. If the reference cells differ by less than 80 the frame has no timecode; a bit cell within 20 % of the range from the midpoint threshold rejects the read as ambiguous. Gray is converted to binary from the most significant bit.

An unreadable frame gives no sample (`--`, never an assumed value).

## Synchronising the two clocks

The timecode carries the **server's** time, so the browser must know the server time, not its own. Every 10 s it sends a burst of 8 requests to `GET /api/time` (`t_ms`, the orchestrator's `time.time()` in ms: the clock FFmpeg burns, on the same host), notes send and receive times (`performance.now()`) and assumes the server time is the midpoint:

```
offset = server time − (send time + receive time) / 2
```

It keeps the request with the **shortest round trip** (`web/src/lib/clock.ts`).

| Value | Example |
| :--- | :--- |
| Sent, browser clock | 12:00:00.000 |
| Received, browser clock | 12:00:00.006 |
| Server answer | 12:00:00.105 |
| Midpoint | 12:00:00.003 |
| Offset | +102 ms: the server is 102 ms ahead |
| Uncertainty | ±3 ms: half of the 6 ms round trip |

The uncertainty comes from not knowing how the round trip splits between the two directions. It is shown in the panel and in the CSV (`clock_offset_ms`, `clock_rtt_ms`). **It bounds every measurement comparing a server time with a browser time**, equally for the three branches, so it does not change the differences between them.

## Glass-to-glass latency

On each sampled refresh, for each player, `latency = server time of the requestAnimationFrame in which the frame was seen − time burned in it`, modulo 2²⁰ ms. A sample is taken only when the timecode changes (a new frame). The card shows the **median of the frames presented in the last second** (`dash_g2g_ms`, `moq_g2g_ms`, `rtc_g2g_ms`). A negative value means the clocks are badly synchronised; it is left visible rather than hidden.

| Included | Not included |
| :--- | :--- |
| Encoding | Reading and decoding the source file, which happen before the burn |
| Packaging | The last step to the screen: composition and monitor refresh, one to two refreshes |
| Network | With the camera source, the camera → server path (the timecode is burned at the server) |
| Player buffer | |
| Decoding and painting | |

What is left out is identical in the three branches. The frame identifies itself, which makes this the most robust measurement in the testbed.

**The measurement assumes the source runs in real time, and it does not always.** The timecode is when FFmpeg draws the frame, but the PTS is frame number × frame duration. If FFmpeg stalls X ms (e.g. lack of CPU), later frames carry a timecode X ms later with the PTS they were due; the players schedule by PTS, so measured latency drops by about X in all three branches at once, though nothing arrived earlier. The buffer pays: in MoQ, the playback reference only moves downwards (the synchronisation code of `@moq/watch`), so the buffer stays at the target minus X until the source catches up and sends frames ahead of their time; if X exceeds the target, the buffer empties and each frame is painted as it arrives, at about 50 ms, with no stall because frames keep arriving. WebRTC readjusts its own RTP-to-clock mapping and comes out differently, with freezes and spikes. A network delay, by contrast, never lowers latency: the buffer either absorbs it or it raises latency. So **a latency below the target in all three branches at once points at the source.** The orchestrator measures this delay every second as `source_lag_ms` (**Source lag** in the panel; see [measurement.md](measurement.md)): check it before interpreting a latency below the target.

## Stage breakdown: the idea

To split the total, the time at which **the same frame** passes several points is recorded and consecutive pairs are subtracted; the panel **Path of a frame and latency measured at each stage** shows the result.

```
burn ──▶ encoder ──▶ handed to ──▶ (fragment ──▶ arrival at ──▶ painted
          output      packager      complete)     player
  │          │            │             │            │             │
  └─ stage 1 ┴─ stage 2 ──┴── stage 3 ──┴─ stage 4 ──┴── stage 5 ──┘
```

**The stages add up exactly to the frame's total latency**, with no estimates. The difficulty is recognising the frame: the timecode is readable only at the start and at the end; in between the frame is compressed bytes, identified differently on each segment.

## Following one frame end to end

About five times per second per branch (one sampled frame every 200 ms), the browser picks a frame that has just been painted and rebuilds its path. Once per second it sends the burned times to `POST /api/trace` and gets back, per frame, `stamp_ms`, `encoded_ms`, `forwarded_ms` and, for DASH, `packaged_ms` (see [api.md](api.md)). The chain of identifiers:

| Step | From | To | How |
| :--- | :--- | :--- | :--- |
| 1 | The painted picture | The burned time | Reading the timecode. |
| 2 | The burned time | The frame number | The source's frame log. |
| 3 | The frame number | Its PTS | Arithmetic. |
| 4 | The PTS | Encoder-output and hand-off times | The gate's log. |
| 5 | The PTS (DASH only) | Time its fragment was completed | The origin's log. |
| 6 | The painted frame | Its arrival time at the player | Different for each player. |

**Step 2: from time to frame number.** The frame log written by the timecode filter gives, for each frame and rendition, the exact time burned and its frame number (0, 1, 2, …). The server looks up the frame whose time matches the one sent by the browser, with 4 ms tolerance (the burned value is whole milliseconds and may differ by 1 ms from the logged one). Frames are 16.7 ms apart at 60 fps, so there is no ambiguity.

**Step 3: from frame number to PTS.** The gate does not see frame numbers: it can only read the PTS, the timestamp each frame carries in the MPEG-TS (see [mpeg-ts.md](protocols/mpeg-ts.md)). The PTS counts 90 000 units per second and advances by a constant `90000 / fps` per frame (1500 at 60 fps, 3750 at 24 fps). Knowing the PTS of frame 0, which the gate records when it sees it pass, any other is:

```
PTS of frame n = PTS of frame 0 + n × 1500          (60 fps)

if frame 0 had PTS 126 000:
   frame 600  →  126 000 + 600 × 1500  =  1 026 000
```

The gates are started about 0.4 s before the source so they see frame 0.

**Step 4: from PTS to server times.** Each branch's gate (`server/app/tsgate.py`) reports two times per video frame, indexed by PTS, to the orchestrator (`server/app/trace.py`), which keeps the last 3600 frames per rendition. The computed PTS is looked up with a tolerance of 750 ticks (half a frame at 60 fps). If the encoder-output time is not between 0 and 1 s after the burn, the PTS reference is considered unreliable and the server returns no times for that frame.

**Step 5, DASH only.** The origin follows CMAF fragments (`moof`/`mdat`) as it receives them and records when each one is completed and which media-time interval it covers. The frame's PTS is converted to media time and looked up in the fragment that contains it.

**Step 6: arrival in the browser.** Each player offers something different:

| Branch | How the painted frame is identified | Where its arrival time comes from |
| :--- | :--- | :--- |
| DASH | By its media time, which `requestVideoFrameCallback` gives with each presented frame | The `<video>` element's `buffered` ranges are polled every 20 ms; arrival is the first poll at which the buffer contained that instant. |
| MoQ | By its timestamp, carried by the decoded frame drawn on the canvas | `@moq/watch` announces the timestamp of each frame it reads from the network, before decoding (`sync.out.timestamp`); arrival is when it announced that one. |
| WebRTC | Not needed | The browser gives, with each presented frame, the time it received its last packet (`receiveTime` in `requestVideoFrameCallback`). |

The tracers are in `web/src/lib/trace.ts` and reuse the `GlassMeter` decoder; in MoQ a frame that is still on the canvas is not sampled twice, which would count its time on screen as buffer.

## Measurement points and stages per branch

The six points, with the clock each time is taken on:

| Point | Where it is taken | Clock |
| :--- | :--- | :--- |
| Burn | FFmpeg filter in the source | Server |
| Encoder output | `tsgate.py`: arrival at the system of the frame's last packet | Server |
| Hand-off to packager | `tsgate.py`: when it reads it and writes it to the packager | Server |
| Fragment complete (DASH) | Origin (`origin.py`) | Server |
| Arrival at player | Web page | Browser, converted |
| Painted | Web page | Browser, converted |

The encoder-output time is the kernel's arrival stamp (`SO_TIMESTAMPNS`), independent of how busy the gate is. The hand-off is delayed if the packager does not drain its input.

**LL-DASH**

| Stage (panel label) | Between | Contains |
| :--- | :--- | :--- |
| Encoding | Burn → encoder output | Scaling, x264 encoding, MPEG-TS multiplexing and internal UDP. |
| Packager ingest | Encoder output → hand-off | Time the frame waits in the gate for FFmpeg to accept it. Normally 0 ms. |
| CMAF packaging | Hand-off → fragment complete | FFmpeg reading the MPEG-TS, and waiting for the fragment to close and reach the origin. |
| Delivery | Fragment complete → arrival | Origin, nginx, emulation router, network and reading in `dash.js`. |
| Buffer and rendering | Arrival → painted | Wait in the MSE buffer, decoding and painting. This is where the target latency acts. |

**Media over QUIC**

| Stage (panel label) | Between | Contains |
| :--- | :--- | :--- |
| Encoding | Burn → encoder output | As in DASH. |
| Publisher ingest | Encoder output → hand-off | Time the frame waits for the publisher (`moq import ts`) to accept it. Normally 0 ms. |
| Publishing and transport | Hand-off → arrival | Importer, relay, emulation router and QUIC network. |
| Jitter buffer and rendering | Arrival → painted | Decoding, wait in the buffer and painting on the canvas. |

**WebRTC**

| Stage (panel label) | Between | Contains |
| :--- | :--- | :--- |
| Encoding | Burn → encoder output | As in DASH. |
| Packager ingest | Encoder output → hand-off | As in MoQ. |
| Publishing and transport | Hand-off → arrival | With `RTC_SERVER=mediasoup` (default): FFmpeg repackaging to RTP, `rtprelay.py`, the mediasoup SFU, emulation router and network. With `RTC_SERVER=mediamtx`: MediaMTX (fed over UDP by the gate), router and network. Includes any retransmissions the browser requests. |
| Jitter buffer and rendering | Arrival → painted | Browser jitter buffer, decoding and presentation. |

Encoding is the same measurement in all branches (before the fan-out); small differences come from sampling different frames. **The resolution is that of the measurement points**: in MoQ, importer, relay and network go together because the third-party relay has nowhere to record a time.

**Confounder: reading the MPEG-TS costs differently in each branch and falls in different stages.** From the arrival of a frame's last packet until it leaves packaged, measured locally at 60 fps: MediaMTX holds it 17 ms (1 frame), the MoQ publisher 34 ms (2 frames, an upper bound that includes the relay) and FFmpeg 50.5 ms (3 frames: 2 reading the MPEG-TS, measured in isolation, and one writing the fragment). The frame inherent to the format (the end of a PES packet is known only when the next one starts) is paid by all three; the rest is each implementation's. In DASH this time falls in **CMAF packaging**, which therefore does not go below about 50 ms at 60 fps even with 1-frame fragments; in MoQ and WebRTC it is hidden inside **Publishing and transport**. The ingest stage measures the same thing in all three branches (time waiting in the gate) and is comparable; the stages after it are not, while the total is. See [mpeg-ts.md](protocols/mpeg-ts.md) and [limitations.md](limitations.md).

## A worked example

Two frames measured against a remote testbed over a client link with high delay variation, which inflates the stages that cross the network. They illustrate how to read the breakdown; they are not reference values.

| Branch | Stages | Sum |
| :--- | :--- | :--- |
| DASH (target 3 s) | 38 + 97 + 76 + 2908 ms (ingest and CMAF packaging combined in the 97) | 3119 ms |
| MoQ (slider 200 ms) | 24 + 0 + 104 + 173 ms | 301 ms |

Reading the DASH row: the frame took 38 ms to encode, 97 ms until its fragment was complete (fragments were 100 ms), 76 ms until it reached the player, and waited 2908 ms in the buffer. Total 3119 ms, which is what its glass-to-glass card showed.

**Which frame is shown.** Of the frames followed each second, stages are not averaged separately: **one real frame**, the one with the median total, is shown, so the figures add up and correspond to something that happened.

## Accuracy and limits

| Measurement | Accuracy | Why |
| :--- | :--- | :--- |
| Stages with both times on the server (encoding, ingest and, in DASH, packaging) | About 1 ms | Same clock at both ends. The burn time may be off by 1 ms. |
| Stages crossing to the browser | The clock uncertainty, ±RTT/2 | They compare a server time with a browser time. |
| Arrival in DASH | Up to 20 ms more | The buffer is polled every 20 ms. Also, a whole fragment arrives at once, so all its frames share an arrival time. |
| Arrival in MoQ | A few milliseconds | The player groups the announcements of frames that arrive almost together; a frame may be given the next one's time. |
| Arrival in WebRTC | Doubtful | See below. |

**Arrival in WebRTC does not match the browser's statistics.** In one test the breakdown gave 11 ms to "Jitter buffer and rendering" while the browser reported 55 ms of mean jitter-buffer residence. The branch total is reliable (it does not use that time); the split between "Publishing and transport" and "Jitter buffer and rendering" is not. Unresolved (see [limitations.md](limitations.md)).

Other limits:

- **What does not add up is discarded.** If any stage of a frame is below −20 ms, some time did not belong to that frame and the whole sample is dropped; frames whose encoding would fall outside 0-1 s get no server times (step 4).
- **Sampling is about five frames per second**, not every frame.
- **The end of a frame is known late** in MPEG-TS, but the gate compensates by recording the arrival of the frame's last packet rather than the moment it learned the frame had ended (see [mpeg-ts.md](protocols/mpeg-ts.md)).
- **After a source restart** the frame-0 reference is lost until it is re-established.

## Three buffer figures that are not the same

Each branch's card also shows a buffer figure, different from the breakdown stage:

| Measurement | What it is | How it is obtained |
| :--- | :--- | :--- |
| "Buffer… and rendering" stage | Time of one concrete frame from arrival to painting. | As above. |
| Local buffer (DASH) | Seconds of video downloaded ahead of the playback position. | Reported by `dash.js`. |
| Jitter buffer (MoQ) | Mean time frames are held in the player. | Time from when the player reads each frame from the network to when it hands it over for painting (`MoqBufferMeter` in `web/src/lib/trace.ts`). Includes decoding. |
| Jitter buffer (WebRTC) | Mean time frames spend in the jitter buffer. | Browser statistics (`jitterBufferDelay / jitterBufferEmittedCount`). Does not include decoding. |

In MoQ the stage and the card figure agree; WebRTC shows the discrepancy above. Not to be confused with either: the **effective delay** next to the MoQ slider, which is not a measurement but the player's target (its buffer setting plus the `jitter`/`delay` the catalog declares; see [moq-catalog-reference.md](protocols/moq-catalog-reference.md)). The measured buffer comes out lower, because the target is counted from the fastest frame to arrive and the others arrive somewhat later (see [moq.md](protocols/moq.md)).

## Where it is recorded

Everything goes to the CSV exported by the panel, one row per second:

| Columns | Content |
| :--- | :--- |
| `dash_g2g_ms`, `moq_g2g_ms`, `rtc_g2g_ms` | Glass-to-glass latency. |
| `dash_stage_encode_ms`, `dash_stage_ingest_ms`, `dash_stage_package_ms`, `dash_stage_deliver_ms`, `dash_stage_player_ms` | DASH stages. |
| `moq_stage_encode_ms`, `moq_stage_ingest_ms`, `moq_stage_transport_ms`, `moq_stage_player_ms` | MoQ stages. |
| `rtc_stage_encode_ms`, `rtc_stage_ingest_ms`, `rtc_stage_transport_ms`, `rtc_stage_player_ms` | WebRTC stages. |
| `dash_buffer_s`, `moq_jitter_buffer_s`, `rtc_jitter_buffer_s` | The card buffer figures. |
| `clock_offset_ms`, `clock_rtt_ms` | Clock synchronisation and its uncertainty. |
| `source_lag_ms` | How far the source is behind real time (last 2 s, from `GET /api/status`). |
| `ingest_anomalies`, `dash_availability_drift_ms` | Session validity indicators (see [measurement.md](measurement.md)). |
