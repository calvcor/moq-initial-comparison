# Quality adaptation and declared experiments

With more than one rendition in the ladder, each player adapts on its own (**Rendition: Auto**) or is pinned to one rendition. This document describes how each player adapts as shipped, what has been observed about it, and every experiment option the testbed offers to isolate a mechanism. The protocol-level background is in [protocols/ll-dash.md](protocols/ll-dash.md), [protocols/moq.md](protocols/moq.md) and [protocols/webrtc.md](protocols/webrtc.md); network conditions are described in [network-emulation.md](network-emulation.md); confounders are collected in [limitations.md](limitations.md).

**In Auto the testbed does not intervene in any player**: it observes dash.js, `@moq/watch` and mediasoup as they come (measurement principle: observe the protocol, do not make it work). Only when a rendition is pinned by hand is the player asked for that one (in MoQ, by rendition name). Every option that changes a player's behaviour is a declared experiment, off by default, recorded in the CSV and flagged in the campaign editor.

## How each player adapts

| | LL-DASH | MoQ | WebRTC (mediasoup) |
| :--- | :--- | :--- | :--- |
| Where the renditions are | Several `Representation` in one `AdaptationSet` of the MPD | Several renditions (tracks) in the broadcast catalog | Simulcast layers received by the SFU over RTP |
| Who decides | The client (dash.js) | The client (`@moq/watch`), from what the relay estimates | The server (mediasoup), per viewer |
| Input | Throughput measured on its own downloads | Rate estimated by the relay's congestion controller, sent in PROBE messages | mediasoup's estimate of the downlink to the viewer |
| Rule | dash.js factory rules (throughput + BOLA), or L2A or LoL+ alone (**ABR** selector) | Highest rendition whose catalog bitrate fits in 80 % of the estimate, no hysteresis (details per version below) | mediasoup defaults; the testbed sets no preferred layers, limits or `initialAvailableOutgoingBitrate` |
| When it switches | At segment boundaries | At group (keyframe) boundaries, seamlessly: keeps the old subscription until the new one catches up | At the next keyframe of the new layer |

With `RTC_SERVER=mediamtx` WebRTC has no adaptation: it always serves the top rendition of the ladder. The WebRTC rendition cannot be pinned by hand.

### Recorded metrics

The panel shows, per player, the current rendition, the number of switches and the estimated bandwidth; everything goes to the CSV (`*_height`, `*_selected_height`, `*_rendition_kbps`, `*_quality_switches`, `*_bw_estimate_kbps`, `*_quality_mode` and `ladder`; see [measurement.md](measurement.md)). The rendition **selected** by the adaptation (`*_selected_height`) and the one **painted** (`*_height`) are recorded separately, because they differ during a switch: in DASH, the Representation chosen by the ABR and being downloaded (`getCurrentRepresentationForType`) versus the `<video>` `videoHeight`, which changes as the buffer drains; in MoQ, the requested track versus the height of the painted frame; in WebRTC, the layer mediasoup sends (`currentLayers` from its stats, read every second; empty with MediaMTX) versus the received height, which changes at the next keyframe. The panel appends "(sel. …)" when they differ.

The three bandwidth estimates do not mean the same thing: DASH reports the mean throughput of its downloads (`getAverageThroughput`); MoQ, the relay estimate that its adaptation uses (`connection.probe`, `estimatedRecvRate`); WebRTC, mediasoup's estimate towards the viewer. The MoQ player always observes the relay estimate, whatever the adaptation mode, so `moq_bw_estimate_kbps` is also filled with a pinned rendition and with the probing experiment. Observing it only keeps open the PROBE channel through which the relay reports its estimate (`@moq/net` opens it only while someone observes it); it does not change which rendition is chosen or how the relay sends.

## LL-DASH (dash.js)

### Rules and the ABR selector

The **ABR** selector chooses among the rules that dash.js itself ships, without modifying them (except the declared `l2afix` experiment):

