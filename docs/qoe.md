# QoE evaluation (VMAF + LL-GABR)

> [!NOTE]
> This part of the testbed is under construction. The pipeline described here works end to end, but the QoE score has only been checked on a few single sessions: use it to verify the computation, not as a result.

Each session can be scored with the QoE of LL-GABR (Raman, Turkkan and Kosar, 2024, section 4.3, equation 6), which combines VMAF, stalls, latency, playback speed and quality changes. **VMAF is not computed in the browser and the browser records no video**: recording frames would load the browser (and alter the measurement, see [measurement.md](measurement.md)), and sending them would require re-encoding. Instead:

1. During the test the server records the stream leaving the encoder. It is the same stream the three branches distribute, none of which re-encodes.
2. The browser logs which timecode it shows and when.
3. The server computes the VMAF of every recorded frame against its original, rebuilds what each viewer saw from the browser log, and scores it.

In DASH and MoQ transport is reliable and H.264 decoding is deterministic, so the rebuilt frame is the one that was painted. In WebRTC with losses this need not hold: the browser's error concealment is not reproduced and VMAF would be optimistic.

## Recording and matching to the original

`POST /api/qoe/recordings` records from the next keyframe (`server/app/recorder.py`, listening on the fourth output of the source tee, UDP 5004, only while recording); the panel offers 5 to 300 s. Then `server/app/qoe.py` indexes every frame of every rendition:

- its frame number comes from the PTS, which the source sets exactly (`setpts=N`: frame number × 1500 ticks plus a base);
- the base is fixed with the timecode: each frame's timecode is read with the same reader as the browser (`decodeTimecodeFromFrame`), and every frame within 4 ms of one of the marks FFmpeg writes when burning it (those of the per-stage breakdown, copied during the recording) votes for the resulting base;
- the frame number modulo the frames of the original (38 072 for Big Buck Bunny) is the original frame it comes from: the source restarts the original's numbering on every loop.

The index counts what does not fit, which must be 0: PTS off the grid (`pts_off_grid`), non-consecutive numbers (`not_consecutive`) and timecodes more than 100 ms from their own mark (`timecode_disagree`). Otherwise VMAF is refused. The last frame of each rendition is dropped: the recorder cuts it and the decoder completes it with the previous one.

**The burned timecode is not exactly the mark.** Each of its 20 bits reads the clock separately and the mark is written with the last; on a loaded machine some time passes between them. The index records the difference (`timecode_lag_ms`): measured on an 8-vCPU server, median 0 ms, p95 1 ms, maximum 6-12 ms, minimum −4 ms; 0-1 ms on a local machine. A few frames per recording exceed the 4 ms tolerance, which is why the frame number comes from the PTS and the timecode only fixes the base. Glass-to-glass latency, which reads the same timecode, carries an error of that order on those few frames.

`POST /api/qoe/recordings/{id}/check` verifies the matching by PSNR: for 20 frames per rendition, scaled to 1080p, it compares with the matched original and the two before and after. It excludes what the source draws on top (clock, rendition label and timecode strip: rows 136 to 927 in the default ladder). Measured locally:

| Rendition | Mean PSNR (−2, −1, **0**, +1, +2) | Maximum at the matched frame |
| :--- | :--- | :--- |
| 1080p (alone) | 30.2 · 31.8 · **35.4** · 31.6 · 29.9 dB | 19 of 20 |
| 1080p (ladder) | 30.2 · 31.8 · **34.1** · 31.5 · 29.6 dB | 17 of 20 |
| 720p | 29.4 · 30.6 · **32.2** · 30.2 · 28.7 dB | 13 of 20 |
| 360p | 27.5 · 28.2 · **29.1** · 28.0 · 27.0 dB | 11 of 20 |

A 20 s recording crossing the loop boundary gives the same on both sides (e.g. 1080p 44.7 dB matched vs 34.3 and 34.2 for the immediate neighbours), with no inconsistent PTS or frame number. Samples where a neighbour wins all differ by less than 0.5 dB, are in slow scenes and the winner is always an earlier frame; a plausible explanation (deduced, not measured) is that at low bitrate x264 copies blocks from the reference frame. An index shift would put the maximum off 0 in moving scenes too, by several dB.

