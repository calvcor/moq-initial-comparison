# MPEG-TS: the testbed's intermediate format

MPEG-TS is what the source emits, what `server/app/tsgate.py` reads, what the packagers consume and what the `mpegts` section of the MoQ catalog describes. **It never reaches the browser**: each branch unwraps it inside the server and repackages the video in its own format.

```
                      ┌── MPEG-TS ──▶ tsgate ──▶ ffmpeg -f dash ─────────────▶ CMAF        (DASH)
Source (FFmpeg) ──────┼── MPEG-TS ──▶ tsgate ──▶ moq import ts ──────────────▶ MoQ frames  (MoQ)
encodes and muxes     └── MPEG-TS ──▶ tsgate ──▶ ffmpeg -f rtp ─▶ mediasoup ─▶ RTP         (WebRTC)
                                                 (or MediaMTX over UDP)

                      └────────────── inside the server ──────────────┘   └─ to the browser ─┘
```

## Containers and why they are needed

An encoder produces **elementary streams** (compressed video frames, audio frames). A **container** (MP4, MPEG-TS, Matroska, WebM) wraps them without compressing anything, and adds what they lack: combining them on one channel, synchronising them (when each frame is shown) and describing them (which tracks and codecs). Combining streams is **multiplexing**; separating them, **demultiplexing**.

MPEG-TS (*MPEG Transport Stream*, ISO/IEC 13818-1) is the **digital television** container (satellite, cable, terrestrial), also used for professional contribution and as HLS's original segment format.

## Design idea: joining at any moment

A regular MP4 has a header indexing the whole file, which suits files, not an endless stream. MPEG-TS targets a continuous broadcast over an error-prone channel that receivers join at any time:

| Decision | Consequence |
| :--- | :--- |
| Fixed-size packets of 188 bytes | After an error the receiver finds the next packet without interpreting anything: it just counts. |
| No global header or trailer | The stream has no beginning; reading can start at any packet. |
| The content description is repeated periodically | A late joiner receives it within a fraction of a second. |
| Every packet carries a counter | Losses are detected. |

## The 188-byte packet

Every packet has a 4-byte header and 184 bytes of payload.

```
┌────────────── 4 bytes ──────────────┬──────────────── 184 bytes ────────────────┐
│ header                              │ payload (or adaptation field + payload)   │
└─────────────────────────────────────┴───────────────────────────────────────────┘
```

The 32 header bits:

| Field | Bits | Meaning |
| :--- | :--- | :--- |
| Sync byte | 8 | Always `0x47`. Marks the start of each packet. |
| Transport error indicator | 1 | Set by the RF receiver if it could not correct the packet. |
| **Payload unit start indicator** | 1 | This packet starts something new: a frame (PES) or a table. |
| Transport priority | 1 | Rarely used. |
| **PID** | 13 | Which stream the packet belongs to. |
| Scrambling control | 2 | Whether the payload is encrypted (pay TV). |
| Adaptation field control | 2 | Whether there is an adaptation field, a payload, or both. |
| **Continuity counter** | 4 | Increments on each packet of the same PID: 0, 1, …, 15, 0, … |

The three fields in bold are the ones the testbed uses.

**The PID** (*Packet Identifier*, 0 to 8191) separates the interleaved video, audio and table packets: to extract the video, keep the packets with its PID.

```
PID:   256  256  257  256  256    0  256  256  257  256 4096  256 ...
       video     audio          PAT            audio     PMT
```

**The continuity counter** detects losses (7, 8, 10: 9 is missing); with 4 bits it cannot count gaps of 16 or more.

**The adaptation field**, an optional extension taking part of the 184 bytes, carries:

| Content | Purpose |
| :--- | :--- |
| **PCR** | The sender's clock reference (see [Time](#time-pts-dts-and-pcr)). |
| **Random access indicator** | Marks that a point from which decoding can start begins in this packet: a keyframe. |
| Stuffing | Filler bytes to complete the 188 when the payload is shorter. |

PID 8191 (`0x1FFF`) carries **null packets** (filler for constant bitrate). The source does not generate them and `tsgate.py` ignores that PID.

## From a frame to packets: the PES layer

Each frame is wrapped in a **PES** (*Packetized Elementary Stream*) packet, a short header with its timestamps followed by the frame, which is cut into 184-byte pieces, each in a TS packet with the stream's PID; the first has the payload unit start indicator set.

