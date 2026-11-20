# MoQ, LL-DASH and WebRTC testbed

Testbed of the doctoral research *"Low-latency live video streaming with Media over QUIC: a comparative evaluation against WebRTC and HTTP adaptive streaming, and adaptation mechanisms to improve QoE"*.

One FFmpeg source encodes a live signal once and delivers the same H.264 bitstream through three branches: **LL-DASH** (CMAF over HTTP/1.1 with chunked transfer), **Media over QUIC** (WebTransport) and **WebRTC**. A web dashboard plays the three side by side and measures them with the same method: glass-to-glass latency read from a timecode burnt into the picture, stalls, quality, bitrate and a per-stage latency breakdown. An emulation router (tc/netem) degrades each protocol's traffic with its own queue, and unattended campaigns sweep network conditions and target latencies and export the results as CSV.

The testbed observes the protocols as their stock implementations behave: it does not tune players, relays or publishers to improve their results. Anything that isolates a mechanism is a separate, declared experiment, and the known confounders are listed in [docs/limitations.md](docs/limitations.md).

```
FFmpeg source ──► LL-DASH packager ─► origin ─► nginx ──┐
  (one encode)  ─► MoQ publisher ───► moq-relay ────────┼─► emulation router ─► browser dashboard
                ─► WebRTC (mediasoup SFU or MediaMTX) ──┘    (tc/netem, per      (three players,
                                                              protocol queues)    one meter)
```

## Quick start

Requirements: Docker with Compose, and an Internet connection on first start (the source videos are downloaded into `media/`).

```bash
git clone <repository-url> && cd <repository>
```

```bash
docker compose up -d --build
```

Open `http://localhost`. Locally no `.env` is needed. To deploy on a server, give it a DNS name, copy [.env.template](.env.template) to `.env` and fill in that name and the DNS provider used to obtain its certificate. The page is then at `https://<name>`. Update a server with `scripts/deploy.sh`. See [docs/deployment.md](docs/deployment.md).

## Documentation

| Document | Contents |
| :--- | :--- |
| [Deployment](docs/deployment.md) | Local, behind a proxy or with own certificate; ports; certificates; every `.env` variable |
| [Architecture](docs/architecture.md) | Containers, networks, the media pipeline of each branch, automatic recovery, project layout |
| [Measurement](docs/measurement.md) | Metrics and CSV columns, validity, statistics, component versions, per-stage breakdown, panel parameters |
| [Latency measurement](docs/latency-measurement.md) | How glass-to-glass latency is read from the burnt-in timecode, and what it includes |
| [QoE](docs/qoe.md) | QoE evaluation (recording, VMAF, LL-GABR model); under construction |
| [Campaigns](docs/campaigns.md) | Unattended batteries of runs, workers, parallel runs, analysis and comparison |
| [Network emulation](docs/network-emulation.md) | The router: queues, link profiles, rate limiters, per-client slots, counters |
| [Adaptation and experiments](docs/adaptation-and-experiments.md) | How each player adapts quality, and the declared experiments |
| [Limitations](docs/limitations.md) | Confounders and known issues to declare with any result |
| [API](docs/api.md) | The orchestrator's HTTP API |
| [Protocols](docs/protocols/README.md) | How LL-DASH, MoQ and WebRTC work and how each is set up here, with field-by-field references of the MPD, the MoQ catalog and MPEG-TS |

## Credits

The test videos are *Big Buck Bunny* (Sunflower version, 1080p 60 fps; © Blender Foundation, [bbb3d.renderfarming.net](http://bbb3d.renderfarming.net)) and *Tears of Steel* (1080p 24 fps; © Blender Foundation, [mango.blender.org](https://mango.blender.org)), both under [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). They are not distributed with the repository.
