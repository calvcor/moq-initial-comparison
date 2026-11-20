# Orchestrator API

The orchestrator (`server/app/main.py`, FastAPI) serves its API under `/api` through the HTTP entry point (port 80). Interactive OpenAPI documentation is at `/docs` (for example <http://localhost/docs>) and the schema at `/openapi.json`. Error responses carry a `detail` string.

General conventions:

- While a campaign is running, the endpoints that change the stream or the network (`POST /api/config`, `/api/start`, `/api/stop`, `/api/network`, `/api/qoe/recordings`) return **409**: the campaign owns them (see [campaigns.md](campaigns.md#while-a-campaign-runs)). The text analyses and comparisons (`/api/compare`, `/api/campaigns/{id}/analysis`, `/api/campaigns-compare`) also return 409 then, so as not to load the orchestrator during a measurement.
- Endpoints that produce text accept `lang=en` for English (default `es`).
- Times are server-clock milliseconds since the epoch unless stated otherwise.

## Contents

- [Status and clocks](#status-and-clocks)
- [Stream control](#stream-control)
- [Network emulation](#network-emulation)
- [Latency trace](#latency-trace)
- [QoE recordings](#qoe-recordings)
- [Campaigns](#campaigns)
- [Campaign results and analysis](#campaign-results-and-analysis)
- [Campaign workers](#campaign-workers)
- [LL-DASH origin](#ll-dash-origin)

## Status and clocks

| Method and path | Description |
| :--- | :--- |
| `GET /api/status` | Overall state (see below) |
| `GET /api/time` | Server clock, `{"t_ms": …}`; the same clock FFmpeg burns into the timecode, used for glass-to-glass latency |
| `GET /api/utc` | Server clock as ISO 8601 text (`xs:dateTime`, ms precision), for the manifest's `UTCTiming` |
| `GET /api/versions` | Deployed version of each third-party component and the latest published one |

`GET /api/status` returns:

| Field | Content |
| :--- | :--- |
| `status` | `running` or `stopped` |
| `config` | Current stream configuration (see [Stream control](#stream-control)) |
| `master_start_time_ms` | When the master source started |
| `processes` | Liveness of `master_source`, `dash_pipeline`, `moq_pipeline`, `rtc_pipeline`, and `pipeline` (desired state) |
| `stream_ids` | Per branch, an id that changes whenever its packager restarts, so open dashboards reconnect |
| `source`, `sources` | Download state of Big Buck Bunny (`source`) and of every source video (`sources`) |
| `camera` | Last known camera probe |
| `restarts` | Automatic supervisor restarts (`master`, `dash`, `moq`, `rtc`) |
| `dash_url`, `dash_http_port`, `dash_path` | Where the browser fetches LL-DASH (always `direct`, through the router) |
| `rtc_server`, `rtc_ingest`, `rtc_path`, `rtc_signal_port`, `rtc_tls_host` | WebRTC server (`mediasoup` or `mediamtx`), its ingest, the WHEP path with MediaMTX, and the mediasoup WebSocket signalling port and TLS host |
| `moq_port`, `moq_host`, `spki_fingerprint` | MoQ relay port, direct host when the page is behind a proxy, and certificate fingerprint |
| `timecodes` | Timecode layout per rendition |
| `ingest_anomalies` | Ingest anomaly count per branch |
| `source_lag_ms` | How far the source is behind real time over the last 2 s |
| `dash_availability_drift_ms` | DASH `availabilityStartTime` drift |
| `network` | Router state: profile and counters |
| `campaign` | The running campaign, if any |
| `campaign_preview` | An open run preview, if any |

## Stream control

| Method and path | Description |
| :--- | :--- |
| `POST /api/config` | Applies a stream configuration and restarts what is needed. **Starts the stream** if it was stopped |
| `POST /api/start` | Starts the packagers (optional body: a configuration) |
| `POST /api/stop` | Stops everything, including source encoding. The stop is remembered across restarts: nothing streams again until `POST /api/start` or `POST /api/config` |
| `GET /api/camera` | Probes the RTSP camera: host (without credentials), codec, resolution, fps, audio and last error. While the camera is streaming, returns the last known state without opening another session |

Stream configuration body (`POST /api/config`, `POST /api/start`, and each entry of a campaign's `streams`):

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `source` | `file` | `file` (Big Buck Bunny loop, 60 fps), `tos` (Tears of Steel loop, 24 fps) or `camera` |
| `gop_size` | 60 | GOP in frames |
| `fps` | 60 | 1-60. Forced to the video's own rate for `file` and `tos`; with `camera` the server sets it from the camera |
| `seg_duration` | 2.0 | DASH segment duration (s); raised to the GOP duration if shorter |
| `frag_duration` | 0.1 | CMAF fragment duration (s); 0 = one frame per fragment |
| `renditions` | `[1080@4000, 720@2000, 360@700]` | Ladder, 1-5 entries `{height, bitrate_kbps}` (height 144-1080, bitrate 150-20000 kbps); sorted highest first; duplicates rejected. One entry = no adaptation |
| `rtc_audio` | false | Audio in the WebRTC branch |
| `rtc_pacing` | false | Pacer in the mediasoup ingest (declared experiment; no effect with MediaMTX) |

Errors: 409 if the chosen video is still downloading (or failed; the download is retried); 502 if the camera cannot be reached, with the reason; 422 for an invalid body.

## Network emulation

| Method and path | Description |
| :--- | :--- |
| `POST /api/network` | Applies one profile to the three branches in the router. 422 if jitter exceeds delay; 502 if the router fails |
| `GET /api/router` | Router state without the rest of `/api/status`: profile, clients with their own slot, counters and tc tree (`tree`). 503 if the router does not respond |

Profile body: `{"down": {…}, "up": {…}}`, each direction with:

| Field | Default | Range | Meaning |
| :--- | :--- | :--- | :--- |
| `rate_kbit` | `null` | 100-1,000,000 | Rate limit; `null` = unlimited |
| `delay_ms` | 0 | 0-2000 | One-way delay |
| `jitter_ms` | 0 | 0-500 | Jitter; cannot exceed `delay_ms` |
| `loss_pct` | 0 | 0-50 | Random loss |
| `queue_ms` | 300 | 10-5000 | Bottleneck queue; only with `rate_kbit` |
| `shaper` | `tbf` | `tbf`, `netem` | How the rate is limited; only with `rate_kbit`. `netem` is a declared experiment |

See [network-emulation.md](network-emulation.md).

## Latency trace

`POST /api/trace` takes the burned-in timestamps of frames the dashboard has just painted and returns when each one passed the server's measurement points. Body: `dash_stream`, `dash_stamps_ms`, `moq_stream`, `moq_stamps_ms`, `rtc_stream`, `rtc_stamps_ms` (stream = rendition index; for MediaMTX always 0). Response: per branch, a list of `{stamp_ms, encoded_ms, forwarded_ms}` (DASH also `packaged_ms`): `encoded_ms` is when the frame's last packet reached the branch gate, `forwarded_ms` when the gate handed it to the packager, `packaged_ms` when the CMAF fragment containing it was complete in the origin; `null` when unknown. See [latency-measurement.md](latency-measurement.md).

## QoE recordings

See [qoe.md](qoe.md). `{player}` is `dash`, `moq` or `rtc`.

| Method and path | Description |
| :--- | :--- |
| `POST /api/qoe/recordings` | Records the encoded stream (all renditions) for `duration_s` seconds (5-330) from the first keyframe and indexes it when done; with the camera, also the reference. Requires the stream to be running (409). With `stop_after: true`, stops the stream when recording ends so VMAF can be computed, and resumes it with the same configuration after VMAF and QoE |
| `GET /api/qoe/recordings` | Stored recordings, newest first |
| `GET /api/qoe/recordings/{id}` | State (`recording`, `indexing`, `ready`, `error`), index summary per rendition and the result of the match check |
| `GET /api/qoe/recordings/{id}/index` | Per recorded frame and rendition: PTS, timecode read and source frame number. 409 if not indexed yet |
| `POST /api/qoe/recordings/{id}/index` | Rebuilds the index from the stored timestamps and re-queues VMAF |
| `POST /api/qoe/recordings/{id}/views/{player}` | What a player painted during the recording: `frames` (`[paint time in ms from window_ms[0], timecode, height]` per new frame), `gaps`, `unreadable`, `window_ms`, `clock_offset_ms`, `clock_rtt_ms`, `hidden`, `user_agent`. Mapped to frames at indexing |
| `GET /api/qoe/recordings/{id}/views/{player}` | Per painted frame: time, rendition, source frame number and exact latency, with a summary of what does not match. 409 if missing or not yet mapped |
| `GET /api/qoe/recordings/{id}/qoe/{player}` | LL-GABR QoE of that player: total, terms, inputs and each 1 s step. 409 until VMAF and the player's view exist |
| `POST /api/qoe/recordings/{id}/qoe` | Recomputes the QoE of every player with a view |
| `POST /api/qoe/recordings/{id}/check` | Checks by PSNR that each recorded frame is matched to its original and not a neighbour (result in `GET …/{id}`). Only with the stream stopped |
| `POST /api/qoe/recordings/{id}/vmaf` | Queues VMAF (queued automatically at indexing); computed as soon as the stream is stopped |
| `GET /api/qoe/recordings/{id}/vmaf` | VMAF and luma PSNR of each recorded frame per rendition, with vmaf version, model and compared area. 409 if not computed yet |

## Campaigns

See [campaigns.md](campaigns.md). Campaign ids are the creation time, `YYYYMMDD-HHMMSS`; run ids are `r` plus four digits (`r0001`).

| Method and path | Description |
| :--- | :--- |
| `POST /api/campaigns` | Creates a campaign with its runs already drawn (does not start it). Returns the campaign with its runs and the estimated duration (`eta_s`) |
| `GET /api/campaigns` | Stored campaigns without their runs, newest first |
| `GET /api/campaigns/{id}` | Plan, state, runs with their summary, worker and events |
| `PUT /api/campaigns/{id}` | Replaces the plan (same body as creation) of a campaign that has never started and redraws its runs; 409 otherwise |
| `PATCH /api/campaigns/{id}` | `{name}` (1-120 chars) or `{description}` (up to 20,000 chars), in any state; or `{archived: true\|false}` (409 for the running campaign). Logged in the events |
| `DELETE /api/campaigns/{id}` | Deletes a campaign that is not running |
| `POST /api/campaigns/{id}/start` | Starts or resumes |
| `POST /api/campaigns/{id}/pause` | Pauses: restores network and stream, removes the campaign from the queue and halts the queue if others remain; the current run is repeated on resume |
| `POST /api/campaigns/{id}/enqueue` | Appends a ready or paused campaign to the queue; starts it if none is active. 409 if archived |
| `POST /api/campaigns/{id}/dequeue` | Removes it from the queue |
| `POST /api/campaigns/{id}/clear` | Deletes the measurements of a campaign that is not running (`samples.jsonl`, `runs.jsonl`, `ip.jsonl`, row indexes and cached analysis) and leaves it ready, with runs redrawn from the plan's seed (same runs, same order; manual repeats disappear). Keeps plan, name, description, archive flag, queue position and events. Irreversible; 409 for the running campaign |
| `GET /api/campaigns-queue` | Queue: `ids` in order, `halted`, and name, state and estimated duration of each |
| `PUT /api/campaigns-queue` | New order, `{"ids": [...]}`, with the same campaigns |
| `POST /api/campaigns-queue/resume` | Resumes a queue halted by a pause; starts the first if none is active |
| `POST /api/campaigns/{id}/runs/{run}/preview` | Applies the run's network and stream for live viewing and returns its player settings; records nothing. 409 while a campaign runs |
| `POST /api/campaigns-preview/stop` | Ends the preview: network and stream return to their state before it opened |
| `POST /api/campaigns/{id}/runs/{run}/repeat` | Repeats a finished run (valid or invalid) at the end of the queue; 409 if not finished or already repeated |

Campaign plan body (`POST` and `PUT /api/campaigns/{id}`):

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `name` | required | 1-120 characters |
| `description` | `""` | Free text, up to 20,000 characters |
| `streams` | required | 1-10 stream configurations (body of [Stream control](#stream-control)) |
| `networks` | required | 1-200 entries `{label, profile}` (profile as in [Network emulation](#network-emulation)) |
| `targets` | required | 1-50 entries `{label, dash_ms, moq_ms, rtc_ms}` (each 0-10000 or `null` for the implementation's default). The first is also used by control runs |
| `players` | `["dash","moq","rtc"]` | Players to test, no repeats |
| `player_mode` | `together` | `together` or `each` |
| `workers` | `null` | Independent worker per player, `{"dash": "name", …}`; with `together`, all different |
| `parallel`, `worker_pool` | `false`, `null` | Parallel runs: both together, at most 8 worker names; not combined with `workers`. With `together`, at least as many workers as players |
| `quality` | `null` | `null` = adaptive; a height 144-1080 fixes it |
| `player_options` | see [campaigns.md](campaigns.md#player-settings-in-a-run) | `dash_abr`, `dash_max_drift_s`, `dash_playback_buffer_min_s`, `moq_abr`, `moq_switching` |
| `repetitions` | 3 | 1-50 |
| `warmup_s` | 30 | 5-600 |
| `measure_s` | 120 | 10-3600 |
| `control_every` | 10 | 0-1000 (0 = no control runs) |
| `max_attempts` | 2 | 1-5 |
| `content` | `continuous` | `continuous` or `restart` |
| `stream_settle_s` | 15 | 0-120 |
| `seed` | `null` | `null` = random, stored |

Worker names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`. Validation errors (jitter above delay, repeated players, missing or shared workers) return 422.

## Campaign results and analysis

| Method and path | Description |
| :--- | :--- |
| `GET /api/campaigns/{id}/runs.csv` | One row per run and player with its summary |
| `GET /api/campaigns/{id}/samples.csv` | Every per-second row with the condition columns |
| `GET /api/campaigns/{id}/ip.csv` | IP traffic at the router per second, read by the orchestrator |
| `GET /api/campaigns/{id}/series?runs=r0001,r0002` | Per-second rows of the last attempt of the requested runs (up to 20) |
| `GET /api/compare?a=<campaign>/<run>/<protocol>&b=…` | Text comparison of two runs, from the same or different campaigns |
| `GET /api/campaigns/{id}/analysis` | Text analysis of the campaign |
| `GET /api/campaigns-compare?a=<campaign>&b=<campaign>` | Text comparison of two whole campaigns |

The CSV columns are described in [campaigns.md](campaigns.md#exported-results).

**`series`** returns, per run, `aligned` (`source`: `t_s` relative to the source start, with `content: "restart"`; `measure`: relative to the start of the measurement, negative during warm-up), `zero_ms` (the zero of `t_s` in server clock, to place stall intervals), `rows` and `ip`. Each row has `t_s`, `phase` and, per player, `g2g_ms`, `kbps`, `height`, `selected_height`, `bw_estimate_kbps`, `stall_ms`, `frametime_p95_ms`, `stall_spans`, `stall_open_since_ms`, `playback_rate`, `content_speed`, `content_skipped_ms`, `buffer_ms` (from `dash_buffer_s` or `*_jitter_buffer_s`, in ms), the page's `main_refreshes_missed` and `main_long_frame_ms` (repeated per player), and for MoQ also `probe_capacity_kbps`, `probing`, `probe_spans` and `probe_open_since_ms`. With independent workers, each row only carries the players of the browser that produced it. Each `ip` entry has `t_s` (end of the interval), `phase` and, per player, `ip_down_kbps`, `ip_up_kbps`, `ip_down_dropped`, `ip_up_dropped` and `source_lag_ms` (common to all players).

**`compare`** returns `a` and `b` (each side's campaign, network, target, ladder and valid repetitions of its condition), `conditions` (what differs: `label`, `a`, `b`), `metrics` (per metric: `a`, `b`, `diff`, `relative`, `noise` (range between repetitions), `noise_reps` and `verdict`: `igual`, `a_mayor`, `b_mayor`, `no_concluyente`, `sin_repeticiones` or `sin_dato`), `sentences` and `warnings`. 404 if the campaign or run does not exist; 422 if the reference is invalid, the run lacks that protocol or has not finished.

**`analysis`** returns `overview` (summary sentences), `sections` (each with `title` and `blocks`; each block with `title`, sometimes empty, and `sentences`) and `warnings`. Cached in `analysis.json` while the runs do not change.

**`campaigns-compare`** returns `a` and `b` (id and name), `conditions` (`label`, `a`, `b`), `overview`, `sections` and `warnings` as in the analysis, and `tables`, in summary units: `metrics` (how to present each metric); `summary` (per protocol and metric: `a`, `b`, `diff`, `relative`, `n`, `b_lower`, `b_higher`, `unclear`); `by_condition` (per protocol, each paired condition with `reps` and, per metric, `a`, `b`, `noise`, `verdict`); `controls` (per protocol, `n` and rows with `a`, `b`, `noise`, `beyond`); `trends` (each series with `levels` and rows of `player`, `key`, `a`, `b`). Cached while the runs do not change. 404 if either campaign does not exist; 422 if both are the same.

## Campaign workers

| Method and path | Description |
| :--- | :--- |
| `POST /api/campaigns-worker` | Worker heartbeat (see below) |
| `POST /api/campaigns/{id}/samples` | Per-second rows of a run: `run_id`, `rows` (up to 600, each with `t_server_ms`) and, for an independent worker, `worker`. Returns `{"stored": n}`; 404 if the campaign does not exist |
| `GET /api/campaigns-workers` | Registered independent workers: name, connection, what they are measuring, window, Chrome mode, display, IP, waiting browsers with the same name (`rivals`) and the campaign using them |
| `PATCH /api/campaigns-workers/{name}` | Chrome mode, `{"browser": "headless"}` or `"kiosk"`. 404 if unknown; 409 if used by a running or paused campaign, or if it has no display |
| `DELETE /api/campaigns-workers/{name}` | Removes an independent worker from the registry. 404 if unknown; 409 if connected or used by a running or paused campaign |
| `GET /api/worker/install.sh` | Worker installer (`scripts/install-worker.sh`) with this orchestrator's address (from `X-Forwarded-Proto` and `X-Forwarded-Host` behind a proxy) as default `--url` |
| `GET /api/worker/campaign-worker.mjs` | The worker script (`scripts/campaign-worker.mjs`), downloaded by the installer. Both return 404 if the `./scripts` volume is missing |

Heartbeat body: `worker_id` (1-80 chars), `name` (independent workers only), `mounted` (run id or `null`), `mounted_at_ms` (when the players were created, server clock) and `info` (user agent, Chrome mode, decoding, display, viewport, `build` and `latest_build`, …). The client IP is taken from the first `X-Forwarded-For` address, or the connection's. The response is `{"busy": bool, "assignment": …}`: `busy` when another browser holds the same name (it must wait); `assignment` is `null` with no active campaign, otherwise `campaign`, `phase` (`idle` when nothing applies to this worker) and, for a run, `run`, its player settings and `ends_ms`; independent workers also receive `viewport`, `browser` and the `players` they must mount.

## LL-DASH origin

| Method and path | Description |
| :--- | :--- |
| `PUT /media/dash/{name}` | Upload from the DASH packager (chunked) |
| `GET`, `HEAD /media/dash/{name}` | Manifest and segments for the player |
| `DELETE /media/dash/{name}` | Delete |

The origin is in memory (`server/app/origin.py`). The browser reaches it directly through the router and the DASH nginx (port 8443 with `DASH_HOST`, 8080 without it), never through the HTTP entry point, which answers 404 for `/media/dash/`. See [protocols/ll-dash.md](protocols/ll-dash.md) and [deployment.md](deployment.md).