| Option (`dash_abr`) | Panel | Active rules |
| :--- | :--- | :--- |
| `default` | Default | dash.js factory rules: `throughputRule`, `bolaRule`, `insufficientBufferRule`, `switchHistoryRule` and `abandonRequestsRule` (`droppedFramesRule` is off by default) |
| `l2a` | L2A | Only `l2ARule` (Learn2Adapt) |
| `l2afix` | L2A (bugfix) | Only `l2ARule`, from a copy of dash.js with its units bug fixed. Declared experiment ([below](#experiment-l2a-bugfix-l2afix)) |
| `lolp` | LoL+ | Only `loLPRule` (Low-on-Latency+) |

dash.js documents L2A and LoL+ as tested alone, so the testbed enables only the selected one, as in dash.js's own low-latency example (`samples/low-latency/low-latency-testplayer.html`). Changing the option recreates the player, because both rules keep state from start-up and that example asks for a reload.

**In practice, with the testbed's MPD, the throughput rule decides** (read from the dash.js 5.2.1 code). The MPD declares `availabilityTimeComplete="false"`, so dash.js runs in low-latency mode, where `insufficientBufferRule` is skipped. BOLA only takes over from the throughput rule with 12 s of buffer or more (`hybridSwitchBufferTime`; it hands back below 6 s), more than the maximum target latency. The throughput rule picks the highest rendition whose nominal bitrate does not exceed 0.9 × the estimated throughput, without hysteresis, before each segment request. Each rule proposes a rendition and the lowest wins.

### Throughput estimation

The throughput estimate is what all the effective decisions rest on, and it is biased in three ways (all with dash.js 5.2.1):

- **Without a bandwidth limit it follows the downloaded bitrate, not the network.** With the buffer filled up to the target, the next segment requested is the one being encoded: it arrives in pieces, at the encoder's pace, and each download lasts as long as the segment. dash.js measures in `moofParsing` mode (each CMAF chunk from its `moof` to the end of its `mdat`, the ACTE approach), but a chunk that arrives in 1 ms or less is accumulated with the following ones until the interval exceeds 1 ms (`chunkDownloadTime > 1` in `_calculateThroughputByMoofMdatTimes`), and that interval already includes the idle gap before the next chunk. On a fast network every 100 ms chunk arrives in microseconds, so the estimate becomes about twice the downloaded bitrate (read from the code, confirmed by measurement: 1.66-1.74 Mbit/s while downloading 360p@700 without a limit, 21.2 Mbit/s with a 20 Mbit/s limit, where each chunk takes a few milliseconds and is measured on its own). This is the application-limited sending problem: with downloads paced by the encoder the spare capacity is invisible. The result is path-dependent: after a minute at a low rendition the estimate stays low and raising the target latency no longer lets LoL+ climb.
- **With a limited link it overestimates.** With 100 ms fragments, 720p pinned and a 4 Mbit/s link, dash.js estimated 4.75-4.94 Mbit/s (1.2× the link).
- **With 1-frame CMAF fragments it overestimates more, also with a limited link.** Same conditions with 1-frame fragments: 6.23-6.88 Mbit/s (1.6-1.7×), with more spread; in a campaign with links from 2 to 10 Mbit/s, 1.8-2× in all of them. Why small chunks are measured worse is not traced; that the first read of each chunk already contains much of it, leaving its time out of the measurement, is a deduction. Without a limit, 1-frame fragments lower the estimate instead (16-18 Mbit/s against 40-50 with 100 ms) and do not lower the latency (394-410 ms against 390 ms with a 0.3 s target; the dash.js buffer sets it).

Any rule that decides by throughput (the factory rules in practice, and L2A in its start-up phase) therefore picks above what fits in these conditions.

### Observed behaviour of the factory rules

- **2 Mbit/s, ladder 1080p@4000 / 720p@2000 / 540p@1200, 0.3 s target** (single runs of 60 s, DASH alone): dash.js estimated 2.4-2.8 Mbit/s and stayed at 720p@2000, whose bitrate can reach 120 % of nominal plus audio, with the buffer around 0 s, playback sped up to 1.5× and latency between 0.4 and 4.7 s; 11 s frozen. A higher target helps not because BOLA or the insufficient-buffer rule step in, but because the buffer absorbs the excursions.
- **4 Mbit/s, same ladder, 100 ms queue, catch-up in dash.js's default mode** (2-4 runs of 60 s per variant, alternated): the throughput rule oscillates between 720p and 1080p on almost every segment. At 720p the link is loose and dash.js estimates ~4450 kbit/s (11 % over the link, which eats the 0.9 safety factor) and picks 1080p@4000, which does not fit; at 1080p the router drops packets, the estimate falls to 3750-3950 and it goes back to 720p. All switch requests come from `ThroughputRule`; almost every `<video>` wait follows a switch up to 1080p. With a 0.3 s target: 12-30 freezes and 6.4-15.4 s frozen per minute (720p pinned: 0.2-3.8 s). With a 1.5 s target the freezes almost disappear (0-0.4 s) but the oscillation does not (25-28 switches). The spread between identical runs is large.

### LoL+

**LoL+ stays at the lowest rendition with low targets** (read from the dash.js 5.2.1 code). Before its self-organising map, LoL+ steps down if `buffer − estimated download time < 0.3 s` (`DWS_BUFFER_MIN`), and stays put at the lowest. It estimates the download time for a whole segment, `bitrate × segment duration / throughput`, with 2 s segments here. With a 0.3 s target the buffer is about 0.26 s, so the condition always holds, with or without a network limit. With 2 s segments it needs about 0.6 s of buffer to climb. Measured with 2 Mbit/s, ladder 4000/2000/700 and a 0.3 s target, two alternated rounds: LoL+ stayed at 360p with no switch and no freeze and 0.31 s median latency; the factory rules behaved almost the same (0-1 s frozen); L2A climbed to 720p, which does not fit, and froze 5 s per round. These are two runs per rule, with DASH going through the HTTP entry proxy (so the emulated link acted on the proxy's connection, not the browser's): indicative only.

### L2A

- **L2A does not leave its start-up phase with targets under 1.5 s** (read from `L2ARule.js`, dash.js 5.2.1). It starts in `L2A_STATE_STARTUP` and switches to its own algorithm only when the buffer reaches `B_target`, fixed at 1.5 s. Until then it picks with `getOptimalRepresentationForBitrate(mean throughput × 0.9)`, like the throughput rule. With the estimate inflated by 1-frame fragments, a campaign at 2-10 Mbit/s showed L2A choosing 720p at 2 Mbit/s and 1080p from 2.5 Mbit/s, which does not fit, staying there with the buffer at 0, 47-99 % of the time stalled and 2-3 s latency. What is measured with targets under 1.5 s is that start-up, not the L2A algorithm.
- **In its steady phase it does not sustain 0.5 s either** (declared experiment: steady phase forced with `maxDrift` 0 and a 2 s target until the buffer exceeds 1.5 s for 6 s, then 0.5 s; 4 Mbit/s, 300 ms queue, 100 ms fragments, four runs of 60 s). Almost all switches were in the steady phase; 20-39 switches per minute between 720p and 1080p, 14-17 s of 60 without a new frame and 0.65-1.44 s median latency. The cycle: at 720p dash.js estimates 4.4-4.9 Mbit/s; L2A steps up because the 4000 kbit/s nominal of 1080p fits in that sample without margin; 1080p plus audio does not fit, the buffer drains in 5-8 s, playback stalls 1-3 s, latency rises to 2-4 s, catch-up speeds up to 1.5× and L2A returns to 720p.
- **Its steady phase has a units bug in dash.js 5** (read from the code; present in 5.0.0, 5.2.1, 5.3.0 and the `development` branch). The Lagrange multiplier `Q` and the cautious one-step increase compare `rep.bandwidth` (bit/s) with the throughput (kbit/s); dash.js 3.x and 4.x converted bitrates to kbit/s first. `Q` explodes and the probability distribution jumps entirely to one rendition at every segment: L2A stops learning and picks the highest rendition that fits in the last throughput sample. The `l2afix` experiment isolates it.

### Experiment: L2A (bugfix) (`l2afix`)

- **What it isolates:** the effect of the dash.js 5 L2A units bug, by comparing L2A as shipped with L2A with that single expression fixed.
- **How to enable it:** **ABR: L2A (bugfix)** in the DASH player, or `dash_abr: "l2afix"` in the player options of a campaign. A Vite virtual module (`web/vite.config.ts`) generates at build time a copy of dash.js in which the steady-phase `Q` computation uses `bitrateInKbit` instead of `bandwidth` (which also fixes the cautious increase, which uses the same bitrates), as in dash.js 4.x. If that expression does not appear exactly once in the minified dash.js build (another version), the build fails. The player loads that copy, as a separate chunk, only with this option; the other three options use dash.js as is. The standalone script `scripts/l2a-units-experiment.mjs` runs the same comparison outside the dashboard: it serves, on the testbed origin (intercepting requests over CDP), a DASH-only page with the original and the fixed unminified dash.js 5.2.1, forces the steady phase, alternates the variants and records `Q`, the throughput and the chosen rendition of every steady-phase decision.
- **Why it is not the default:** it is not dash.js as shipped.
- **What was measured** (steady phase forced, 100 ms fragments, 300 ms queue, alternated runs of 60 s). With the script, three runs per variant: at 3 Mbit/s the original stalls 8.8-17.8 s and switches 6-13 times, the fixed one stays at 720p without a switch and stalls 0.1-0.6 s; at 4 Mbit/s, 13.9-16.0 s against 7.5-11.6 s stalled. `Q` is 31,000-39,000 in the original and 0 in the fixed one. At 3 Mbit/s a single download's throughput exceeds 4000 kbit/s in 13-33 % of decisions: the original jumps to 1080p on each, the fixed one does not; at 4 Mbit/s the estimate is above 4000 almost always and the fixed one also climbs, though less. With the dashboard option, two runs per option and network: at 4 Mbit/s, L2A 15.7-19.6 s stalled, 13-15 switches, 67-70 % of the time at 1080p, 0.83-1.01 s median latency; L2A (bugfix) 9.9-13.9 s, 7 switches, 48-50 % at 1080p, 0.52 s. At 3 Mbit/s, L2A 0-14.4 s stalled (1-7 switches); L2A (bugfix) 0.9 s, no switch, 720p throughout.

## MoQ (`@moq/watch`)

### Selection rule

The rule depends on the `@moq/watch` version (read from `js/watch/src/video/source.ts`, `#runSelected`, and `web/src/lib/moqApi.ts`):

| Version | Selection |
| :--- | :--- |
| npm 0.6.x (the default build) | Discards renditions it cannot decode and those the catalog marks `stalled`; takes the relay estimate (`estimatedRecvRate`), applies an 80 % margin and picks the highest catalog bitrate that fits; if none fits, the lowest; without an estimate, the largest picture |
| Commit `bc64b9c` (`MOQ_WATCH_FROM=git`) | The same, without the `stalled` mark (no longer in the catalog schema) |
| Commit `c19c723` and later | The player no longer receives the relay estimate directly: like the official `<moq-watch>` element of that version, it reserves part of the connection's estimate (`viewer.viewers`), chooses with what it is granted, and the connection asks the relay how far to probe (PROBE) from the sum of what the players request |

There is no hysteresis, timer, buffer or history in the rule: selection is recomputed whenever the estimate changes, and the 80 % margin is the only damping. It is a pure throughput rule with the sender's estimate instead of the client's.

**The catalog bitrate is the held peak.** The publisher (`moq-cli`) measures each rendition's bitrate in 1 s windows and keeps the maximum (it rises when a window exceeds it and never falls). Measured: 7.4-7.5 Mbit/s for 1080p@4000 and 3.6 for 720p@2000, about 1.85× nominal. With the 80 % margin, holding 1080p requires an estimate above 9.3 Mbit/s. DASH compares against the nominal bitrate of the MPD.

**The relay estimate is not a measured rate** in the published relay: see [limitations.md](limitations.md#moq-bandwidth-estimate).

**Seamless switching can deadlock.** Switching is subscribing to the new track and unsubscribing from the old one. `@moq/watch` keeps painting the old track until the new one has caught up with its playhead (100 ms slack), then promotes it; there is no timeout that releases the old one, and both are requested with the same priority (`Catalog.PRIORITY.video`, 60). During a switch two renditions are downloaded, exactly when the network is worse; if the old one already fills the link, the new one never catches up. Measured with `moq-cli` and `@moq/watch` at `bc64b9c`, ladder 1080p@4000 / 720p@2000 / 540p@1200 and 2 Mbit/s: for 60 s the selection was 540p in 58 of 60 samples and the painted frame 1080p in all 60, with the link full and 10 s frozen. No option of the library changes this, and no IETF draft prescribes it; MOQT (`draft-ietf-moq-transport-22`, 14.1.2) only suggests requesting the alternative track at lower priority to probe when switching up. The `switching` experiment isolates it.

### Observed behaviour

- **4 Mbit/s, ladder 1080p@4000 / 720p@2000 / 360p@700 / 240p@400, `@moq/watch` 0.6.2 and `moq-cli` 0.14.2** (one 90 s run): the selection changed about 35 times per minute while the painted frame stayed at 1080p (the seamless switch never completed with the link full), with 46 freezes (14.8 s); the relay estimate was 3-6 Mbit/s on a 4 Mbit/s link. DASH, in the same conditions, stayed at 720p with 1 freeze. With a free network the selection also oscillated (about 50 times per minute) because the publisher marked the top rendition `stalled` intermittently; that mark comes from the publisher's ingest limit ([limitations.md](limitations.md#source-content-and-server-load)) and does not reflect the network.
- **10 Mbit/s, 3 renditions, one browser:** 1080p for 60 s without a switch or a freeze, 3.8 Mbit/s of payload.

### Micro-stalls with a limited network

With the downlink limited to 6 Mbit/s (ladder 1080p@4000 / 720p@2000 / 360p@700, MoQ alone, a per-frame log of what `@moq/watch` paints, obtained from the frame signal without copying images), MoQ is shown almost always at 1080p but with hitches and, at times, a step back in the picture. Without a limit, over 60 s: 0-2 gaps over 50 ms, no backward or forward jumps, constant `auto` delay and no drops. With 6 Mbit/s there are two distinct phenomena:

1. **Backward steps of up to 100 ms: every track switch.** In Auto the selection changed 122-150 times per minute (the 1080p catalog bitrate, ~7.5 Mbit/s, oscillates around the threshold), with 44-55 backward jumps of at most 100 ms, including 1080p → 1080p: re-selecting the track already on screen opens another subscription to it and promotes it the same way. With 1080p pinned, no backward jumps. The bound is by design: `@moq/watch` promotes the new track when it is less than 100 ms from the old picture (`SLACK` in `js/watch/src/video/playhead.ts`, whose comment says it is also the largest backward step that can be seen).
2. **Freezes and forward jumps: late frames.** With 1080p pinned there remain 11-20 gaps over 50 ms per minute (1.7-3.5 s in total) and 14-56 forward jumps: the picture stops and resumes further on, without showing what arrived late. The library logged 34 late frames and 3 whole groups skipped as slow (`skipping slow groups`) in a minute. Mean traffic was 3.9-4.5 Mbit/s on a 6 Mbit/s link, yet the router queue dropped packets in almost every run (up to 610 per minute): the relay sends in bursts above 6 Mbit/s. Gaps often end exactly at a keyframe.

| 6 Mbit/s, 1080p pinned | Runs | Gaps >50 ms (sum per minute) | Forward jumps | Queue drops |
| :--- | :--- | :--- | :--- | :--- |
| 100 ms queue, `auto` delay | 4 | 1.7-3.2 s | 14-56 | 0-610 |
| 300 ms queue, `auto` delay | 2 | 3.0 and 3.5 s | 26 and 31 | 100 and 344 |
| 100 ms queue, fixed 800 ms delay | 2 | 0.27 and 1.85 s | 17 and 52 | 294 and 429 |

A deeper queue does not fix it, and an 800 ms buffer only helps in one run. Drops do not explain everything: one run without any had 8 gaps over 100 ms. Why the relay exceeds the link rate with a 4 Mbit/s average is not located; the hypothesis is the BBRv3 pacing of `noq` with 1080p keyframes plus its window cut after each loss, to be confirmed with a relay qlog trace. One or two runs per case, with large variation.

### Experiment: MoQ down-switching (`switching`)

- **What it isolates:** the seamless down-switch deadlock described above, without touching the selection rule.
- **How to enable it:** a patch on `@moq/watch` commit `bc64b9c`, [web/patches/moq-watch-switching.patch](../web/patches/moq-watch-switching.patch), which `web/Dockerfile` applies before compiling `@moq/watch` when building with `MOQ_WATCH_FROM=git` and `MOQ_WATCH_PATCHES=1` (the default in that mode). It adds a `switching` option to `Player` and to the video decoder, exposed as the **Switching:** selector of the MoQ panel (remembered in the browser, because the first switch arrives seconds after loading and the option must be set before connecting) and as `moq_switching` in campaign player options and in the CSV. The version is then shown as `git@bc64b9c+switching`. With the npm build, or with commit `c19c723` (where 9 of the patch's 12 hunks fail; build with `MOQ_WATCH_PATCHES=0`), the patch is absent and the selector is disabled. If the commit changes, the patch must be redone; the build fails if it does not apply.

  | `moq_switching` | Panel | On a down-switch |
  | :--- | :--- | :--- |
  | `seamless` (default) | Seamless | Original behaviour: keeps downloading the old rendition until the new one catches up |
  | `cancel` | Cancel | Stops downloading the old rendition immediately (closes its subscription) and freezes its last picture until the new one catches up; if the selection changes before that, or the new one fails, the old one resumes |
  | `priority` | Priority | Seamless, but the new rendition is requested with priority 61 against 60 while the switch lasts |

  A down-switch is a change to a rendition with a lower catalog `bitrate` than the one on screen; switching up is always as in the original. With the patch, the 388 `@moq/watch` tests pass (they cover the default behaviour; the new variants have no tests of their own).
- **Why it is not the default:** it modifies the library.
- **What was measured** (ladder 1080p@4000 / 720p@2000 / 360p@700, MoQ alone, a new headless Chrome per run, variant set before loading, two alternated rounds of 60 s):

  | Downlink | Variant | Painted rendition | Median g2g latency | Frozen (of 60 s) | Router traffic |
  | :--- | :--- | :--- | :--- | :--- | :--- |
  | 2 Mbit/s | Seamless | 1080p throughout | 1.20 and 1.32 s | 50.0 and 51.1 s | 1.97 Mbit/s (full) |
  | 2 Mbit/s | Cancel | 360p throughout | 125 and 141 ms | 0 and 0 s | 1.45-1.48 Mbit/s |
  | 2 Mbit/s | Priority | 360p throughout | 189 and 220 ms | 0 and 0.4 s | 1.45-1.49 Mbit/s |
  | 5 Mbit/s | Seamless | 720p; 1080p the first 14-18 s | 312 and 408 ms | 2.1 and 3.1 s | 3.7-3.9 Mbit/s |
  | 5 Mbit/s | Cancel | 720p | 181 and 229 ms | 0.65 and 0.65 s | 3.5-3.6 Mbit/s |
  | 5 Mbit/s | Priority | 720p | 245 and 262 ms | 0.62 and 0.67 s | 3.7 Mbit/s |

  At 2 Mbit/s both variants remove the deadlock: the switch completes on the first attempt and playback is smooth at the rendition that fits, whereas seamless never leaves 1080p. At 5 Mbit/s the gain is smaller (about 2 s less frozen per minute and 100-200 ms less latency, same sign in both rounds); there the selection rule dominates (the held-peak catalog bitrate makes 1080p unsustainable and the selection changes 18-28 times per minute in all three variants). Cancel and priority give similar results; two rounds cannot rank them.

### Experiment: MoQ adaptation by priority probing (`probe`, `probe2`)

- **What it isolates:** the relay estimate. It replaces it with a capacity measurement that does not depend on it, in the line suggested by MOQT (`draft-ietf-moq-transport-22`, 14.1.2): request the alternative rendition at low priority to probe.
- **How to enable it:** **ABR** selector of the MoQ panel (*Library*, the `@moq/watch` rule; *Probing*; *Probing v2*), or `moq_abr` in campaign player options (`watch`, `probe`, `probe2`). It only acts with the rendition in Auto, and is remembered in the browser. The controller (`web/src/lib/moqProbe.ts`) does not modify `@moq/watch`: it asks for the rendition by `target.name` and subscribes to the probe track with the track API (priority and `maxDelay`) of the older player API. It was developed and measured with `@moq/watch` `bc64b9c`; the dashboard enables it whenever the player does not expose the newer `viewers` API, and with `c19c723` and later (different track API, and the connection itself asks the relay to probe) the options are disabled and the CSV records `watch` in `moq_abr`. The controller is exposed as `window.moqProbeAbr`.
- **How it works (v1, `probe`):**
  - The current rendition keeps the normal video priority. Periodically (4 s probes; every 6 s at first, with a wait that doubles up to 32 s after a failed probe or a down-switch) the controller also subscribes to the next rendition at the lowest priority (0), without decoding it: only its bytes and frames are counted.
  - **Capacity.** The relay only gives the probe track what is left over, so while it lags behind its received rate is the free capacity: `capacity ≈ received by the current + received by the probe`, over the last 2 s of the probe (excluding the first). While probing there is always pending data, so sending is network-limited and there are no idle gaps to bias the measurement.
  - **Real bitrate of the next rendition:** bytes per frame × frame rate, only over groups that arrive whole and at least two (a group start begins with the keyframe and would inflate it); the probe subscription tolerates 10 s of delay so that groups arrive whole.
  - **Up** if `0.8 × capacity ≥ real bitrate of the next rendition` (the same 80 % as `@moq/watch`); after an up-switch the next rendition is probed 5 s later. **Down** if the current rendition receives under 90 % of its frame rate (2 s window); if that happens during a probe, the probe is cut instead.
  - After every switch nothing is decided until the requested rendition is painted (minimum 3 s, maximum 10 s). It starts at the lowest rendition. It works with any **Switching** option; with *Seamless* down-switches may not complete on a full link, so it is measured with *Priority*.
- **v2 (`probe2`).** Same controller with these changes (`probe` stays unchanged so that earlier campaigns can be reproduced):
  - Tolerates 2 s of delay instead of 10, so subscribing brings at most the current and the previous group (with a 1 s GOP), not 10 s of backlog at once.
  - Also switches up if the next rendition keeps up with its frame rate (at least 90 % of its frames per second in the measurement window): if it keeps up next to the current one, it fits alone. If it lags, the capacity rule decides.
  - A probe is not cut because of the current rendition during its first 2.5 s, and a probe cut in its first 3 s does not double the wait.
  - When a probe ends, the frame-rate measurement of the current rendition restarts from zero, so a rate loss caused by the probe itself does not trigger a down-switch.
  - `window.moqProbeAbr.state` also exposes the probe track's frames per second and whether it kept up (`probeFps`, `keptUp`).
- **Recorded data:** the panel shows the capacity of the last probe and the probes started and cut. The CSV has `moq_abr`, `moq_probing` (probe in progress in that row), `moq_probe_capacity_kbps` (value of the last probe, complete or cut, until the next one; empty before the first and if a probe is cut at its start), `moq_probe_spans` (`start-end-result;…` in server-clock ms, each probe in the row of the second it ended), `moq_probe_open_since_ms` (start of the probe still open) and the cumulative `moq_probe_count` and `moq_probe_cuts`. The result is `up` (ended and switched up), `stay` (ended and did not fit), `cut` (cut because the current rendition lost its rate; after 1 s in v1, 2.5 s in v2) or `abort` (the controller closed mid-probe). Recording does not change any decision. In campaign per-second charts the capacity is the metric **capacity estimated by probing**, separate from the estimated bandwidth (which for MoQ is always the relay estimate), and each probe is drawn as a band coloured by its result ([campaigns.md](campaigns.md)). The top rendition is never probed, so a test that stays there shows no probes.
- **Why it is not the default:** it is our own adaptation algorithm, not `@moq/watch`'s. Its parameters (margin, probe duration and interval, starting at the lowest rendition) are a first choice, not tuned.
- **What was measured with v1** (ladder 1080p@4000 / 720p@2000 / 360p@700, MoQ alone, two alternated rounds of 60 s). *Library + Seamless* is the stock behaviour; *Library + Priority* is the switching experiment; *Probing + Priority* is this one.

  | Downlink | Variant | Painted rendition (s of 60) | Median g2g latency | Frozen | Queue drops | Probe capacity |
  | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
  | 2 Mbit/s | Library + Seamless | 1080p throughout | 1.17 and 0.78 s | 52.5 and 50.1 s | 0 | — |
  | 2 Mbit/s | Library + Priority | 360p throughout | 226 and 124 ms | 0.2 and 0.2 s | 0 | — |
  | 2 Mbit/s | Probing + Priority | 360p (53, 60), 720p (7, 0) | 253 and 212 ms | 1.2 and 0 s | 9 and 19 | 0.84-1.88 Mbit/s |
  | 5 Mbit/s | Library + Seamless | 720p (48, 47), 1080p (11, 13) | 259 and 454 ms | 2.5 and 6.6 s | 0 | — |
  | 5 Mbit/s | Library + Priority | 720p throughout | 252 and 233 ms | 0.4 and 0.2 s | 0 | — |
  | 5 Mbit/s | Probing + Priority | 720p (25, 34), 360p (31, 12), 1080p (4, 14) | 178 and 221 ms | 0.6 and 0 s | 45 and 33 | 4.56-4.91 Mbit/s |
  | 10 Mbit/s | Library + Seamless | 1080p throughout | 105 and 229 ms | 0 and 0 s | 0 and 20 | — |
  | 10 Mbit/s | Library + Priority | 1080p throughout | 128 and 277 ms | 0 and 0.3 s | 41 and 4 | — |
  | 10 Mbit/s | Probing + Priority | 720p (39, 39), 1080p (21, 21) | 233 and 252 ms | 0.4 and 0.8 s | 530 and 546 | 8.85-9.81 Mbit/s (2.5-3.6 in the first probe) |
  | Unlimited | Library + Seamless | 1080p throughout | 51 and 50 ms | 0 | 0 | — |
  | Unlimited | Library + Priority | 1080p throughout | 52 and 53 ms | 0 | 0 | — |
  | Unlimited | Probing + Priority | 1080p (53, 37), 720p (7, 23) | 48 and 43 ms | 0 | 0 | 3.2-5.9 Mbit/s |

  - **The capacity measurement works:** on a limited link the probe estimates 85-98 % of the real rate, without the inflation of the relay estimate. Without a limit there is no capacity to measure: the probe track catches up and what is received is just the bitrate of both renditions.
  - **As an adaptation algorithm it does not beat `@moq/watch` with the Priority switch** in these static conditions: they tie at 2 Mbit/s; at 5 Mbit/s probing oscillates (1080p sits right at the limit, 0.8 × capacity ≈ 3.7-3.9 Mbit/s against a real 3.8-4) and chained down-switches leave it at 360p for up to 31 s; at 10 Mbit/s and unlimited it loses on start-up (7-39 s to reach 1080p).
  - **Probing costs drops:** at 10 Mbit/s the queue dropped 530-546 packets per minute (against 4-41 without probing), because the relay fills the link while probing. Priority protects the current rendition at the relay, not in the bottleneck queue.
- **Why v1 leaves MoQ at 360p on 4-10 Mbit/s links** (campaign of 200 tests, 1230 probes reconstructed from the per-second rows, no loss, 300 ms queue; MoQ selected above 360p only 10-26 % of the time). Both causes come from the burst that opens each probe. Subscribing with 10 s of tolerance requests every group of those 10 s that the relay holds (`maxDelay` is what asks for late data: `js/net/src/track.ts` in moq), and they arrive at once: in one 10 Mbit/s test the first probe filled the link for 3 s and the second entered at 20.5 Mbit/s with 1303 drops. The router queue is FIFO, so the current rendition's frames wait behind the burst or are dropped, it falls under 90 % of its rate and the probe is cut without measuring; 51-60 % of probes were cut on 4-10 Mbit/s links (none without a limit), and 154 of 360 down-switches came within 4 s of a probe. The probes that end measure after the backlog has drained, when the next rendition is already up to date, so they measure the sum of both bitrates rather than the capacity (2.8 Mbit/s median from 360p at 10 Mbit/s, 2.7 unlimited), which leaves the 720p decision on the edge.
- **What was measured with v2** (relay 0.17.9, `moq-cli` and `@moq/watch` at `bc64b9c`; ladder 1080p@4000 / 720p@2000 / 360p@700 with 1-frame fragments, 600 ms target, Priority switch, no loss, 300 ms queue, 20 s warm-up and 60 s measurement, content restarted per test, two tests per network and variant; v2 was measured after the others, not alternated with them). Painted rendition as a share of the measured seconds:

  | Downlink | Variant | Painted rendition | Stalled | Queue drops | Switches |
  | :--- | :--- | :--- | :--- | :--- | :--- |
  | 10 Mbit/s | Probing | 1080p 100 %; 1080p 52 %, 720p 28 %, 360p 20 % | 0 and 0 % | 0 and 133 | 0 and 2 |
  | 10 Mbit/s | Probing v2 | 1080p 67 %, 720p 33 %; 1080p 57 %, 720p 43 % | 0 and 0 % | 36 and 34 | 2 and 3 |
  | 10 Mbit/s | Library | 1080p 100 % in both | 0 and 0.5 % | 0 and 0 | 0 and 0 |
  | 6 Mbit/s | Probing | 360p 82 %, 720p 18 %; 720p 60 %, 360p 40 % | 1.3 and 0 % | 97 and 259 | 1 and 1 |
  | 6 Mbit/s | Probing v2 | 720p 100 % in both | 0 and 1.0 % | 48 and 470 | 0 and 0 |
  | 6 Mbit/s | Library | 1080p 90 and 80 %, the rest 720p | 24.5 and 7.1 % | 0 and 148 | 46 and 25 |
  | 4 Mbit/s | Probing | 360p 82 and 83 %, the rest 720p | 0 and 0.4 % | 18 and 213 | 1 and 1 |
  | 4 Mbit/s | Probing v2 | 720p 100 % in both | 2.9 and 0.4 % | 876 and 201 | 0 and 0 |
  | 4 Mbit/s | Library | 720p 98 % in both | 23.7 and 23.0 % | 0 and 0 | 64 and 51 |

  v2 no longer stays at 360p; against the library it stalls much less on a tight link (0-2.9 % against 7-25 % at 4 and 6 Mbit/s) and does not oscillate, at the price of staying at 720p where the library tries 1080p; at 10 Mbit/s the library reaches 1080p sooner. Probing still costs drops when the next rendition does not fit (201-876 per test at 4 Mbit/s). Two tests per case on a development host, with a static network: indications, not results.

## WebRTC (mediasoup)

mediasoup chooses the simulcast layer per viewer with its default settings; nothing is tuned. Observed behaviour (single runs and one small campaign, ladder 1080p@4000 / 720p@2000 / 360p@700):

- Without a limit it stays at 1080p, 60 fps, with an estimate of 8-11 Mbit/s.
- When the link drops to 6 Mbit/s with 1080p in progress it switches down in 2-5 s, with losses (NACKs and PLIs).
- It climbs back very slowly once the limit is removed: from 720p the estimate went from 2.8 to 4.4 Mbit/s in ~45 s without reaching 1080p; from 360p it was still at 360p after ~100 s.
- At 3 and 1.5 Mbit/s it stays at 360p with an estimate of ~1.2 Mbit/s, although 720p would fit at 3 Mbit/s. **If the estimate falls below the bitrate of the lowest layer, mediasoup stops sending video** (layer "none" in its log), and the picture freezes until the player's watchdog recreates the connection (about 11 s later). Stall time then includes those watchdog restarts, which give a new session: part of the recovery belongs to the testbed, not to mediasoup.
- At 8 Mbit/s with a 100 ms queue a 4-minute session did not converge (21 switches, 360p in the last 2 min, estimate 1.7-3.4 Mbit/s); with a 500 ms queue it was better (mostly 1080p or 720p, no drops) but still oscillated (19-37 switches in 80 s).

Why it underestimates the link is summarised in [limitations.md](limitations.md#webrtc-mediasoup-underestimates-the-link). `SFU_TRACE=1` in the `.env` writes the estimate and the probes to `docker logs testbed-sfu` (diagnosis only).

### Experiment: ingest pacer (`rtc_pacing`)

- **What it isolates:** the effect of unpaced keyframe bursts on mediasoup's estimator and on the bottleneck queue. Without the pacer, FFmpeg releases each frame at once and mediasoup forwards it the same way, with no pacing of its own; a WebRTC publisher such as Chrome would send paced.
- **How to enable it:** the **Pacer on the WebRTC ingest (mediasoup only)** checkbox in the control panel, **Pacer in WebRTC** in each stream of a campaign, or `rtc_pacing` in `POST /api/config` and in the plan's `streams`. The RTP relay (`server/app/rtprelay.py`) then spreads each rendition's RTP over time at `RTC_PACING_FACTOR` × its nominal bitrate (`.env`, default 2.5, libwebrtc's default pacing multiplier `kDefaultPaceMultiplier`), with a 5 ms burst allowance after an idle period; what does not fit waits in order in its queue. RTCP and audio pass without waiting. It does nothing with MediaMTX. Recorded as `rtc_pacing` in the CSV.
- **Why it is not the default:** it changes the input of the SFU for all viewers and delays what waits in its queue, above all keyframes (one of 150 kB at 4 Mbit/s × 2.5 takes about 120 ms to leave). That delay appears in the glass-to-glass latency, not in the server stages.
- **What was measured** (three tests per network, 300 ms queue, development host): at 5 Mbit/s it removes the queue drops and almost all stall time (from 5-26 % to 0-0.4 %), but mediasoup still stays at 360p almost all the time, with its estimate at 1.3-1.6 Mbit/s; at 3 Mbit/s it helps less. Without a network limit it costs about 30 ms of latency (88 against 58 ms).

### Option: audio in WebRTC (`rtc_audio`)

- **What it changes:** adds the source's Opus audio to the WebRTC branch, without re-encoding (**Audio in WebRTC** in the control panel, `rtc_audio` in `POST /api/config`; with MediaMTX through a separate UDP path, `liveudpa`). Recorded as `rtc_audio`.
- **Why it is off by default:** the browser synchronises both tracks and **delays the video up to the audio jitter buffer**. Measured with `getStats()` (`jitterBufferTargetDelay` of each track), no sound on any player: with the looped file, video alone gets 59-71 ms glass-to-glass and a 15-20 ms video buffer target; with audio (connecting with the stream already running) 79-149 ms, with the video target rising to the audio's ~40 ms. With the camera, where audio arrives irregularly (27-28 ms of jitter), the audio buffer is 225-315 ms and the video latency rises by 100-200 ms (244-329 ms without audio, 330-557 ms with it). DASH and MoQ carry audio in their streams regardless; see [limitations.md](limitations.md#audio).

## Other declared variants

| Variant | How | What it changes |
| :--- | :--- | :--- |
| `netem rate` limiter | `shaper: "netem"` in a link profile | How the router enforces the rate ([network-emulation.md](network-emulation.md#rate-limiter-tbf-or-netem-rate)) |
| WebRTC through MediaMTX | `RTC_SERVER=mediamtx` in the `.env` | A single rendition over WHEP, no adaptation ([protocols/webrtc.md](protocols/webrtc.md)); recorded in `rtc_server` |
| MediaMTX ingest over RTSP | `RTC_INGEST=rtsp` (MediaMTX only) | An extra FFmpeg publishing over RTSP instead of direct UDP; recorded in `rtc_ingest` |
| MoQ components from a git commit | `MOQ_RELAY_FROM`, `MOQ_CLI_FROM`, `MOQ_WATCH_FROM` = `git` with their `*_COMMIT` | Relay, publisher or player built from an unreleased commit; versions shown as `git@<commit>` in the panel and in `versions` ([deployment.md](deployment.md)) |
| DASH catch-up settings | **Seek to live** (`maxDrift`, default 1.5 s) and **Minimum buffer** (`playbackBufferMin`, 0 on load; dash.js default 0.5 s) | How dash.js chases its target; recorded in `dash_max_drift_s` and `dash_playback_buffer_min_s` |
| One player per test | `player_mode: "each"` in a campaign | Controls interference between players in the same browser ([campaigns.md](campaigns.md)) |
