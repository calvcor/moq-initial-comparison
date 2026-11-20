# Deployment

The testbed runs as a set of Docker Compose services. There are three ways to deploy it: on your own machine (`http://localhost`), on a server behind an HTTPS reverse proxy, or on a server without a proxy that holds its own certificate (the TLS overlay). This document covers all three, the ports, the certificates and every variable of the `.env` file. The containers, networks and media pipeline are described in [architecture.md](architecture.md); the network emulation in [network-emulation.md](network-emulation.md).

## Requirements

- Docker with Compose, and an Internet connection on the first start (the source videos and the images are downloaded).
- Chrome or Edge on the viewing side: the MoQ player needs WebTransport and WebCodecs.
- Outside `localhost`, the page must be served over HTTPS: browsers only expose WebTransport and WebCodecs in secure contexts.
- For network emulation, the kernel modules `sch_prio`, `sch_tbf`, `sch_netem` and `cls_u32`. In an LXC container they must be loaded on the host. If they are missing, everything else works and the panel says that emulation is unavailable.
- Building moq-cli or the MoQ relay from a git commit (optional, see [Third-party versions](#third-party-versions)) needs several GB of RAM.

## Choosing a deployment mode

| Mode | Page URL | `.env` | Certificate |
| :--- | :--- | :--- | :--- |
| [Local](#local-deployment) | `http://localhost` | none needed | none; the MoQ relay generates a self-signed one, pinned by fingerprint |
| [Behind an HTTPS proxy](#server-behind-an-https-reverse-proxy) | `https://<name of the proxy>` | `cp .env.template .env` | the proxy's, for the page; Let's Encrypt via DuckDNS for direct DASH; self-signed with fingerprint for the relay |
| [Own certificate, no proxy](#server-without-a-proxy-own-certificate-tls-overlay) | `https://<server name>` | `cp .env.tls.template .env` | one Let's Encrypt certificate (Cloudflare DNS challenge) for the page, direct DASH and the relay |

The two templates are complete: each lists every option of its mode, with the defaults commented out. Copy the one that matches, fill it in, and start with `docker compose up -d --build`. The `.env` file holds secrets (DNS tokens, camera credentials) and is never committed.

## Why DASH goes direct

Every media path goes from the browser straight to the server's emulation router, never through the HTTP entry point or a reverse proxy in front of the page. For MoQ (QUIC over UDP) and WebRTC (UDP) this is natural. For DASH it is a deliberate choice: a proxy terminates the browser's TCP connection and opens a second one towards the server, so the emulated network would act on the proxy's connection and not on the browser's. Going direct, the browser's own TCP connection (and its congestion control) crosses the emulated link, as the QUIC and WebRTC connections do.

Consequences:

- With `DASH_HOST` set, the browser fetches the manifest over HTTPS from `https://<DASH_HOST>:8443/media/dash/manifest.mpd`. A certificate for that name is needed, which is why the proxy deployment obtains one (see [Certificates](#certificates)).
- Without `DASH_HOST`, DASH only works from HTTP pages (`http://localhost` or `http://<server IP>`): the browser asks for the manifest over plain HTTP on port 8080 (`DASH_HTTP_PORT`) of `MOQ_HOST`, or of the page's host when `MOQ_HOST` is empty.
- On an HTTPS page without `DASH_HOST`, the DASH player shows an error and does not play ("This page is HTTPS and the server has no DASH_HOST: DASH has no direct path").
- The player footer shows the address it connects to ("Direct · host:port"). `GET /api/status` reports `dash_url`, `dash_http_port` and `dash_path` (always `direct`), and the CSV column `dash_path` records it.
- Direct DASH is served over HTTP/1.1 only, on both ports: HTTP/2 would multiplex video and audio over one TCP connection and change what is measured.
- The HTTP entry point answers `404` on `/media/dash/`.

## Local deployment

```bash
git clone <repository URL>
cd moq-dash-initial-comparison
docker compose up -d --build
```

Open <http://localhost> in Chrome or Edge. The stream starts on its own.

**Source videos.** The videos are not in the repository. On the first start the orchestrator downloads Big Buck Bunny 1080p60 (355 MB) and Tears of Steel 1080p (584 MB) from [download.blender.org](https://download.blender.org/demo/movies/) and unpacks them into `media/`, one after the other and before the stream starts, so that the download never overlaps a measurement. The panel shows the progress and the stream starts when it finishes. Later starts reuse the files. If the Big Buck Bunny download fails it is retried every 30 s; if Tears of Steel fails, the stream starts anyway and the download is retried when that video is selected. To use copies you already have, place them at `media/bbb_sunflower_1080p_60fps_normal.mp4` and `media/tears_of_steel_1080p.mov` before starting. Paths and URLs can be changed with `VIDEO_FILE`, `VIDEO_URL`, `TOS_VIDEO_FILE` and `TOS_VIDEO_URL` (orchestrator environment).

`media/` also holds the campaign data (`media/campaigns/`), the QoE recordings (`media/qoe/`) and the marker that keeps the stream stopped across restarts (`media/.stopped`).

Useful commands:

```bash
docker compose logs -f orchestrator
docker compose down
```

After editing code:

| Changed | How to apply |
| :--- | :--- |
| `server/app/*.py` | `docker compose restart orchestrator` (the directory is mounted, but uvicorn does not reload on its own) |
| `server/nginx.conf` | `docker compose restart nginx-dash` |
| `web/` | `docker compose up -d --build --no-deps web` |
| `router/` | `docker compose up -d --build --no-deps router` |
| `sfu/` | `docker compose up -d --build --no-deps sfu` |

Use `--no-deps` when rebuilding a single service: without it Compose may also recreate the orchestrator, and restarting the orchestrator loses the stream configuration, which goes back to the default three-rendition ladder (restore it with `POST /api/config`, see [api.md](api.md)). `POST /api/config` also starts the stream; if it was stopped, send `POST /api/stop` afterwards.

## Server behind an HTTPS reverse proxy

Use `.env.template`. The proxy (for example Nginx Proxy Manager) provides HTTPS for the page; the media paths bypass it.

1. On the server, `cp .env.template .env` and set the name the page is opened with: `PUBLIC_HOST=testbed.example.org`. It is the name in the relay's self-signed certificate.
2. `docker compose up -d --build`.
3. In the proxy, create a single host that forwards `https://testbed.example.org` to `http://<server>:80`. No custom locations are needed: the entry point dispatches page, API, relay fingerprint and WHEP signalling.
4. Make the server's ports **8443/tcp** (DASH), **4433/udp** (MoQ), **8189/udp** (WebRTC media) and **8189/tcp** (mediasoup signalling) reachable directly from the browsers. They do not go through the proxy.
5. If the public name resolves to the proxy and not to the server (typical with a wildcard DNS record), set the server's direct address in `MOQ_HOST=10.0.0.5`. The browser uses it for MoQ, for the WebRTC ICE candidates, for the mediasoup signalling over `ws://` and for DASH over HTTP. Because the relay's self-signed certificate is pinned by fingerprint, an IP address works. Without `MOQ_HOST`, the SFU and MediaMTX announce `127.0.0.1` as ICE candidate, which only works locally. The alternative for MoQ is to have the proxy forward 4433/udp as a stream.
6. **Direct DASH (required on an HTTPS page).** Create a DNS name that points **directly** to the server, not to the proxy. The template uses DuckDNS for the certificate, so the name must be a DuckDNS subdomain, e.g. `testbed-direct.duckdns.org` → `10.0.0.5`. Add `DASH_HOST=testbed-direct.duckdns.org` and `DUCKDNS_TOKEN=<token>` to the `.env`. The `dash-cert` service obtains and renews a Let's Encrypt certificate for it and `nginx-dash` starts serving DASH with TLS on port **8443/tcp**, which the router forwards and degrades like the MoQ and WebRTC ports. The same certificate is mounted in the SFU, so on HTTPS pages the mediasoup signalling uses `wss://<DASH_HOST>:8189`.

## Server without a proxy, own certificate (TLS overlay)

Use `.env.tls.template`. The server holds its own Let's Encrypt certificate, obtained with a Cloudflare DNS challenge, so no port needs to be open to the Internet: this works on an internal network. One certificate serves the panel (443/tcp), direct DASH (8443/tcp) and the MoQ relay (4433/udp). WebRTC media does not need it (DTLS with its own fingerprint); the mediasoup signalling (8189/tcp, `wss://`) uses it, and MediaMTX's WHEP signalling goes through the panel.

The overlay is `docker-compose.tls.yml`, loaded by this line of the `.env`:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml
DASH_HOST=testbed.example.org
MOQ_HOST=testbed.example.org
PUBLIC_HOST=testbed.example.org
RTC_HOST=10.0.0.5
CF_TOKEN=<token with Zone DNS Edit and Zone Read permissions>
```

- `DASH_HOST`, `MOQ_HOST` and `PUBLIC_HOST` are the same name, which must resolve to the server's IP from the browser's network. If the local DNS resolver drops answers with private IPs (DNS rebinding protection), the name must be allowed there too.
- `RTC_HOST` is the IP announced in the WebRTC ICE candidates (by the SFU and by MediaMTX): with the overlay, `MOQ_HOST` is a name and the certificate is not valid for the IP.
- Compose refuses to start if `DASH_HOST`, `CF_TOKEN` or `RTC_HOST` is missing.
- The page is at `https://testbed.example.org`, with no browser flags. Port 80 keeps serving the page over HTTP.

What the overlay changes:

| Service | Change |
| :--- | :--- |
| `edge` | Publishes 443 (`HTTPS_PORT`). Serves port 80 from the start and enables 443 as soon as the certificate exists; it checks the certificate every minute and reloads nginx when it is renewed. On 443, `/certificate.sha256` returns 404 |
| `dash-cert` | Uses the Cloudflare DNS API (`CF_TOKEN`) instead of DuckDNS |
| `moq-relay` | Uses the certificate files instead of generating a self-signed one. It fails until the certificate exists and Compose restarts it until `dash-cert` issues it (a couple of minutes on the first start). It reloads a renewed certificate for new connections without restarting |
| `mediamtx`, `sfu` | Announce `RTC_HOST` as ICE address |

**Measurement condition.** With the overlay, WebTransport validates the relay's certificate chain instead of pinning a fingerprint (Chrome refuses to pin it anyway: `serverCertificateHashes` requires a validity of at most 14 days). It is a different condition from the self-signed relay; at most it affects the initial QUIC handshake. Declare which one was used.

## Certificates

| Certificate | Used by | How it is obtained |
| :--- | :--- | :--- |
| Self-signed, for `PUBLIC_HOST` (default `localhost`) | MoQ relay (without the overlay) | Generated by the relay at start (`--listen-tls-generate`). The browser fetches its SHA-256 fingerprint from `/certificate.sha256` (entry point → relay port 8081) and pins it in WebTransport. The publisher inside the server connects with `--connect-tls-insecure` |
| Let's Encrypt, for `DASH_HOST`, DuckDNS DNS challenge | `nginx-dash` (8443), SFU signalling (`wss://`) | `dash-cert` (acme.sh, account registered without e-mail) when `DASH_HOST` and `DUCKDNS_TOKEN` are set |
| Let's Encrypt, for `DASH_HOST`, Cloudflare DNS challenge | With the overlay: `edge` (443), `nginx-dash` (8443), MoQ relay (4433), SFU signalling | `dash-cert` with `CF_TOKEN` |
| Proxy's own | The page and API behind a reverse proxy | Managed in the proxy |

- Certificates and the ACME account live in `certs/dash/` (outside the repository; it contains private keys). `certs/dash/certificates/<DASH_HOST>.crt` and `.key` are what the services read.
- `dash-cert` retries every 10 minutes if issuance fails, checks for renewal every 12 h, and acme.sh renews when fewer than 30 days remain. `nginx-dash` and `edge` check the files every minute and reload when they change; the relay reloads them on its own.
- Without `DASH_HOST` or without a DNS token, `dash-cert` does nothing and sleeps.
- If `certs/dash/` is deleted, restart `nginx-dash` after the certificate is issued again.

## Ports

Published on the host:

| Port | Default variable | Goes to | Through the emulation router | Use |
| :--- | :--- | :--- | :--- | :--- |
| 80/tcp | `HTTP_PORT` | `edge` | no | Page, API (`/api`), relay fingerprint, MediaMTX WHEP signalling (`/rtc/`) |
| 443/tcp | `HTTPS_PORT` | `edge` | no | Same over HTTPS; only with the TLS overlay |
| 8443/tcp | `DASH_PORT` | router → `nginx-dash:443` | yes | LL-DASH over HTTPS (with `DASH_HOST`) |
| 8080/tcp | `DASH_HTTP_PORT` | router → `nginx-dash:80` | yes | LL-DASH over HTTP (without `DASH_HOST`, from HTTP pages) |
| 4433/udp | `MOQ_PORT` | router → `moq-relay:4433` | yes | MoQ over QUIC / WebTransport |
| 8189/udp | fixed | router → SFU or MediaMTX | yes | WebRTC ICE, DTLS and SRTP |
| 8189/tcp | fixed | router → SFU | yes | mediasoup signalling over WebSocket (unused with MediaMTX) |

QUIC runs over UDP: 4433/udp (and 8189/udp for WebRTC) must be open in every firewall between browser and server. The signalling of each branch goes through a different path: mediasoup's WebSocket crosses the router's WebRTC queue and suffers its network profile; MediaMTX's WHEP request goes through the entry point and is not degraded. Internal ports are listed in [architecture.md](architecture.md#ports).

## Environment variables

All variables go in `.env` at the repository root. "Templates" says which template lists the variable: P for `.env.template` (local or proxy), T for `.env.tls.template` (overlay).

**Deployment and addresses**

| Variable | Default | Templates | Meaning |
| :--- | :--- | :--- | :--- |
| `COMPOSE_FILE` | unset | T | `docker-compose.yml:docker-compose.tls.yml` loads the TLS overlay. Do not change it in the overlay template |
| `PUBLIC_HOST` | `localhost` | P, T | Name the page is opened with; name of the relay's self-signed certificate |
| `MOQ_HOST` | empty (the page's host; `127.0.0.1` as ICE address) | P, T | Direct address of the server for MoQ, DASH over HTTP, mediasoup signalling over `ws://` and, without the overlay, the ICE candidates of the SFU and MediaMTX |
| `DASH_HOST` | empty | P, T | DNS name pointing directly to the server; enables DASH over HTTPS on 8443 and `wss://` signalling. Required by the overlay |
| `DUCKDNS_TOKEN` | empty | P | DuckDNS token for the `DASH_HOST` certificate. Secret |
| `CF_TOKEN` | none (required by the overlay) | T | Cloudflare API token with Zone DNS Edit and Zone Read. Secret |
| `RTC_HOST` | none (required by the overlay) | T | Server IP announced in the WebRTC ICE candidates |

**Ports**

| Variable | Default | Templates | Meaning |
| :--- | :--- | :--- | :--- |
| `HTTP_PORT` | 80 | P, T | Page and API over HTTP (what the proxy forwards to) |
| `HTTPS_PORT` | 443 | T | Page and API over HTTPS (overlay) |
| `MOQ_PORT` | 4433 | P, T | MoQ, UDP |
| `DASH_PORT` | 8443 | P, T | DASH with TLS |
| `DASH_HTTP_PORT` | 8080 | P | DASH without TLS |

**Source**

| Variable | Default | Templates | Meaning |
| :--- | :--- | :--- | :--- |
| `CAMERA_RTSP_URL` | empty | P, T | RTSP camera used when the panel's **Source** is **RTSP camera** (see [architecture.md](architecture.md#rtsp-camera)). It usually carries credentials, which is why it only lives in `.env`; the API only reports the host |
| `CAMERA_FPS` | empty | P, T | Forces the camera frame rate when the camera does not announce it correctly |

After setting the camera, apply it with `docker compose up -d --no-deps orchestrator` and select **RTSP camera** in **Source**. The orchestrator must be able to reach the camera over the network.

**WebRTC**

| Variable | Default | Templates | Meaning |
| :--- | :--- | :--- | :--- |
| `RTC_SERVER` | `mediasoup` | P, T | `mediasoup` (SFU with simulcast and adaptation) or `mediamtx` (one rendition over WHEP, no adaptation) |
| `RTC_INGEST` | `udp` | P, T | Only with MediaMTX: `udp` (MPEG-TS straight from the gate) or `rtsp` (remuxed by FFmpeg and published over RTSP) |
| `SFU_TRACE` | empty | P, T | `1` writes the SFU bandwidth estimate and probes to `docker logs testbed-sfu` (diagnostics) |

Switching `RTC_SERVER` needs no rebuild: both servers are always up and only the router's forwarding and the player change. Apply it with `docker compose up -d --no-build --no-deps router orchestrator` (and restore the stream configuration afterwards). `RTC_INGEST` only needs `docker compose up -d --no-deps orchestrator`. See [architecture.md](architecture.md#webrtc-branch).

The pacer factor of the experimental WebRTC ingest pacer is read by the orchestrator from `RTC_PACING_FACTOR` (default 2.5), but `docker-compose.yml` does not forward it from `.env`: to change it, add it to the orchestrator's `environment`.

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