### Camera as source

With the RTSP camera ([architecture.md](architecture.md)) the original is the reference the source emits on UDP 5005, recorded alongside the stream (`reference.ts` next to `stream.ts`). Its recorder starts earlier, waits for its own keyframe and lasts 5 s longer, to cover all recorded frames. It has the same PTS as the ladder, so the index numbers its frames with the base of the first rendition without decoding it. The index checks that the reference has no off-grid PTS or gaps and covers all renditions (`reference` in the recording: `pts_off_grid`, `not_consecutive`, `uncovered_streams`); otherwise VMAF and the check are refused. Only the PSNR check confirms the matching: a base shifted by a whole number of frames would fit the grid just as well.

For the PTS to match, the reference output avoids two FFmpeg offsets: `muxdelay`/`muxpreload` (0.7 + 0.5 s), which FFmpeg adds to a standalone MPEG-TS output but not to those inside the `tee`; and the shift FFmpeg applies so nothing starts negative, driven by the audio encoder starting a few samples early (312 samples with Opus, 585 ticks). The reference therefore carries its own silent audio track in the same codec, only to shift like the ladder.

The reference is x264 with `qp` 10. Measured on 5 s of Big Buck Bunny against the original:

| Reference | Mbit/s | VMAF mean / min | Luma PSNR |
| :--- | :--- | :--- | :--- |
| qp 0 (lossless) | 238 | 99.26 / 97.43 | 60 dB (identical) |
| qp 6 | 141 | 98.98 / 96.76 | 54.1 dB |
| **qp 10 (used)** | **99** | **98.79 / 96.39** | **51.5 dB** |
| qp 14 | 61 | 98.26 / 95.29 | 48.4 dB |

`-tune zerolatency` gives exactly the same. The VMAF of an identical copy is not 100 (99.26), so the reference costs ~0.5 points. Its size depends on the image: with a near-static 1080p15 test camera, ~9 Mbit/s, about 27 MB per 20 s. With that camera (one 1080p rendition at 4000 kbps, 20 s) index and reference had no incidents and mean VMAF was 95.3 (p5 93.7); the PSNR check won on all 20 samples but by only ~0.5 dB, because neighbouring frames of a still scene are very similar.

### Load on the encoder

Decoding, scaling and comparing run after recording, in processes with `nice 19`, but **`nice 19` is not enough to leave the encoder untouched**. Encoder delay (burned mark → gate arrival, `POST /api/trace`) on an 8-vCPU server, one 1080p rendition, no viewers:

| While | Delay p50 / p95 / max | Duration |
| :--- | :--- | :--- |
| Idle | 6.1 / 15.8 / 42.6 ms | |
| Recording | 4.8 / 11.2 / 19.6 ms | 30 s |
| Indexing | 5.5 / 15.8 / 44.7 ms | 5.3 s for 30 s recorded |
| PSNR check | **10.7 / 28.4 / 48.1 ms** | 22.7 s |

Recording and indexing are not noticeable; the check is. Therefore anything that compares images (the check and VMAF) **only runs with the stream stopped**: the check is rejected while the stream runs. Recordings are kept in `media/qoe/` (the last 10).

## VMAF of every recorded frame

After indexing, the recording joins a queue. Computation starts as soon as the stream is stopped (`POST /api/stop`: neither packagers nor source running). If the stream restarts midway, the job is interrupted and requeued, as on an orchestrator restart. `POST /api/qoe/recordings/{id}/vmaf` requeues a recording; `GET` on the same path returns the result.

- **Tool:** Netflix `vmaf` 3.0.0, built in its own stage of `server/Dockerfile`. Debian's FFmpeg has no libvmaf and is not replaced, because it encodes the source. FFmpeg only decodes and scales; `vmaf` compares.
- **Model:** `vmaf_v0.6.1`, the default (1080p viewed at three screen heights). The recorded image is scaled to 1920×1080 with bicubic, as the VMAF method requires; the browser scales with its own algorithm.
- **Compared area:** the same as the check (without clock, label or timecode strip), so it is not the VMAF of the whole image.
- **Reference:** since the recorded frames are consecutive (checked by the index; otherwise the computation is refused), the original is a continuous stretch of the source video, split in two if it crosses the end of the loop (with `-stream_loop`, FFmpeg does not return to frame 0 after a `-ss`).
- **Output:** VMAF and luma PSNR of every frame, per rendition and in index order, plus mean, p5 and minimum.

