# Deployment

The testbed runs as a set of Docker Compose services. It runs in one of two modes, chosen by the `.env` file: **local**, with no `.env`, at `http://localhost`; or **server**, with a DNS name and its own Let's Encrypt certificate, at `https://<name>`. This document covers both, the ports, the certificate, every variable of the `.env` file and how to update a server. The containers, networks and media pipeline are described in [architecture.md](architecture.md); the network emulation in [network-emulation.md](network-emulation.md).

## Requirements

- Docker with Compose 2.24 or later, and an Internet connection on the first start (the source videos and the images are downloaded).
- Chrome or Edge on the viewing side: the MoQ player needs WebTransport and WebCodecs.
- Outside `localhost`, the page must be served over HTTPS: browsers only expose WebTransport and WebCodecs in secure contexts. Server mode does this.
- For network emulation, the kernel modules `sch_prio`, `sch_tbf`, `sch_netem` and `cls_u32`. In an LXC container they must be loaded on the host. If they are missing, everything else works and the panel says that emulation is unavailable.
- Building moq-cli or the MoQ relay from a git commit (optional, see [Third-party versions](#third-party-versions)) needs several GB of RAM.

## The two modes

| | Local | Server |
| :--- | :--- | :--- |
| `.env` | none needed | `cp .env.template .env`: `SERVER_HOST`, `ACME_DNS` and its token |
| Page | `http://localhost` | `https://<SERVER_HOST>` |
| Certificate | none; the MoQ relay generates a self-signed one, pinned by fingerprint | one Let's Encrypt certificate for `SERVER_HOST` (DNS challenge), used by the page, DASH, the MoQ relay and the WebRTC signalling |
| DASH | HTTP, port 8080 | HTTPS, port 8443 |
| MoQ | `localhost:4433`, fingerprint pinned | `<SERVER_HOST>:4433`, certificate chain validated |
| WebRTC ICE address | `127.0.0.1` | the IP `SERVER_HOST` resolves to (or `SERVER_IP`) |

Nothing else changes between the two modes: the same services, ports and network emulation.

**Measurement condition.** In local mode WebTransport pins the relay's self-signed certificate by fingerprint; in server mode it validates the certificate chain (Chrome refuses to pin a Let's Encrypt certificate anyway: `serverCertificateHashes` requires a validity of at most 14 days). It is a different condition; at most it affects the initial QUIC handshake. Declare which one was used.

## Why DASH goes direct

Every media path goes from the browser straight to the server's emulation router, never through `nginx-web` (the container that serves the page) or a reverse proxy. For MoQ (QUIC over UDP) and WebRTC (UDP) this is natural. For DASH it is a deliberate choice: a proxy terminates the browser's TCP connection and opens a second one towards the server, so the emulated network would act on the proxy's connection and not on the browser's. Going direct, the browser's own TCP connection (and its congestion control) crosses the emulated link, as the QUIC and WebRTC connections do. This is also why the testbed does not support a reverse proxy in front of the page: the media names must resolve to the server itself.

Consequences:

- In server mode the browser fetches the manifest from `https://<SERVER_HOST>:8443/media/dash/manifest.mpd`.
- In local mode it fetches it over plain HTTP from port 8080 of the page's host. This only works from HTTP pages; on an HTTPS page without `SERVER_HOST`, the DASH player shows an error and does not play.
- The player footer shows the address it connects to ("Direct · host:port"). `GET /api/status` reports `dash_url`, `dash_http_port` and `dash_path` (always `direct`), and the CSV column `dash_path` records it.
- DASH is served over HTTP/1.1 only, on both ports: HTTP/2 would multiplex video and audio over one TCP connection and change what is measured.

## Local deployment

```bash
git clone <repository URL>
cd moq-initial-comparison
docker compose up -d --build
```

Open <http://localhost> in Chrome or Edge. The stream starts on its own.

**Source videos.** The videos are not in the repository. On the first start the orchestrator downloads Big Buck Bunny 1080p60 (355 MB) and Tears of Steel 1080p (584 MB) from [download.blender.org](https://download.blender.org/demo/movies/) and unpacks them into `media/`, one after the other and before the stream starts, so that the download never overlaps a measurement. The panel shows the progress and the stream starts when it finishes. Later starts reuse the files. If the Big Buck Bunny download fails it is retried every 30 s; if Tears of Steel fails, the stream starts anyway and the download is retried when that video is selected. To use copies you already have, place them at `media/bbb_sunflower_1080p_60fps_normal.mp4` and `media/tears_of_steel_1080p.mov` before starting. Paths and URLs can be changed with `VIDEO_FILE`, `VIDEO_URL`, `TOS_VIDEO_FILE` and `TOS_VIDEO_URL` (orchestrator environment).

`media/` also holds the campaign data (`media/campaigns/`), the QoE recordings (`media/qoe/`), the last stream configuration (`media/stream-config.json`) and the marker that keeps the stream stopped across restarts (`media/.stopped`). The stream resumes with the last configuration applied by `POST /api/config` or by a campaign, and stays stopped if it was stopped.

Useful commands:

```bash
docker compose logs -f orchestrator
docker compose down
```

After editing code:

| Changed | How to apply |
| :--- | :--- |
| `server/app/*.py` | `docker compose restart orchestrator` (the directory is mounted, but uvicorn does not reload on its own) |
| `nginx/` | `docker compose restart nginx-web nginx-dash` |
| `web/` | `docker compose up -d --build --no-deps web` |
| `router/` | `docker compose up -d --build --no-deps router` |
| `sfu/` | `docker compose up -d --build --no-deps sfu` |
| `relay/` | `docker compose up -d --build --no-deps moq-relay` |

Use `--no-deps` when rebuilding a single service: without it Compose may also recreate the orchestrator. `POST /api/config` starts the stream; if it was stopped, send `POST /api/stop` afterwards.

## Server deployment

1. Create a DNS name that resolves to the server's IP from the browsers' network, for example `testbed.example.org`. It can be a private IP: the certificate is obtained with a DNS challenge, so no port needs to be open to the Internet. If the local DNS resolver drops answers with private IPs (DNS rebinding protection), the name must be allowed there.
2. On the server, `cp .env.template .env` and set `SERVER_HOST=testbed.example.org`, `ACME_DNS` (the DNS API of [acme.sh](https://github.com/acmesh-official/acme.sh/wiki/dnsapi) for the provider that hosts the name, such as `dns_duckdns` or `dns_cf`) and the token variables that API expects (`DuckDNS_Token`, `CF_Token`…).
3. `docker compose up -d --build`.
4. Make the server's ports reachable from the browsers: **80/tcp** and **443/tcp** (page), **8443/tcp** (DASH), **4433/udp** (MoQ), **8189/udp** (WebRTC media) and **8189/tcp** (WebRTC signalling). QUIC and WebRTC run over UDP: 4433/udp and 8189/udp must be open in every firewall between browser and server.
5. Open `https://testbed.example.org`. On the first start the certificate takes a couple of minutes: until then the page is only served over HTTP and MoQ is down.

The SFU announces in its ICE candidates the IPv4 address `SERVER_HOST` resolves to from inside the container; if that is not the address the browsers reach (or the name does not resolve there), set it with `SERVER_IP`. If it cannot resolve the name and there is no `SERVER_IP`, the SFU exits with an error in its log and Docker restarts it. MediaMTX receives `SERVER_IP`, or `SERVER_HOST` when it is not set.

## Certificate

- The `cert` service (acme.sh) obtains a Let's Encrypt certificate for `SERVER_HOST` with the DNS challenge of `ACME_DNS`, registering the account without an e-mail address. It reads the token variables straight from `.env`. Without `SERVER_HOST` it does nothing; without `ACME_DNS` it logs an error and does nothing.
- The certificate and the ACME account live in `certs/` (outside the repository; it contains private keys): `certs/<SERVER_HOST>.crt` and `.key` are what the services read, `certs/acme/` is the acme.sh state.
- `cert` retries every 10 minutes if issuance fails and checks for renewal every 12 h; acme.sh renews when fewer than 30 days remain.
- `nginx-web` and `nginx-dash` serve HTTP from the start, enable TLS as soon as the certificate exists and reload every 12 h to pick up a renewed one. The MoQ relay and MediaMTX wait for the certificate before starting and reload a renewed one on their own; the SFU checks it every minute.
- In local mode the relay generates a self-signed certificate at start (`--listen-tls-generate`). The browser fetches its SHA-256 fingerprint from `/certificate.sha256` (`nginx-web` → relay port 8081) and pins it in WebTransport. In server mode, `/certificate.sha256` on port 443 returns 404. The publisher inside the server always connects with `--connect-tls-insecure`.

## Ports

Published on the host:

| Port | Goes to | Through the emulation router | Use |
| :--- | :--- | :--- | :--- |
| 80/tcp | `nginx-web` | no | Page, API (`/api`), relay fingerprint (local mode) |
| 443/tcp | `nginx-web` | no | Same over HTTPS (server mode) |
| 8443/tcp | router → `nginx-dash:443` | yes | LL-DASH over HTTPS (server mode) |
| 8080/tcp | router → `nginx-dash:80` | yes | LL-DASH over HTTP (local mode, from HTTP pages) |
| 4433/udp | router → `moq-relay:4433` | yes | MoQ over QUIC / WebTransport |
| 8189/udp | router → SFU or MediaMTX | yes | WebRTC ICE, DTLS and SRTP |
| 8189/tcp | router → SFU or MediaMTX | yes | WebRTC signalling: mediasoup's WebSocket or MediaMTX's WHEP |

The ports are fixed. The signalling of both WebRTC servers (mediasoup's WebSocket and MediaMTX's WHEP request) crosses the router's WebRTC queue and suffers its network profile, like the media. Internal ports are listed in [architecture.md](architecture.md#ports).

## Environment variables

All variables go in `.env` at the repository root; `.env.template` lists every one, with the optional ones commented out at their defaults.

**Server mode**

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `SERVER_HOST` | empty (local mode) | DNS name that resolves to the server. The page, DASH, MoQ and the WebRTC signalling use it, with its certificate |
| `ACME_DNS` | empty | acme.sh DNS API used for the certificate (`dns_duckdns`, `dns_cf`, …) |
| token variables | — | Those of the chosen DNS API, under the names acme.sh expects (`DuckDNS_Token`, `CF_Token`, …). Secret |
| `SERVER_IP` | the IP `SERVER_HOST` resolves to | Address announced in the WebRTC ICE candidates, when it differs |

**Source**

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `CAMERA_RTSP_URL` | empty | RTSP camera used when the panel's **Source** is **RTSP camera** (see [architecture.md](architecture.md#rtsp-camera)). It usually carries credentials, which is why it only lives in `.env`; the API only reports the host |
| `CAMERA_FPS` | empty | Forces the camera frame rate when the camera does not announce it correctly |

After setting the camera, apply it with `docker compose up -d --no-deps orchestrator` and select **RTSP camera** in **Source**. The orchestrator must be able to reach the camera over the network.

**WebRTC**

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `RTC_SERVER` | `mediasoup` | `mediasoup` (SFU with simulcast and adaptation) or `mediamtx` (one rendition over WHEP, no adaptation; it reads the MPEG-TS straight from the gate over UDP) |
| `RTC_PACING_FACTOR` | `2.5` | Rate of the experimental ingest pacer (`rtc_pacing`) relative to each rendition's bitrate |
| `SFU_TRACE` | empty | `1` writes the SFU bandwidth estimate and probes to `docker logs testbed-sfu` (diagnostics) |

Switching `RTC_SERVER` needs no rebuild: both servers are always up and only the router's forwarding and the player change. Apply it with `docker compose up -d --no-build --no-deps router orchestrator`. See [architecture.md](architecture.md#webrtc-branch).

### Third-party versions

Every third-party component is pinned; nothing updates on its own. Changing a version changes what is measured: record it with the results (the panel and the CSV show the installed versions, see [measurement.md](measurement.md)). These variables need `--build`.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `MOQ_RELAY_FROM` | `release` | MoQ relay: `release` (image `moqdev/moq-relay:<MOQ_RELAY_VERSION>`) or `git` (built from `MOQ_RELAY_COMMIT`) |
| `MOQ_RELAY_VERSION` | `0.17.9` | Published relay version |
| `MOQ_RELAY_COMMIT` | `c19c723d90c6e8df60c9a656cc2a4d92ee358295` | moq-dev/moq commit for the relay |
| `MOQ_CLI_FROM` | `release` | MoQ publisher (moq-cli): `release` or `git` (built from `MOQ_CLI_COMMIT`; several GB of RAM) |
| `MOQ_CLI_VERSION` | `0.14.7` | Published moq-cli version |
| `MOQ_CLI_COMMIT` | `bc64b9c52561209322dcb8dec9992bf867f499f7` | moq-dev/moq commit for moq-cli |
| `MOQ_WATCH_FROM` | `release` | Browser player `@moq/watch` and its `@moq/*` packages: `release` (npm, locked in `web/package-lock.json`) or `git` (built from `MOQ_WATCH_COMMIT`) |
| `MOQ_WATCH_COMMIT` | `bc64b9c52561209322dcb8dec9992bf867f499f7` | moq-dev/moq commit for the player |
| `MOQ_WATCH_PATCHES` | `1` | With `git`: `1` applies `web/patches/` (written for the default commit; the build fails if they do not apply), `0` applies none |
| `MOQ_WATCH_BUN` | `1.3.5` | With `git`: bun version used to build; commits from `c19c723` on need `1.4.4` |
| `MEDIAMTX_VERSION` | `1.21.3` | MediaMTX image tag |

Built from git, a component is shown as `git@<commit>` in the panel and the CSV (`git@<commit>+switching` for the player with the patch). With `MOQ_WATCH_FROM=git` the lockfile is discarded and the ranges of `web/package.json` apply, which is why `dashjs` is pinned to an exact version there. The pinned versions of everything else are listed in [architecture.md](architecture.md#pinned-versions).

## Updating a server

`scripts/deploy.sh` updates a server from a local checkout over SSH, without the server needing access to the remote repository:

```bash
scripts/deploy.sh root@testbed.example.org [/opt/moq-initial-comparison]
```

It refuses to deploy while a campaign is running (a deployment in the middle of one contaminates it), or if the server's checkout has uncommitted changes or commits that local `main` does not contain. Otherwise it sends the missing commits as a `git bundle`, fast-forwards the server's checkout, and rebuilds or restarts only the services whose files changed: an image rebuild for `web/`, `server/` (except `server/app/`), `relay/`, `router/`, `sfu/` and `mediamtx/`; a restart for the mounted `server/app/`, `nginx/` and `cert/`; and `docker compose up -d --build --remove-orphans` when `docker-compose.yml` changes. It prints the stream state before and after; the stream configuration and whether it was stopped survive the restarts. Campaign workers reload the new web build on their own between tests (see [campaigns.md](campaigns.md)).

Changes to `.env` are not part of the repository: after editing it on the server, apply them with `docker compose up -d`.