```
Video frame (8300 bytes)
        │
        ▼
┌─────────────┬──────────────────────────────────────────┐
│ PES header  │ H.264 frame                              │   one PES
│ (PTS, DTS)  │                                          │
└─────────────┴──────────────────────────────────────────┘
        │  cut into 184-byte pieces
        ▼
[TS start=1][TS][TS][TS][TS] ... [TS + stuffing]           ≈ 46 packets, all with PID 256
```

With the testbed defaults, in orders of magnitude:

| Unit | Approximate size | TS packets |
| :--- | :--- | :--- |
| Average video frame (1080p at 4 Mbit/s, 60 fps) | 8.3 kB | About 46 |
| Keyframe | Several times larger | Several hundred |
| Audio frame (Opus at 128 kbit/s, 20 ms frames) | About 320 bytes | 2 |

About 2900 packets per second for one rendition (the Opus row is computed from the encoder settings, not measured). The source writes one PES per audio frame (`pes_payload_size=0`); by default FFmpeg groups about 180 ms of audio per PES and the packagers would hold the interleaved video that long.

**How the end of a frame is known.** The PES length field is usually 0 ("unbounded") for video, so a frame ends when **the next one starts** on the same PID. A reader therefore learns a frame is complete one frame period late (17 ms at 60 fps); `tsgate.py` compensates by timestamping each frame with the arrival of its *last* packet.

**What reading MPEG-TS costs each packager.** Measured at 1080p60 with one rendition, from the arrival of the last packet of each frame to the moment it leaves each program:

| Packager | Hold time | Frames | How it was measured |
| :--- | :--- | :--- | :--- |
| MediaMTX | 17 ms | 1 | MPEG-TS read and repackaging to RTP, observed with an RTSP reader on the same machine. |
| MoQ publisher (`moq import ts`) | 34 ms | 2 | Upper bound: includes the relay and a `moq export h264` subscriber on the same machine. |
| FFmpeg (`-f dash`) | 50.5 ms | 3 | The "CMAF packaging" stage with 1-frame CMAF fragments; median about 50 ms per frame, almost constant. |

In FFmpeg, reading the MPEG-TS alone holds each frame 33.5 ms (2 frames), measured with an isolated FFmpeg fed in real time and writing each frame immediately; `-fflags nobuffer` does not change it. Attributing one frame to PES end detection and one to the H.264 parser (which delimits a frame when the next starts) is a deduction. The third frame is in writing the MP4 fragment and sending it to the origin; that the muxer needs the next timestamp to compute a frame's duration is also a deduction. Audio and interleaving do not affect it (50.4 ms without audio, 50.5 ms with `-max_interleave_delta 1`). It is a cost of these implementations and of the intermediate format, not of DASH. The FFmpeg feeding mediasoup (`-f rtp`) has not been measured this way.

This cost falls in "CMAF packaging" for DASH but inside "Publishing and transport" for MoQ and WebRTC. "Packager ingest" (the wait at the gate) and total latency are comparable across branches; the stages in between are not. A declared confounder (see [limitations.md](../limitations.md), [latency-measurement.md](../latency-measurement.md)).

## Tables: how the content is described

Which PID carries what travels in the stream itself, in **tables** (PSI, *Program Specific Information*) on their own PIDs, repeated several times per second and read as a chain:

```
PAT  (PID 0, always)
 └─▶ "programme 1 is described in PID 4096"
        │
        ▼
PMT  (PID 4096)
 └─▶ "programme 1 has: H.264 video in PID 256
                       audio       in PID 257"
        │
        ▼
     packets with PID 256 and 257: the media
```

| Table | PID | Content |
| :--- | :--- | :--- |
| **PAT** (*Program Association Table*) | 0, fixed | The programmes in the stream and the PID of each one's PMT. The entry point: its PID is the only one known in advance. |
| **PMT** (*Program Map Table*) | The one given by the PAT | For one programme: its streams, the type of each and its PID. |
| **SDT** (*Service Description Table*) | 17 | Service and provider name. From the DVB standard; not needed for decoding. |

A **programme** is a channel: streams played together. One MPEG-TS can carry several; the testbed's carries one, with FFmpeg's default PIDs:

| What | PID | Hex |
| :--- | :--- | :--- |
| PAT | 0 | `0x0000` |
| SDT | 17 | `0x0011` |
| PMT | 4096 | `0x1000` |
| First stream (the highest-quality video) | 256 | `0x0100` |
| Following streams | 257, 258, … | `0x0101`, … |

With one rendition, video is PID 256 and audio PID 257. With three, the videos take 256, 257 and 258, from highest to lowest quality, and audio moves to 259. **All renditions travel in the same stream**, as video tracks of a single programme.

This explains the `mpegts` section of the MoQ catalog ([moq-catalog-reference.md](moq-catalog-reference.md)):