Computation time: 55 s for a 20 s, three-rendition recording on a 10-core machine; on an 8-vCPU server, 51-59 s for 30 s with one rendition and 138 s for 27 s with three. As an order of magnitude for Big Buck Bunny: mean VMAF at 1080p and 4000 kbps between 69 and 78 depending on the stretch of the film (p5 57-62); with a three-rendition ladder, mean 89.9 (1080p), 82.0 (720p) and 58.2 (360p) on one stretch; black frames at the end and start of the film give 97.4 in all renditions.

## What each player painted

During the test, the glass-to-glass meter of each active player logs every new frame it paints: time (server clock), timecode and height. These are reads the meter already does; it adds no pixel reads, only stores three numbers per frame (deduced from the code: its cost has not been measured). At the end each player uploads its log (`POST /api/qoe/recordings/{id}/views/{dash|moq|rtc}`) and the server translates it once the recording is indexed:

- **Frame number:** the timecode read in the browser comes from the same encoded pixels as the one the server read when indexing, so it is looked up as-is in that rendition's index, without tolerance. The rendition comes from the frame height.
- **Exact latency of each frame:** paint time minus the mark FFmpeg wrote when burning that frame, not the burned timecode (which may lag a few ms).
- **What does not fit is counted, never filled in:** frames outside the recording (encoded before it started or after it ended), unmatched (timecode inside the recording but not in the index: a misread), unknown height, illegible reads, stretches with sampling stopped (`gaps`) and whether the tab was hidden.
- **Also:** source frames not painted between two painted ones (`skipped`: jumps to live, dropped frames or frames the meter missed), quality changes and frames painted out of order (`backwards`, must be 0).

Recording starts a few seconds before the log (`prerollS`, 5 s by default): frames painted at the start were encoded earlier, by as much as the latency. With more latency than that margin, frames fall outside the recording. `GET /api/qoe/recordings/{id}/views/{player}` returns, per painted frame, time, rendition, frame number and latency.

Checks: with the camera at 15 fps and three renditions, 20 s, all painted frames of the three players (300-309) were matched and none fell outside the recording; with a 0.2 s margin, those of the first second or so fell outside (18-26) and none was unmatched. With the 60 fps loop and a 1080/720/540 ladder, 30 s from a remote headless Chrome: DASH and MoQ painted 1800 frames and WebRTC 1741, all matched; the exact latency (p50 361, 95 and 77 ms) agreed with the meter's within minute-to-minute variation.

## LL-GABR QoE

Once a recording has its VMAF and a player's log, the server computes the QoE with equation 6 of the paper and its weights (`LLGABR` in `server/app/qoe.py`):

$$\text{QoE} = \alpha\sum_t \frac{vmaf_t}{20} - \beta\sum_t rt_t - \gamma\, r_c - \sigma\,\frac{\sum_t l_t}{T} - \mu\,|1-s_t| - \omega\sum_{t\ge 2}\frac{|vmaf_t - vmaf_{t-1}|}{20}$$

with α = 0.077, β = 1.249, γ = 2.897, σ = 1.249, μ = 0.771 and ω = 1.436. Each step t is 1 s of the viewer's clock (a 1 s segment in the paper).

**Content alignment.** With different latencies, in the same clock window each player shows a different part of the film, and VMAF depends strongly on the scene (60 to 77 within half a minute of Big Buck Bunny). So each player's QoE is computed over the same stretch of the source: from the latest "first painted frame" to the earliest "last painted frame" among all players in the test (`content` in the result: frames, video seconds and clock seconds each took). Each is evaluated on its own clock while painting that stretch, so durations may differ: a stall lengthens it, cutting latency shortens it. The same frame of the same rendition has the same VMAF for everyone, since they receive the same encoded stream. With a single player the stretch is everything it painted.

