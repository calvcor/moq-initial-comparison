# Measurement campaigns

A campaign is an unattended battery of runs that measures how the three implementations behave under different network conditions and target latencies. The orchestrator owns the campaign (`server/app/campaign.py`): it stores the plan, applies the stream configuration and the network profile, and decides which run comes next. A browser acts as the **worker**: it mounts the players for the current run and uploads their per-second rows. The worker can be the `/campaign` page itself or headless Chrome driven by `scripts/campaign-worker.mjs`.

Campaigns are managed from the `/campaign` page, linked from the dashboard header. The HTTP endpoints are listed in [api.md](api.md#campaigns); the metrics in each row are described in [measurement.md](measurement.md).

## Contents

- [Concepts](#concepts)
- [The campaign page](#the-campaign-page)
- [Player settings in a run](#player-settings-in-a-run)
- [Target latency](#target-latency)
- [Experimental design](#experimental-design)
- [Validity](#validity)
- [Viewing a run live](#viewing-a-run-live)
- [Campaign queue](#campaign-queue)
- [Repeating a run by hand](#repeating-a-run-by-hand)
- [While a campaign runs](#while-a-campaign-runs)
- [Exported results](#exported-results)
- [Comparing two runs](#comparing-two-runs)
- [Campaign analysis](#campaign-analysis)
- [Comparing two campaigns](#comparing-two-campaigns)
- [Row index and cached analyses](#row-index-and-cached-analyses)
- [Unattended worker script](#unattended-worker-script)
- [Independent workers](#independent-workers)
- [Parallel runs](#parallel-runs)
- [Keeping the worker's web bundle up to date](#keeping-the-workers-web-bundle-up-to-date)
- [Installing a worker with one command](#installing-a-worker-with-one-command)
- [Copying and exporting charts](#copying-and-exporting-charts)

## Concepts

**Division of work.** The orchestrator stores each campaign on disk (`media/campaigns/<id>/`) and sets the pace. The worker sends a heartbeat every second (`POST /api/campaigns-worker`) saying which run it has mounted, receives what it should have mounted, and uploads the per-second rows of its players (the same rows as the dashboard CSV, plus `t_server_ms` in server clock). If the tab reloads or hangs, it reconnects and the interrupted run is repeated. Without independent workers there is a single worker at a time; a second one waits.

**A run** is one network condition × one target latency × one repetition, with one stream configuration and a set of players. It goes through these phases (`phase` in the heartbeat):

| Phase | Orchestrator | Worker |
| :--- | :--- | :--- |
| `preparing` | Applies the stream (only if it changes, or on every run with `content: "restart"`, then waits `stream_settle_s`) and the network, then waits 2 s for the queues to drain | Unmounts its players |
| `mounting` | Waits for the worker (up to 60 s) | Creates **new** players with the run's settings and reports `mounted` and `mounted_at_ms` |
| `warmup` | `warmup_s`; rows are stored, flagged, and excluded from the summary | Measures and uploads rows |
| `measuring` | `measure_s`; these rows make up the summary | Measures and uploads rows |
| `closing` | 8 s to receive the last rows; summary and validity check | Keeps uploading |

Players are always recreated because MoQ in auto mode computes its target only when it connects (see [protocols/moq.md](protocols/moq.md)); this also yields the start-up time (`first_g2g_s`, with a resolution of one row per second).

## The campaign page

- **Campaign list** (left; on mobile, on top). On desktop the page header is fixed and the list and the content scroll independently. Campaigns are grouped by creation day, newest first, with state, time and queue position, plus **New**. The list can be collapsed to a column of buttons (remembered by the browser). **Archive** (on hover in the list, or in the monitor) moves a campaign to the collapsed **Archived** section at the end: nothing is deleted, but an archived campaign cannot be started or queued (archiving a queued one removes it from the queue). The running campaign cannot be archived.
- **Editor** (**New**): streams (source, ladder `height@kbps`, GOP, segment, CMAF fragment from 1 frame (`frag_duration` 0) to 1 s, audio in WebRTC; one per block), **Network conditions** (sweeps of one parameter over a common base, where RTT and jitter are split equally between both directions, loss applies to both and bandwidth to the downlink only; or the network panel profiles; all editable in a table), **Target latencies** (`auto, 100, 300…`: the same value for the three players; per-branch values only through the API), **Protocols and players** (which protocols, their settings, **All at once** or **One at a time**, and quality), and **Design** (repetitions, durations, control runs, attempts, seed). It estimates the number of runs and the duration with the same formula as the server. The campaign is created without starting.
- **Monitor**: state, progress bar (valid and invalid), remaining time, current run, worker, events and the run table with each result (glass-to-glass p50/p95, stall fraction and quality switches per player). The stream (source, GOP, LL-DASH segment and fragment, ladder, WebRTC audio or pacer if used) is shown for the current run and, with several streams, in the **Stream** column, numbered in plan order (`stream_idx` in `runs.csv`, starting at 0). Controls: **Start** or **Resume**, **Pause**, **Archive**, **Delete measurements**, delete, and download the CSVs. There is no cancel: pause does the same and can be resumed. The pencil next to the name renames the campaign in any state (Enter saves, Esc cancels); measurements are keyed by id and are unaffected.
- **Description** (below the name): free text of any length (purpose, hypothesis, what differs from other campaigns; `plan.description`). It is written in the editor and can be edited with its pencil in any state (Ctrl/⌘ + Enter saves, Esc discards); changes are logged in the events, it is shown on hover in the list and it is copied when duplicating.
- **Duplicate** opens the editor with the campaign's plan to create a new one; the seed is left empty (new draw) unless the original one is typed in. **Edit** is available only while the campaign is ready and has never started: it replaces the plan and redraws the runs with the same seed. A campaign that has measured anything cannot be edited (that would mix runs from two plans); duplicate it instead. Per-branch targets created through the API survive duplicating or editing as long as their text is not touched.
- **Worker** (checkbox **This tab is the worker**, or open `/campaign?worker=1`): mounts each run's players and uploads their rows. It requests a screen Wake Lock and warns that the tab must stay visible. While it is active, the monitor polls less often and the run table and results are collapsed, so as not to load the measuring browser.
- **Results** (**Show the results**): one chart per target latency with network conditions on the x axis, or one per network condition with targets on the axis. With several streams, one chart per stream and value (control runs too): runs from different streams are never mixed. To compare streams, the axis can also be **Stream** (one chart per target and network, "Stream 1", "Stream 2"… on the axis, with a key of what changes between them above). Per protocol, one point per valid run (each repetition) and a line through the median of the repetitions; in latency metrics, the requested target as a dashed line (when numeric and equal for the three players). Metrics: glass-to-glass p50 and p95, stall time, seconds with measured latency, bitrate, mean height, mean buffer (`buffer_s_mean`, not the same quantity in the three branches; see [measurement.md](measurement.md)), quality switches, median of the per-second frame-time p95, start-up, **Time in the top rendition of the stream**, **Maximum played height** and **Drops in the downlink queue**. Linear or logarithmic scale (with DASH at `auto`, around 8 s, the log scale keeps the others readable). Control runs are also plotted in execution order, to see drift. Only finished, valid runs are shown. Clicking a run's point opens the run table at its row and highlights it (to **Repeat** or **View** it); median points are not clickable.
- **Second by second** (below the results): up to 8 runs overlaid, by default the repetitions of one condition. The condition is chosen with three selectors: **stream** (only with several; **All (compare streams)** overlays the same network and target across streams, labelling each run with its stream), **network** (with **Control (no restriction)** last) and **target**. Each selector offers only values that have runs; if the other two leave no runs (control runs, for example, only have the first target), choosing it moves the other selector to the closest value and the option says so. One chart per protocol and one line per run. Available series: glass-to-glass, bitrate, IP traffic down or up at the router (`ip.csv`), quality chosen by the adaptation (`*_selected_height`, next to the played height), bandwidth estimated by each protocol (`*_bw_estimate_kbps`; in MoQ, the relay's estimate), MoQ probing capacity (`moq_probe_capacity_kbps`, only with the ABR set to *Probing* or *Probing v2*; each probe drawn as a band from start to end, coloured by its outcome; see [adaptation-and-experiments.md](adaptation-and-experiments.md)), downlink queue drops per second, source lag (common to the three protocols, repeated in each), main-thread load of the worker page (missed refreshes and time in long frames; also common), height, buffer (DASH: video buffered ahead at the row's instant; MoQ and WebRTC: mean wait of the frames delivered since the previous row, empty if none), cumulative stall time, frame-time p95, content progress and content not played. Warm-up is drawn dashed, and seconds without a measurement are not joined (an isolated measured second is drawn as a point).
- **Shade the stalls** (on by default) draws each stall as a vertical band in its line's colour, from its exact start to its exact end. The meter records them in each row (`*_stall_spans`, `"start-end;…"` in server-clock ms, each stall in the row of the second in which it ended, and `*_stall_open_since_ms`, the start of a stall still open). Runs without these fields are shaded per second, more opaque the larger the stalled fraction of the second. With protocols overlaid, each protocol's bands go in their own lane at the top of the chart. The x axis spans all rows of the selected runs, with or without latency, and is the same for all charts.
- **Overlay the protocols** puts everything in a single chart in each protocol's colour (all its runs in that colour; the tooltip names each line), and the legend toggles a whole protocol. The **Several metrics of one run** view selects one run and any set of metrics, each in its own stacked strip with its own scale, a shared time axis and equal y-axis width; protocols are either overlaid (the common legend toggles a protocol in all strips) or, without **Overlay the protocols**, one column per protocol with the same scale in the three columns of a metric. **Chart** in the run table (finished, valid runs) opens that run in this view. Hovering over a strip marks the same second in all strips with its values, to see what happens at once (for example a traffic spike, the DASH buffer draining and skipped content in the same second). Metrics with different units are never overlaid on one axis.
- **Time axis.** With `content: "restart"` the axis is the second of the video since the source started (`source_started_ms`, recorded per run), so the same point on the axis is the same stretch of the source video in every run, which separates content effects (a heavier GOP, a scene cut) from network effects; FFmpeg start-up shifts all runs equally. With `continuous` the axis is seconds since the start of the measurement and each run sees a different stretch of the loop.

While a campaign is running, the dashboard does not mount its players and shows a notice: players in another tab or on another machine would share the emulation queue with the worker's.

## Player settings in a run

Target latency and quality come from the run. Everything else is fixed by the campaign for all its runs (`player_options`, section **Protocols and players** of the editor) and defaults to the dashboard's settings at page load; settings remembered in the browser do not count.

| Option | Values | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `dash_abr` | `default`, `l2a`, `l2afix`, `lolp` | `default` | dash.js ABR rules: factory, L2A, L2A (bugfix, experiment) or LoL+ |
| `dash_max_drift_s` | 0-10 | 1.5 | dash.js `liveCatchup.maxDrift`: drift beyond which it jumps to live (0 = never) |
| `dash_playback_buffer_min_s` | 0-2 | 0 | dash.js `liveCatchup.playbackBufferMin` (LoL+) |
| `moq_abr` | `watch`, `probe`, `probe2` | `watch` | `@moq/watch` adaptation, or the probing experiments |
| `moq_switching` | `seamless`, `cancel`, `priority` | `seamless` | Down-switch behaviour; `cancel` and `priority` need the `switching` patch in `web/patches/` and have no effect without it |

MoQ values other than the library's are experiments: the editor warns and the campaign is declared as such (see [adaptation-and-experiments.md](adaptation-and-experiments.md)). The settings go into every row of `samples.csv` (as reported by the player itself) and into `runs.csv`. Comparing values of one setting requires separate campaigns. No player has sound in a campaign.

## Target latency

Each entry of `targets` carries a value per player (`dash_ms`, `moq_ms`, `rtc_ms`), passed to the player's own control as its implementation understands it: dash.js `liveDelay` (end to end), `@moq/watch` `delay` (a buffer to which the library adds the catalog jitter) and WebRTC `jitterBufferTarget` (receiver buffer only). **They do not mean the same thing**; the analysis axis is achieved latency versus requested latency. `null` (`auto` in the editor) is each implementation's default: in MoQ and WebRTC, their auto mode (sliders at 0); in DASH, `liveDelay` is not set (left at dash.js's `NaN`) and dash.js derives it from the manifest. **For DASH that gives about 8 s** (measured: 8.1 s p50 with 40 ms RTT and with 6 Mbit/s), so `auto` is DASH's unconfigured behaviour, not a low-latency operating point. Normally the three values are equal; different values are a separate, declared experiment.

## Experimental design

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `repetitions` | 3 | Repetitions of each network × target (1-50) |
| `warmup_s` | 30 | Warm-up per run (5-600 s) |
| `measure_s` | 120 | Measurement per run (10-3600 s) |
| `control_every` | 10 | One control run every N runs (0 = none) |
| `max_attempts` | 2 | Attempts per run before it stays invalid (1-5) |
| `content` | `continuous` | `continuous` or `restart` |
| `stream_settle_s` | 15 | Margin after restarting the stream before mounting (0-120 s) |
| `seed` | random | Seed of the run order, stored with the plan |
| `player_mode` | `together` | `together` (all players in each run) or `each` (one run per player) |
| `quality` | `null` | `null` = each player's adaptation; a height fixes the quality |

The order is randomised (with `seed`) within each **block**, which is one stream configuration × one repetition: system drift in a long campaign is not confounded with the condition, and the source is only restarted when the block changes. Every `control_every` runs a **control** run is interleaved, with no network restriction and the first target, to detect that drift. With `player_mode: "each"` each player gets its own run, to measure how much the players interfere with each other in the browser.

**Content.** With `continuous`, the source keeps running between runs and each run sees whatever stretch of the loop comes up, so content (and with it the real bitrate of each GOP) is another variable, randomised by the draw. With `restart`, the source restarts before each run and all runs see the video from the beginning, at the cost of `stream_settle_s` per run. The match is approximate: the instant the measurement starts varies by a few seconds with player mounting time, and each protocol starts at its own pace. A camera source has no content to repeat and always runs continuously. The value is in the `content` column of `runs.csv`.

## Validity

A run is marked `invalid` and repeated at the end of its block (up to `max_attempts`) if any of these hold: rows with the tab hidden; supervisor restarts; ingest anomalies; active players different from the run's; fewer rows than 80 % of the measurement seconds; the worker disconnects (15 s without heartbeat) or unmounts the players; the workers did not mount in time; or, with independent workers, rows from a worker that is not part of the run, a worker missing rows or with other players mounted, or Chrome not in the required mode. With parallel runs, a run is also invalid if the router did not see a player's traffic in its worker's queue.

These are failures of the measurement, not of the protocol. Seconds without latency for a player (stalled video, or video that never starts) do **not** invalidate a run: they are its result, and repeating them would bias the campaign towards good runs. They appear in `coverage` (fraction of measurement seconds with latency) and in the stall metrics. Validity does not check whether the worker machine keeps up with decoding; check `fps_mean` and `main_long_frame_share` before using a run.

## Viewing a run live

**View** in the run table opens the run's players at the top with its settings (target, quality, options), and the server applies its network and its stream (the stream only if it differs from the current one, since reapplying restarts the packagers; if it changes, the page waits `stream_settle_s` before mounting). Nothing is measured or recorded, and it does not count as an attempt. The previous network and stream are saved and restored on **Close** or when leaving the page (with `sendBeacon`); if several previews are chained, the state before the first is restored. Not allowed while a campaign is running (409); starting or resuming a campaign closes any preview first. While a preview is open, `GET /api/status` reports it in `campaign_preview` and the dashboard shows a notice. If the browser is killed, the network stays as the run's until the next preview, campaign or manual change.

## Campaign queue

Only one campaign runs at a time; others can be queued. **Enqueue** (on a ready or paused campaign) appends it to the queue and, if none is active, starts it immediately. When the running campaign finishes, the scheduler starts the first in the queue without involving the browser (workers attach on their own; if the next one needs independent workers that are not connected, it waits for them). The queue is stored by the server (`queue.json`, next to the campaigns) and survives restarts. On the page it is shown above the monitor with order, estimated duration and buttons to move each campaign up, down or out. Each campaign restores, when it ends, the network and stream that existed when it started, and the next one starts from there.

**Pausing the running campaign removes it from the queue and halts the queue** (`halted`): nothing else starts until **Resume the queue**, because pausing is an intervention. A paused campaign does not count in the queue; it can be re-queued or resumed by hand. Starting a queued campaign by hand removes it from the queue, as does deleting it.

## Repeating a run by hand

**Repeat** in the run table appends a copy of a finished run, valid or invalid, to the end of the queue (`retry_of` points to the original; `manual` distinguishes it from an automatic retry; an invalid run keeps whatever attempts it has left up to `max_attempts`). If the campaign had finished, it goes to paused and must be resumed; the network and stream restored at the end are those of that moment. A valid run that is repeated keeps counting until the repetition ends valid; then the original becomes `replaced` (`replaced_by`) and drops out of the results. If the repetition fails, the original is kept. Repeating valid runs chosen after seeing their result biases the campaign just like repeating seconds without latency: use it only when the measurement is known to have been wrong (for example another browser on the same network). It is recorded in `runs.csv` (`retry_of`, `manual_repeat`, `state: replaced`).

## While a campaign runs

`POST /api/config`, `/api/start`, `/api/stop`, `/api/network` and `/api/qoe/recordings` return 409: the campaign owns the stream and the network. When it ends or is paused, the network and stream return to how they were when it started (also if the stream was stopped). While paused they can be changed; on resume, the current state is recorded again and the campaign's settings are reapplied. Resuming while the previous state is being restored returns 409. If the orchestrator restarts with a campaign running, it resumes it on start-up and repeats the current run.

The run analysis, run comparison and campaign comparison endpoints also return 409 while a campaign is running (the page disables **Compare** and shows a notice instead of the analysis), so as not to use the orchestrator's disk and CPU during a measurement. They become available again when the campaign is paused or finished.

## Exported results

Three CSV files per campaign: `runs.csv`, `samples.csv` and `ip.csv` (`GET /api/campaigns/{id}/{name}.csv`). The campaign does not change the behaviour of the implementations: it measures them as they ship.

**`runs.csv`**: one row per run (invalid ones included) and player.

| Group | Columns |
| :--- | :--- |
| Identity and condition | `campaign`, `run_id`, `attempt`, `state`, `kind`, `rep`, `stream_idx`, `network_label`, `target_label`, `players_run`, `player`, `quality`, `content`, `net_down_*`, `net_up_*` (network profile), the `player_options` fields, `invalid_reasons`, `retry_of`, `manual_repeat`, `replaced_by`, `started_ms`, `measure_start_ms`, `ended_ms`, `target_ms` |
| Workers | `workers` (`dash=…\|moq=…`), `worker` (independent worker name, or the single worker's `w-…` id), `worker_ip`, `worker_user_agent`, `worker_decode`, `web_build`; with independent workers also `worker_browser` and `worker_browsers` (`name=headless\|…`) |
| Parallel runs | `parallel`, `batch`, `concurrent`, `concurrent_players` |
| Latency | `samples`, `coverage`, `g2g_p50_ms`, `g2g_p95_ms`, `g2g_mean_ms`, `g2g_sd_ms`, `g2g_min_ms`, `g2g_max_ms`, `first_g2g_s` |
| Stalls and playback | `stalls`, `stall_ms`, `stall_ratio`, `fps_mean`, `frametime_p95_ms_median`, `content_speed_mean`, `content_skipped_ms`, `content_skipped_share`, `playback_rate_mean`, `playback_rate_min`, `playback_rate_max`, `playback_slow_share`, `playback_fast_share` (playback rate fields: DASH only) |
| Quality | `kbps_mean`, `net_kbps_mean`, `buffer_s_mean`, `height_mean`, `top_height_share` (fraction of time at the highest height reached in the run: a run always at 360p gives 1), `height_max`, `height_min`, `ladder_top_share` (fraction of time at the top rendition of the stream, or the fixed quality), `quality_switches`, `player_restarts` |
| Router (from `ip.csv`) | `ip_down_kbps`, `ip_up_kbps` (exact mean: bytes over duration), `ip_down_kbps_p95`, `ip_up_kbps_p95`, `ip_down_dropped`, `ip_up_dropped`, `ip_down_drop_pct`, `ip_up_drop_pct`, `ip_down_drop_base`, `ip_up_drop_base` |
| Router (from the browser rows) | `ip_down_kbps_mean` (mean of the `samples.csv` column, a 10 s window), `down_dropped`; `packets_lost` (WebRTC) |
| Server | `server_restarts`, `ingest_anomalies`, `source_lag_max_ms`, `source_lag_p95_ms`, `source_late_share` (fraction of seconds with source lag above 50 ms); identical in the three rows of a run |
| Page load | `main_refreshes_missed_per_s`, `main_long_frame_share` (fraction of time in frames of 50 ms or more), `main_long_frame_max_ms`; identical for the players of the same browser |

The drop percentage is computed over the packets that entered the queue according to tc (sent, dropped and queue growth: `<protocol>_<direction>_tc_packets` in `ip.csv`), which are segmented like the drops, and `ip_*_drop_base` is `tc`. Summaries without tc counters use iptables packets (`ip_*_drop_base` = `iptables`), which count each aggregated TCP super-packet as one while netem drops segments; for DASH that overstates the percentage by a factor of 2-4 (measured: about 4 segments per super-packet). This has not been measured on the UDP branches. Stored summaries are not recomputed, and the run comparison warns when the DASH one uses the old base. Drops combine queue overflow and the profile's random loss: they are overflow only on rate-limited networks without loss. See [network-emulation.md](network-emulation.md) for the counters.

**`samples.csv`**: every per-second row with the condition columns in front. `in_summary` marks rows that make up the summary of a valid run (rows from an interrupted attempt keep their `run_id` with a different `run_started_ms`). Each row carries `web_build` and, for every worker, `worker`; independent workers add `worker_viewport` and `worker_browser`. The `net_*` columns always come from the run's plan. In runs with their own router queue (parallel runs), the browser-read global counters (`*_ip_down_kbps`, `*_ip_up_kbps`, `*_down_dropped`, `*_up_dropped`) are emptied on export, as are `ip_down_kbps_mean` and `down_dropped` in `runs.csv`, because they summed every run in the batch; the run's own figures are in `ip.csv` and in `ip_down_kbps`, `ip_down_kbps_p95` and `ip_down_dropped`.

**`ip.csv`**: IP traffic at the router for each second of warm-up and measurement, per protocol and direction (`dash_down_bytes`, `dash_down_kbps`, …, `dash_down_packets`, `dash_down_dropped`, `dash_down_tc_packets`, …), read by the orchestrator itself, plus the source lag in that interval (`source_lag_ms`). Each row is the exact interval between two readings (`from_ms` to `t_server_ms`, server clock) and belongs to the phase in which it ends. With parallel runs, these counters are those of the worker's own queue, and those of protocols the run does not measure are empty.

## Comparing two runs

Runs from the same campaign or from two different ones. **Compare** on a finished run selects it as A (remembered in the browser; a bar shows it, also when switching campaign), and **Compare with A** on another selects B. A panel opens at the top with the protocol on each side (the same by default; they can be crossed), **Swap** and **Copy text**. The text is written by the orchestrator (`server/app/compare.py`, `GET /api/compare`) with fixed rules from each run's summary and rows, without a language model: the same figures always give the same text and nothing unmeasured is filled in. It has four parts:

- **What differs between them**: protocol, content and frame rate, ladder, GOP, segment and fragment (with DASH), audio, pacer and WebRTC server (with WebRTC), network and its profile, target, compared player settings, player with sound, players in the run, versions (from the row, including browser libraries; otherwise from the campaign), worker, Chrome, decoding, web build, runs measured concurrently and durations. Between campaigns, something other than what was meant to be compared almost always differs.
- **Sentences**: the first says which differences exceed the variation between repetitions and which are inconclusive; then one per aspect, with both figures and the difference: latency (median and p95; under one frame, "practically the same"), stalls (time, count and seconds; under 0.5 % of the time only the figures, without a relative percentage), quality (mean height, whether they reached the top rendition and for how long, quality switches; maximum height and time at the top are computed from the rows), bitrate and, when relevant, coverage, content not played, fps, start-up, player restarts and router drops.
- **Variation between repetitions**: each metric is compared with its range across the valid repetitions of the same condition (stream, network and target) in each side's campaign, taking the larger of the two; if the difference does not exceed it, the sentence says it is inconclusive. This is a practical rule, not a statistical test: with two or three repetitions the range underestimates the variation, and with no other repetitions there is no verdict (a warning says so).
- **Warnings**: run not current (invalid or replaced), measured with an older version of the meter whose figures are not comparable, camera source, source more than 100 ms behind real time, measured in parallel, different frame rates, different protocols, different ladders, and metrics only one side has.

**Show all metrics** gives the full table: A, B, difference, range between repetitions and verdict.

## Campaign analysis

**Show the text analysis** (below the results) describes the whole campaign in sentences, with **Copy text**. Like the run comparison, it is written by the orchestrator (`server/app/analysis.py`, `GET /api/campaigns/{id}/analysis`) with fixed rules over the valid runs, without a language model. The unit is the **condition** (stream × network × target), with the median of its valid repetitions and their range as the variation between repetitions; control runs are handled separately. Sections:

- **Between protocols**: for each pair, in how many conditions one has lower latency (median and p95), stalls less, plays at a higher height, spends more time at the top rendition, receives more bitrate, switches quality more or leaves more content unplayed than the other by more than the variation between repetitions of that condition, in how many the reverse, and in how many it cannot be said; plus the mean over conditions of each (if the mean goes the opposite way to the count, it says so).
- **Between streams**: the same for each pair of streams and each protocol, pairing the same networks and targets.
- **With the network**: series of networks that differ in a single parameter (loss, rate limit, delay, jitter or queue), from least to most restrictive, with each network's median and how it changes.
- **With the target latency**: the same and, for latency, whether it follows the target or stays above it (and below what value it does not go).
- **Drift**: control runs, first half versus second half.
- **Cases to look at**: conditions in which a protocol had latency in fewer than half of the seconds, never reached the top rendition in any repetition, or had repetitions with very different latencies.
- **Warnings**: runs measured with an older meter version, conditions with fewer than three repetitions, runs with the source more than 100 ms behind, runs with a player below 90 % of the frames without being stalled (the worker or the protocol), parallel runs, camera source, declared experiments in the settings, and the fact that target, buffer and bandwidth estimate do not mean the same thing across protocols.

Trends only use combinations of the other factors that were measured at every level (in a half-finished campaign, each level would otherwise come from different conditions), and a change smaller than the variation between repetitions (divided by √n, since each point is the median of n conditions) does not count. With a single rendition (or fixed quality), height, time at the top and quality switches are not discussed. It is a descriptive reading, not a statistical test.

## Comparing two campaigns

**Compare with another campaign** (below the analysis) picks another campaign with at least one finished run and compares the whole campaign being viewed (A) with it (B), with **Swap** and **Copy text**. It is written by the orchestrator (`server/app/campaign_versus.py`, `GET /api/campaigns-compare?a=…&b=…`) with the analysis rules, pairing conditions of the two: a condition of A pairs with one of B if they match in **network profile** (not its label), the protocol's **target latency** in ms, and **stream** (if each campaign has a single stream, they are paired even if different and the difference is declared; with several, only identical ones). Parts:

- **What differs between them**: dates, protocols, stream, fixed quality, player settings, WebRTC server, sound, versions, workers, Chrome, parallel runs, design, repetitions and durations.
- **Per protocol**: in how many paired conditions B is ahead of or behind A beyond the variation between repetitions (the larger of the two conditions), and the overall mean.
- **Trends** with network and target for both, side by side.
- **Control runs** of both, face to face: the check that the system did not change between campaigns. If, without network restriction, they already differ by more than their variation and by more than 2 frames of latency, half a point of stall time or 5 % of height or bitrate, it says so, because that weighs on every condition.
- **Unpaired**: conditions of each with no equivalent in the other, warning when a network has the same label in both with a different profile.
- **Warnings**: stall time measured with different meter versions, different streams paired, no equivalent stream, few repetitions, delayed source, parallel runs and declared experiments.

Below the text, the same figures in **tables**, each with **Copy table** (tab-separated, for pasting into a spreadsheet): per protocol, each metric with A and B (mean over paired conditions with data in both), B − A (in points, pt, for percentage metrics, with the relative change beside it) and in how many conditions B is lower, higher or inconclusive; the control runs, with their variation and whether they differ; **Show the per-condition table**, choosing protocol and metric, each paired condition with its repetitions, A, B, B − A, variation and verdict; and **Show the trend tables**, choosing series and metric, each level with A and B for each protocol.

## Row index and cached analyses

Next to each campaign the orchestrator keeps an index of its rows (`samples_index.json`, `server/app/samples_index.py`): per run attempt and player, the seconds spent at each height and some fields from the first measurement row (versions, WebRTC server, sound, frame rate, worker), plus the byte range of each attempt's rows in the file. The same is kept for `ip.jsonl` in `ip_index.json`. Since `samples.jsonl` only grows, only the new part is read each time (a half-written line is left for next time); if the file shrinks or is replaced, the index is rebuilt. The analysis, the comparisons and the **Second by second** chart read only the indexed ranges. While data is loading, the page says so and aborts the previous request when the selection changes.

The analysis is cached (`analysis.json`, `analysis.en.json` for English) and the campaign comparison too (`campaigns/comparisons/<a>__<b>.json`), valid while the rows, the plans, the run states and the analysis code do not change. **Delete measurements** removes the indexes and the cached analysis along with the measurements (`POST /api/campaigns/{id}/clear`).

## Unattended worker script

To leave a machine measuring without a visible tab:

```bash
node scripts/campaign-worker.mjs --url https://testbed.example.org
```

It launches headless Chrome with a disposable profile on `/campaign?worker=1` and checks it every 10 s: if Chrome exits, it relaunches it; if the tab hangs or disappears or, with a campaign running, the server has had no worker heartbeat for 60 s, it reloads the page. The server repeats the interrupted run. On macOS it prevents sleep (`caffeinate`) while it runs. Ctrl+C closes Chrome (killing it if it does not exit within 2 s) and deletes the profile. Requires Node 22 (global `WebSocket` and `fetch`).

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `--url` | `http://localhost` | Orchestrator URL |
| `--name` | none | Run as an [independent worker](#independent-workers) with this name (letters, digits, `.`, `_`, `-`; up to 40 characters). Without it, the single worker |
| `--chrome` | `CHROME` env, else the platform's Google Chrome | Chrome executable |
| `--port` | 9400 | Chrome remote-debugging port. Several workers on one machine need different ports; a worker that finds its port taken by another Chrome refuses to start |
| `--insecure` | off | Treat the HTTP origin of `--url` as secure (needed by IP without HTTPS, not for localhost), e.g. `--url http://10.0.0.5 --insecure` |
| `--no-sandbox` | off | Run Chrome without its sandbox, only if it does not start (e.g. an unprivileged LXC without `nesting=1`) |
| `--software-decode` | off | Software video decoding (`--disable-accelerated-video-decode`) in the three players, for machines whose hardware decoder fails |

Chrome flags: `--headless=new` (or `--kiosk` for a kiosk window), `--enable-gpu`, `--ignore-gpu-blocklist`, `--autoplay-policy=no-user-gesture-required`, plus `--use-angle=metal` on macOS only; on Linux Chrome picks its own backend and `--password-store=basic` avoids a keyring prompt. Without a GPU, decoding and compositing are done in software, so each machine needs enough CPU for 60 fps video.

`--software-decode` exists because on one Linux laptop with an Intel HD 500 (VA-API, iHD driver) MoQ's WebCodecs `VideoDecoder` failed with `Decoding error` after the first GOP while DASH and WebRTC, whose `<video>` falls back to software on its own, kept playing. It costs more CPU, is announced by the worker and recorded in every row as `worker_decode`, and is a confounder when comparing with other machines.

## Independent workers

A campaign can spread its players across separate browsers, each on its own machine (for example one container per protocol), so that they do not share a main thread, decoder, CPU or client connection. It is a campaign option; without it, a single worker (the tab, or the script without `--name`) mounts all players.

- **Announcement and registry.** Each independent worker is launched with a name and sends the same heartbeat as the single worker, with `name`, what it has mounted, its window size, its Chrome mode and whether its machine has a display. On first contact it is registered, with its Chrome mode, in `media/campaigns/workers.json`, and stays there across disconnections and orchestrator restarts until deleted by hand.
- **Management.** The **Workers** section of the settings (opened by **Settings** in any header, **Workers** on `/campaign` and **Manage workers** in the editor) shows each worker: connected or not and last heartbeat, what it is measuring (players, campaign, run and phase), its window, its IP, whether it has a display, its Chrome version and its mode: *Headless* or *Kiosk window* (full screen without bars; only with a display, on Linux the one in `DISPLAY`, for example an Xvfb). Workers that no longer exist are deleted there. A connected worker cannot be deleted (it would re-announce on its next heartbeat), and a worker used by a running or paused campaign cannot be deleted or have its mode changed. API: `GET /api/campaigns-workers`, `PATCH /api/campaigns-workers/{name}` (`{"browser": "headless"}` or `"kiosk"`), `DELETE /api/campaigns-workers/{name}`.
- **Duplicate names.** If two browsers use the same name, the first to send a heartbeat keeps it and the other receives `busy` and waits without mounting anything; if the first stops for 15 s, the other takes its place under that name, and its following runs are measured on another machine (the IP and browser recorded per run reveal it). The orchestrator records the waiting ones (`rivals` in `GET /api/campaigns-workers`, plus a log entry) and the panel shows them in red on the worker's row with their IP. Use one name per machine.
- **Selection.** In the editor, **Worker**: *One tab (all players in the same browser)* or *Independent browsers (one player in each)*, and then the worker of each player among those registered (by default, a free one whose name contains the protocol's, e.g. `lxc-moq`). In the plan, `workers` (`{"dash": "lxc-dash", ...}`). Each worker's Chrome mode is fixed when the campaign starts (`worker_browsers` in the campaign), so the whole campaign is measured with the same modes. A campaign with independent workers gives nothing to the single worker, and vice versa.
- **Window.** The orchestrator asks each worker for a window the size of the top rendition of the run's stream, in 16:9 (1920×1080 for 1080p), and the page draws its single player filling the window: the browser composites the picture at 1:1 and a lower rendition is scaled up, as a full-screen viewer would see it. The script sets the window (`Emulation.setDeviceMetricsOverride`, no scaling) and relaunches Chrome if the campaign asks for another mode; the page does not mount until the mode matches and the window fits (or 10 s have passed, in which case the actual size is recorded in the row). On a real display, the kiosk window fills the screen and the script fixes the page area to the requested size; if the screen has another size, the picture does not map pixel to pixel.
- **One player per worker.** An independent worker never plays more than one protocol at a time. With *All at once*, each player needs its own worker (the editor and the API reject a shared one). With *One at a time*, several players can share a worker, even all of them on one: their runs happen one after another on it, each with its player; if there are not enough free workers, the editor offers to repeat one.
- **Runs.** The orchestrator waits until all the run's workers are connected, until all have mounted and, during measurement, checks that none drops or unmounts. With *One at a time*, each run uses only its player's worker and the others stay unmounted. An independent worker also checks every second that its tab is still on its page with its name, and reopens it if not.
- **Rows and summaries.** Each worker uploads its players' rows with its name (`worker`), window size (`worker_viewport`) and Chrome mode (`worker_browser`). Each player's summary comes from its browser's rows: the main-thread load is that browser's, and start-up (`first_g2g_s`) counts from when its own worker mounted (`mounted_by`).
- **The worker of every run, in all modes.** Each run stores which worker measured each player and what that worker announced when mounting (`workers` and `worker_info` in the run), exported as described in [Exported results](#exported-results).

Confounders added by this mode, compared with single-browser measurements: a headless browser has its own 60 Hz refresh rhythm (measured on macOS, with and without GPU); compositing is in software if the machine has no GPU; and players no longer compete with each other in the browser or the client connection, which is the point. Do not mix these campaigns with single-tab ones. Chrome is installed at the current version and pinned on each machine; the panel shows each worker's version, and the workers of one campaign should match.

## Parallel runs

Checkbox *Parallel runs with the idle workers of* (`parallel` and `worker_pool` in the plan, at most 8 workers, the router's per-client slots). Instead of a fixed worker per player, a group of workers is chosen and each run takes any free one (the first by name). The scheduler launches **batches**: the first pending run plus the following pending runs of the **same stream** (there is one source), of any network, target or protocol, while free workers remain. With *All at once*, the group needs at least as many workers as players.

Each worker in a batch gets its own router queue with its run's network (see [network-emulation.md](network-emulation.md)), so two runs of the same protocol can run at once, each with its own link. The router separates workers by the IP their heartbeat comes from (the first `X-Forwarded-For` address, added by the reverse proxy and the entry point; shown in the workers panel). Two workers with the same IP (same machine or behind the same NAT) never run at once; only the first by name is used. If the router does not see a player's traffic in its worker's queue (it arrives from another IP: another route or NAT, or DASH through a proxy), the run is invalid ("its traffic did not go through its worker's queue in the router").

The batch shares preparation, warm-up and measurement; each run is closed and validated separately, and if a worker drops only its run is invalidated. The monitor shows the current batch as its run ids joined by `+`. Each run records its batch (`batch`, `concurrent`, `concurrent_players`, `parallel` in `runs.csv`) and its worker's IP (`client_ips` in the run, `worker_ip` in `runs.csv`). The router counters of each run (`ip.csv` and the `ip_*` columns of `runs.csv`) are those of its worker's queue.

The duration estimate (in the editor, the monitor and the queue) counts batches: per stream, the pending runs that fit at once (workers divided among each run's players), with one source restart per batch under `content: "restart"`. The editor counts the workers of the chosen group; with the campaign running, the server counts those able to measure in parallel at that moment (all of the group if none, or if the campaign is stopped).

Confounders: runs in a batch share the server (relay, SFU, publisher, origin, CPU), the source and the server's physical link, though not the router queue or the browser, and one protocol may be measured on different machines over the campaign. Workers must have enough CPU and preferably a GPU: in a test with three containers with 2 vCPU, 2 GB and no GPU (software decoding), running all three at once painted 5-21 of 60 fps with the main thread saturated, and MoQ without a rate limit accumulated latency continuously; one such container alone painted 46 fps. Those runs were still valid, because validity does not check whether the worker keeps up (see [Validity](#validity)).

## Keeping the worker's web bundle up to date

A worker keeps the web bundle it loaded at start-up; the script only reloads if Chrome crashes or the page hangs. A worker running an old bundle may not know newer plan options yet record them in the CSV anyway, because options such as `moq_abr` and `dash_abr` are copied from the run. To prevent that, every web build carries an identifier (its build time, set in `vite.config.ts`) published in `/build.json`, served without cache. On every heartbeat the worker page (only with `worker=1`, not the dashboard) compares it with its own and, if different, reloads as soon as it has no run mounted and has uploaded all its rows. A run in progress finishes with the code it started with. After three reloads that do not bring the served version (a cache), it stops trying.

The heartbeat carries both versions (`build` and `latest_build`). The orchestrator does not give runs to an outdated worker, nor to one that does not report its version: it waits for it to reload, logs it once in the campaign log, and the workers panel, the campaign monitor and the worker page itself mark it as *Outdated web*. A run already mounted is not closed because of it. Rebuilding the web without changes reuses Docker's cached build and keeps the identifier, so it causes no reloads. Every row carries the build it was measured with (`web_build`, also in the dashboard CSV), and `runs.csv` the build of each worker at mount time. The worker script itself is not updated by the reload: if it changes, rerun the installer on each machine.

## Installing a worker with one command

The worker is a single dependency-free file (Node 22 and Chrome only; the page is served by the orchestrator). The orchestrator serves its installer, `scripts/install-worker.sh`, at `/api/worker/install.sh` with its own address pre-filled, and the **Workers** settings section gives the command ready to copy (name, display and `--insecure`). On a Debian or Ubuntu (amd64) machine with systemd, for example an LXC container, as root:

```bash
curl -fsSL https://testbed.example.org/api/worker/install.sh | bash -s -- --url https://testbed.example.org --name lxc-moq
```

It installs Node 22 (NodeSource) and Google Chrome, the latter pinned with `apt-mark hold` like every other version in the testbed; downloads the worker script from the same orchestrator (`/api/worker/campaign-worker.mjs`), so it always matches; and creates the `moq-worker` service with its own user (`moq-worker`: Chrome does not start as root with its sandbox), which starts at boot, restarts if it fails, and on stop closes Chrome with its whole process group. Rerunning it updates the script and the service configuration. Log: `journalctl -u moq-worker -f`.

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `--name NAME` | required | Name to announce: letters, digits, `.`, `_`, `-` |
| `--url URL` | the orchestrator that served the installer | Orchestrator URL |
| `--desktop` | off | PC with its own display: user service in the graphical session, run without root (see below) |
| `--display` | off | Install Xvfb (service `moq-worker-xvfb`, display `:99`) so Chrome can open a kiosk window on a headless machine |
| `--screen WxH` | `1920x1080` | Size of that virtual display (at least the top rendition) |
| `--insecure` | off | Orchestrator by IP without HTTPS |
| `--no-sandbox` | off | Chrome without its sandbox, only if it does not start; in an unprivileged LXC, prefer enabling `nesting=1` on the container |
| `--software-decode` | off | Software video decoding (see [Unattended worker script](#unattended-worker-script)) |
| `--port PORT` | 9400 | Local Chrome debugging port |

Below the install command, the **Workers** section shows (collapsed under **Manage it later, on that machine**; the browser remembers if left open) the management commands the installer prints at the end, each with a copy button: status, log, restart, stop, start and remove (`systemctl disable --now moq-worker`, and `moq-worker-xvfb` with Xvfb; Chrome, Node and the user are not uninstalled), with `--user` for a desktop PC. The orchestrator reads `scripts/` from a volume (`docker-compose.yml`), so it always serves the checkout's version.

In a Debian 12 amd64 Docker container with simulated systemd, Chrome aborted at start with its sandbox (Docker does not grant the permissions it needs) and started with `--no-sandbox`. In an LXC with `nesting=1` it is expected, but not verified, to start with the sandbox.

**On a machine with a display.** A system service cannot open windows in someone's graphical session (it has neither their `DISPLAY` nor their permissions), so on a desktop PC it would announce itself without a display. To use the physical screen the panel offers two more commands (tabs **PC with a display (Linux)** and **Mac or another machine, in this terminal**):

- With `--desktop`, from a terminal in the graphical session and as that session's user, without `sudo` (it asks for it only to install what is missing): the worker becomes a user service (`systemctl --user`, in `~/.config/systemd/user/moq-worker.service`) that starts with the user's session and uses the display of the session it was installed from (`DISPLAY` or `WAYLAND_DISPLAY`, and `XAUTHORITY`, written into the service). It is not bound to `graphical-session.target`, which some desktops (e.g. XFCE) do not activate; if it starts before the display, Chrome fails and the service retries every 5 s. Log: `journalctl --user -u moq-worker -f`.
- On macOS, or any machine with Node 22 and Chrome already installed, download the script and run it in a terminal; it runs as that session's user and display while the terminal is open (on macOS it always counts as having a display).

By hand, on any machine with Node 22 and Chrome:

```bash
node scripts/campaign-worker.mjs --url https://testbed.example.org --name lxc-moq
```

## Copying and exporting charts

- **Copy image** from the right-click menu on any chart (dashboard and campaigns) gives the chart with dark text, light grid and white background, without tooltip or cursor, ready to paste into a document; the page keeps its dark style (`web/src/lib/chartCopy.ts` draws a separate copy with the same data and options and places its invisible image over the chart, which is what receives the menu).
- **PNG capture.** In the campaign results, per-run series, the metrics panel and the QoE view, each chart has two buttons in its corner (on hover): copy to clipboard and download as PNG; each block or grid has the same for the whole block (**Copy image** and **PNG**). The background is chosen in **Settings → Captures**: transparent or white with paper colours (dark text), or the interface blue with the page colours. The image includes the HTML context around the chart: titles, the common protocol legend (hidden protocols struck through), the row title and the common x-axis title; a single chart from a grid carries that shared context above and below. It is not a screenshot: `web/src/lib/capture.ts` walks the DOM of the marked fragment (`data-capture="block"` or `"chart"`, with `data-capture-keep` for context and `data-capture-skip` for what is left out) and redraws it on a separate canvas at double density, with Chart.js charts redrawn in a separate copy, so it does not touch the page or depend on it being visible. If the browser does not allow copying (page without HTTPS), it downloads instead.