```json
"mpegts": {
  "tracks":  { "0.avc3": { "pid": 256 }, "1.opus": { "pid": 257 } },
  "program": { "transportStreamId": 1, "programNumber": 1, "pmtPid": 4096 },
  "si":      { "17": { "66": { "track": "0x0011-0x42.si", "interval": 2000 } } }
}
```

- `tracks`: the PIDs the PMT assigned to video and audio.
- `program`: what the PAT said: a transport stream with id 1, carrying programme 1, described in PID 4096.
- `si`: the SDT, carried in PID 17 with table id 66 (`0x42`).

The importer keeps this so an equivalent MPEG-TS could be rebuilt at the relay's output.

## Time: PTS, DTS and PCR

MPEG-TS measures time with a **90 000 units-per-second** clock (90 kHz). There are three timestamps:

| Timestamp | Where | What it indicates |
| :--- | :--- | :--- |
| **PTS** (*Presentation Time Stamp*) | PES header | When the frame must be displayed. |
| **DTS** (*Decoding Time Stamp*) | PES header | When it must be decoded. Differs from PTS only with B-frames. |
| **PCR** (*Program Clock Reference*) | Adaptation field | The sender's clock, so the receiver can adjust its own. |

**The PTS**: at 60 fps consecutive frames are 90 000 / 60 = **1500 units** apart (3750 at 24 fps); 33 bits, wrapping every 26.5 hours.

```
frame n     PTS = 1 260 000
frame n+1   PTS = 1 261 500     (+1500 = 1/60 s)
frame n+2   PTS = 1 263 000
```

The testbed uses the PTS to **identify frames**. The stage timestamps of the latency breakdown are stored by PTS: `tsgate.py` records when the frame with each PTS arrived, and the orchestrator computes a frame's PTS from its sequence number (PTS of frame 0 plus 90 000 / fps per frame).

**The DTS** equals the PTS here: the source has no B-frames (`-preset ultrafast -tune zerolatency`). **The PCR** lets a broadcast receiver, which cannot ask the sender for the time, lock its clock to the emission rate; in the testbed it has no practical function, since packagers process the stream as it arrives.

## How it travels inside the server

The source sends MPEG-TS over **UDP** to local ports, through FFmpeg's `tee` muxer, which writes the same stream to every destination. All branches receive **exactly the same packets**.

| Port | Consumer |
| :--- | :--- |
| 5001 | DASH packager |
| 5002 | MoQ publisher |
| 5003 | WebRTC ingest |
| 5004 | QoE recorder (listens only while recording) |
| 5005 | Reference stream for VMAF, only with the camera source (a separate, near-lossless encode, not a `tee` output; large datagrams of 348 TS packets) |

Each datagram on ports 5001-5004 carries **7 TS packets**: 7 × 188 = 1316 bytes (`pkt_size=1316`), the usual size because it is the largest multiple of 188 that fits a normal network packet without fragmentation.

UDP can drop datagrams even on loopback if a reader falls behind; that would hit one branch only and bias the comparison, so it is monitored (next section). `tsgate.py` requests an 8 MB receive buffer.

## What `tsgate.py` does

A small program between the source and each packager: it reads the UDP datagrams and writes them to the packager's pipe (or, with `--udp HOST:PORT`, forwards them over UDP in datagrams of up to 7 packets, for MediaMTX).

**1. Start at a keyframe.** With `-c copy`, FFmpeg would drop video up to the first IDR but keep earlier audio, offsetting video by up to one GOP from the DASH segment grid so that `dash.js` miscomputes its latency. The gate discards everything until a packet on PID 256 (the highest-quality video) has the **random access indicator** set, and sends the latest PAT, SDT and PMT just before it, so every branch starts cleanly with audio and video together.

**2. Monitor continuity.** For every PID with payload (except null packets) it checks that the **continuity counter** advances by one. If not, it writes to stderr a line such as:

```
continuity check failed: pid=257 expected=9 got=10
```

The orchestrator counts these lines as **Ingest anomalies**. They appear when the host is CPU-saturated (hundreds on one branch on an undersized host), not on an adequately sized one.

**3. Record when each frame arrives.** On each **payload unit start** of a video PES (stream id `0xE0`-`0xEF` with a PTS) it reads the **PTS** and closes the previous frame of that PID. It sends the orchestrator (UDP 5010, at most every 100 ms) each frame's PTS with two times: kernel arrival of its last packet (`SO_TIMESTAMPNS`, independent of any reader) and when the gate read and forwarded it. The gate blocks on the pipe if the packager does not drain it, so the difference is the frame's wait for the packager. These feed the "Encoding" and "Packager ingest" stages (see [latency-measurement.md](../latency-measurement.md)).