| Term | How it is obtained here |
| :--- | :--- |
| vmaf_t | Mean VMAF of the distinct frames on screen during the step, even if painted earlier: a fully frozen step has the frozen frame's |
| rt_t | Seconds of the step inside a stall: 150 ms or more without a new frame (the Freezes threshold), with its full duration |
| r_c | Number of stalls |
| l_t | Mean latency of what was on screen, in seconds: each frame's (against the FFmpeg mark) grows while it stays on screen. Compared with latency at paint time it adds half a frame interval (~8 ms at 60 fps) |
| s_t | Speed: least-squares slope of video advanced (frame number / fps) against clock over the painted frames of the step, so it does not depend on rounding to refreshes. Identical for the three branches, without reading any player parameter. Only in steps without a stall |

**Choices where the paper is not specific:** it does not define rt_t, r_c or s_t in the text (from its table 3, freeze and latency are in seconds); the speed term appears without a sum and its mean over steps is taken, like the latency term; a step overlapping something unknown (unmatched or out-of-recording frame, no VMAF or latency, sampling stopped) is excluded entirely, so T is the remaining steps (`excluded_steps` counts the others). Quality, stall and smoothness terms are sums, so **QoE grows with duration: only compare sessions of the same duration**, and not with the paper's values (300 s). Smoothness (ω) penalises any VMAF change between seconds, including those of the content itself, not only quality switches: with Big Buck Bunny it subtracts about 4 points in 30 s even without any quality change, equally for the three branches.

`GET /api/qoe/recordings/{id}/qoe/{player}` returns the total, each term, its inputs and every step; the summary is also stored in the recording (`qoe`). `POST /api/qoe/recordings/{id}/qoe` recomputes it.

As a check of the computation (single sessions, no emulated network, all players at 1080p): with the camera at 15 fps, 20 s, DASH 5.20, MoQ 6.17, WebRTC 5.27, with the same VMAF (92.1-92.3) and the difference coming almost entirely from latency (1.09, 0.32 and 0.88 s mean) and, in WebRTC, from speed (1.042 mean, as it was reducing its latency) and smoothness; with the 60 fps loop, 30 s, DASH 2.83, MoQ 3.40, WebRTC 3.42, mean VMAF 67.0-67.1, quality contributing ~7.5 points and smoothness subtracting ~4 to each, the difference coming from latency (0.37, 0.10 and 0.08 s mean).

## QoE test panel

The **QoE test (LL-GABR + VMAF)** panel sits below the dashboard metrics:

- **Run test:** **Duration** (15, 30, 60, 120 or 300 s) and initial **Margin**; the test uses the active players and needs the stream running. It shows the phase and its countdown. Do not switch tabs: the browser stops sampling and those stretches are excluded.
- **Results of each test** (the last 10): per player, the QoE with its six terms (**Quality**, **Stall time**, **Number of stalls**, **Mean latency**, **Playback speed**, **Smoothness**), its inputs (mean VMAF, latency, stalls, speed), frames matched, frames not painted and quality changes, plus warnings when something did not fit (hidden tab, stretches without sampling, frames outside the recording, excluded steps). Per-second chart of VMAF, latency or speed.
- **Stop and resume:** with **Stop the stream for VMAF and resume it afterwards** (checked by default) the server stops the stream as soon as the recording ends (`stop_after` in `POST /api/qoe/recordings`), computes VMAF and QoE, and restarts it with the configuration it had when the test started, stored with the recording (`resume_config`), so it also survives an orchestrator restart. Indexing and log upload do not depend on the stream. If the recording fails, the stream is not stopped; if VMAF fails, it resumes anyway; if someone starts the stream during the computation, the job is requeued and the stream is left alone. That test goes first in the VMAF queue. The outcome is stored in the recording (`resumed`). Unchecked, VMAF waits in the queue until the stream is stopped by hand, and the panel offers a **Stop the stream** button.
- **Export:** **Per-second CSV** with every 1 s step of every player, and **Full JSON** (recording, terms, inputs and steps). QoE is a per-test result, not a per-second measurement: it is not in the samples CSV.

From the browser console: `await qoeTest(30)` (duration in s; an optional second argument sets the margin, default 5 s). It does not stop the stream. API details: [api.md](api.md).