**4. Track selection for MediaMTX** (`RTC_SERVER=mediamtx`, UDP ingest). MediaMTX cannot choose tracks and expects data on every track the PMT announces, so with `--first-video` the gate passes only the highest rendition (plus audio with `--audio`, the `rtc_audio` option) and rewrites the PMT (new CRC) to match; it warns if the PCR is on a dropped PID.

It never modifies media bytes.

## Why MPEG-TS here, and its cost

**Why MPEG-TS as the intermediate format:**

- **Independent start and restart**: any packager can join mid-stream, so the supervisor restarts one branch without touching the others or the source.
- **All the tools read it**: FFmpeg, the MoQ importer and MediaMTX.
- **Several video tracks in one stream**: the whole ladder travels at once.
- **Frame-start and keyframe markers readable without decoding**, which makes the gate possible.

**What it costs:**

- **Overhead**: 2 % for TS headers, plus PES, tables and stuffing, on the internal path only.
- **The end of each frame is known one frame late** (see [the PES layer](#from-a-frame-to-packets-the-pes-layer)).
- **A single channel**: video, audio and tables are serialised, so the muxer decides the order.

The last point can make video leave the source in bursts. Three source settings prevent it; the first two are needed together:

- **A separate filter graph for audio** (its own `-filter_complex`). With a shared graph, FFmpeg feeds the graph by pulling frames from its inputs in timestamp order, so video advances in step with the audio frames of the source file (24 ms MP3 frames) instead of its own.
- **`-max_interleave_delta 1`.** Without it, the muxer holds each video frame until it has a later audio packet, to write in strict timestamp order, and video leaves two frames at a time.
- **`pes_payload_size=0`**, one PES per audio frame (see above).

With them, video frame spacing at the source output (20 s, 1080p, three-rendition ladder) matches the same source without audio: median 16.3 ms, p95 24.1 ms, maximum 38 ms (16.4, 24.1 and 36 ms without audio), and the "Encoding" stage median is about 10 ms (about 30 ms without these settings). The trade-off: audio may travel some tens of milliseconds behind the video of the same instant; all packagers accept it and timestamps are unchanged.

## What each branch does with the stream

All branches demultiplex (separate by PID, rebuild PES, extract frames with their PTS); they differ in what they rewrap them in.

| Branch | Tool | What it takes | What it turns it into |
| :--- | :--- | :--- | :--- |
| DASH | `ffmpeg -f dash` (`-c copy`) | All video tracks and the audio | CMAF fragments: each frame goes into an `mdat` and its PTS into the `moof` timing. |
| MoQ | `moq import ts` | All video tracks and the audio | One track per PID; each frame becomes a MoQ frame with its timestamp; each keyframe opens a group. |
| WebRTC, `RTC_SERVER=mediasoup` (default) | `ffmpeg -c copy -f rtp`, one output per rendition, then `rtprelay.py` to mediasoup | All video tracks, and the audio with `rtc_audio` | RTP packets per rendition (one SSRC each), which the SFU forwards to the browser. |
| WebRTC, `RTC_SERVER=mediamtx` | MediaMTX reading MPEG-TS over UDP from the gate | Only the first video (PID 256), and the audio with `rtc_audio` | RTP packets to the browser. |

None re-encodes: the H.264 bytes are unchanged; only the MPEG-TS wrapping is discarded (the MoQ importer summarises the tables in its catalog).

Two details about the PTS:

- **DASH** subtracts the first frame's PTS so media time starts at 0, which is why the gate must start at a keyframe.
- **MoQ** rewrites timestamps with its own offset, so the testbed identifies MoQ frames by the burnt-in timecode instead.

## Vocabulary

| Term | Meaning |
| :--- | :--- |
| Elementary stream | The output of an encoder: video only or audio only. |
| Multiplex / demultiplex | Combine several streams into one / separate them. |
| TS packet | The 188-byte unit. |
| PID | Stream identifier carried by each packet. |
| PES | The wrapper of each frame, with its timestamps, before it is cut into packets. |
| PAT, PMT | Tables describing which programmes exist and which streams each has. |
| SDT | Table with the service name. |
| Programme | A set of streams played together: a channel. |
| PTS, DTS | Presentation and decoding instant of a frame, at 90 kHz. |
| PCR | The sender's clock reference. |
| Continuity counter | 4-bit per-PID counter for detecting losses. |
| Random access indicator | Marks the start of a keyframe. |
| Null packet | Filler, on PID 8191. |
