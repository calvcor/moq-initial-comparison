# MPD reference: the LL-DASH manifest, field by field

The manifest the LL-DASH branch serves, attribute by attribute: meaning, value here, where it comes from and what the player does with it. For the branch as a whole see [ll-dash.md](ll-dash.md); for the MoQ counterpart, [moq-catalog-reference.md](moq-catalog-reference.md).

The example is one rendition (1080p at 4000 kbit/s), 2 s segments and 100 ms fragments, captured from a running testbed; wall-clock timestamps are placeholders and the audio Representation is adapted to the Opus audio the source encodes (see [Audio](#audio)).

## The complete manifest

```xml
<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns="urn:mpeg:dash:schema:mpd:2011"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xsi:schemaLocation="urn:mpeg:DASH:schema:MPD:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd"
     profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="dynamic"
     minimumUpdatePeriod="PT500S"
     availabilityStartTime="2030-01-01T12:00:00.000Z"
     publishTime="2030-01-01T15:05:35.940Z"
     timeShiftBufferDepth="PT30.0S"
     maxSegmentDuration="PT2.0S"
     minBufferTime="PT1.0S">
  <ProgramInformation>
  </ProgramInformation>
  <ServiceDescription id="0">
  </ServiceDescription>
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true"
                   bitstreamSwitching="true" frameRate="60/1" maxWidth="1920" maxHeight="1080" par="16:9">
      <Resync dT="100000" type="0"/>
      <Representation id="0" mimeType="video/mp4" codecs="avc1.42c02a" bandwidth="4000000"
                      width="1920" height="1080" sar="1:1">
        <ProducerReferenceTime id="0" inband="true" type="captured"
                               wallClockTime="2030-01-01T12:00:00.973Z" presentationTime="0">
          <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="/media/dash/utc"/>
        </ProducerReferenceTime>
        <Resync dT="1000000" type="1"/>
        <SegmentTemplate timescale="1000000" duration="2000000"
                         availabilityTimeOffset="1.900" availabilityTimeComplete="false"
                         initialization="init-stream$RepresentationID$.m4s"
                         media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true"
                   bitstreamSwitching="true">
      <Resync dT="100000" type="0"/>
      <!-- bandwidth and the type-1 Resync dT are written by FFmpeg from the Opus stream -->
      <Representation id="1" mimeType="audio/mp4" codecs="opus" bandwidth="…"
                      audioSamplingRate="48000">
        <AudioChannelConfiguration
            schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
        <Resync dT="…" type="1"/>
        <SegmentTemplate timescale="1000000" duration="2000000"
                         availabilityTimeOffset="1.900" availabilityTimeComplete="false"
                         initialization="init-stream$RepresentationID$.m4s"
                         media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="/media/dash/utc"/>
</MPD>
```

FFmpeg writes it (`-f dash`, `start_dash()` in `server/app/main.py`). The testbed intervenes in three places, flagged below: the origin rewrites `availabilityStartTime`, it serves the `UTCTiming` clock itself, and the video `bandwidth` is declared to FFmpeg by hand. The packager command with the defaults:

```
python3 -u tsgate.py 5001 dash | ffmpeg -y -analyzeduration 1000000 -i pipe:0 \
  -map 0:v -map 0:a:0 -c:v copy -c:a copy -tag:v avc1 -b:v:0 4000k \
  -f dash -dash_segment_type mp4 -adaptation_sets 'id=0,streams=v id=1,streams=a' -seg_duration 2.0 \
  -frag_type duration -frag_duration 0.1 \
  -streaming 1 -ldash 1 -use_template 1 -use_timeline 0 \
  -utc_timing_url '/media/dash/utc' \
  -window_size 15 -extra_window_size 15 \
  -method PUT -http_persistent 1 'http://127.0.0.1:8000/media/dash/manifest.mpd'
```

A fragment duration of 0 ("1 frame" in the panel) becomes `-frag_type every_frame`; `-b:v:i` is repeated per rendition; `-utc_timing_url` comes from `UTC_TIMING_URL` (default `/media/dash/utc`).

## Notations used in the manifest

| Notation | Example | How to read it |
| :--- | :--- | :--- |
| Duration (`xs:duration`) | `PT2.0S`, `PT500S`, `PT1H30M` | `P` for period, `T` for time, then quantities with units: `H` hours, `M` minutes, `S` seconds. `PT2.0S` is 2 seconds. |
| Date and time (`xs:dateTime`) | `2030-01-01T12:00:00.000Z` | ISO 8601; the trailing `Z` means UTC. Always wall-clock time, never media time. |
| Time in `timescale` units | `duration="2000000"` with `timescale="1000000"` | An integer divided by the scale gives seconds: 2 000 000 / 1 000 000 = 2 s. Avoids decimals. |
| Scheme identifier (URN) | `urn:mpeg:dash:utc:http-xsdate:2014` | A standard name that says how to interpret the accompanying `value`. |

The manifest relates two clocks: **wall-clock time** (real time, UTC) and **media time** (position in the video, 0 at the start of the stream).

## The root element, `MPD`

Describes the stream as a whole.

| Attribute | Value here | Meaning |
| :--- | :--- | :--- |
| `xmlns`, `xmlns:xsi`, `xmlns:xlink`, `xsi:schemaLocation` | — | XML declarations: vocabulary and schema location. No effect on playback. |
| `profiles` | `urn:mpeg:dash:profile:isoff-live:2011` | The DASH subset the manifest complies with: "ISO BMFF live", fragmented-MP4 segments addressed by template. |
| `type` | `dynamic` | `dynamic` is live: content grows and availability depends on the clock. `static` is on demand: everything already exists. |
| `availabilityStartTime` | placeholder | The anchor of everything: the wall-clock time that corresponds to media time 0. Rewritten by the origin. |
| `publishTime` | placeholder | When this version of the manifest was generated. |
| `minimumUpdatePeriod` | `PT500S` | Minimum interval between manifest changes; the player does not re-fetch it sooner. |
| `timeShiftBufferDepth` | `PT30.0S` | How much past content the server keeps. |
| `maxSegmentDuration` | `PT2.0S` | Maximum segment duration in the whole stream. |
| `minBufferTime` | `PT1.0S` | Buffer-model parameter that defines what `bandwidth` means. |

**`availabilityStartTime` (AST).** With AST 12:00:00.000, media time 10 s is 12:00:10.000; all of [SegmentTemplate](#segmenttemplate-how-addresses-are-computed) starts here. Too early an AST makes the player request segments that do not exist yet (404); too late adds latency the player does not know about.

> **Testbed intervention.** FFmpeg writes as AST the time of its first write, delayed by input probing (`-analyzeduration`), not the time segments start to exist. The origin (`server/app/origin.py`) records when the first bytes of each segment arrive; FFmpeg opens segment *n* on the frame at media time (*n* − 1) × segment duration, so each segment estimates the AST as `arrival − (n − 1) × seg_duration`. Calibration uses segment ⌈(probe + 2 s) / seg_duration⌉ + 1 (past the startup burst; segment 3 with the 1 s probe and 2 s segments), one estimate per Representation, keeping the latest. The origin substitutes that AST on every manifest request and answers 404 for the manifest until calibrated. For later segments, estimate minus AST is reported as `dash_availability_drift_ms` (see [measurement.md](../measurement.md)).

**`minimumUpdatePeriod`.** Addresses are computed from a formula, so the manifest does not change and a large value (500 s) suffices; an explicit segment list would require constant re-reads.

**`timeShiftBufferDepth`.** The seek-back window. FFmpeg gets it as `-window_size` = ⌈30 s / segment duration⌉ segments (15 with 2 s), keeps as many again (`-extra_window_size`) and then deletes older segments on the origin (HTTP `DELETE`).

**`minBufferTime` and `bandwidth`.** Formally, a client downloading at a constant rate equal to `bandwidth` that waits `minBufferTime` before playing will not run dry: `bandwidth` is a rate that guarantees continuity given that cushion, not the mean bitrate. In practice players treat it as the rendition bitrate and manage their buffer with their own settings.

Attributes this manifest does not carry but that are worth knowing:

| Attribute | Purpose |
| :--- | :--- |
| `suggestedPresentationDelay` | Distance to the live edge recommended by the service. Without it, the player decides. |
| `mediaPresentationDuration` | Total duration. Only meaningful with `static`. |
| `availabilityEndTime` | Time after which the content stops being available. |

## `ProgramInformation` and `ServiceDescription`

**`ProgramInformation`** carries human-readable metadata (`Title`, `Source`, rights). Empty here.

**`ServiceDescription`** is the standard way for a service to set the player's low-latency behaviour. Here it is empty, with only its `id`. Filled, it would read:

```xml
<ServiceDescription id="0">
  <Latency target="3000" min="2000" max="6000"/>
  <PlaybackRate min="0.96" max="1.04"/>
</ServiceDescription>
```

| Element | Meaning |
| :--- | :--- |
| `Latency@target` | Target latency behind the live edge, in milliseconds. |
| `Latency@min`, `@max` | Acceptable range; outside it the player should correct. |
| `PlaybackRate@min`, `@max` | How much the player may speed up or slow down to correct. `1.04` is 4 % faster. |

Because the testbed's element is empty, **the manifest imposes no latency**: it is set by the panel's latency slider, which writes the `liveDelay` setting of `dash.js`. This differs from MoQ, where the publisher does condition the player's buffer through the catalog ([moq-catalog-reference.md](moq-catalog-reference.md)).

## `Period`

A continuous stretch of content; a stream can have several (programme, advert, programme), each with its own tracks.

| Attribute | Value here | Meaning |
| :--- | :--- | :--- |
| `id` | `0` | Identifier. |
| `start` | `PT0.0S` | When the period starts, counted from the AST. |

## `AdaptationSet`

One component (here video and audio). Its Representations are **interchangeable versions of the same content**: the player picks one per set and can switch within the set.

| Attribute | Video | Audio | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | `0` | `1` | Identifier. |
| `contentType` | `video` | `audio` | Media type. |
| `startWithSAP` | `1` | `1` | Every segment starts with an access point of the given type. |
| `segmentAlignment` | `true` | `true` | Segments of different renditions cover the same intervals. |
| `bitstreamSwitching` | `true` | `true` | Renditions can be switched without reinitialising the decoder. |
| `frameRate` | `60/1` | — | Frames per second, as a fraction. |
| `maxWidth`, `maxHeight` | `1920`, `1080` | — | The largest resolution among its Representations. |
| `par` | `16:9` | — | Picture aspect ratio. |

**`startWithSAP`.** A SAP (*Stream Access Point*) is where decoding can start; type 1, the strictest, is a keyframe after which everything decodes and displays in order. It lets the player join at any segment, so the segment must be a multiple of the GOP. The orchestrator raises `seg_duration` to GOP / fps when it is smaller (the panel shows "Must be ≥ GOP").

**`segmentAlignment`.** Segment *n* covers the same interval in every rendition, so the player can switch between segments without gaps or overlaps. All renditions share the GOP and have no scene-cut keyframes (`-g` = `-keyint_min` = GOP, `-sc_threshold 0`).

**`frameRate`** is a fraction so non-integer rates fit (29.97 fps is `30000/1001`); 24 with Tears of Steel. **`par`** is the picture shape, not the pixel shape (`sar`).

**With several renditions**, all are Representations of the one video AdaptationSet thanks to `-adaptation_sets "id=0,streams=v id=1,streams=a"`; otherwise each would get its own set and `dash.js` would not switch among them.

### The `Resync` element

Specific to low latency, twice per component: **resynchronisation points inside a segment**, where a player can join without waiting for the next segment.

| Where | Value | Meaning |
| :--- | :--- | :--- |
| AdaptationSet (video and audio) | `dT="100000" type="0"` | A resynchronisation point at most every 100 ms. |
| Video Representation | `dT="1000000" type="1"` | A type-1 access point at most every 1 s. |
| Audio Representation | `type="1"` | A type-1 access point at most every audio frame. |

- **`dT`** is the maximum distance between points, in `timescale` units (microseconds here).
- **`type`** is the SAP type guaranteed at those points. `0` means none is guaranteed: it is only a fragment boundary, where one can start *reading* but not necessarily *decoding*.

The values map to the configuration:

- 100 ms is the fragment duration: each `moof` + `mdat` pair is a resynchronisation point.
- 1 s is the GOP: each keyframe is a point from which decoding can start.
- Every audio frame is independently decodable, so audio `dT` is the audio frame duration: 21333 with AAC (1024 samples at 48 kHz) in the captured manifest; for Opus, 20 ms with libopus defaults (a deduction, not read from a captured manifest).

Together: "you can join mid-segment every 100 ms, but showing video may wait up to 1 s for a keyframe".

## `Representation`

One concrete version: what MoQ calls a rendition.

### Video

| Attribute | Value here | Meaning |
| :--- | :--- | :--- |
| `id` | `0` | Identifier; used to build addresses (`$RepresentationID$`). |
| `mimeType` | `video/mp4` | Container format. |
| `codecs` | `avc1.42c02a` | Codec and its parameters, as a normalised string. |
| `bandwidth` | `4000000` | Required rate, in bits per second (see [the root element](#the-root-element-mpd)). |
| `width`, `height` | `1920`, `1080` | Resolution in pixels. |
| `sar` | `1:1` | Sample (pixel) aspect ratio. |

**`codecs="avc1.42c02a"`** breaks down as:

| Part | Value | Meaning |
| :--- | :--- | :--- |
| `avc1` | — | H.264 with the decoder parameters (SPS and PPS) in the initialisation segment. The packager forces this tag (`-tag:v avc1`). |
| `42` | 66 decimal | *Baseline* profile. |
| `c0` | — | Constraint flags: with these bits, *Constrained Baseline*. |
| `2a` | 42 decimal | Level 4.2, which allows 1080p at 60 fps. |

The player asks the browser whether it can decode this string before downloading anything. *Baseline* follows from `-preset ultrafast` (no B-frames, no CABAC). The MoQ catalog calls the same bytes `avc3.42c02a`: `avc3` means parameters in-band at every keyframe (the source uses `repeat-headers=1`), `avc1` means they are in the initialisation segment.

**`bandwidth="4000000"`.**

> **Testbed intervention.** With `-c copy` FFmpeg does not know the video bitrate, so the testbed declares it (`-b:v:i`, per rendition). It is the ladder's **nominal** value, not a measurement, and the `dash.js` ABR uses it to decide whether a rendition fits. The MoQ catalog declares the publisher's measured maximum instead (about 7 Mbit/s for a 4000 kbit/s rendition in a captured catalog): a confounder when comparing adaptation (see [limitations.md](../limitations.md)).

**`sar`** is the pixel shape: `1:1` is square; anamorphic 1440×1080 shown as 16:9 would be `4:3`.

### Audio

The source encodes audio as Opus (`-c:a libopus -ac 2 -b:a 128k`) and the packager copies it into MP4 (`-dash_segment_type mp4`; without it FFmpeg would choose WebM for an Opus track).

| Attribute | Value here | Meaning |
| :--- | :--- | :--- |
| `codecs` | `opus` | Opus audio in MP4. |
| `bandwidth` | set by FFmpeg | Known to FFmpeg because it reads it from the stream: around the 128 kbit/s of the encoder plus overhead. |
| `audioSamplingRate` | `48000` | Samples per second (Opus works at 48 kHz; Tears of Steel's 44.1 kHz audio is resampled). |

**`AudioChannelConfiguration`** gives the channel layout. With the scheme `...audio_channel_configuration:2011`, `value` is the number of channels: `2` is stereo.

## `ProducerReferenceTime`

Relates a media instant to the wall-clock time it was produced, which would let a player compute its end-to-end latency.

| Attribute | Value here | Meaning |
| :--- | :--- | :--- |
| `id` | `0` | Identifier. |
| `type` | `captured` | Which moment the time refers to: `captured` is capture; `encoder` would be encoder output. |
| `wallClockTime` | placeholder | The wall-clock time. |
| `presentationTime` | `0` | The media time it corresponds to, in `timescale` units. |
| `inband` | `true` | The same information also travels inside the segments, in `prft` boxes. |

"The frame at media time 0 was captured at `wallClockTime`", so:

```
latency = now − (wallClockTime + media time being displayed)
```

The nested `UTCTiming` names the clock it was taken with.

> **Observation.** In the captured manifest, `wallClockTime` and `availabilityStartTime` differ by 0.973 s although both refer to media time 0. FFmpeg writes the first with its own clock and the origin does not correct it; the second is the one the origin recalibrates. The latency `dash.js` reported in tests (3.002 s with a 3 s target, against 3.119 s measured from the timecode) is consistent with the player following the AST. What `dash.js` does with this element has not been checked in its code.

## `SegmentTemplate`: how addresses are computed

Instead of listing segments, a **formula** for their addresses and availability.

| Attribute | Value here | Meaning |
| :--- | :--- | :--- |
| `timescale` | `1000000` | Units per second for the times in this element. |
| `duration` | `2000000` | Duration of each segment: 2 s. |
| `startNumber` | `1` | Number of the first segment. |
| `initialization` | `init-stream$RepresentationID$.m4s` | Template for the initialisation segment. |
| `media` | `chunk-stream$RepresentationID$-$Number%05d$.m4s` | Template for media segments. |
| `availabilityTimeOffset` | `1.900` | How many seconds before completion a segment may be requested. |
| `availabilityTimeComplete` | `false` | Whether what is served at that moment is complete. |

**Templates.** Identifiers between `$` are substituted:

| Identifier | Replaced by |
| :--- | :--- |
| `$RepresentationID$` | The Representation's `id`. |
| `$Number$` | The segment number; `%05d` zero-pads it to 5 digits. |
| `$Bandwidth$` | The Representation's `bandwidth`. Not used here. |
| `$Time$` | The segment's start time. Used with segment timelines, not here. |

For Representation `0`, addresses are `init-stream0.m4s` and `chunk-stream0-00042.m4s`, relative to the manifest: `/media/dash/chunk-stream0-00042.m4s`.

**Which segment is current.** The number of the segment being produced at a given instant is:

```
number = startNumber + floor( (now − AST − Period@start) / duration )
```

Example, with the manifest above, at 15:05:35.940:

```
now − AST = 15:05:35.940 − 12:00:00.000 = 11 135.94 s
11 135.94 / 2 = 5567.97  →  floor: 5567
number = 1 + 5567 = 5568

address: /media/dash/chunk-stream0-05568.m4s
```

It covers media time 11 134 to 11 136 s, computed from the clock without any list.

**When it can be requested.** In classic DASH a segment is available once it is finished:

```
available from = AST + Period@start + (number − startNumber + 1) × duration
```

For 5568: 12:00:00.000 + 5568 × 2 s = **15:05:36.000**, 2 s after production started: the reason for classic DASH's high latency.

**`availabilityTimeOffset`** brings that moment forward:

```
available from = (the above) − availabilityTimeOffset
               = 15:05:36.000 − 1.9 s = 15:05:34.100
```

Production started at 15:05:34.000, so it can be requested 100 ms later, once its first fragment exists. FFmpeg computes the value as segment minus fragment duration (2 − 0.1).

| Fragment | Segment | `availabilityTimeOffset` |
| :--- | :--- | :--- |
| 100 ms | 2 s | 1.900 |
| 200 ms | 2 s | 1.800 |
| 500 ms | 2 s | 1.500 |
| 100 ms | 4 s | 3.900 |

**`availabilityTimeComplete="false"`** warns that at that moment the segment is **incomplete**: the player must read the response as it arrives. `dash.js` enables its low-latency mode on this value. The origin serves an incomplete segment with chunked transfer encoding and no `Content-Length`, fragment by fragment as FFmpeg writes it (see [ll-dash.md](ll-dash.md)).

**Timeline of segment 5568:**

```
15:05:34.000  starts being produced
15:05:34.100  first fragment complete → can already be requested (thanks to availabilityTimeOffset)
15:05:34.200  second fragment, sent by the server over the already-open request
     ...      (one fragment every 100 ms)
15:05:36.000  last fragment: the segment is complete and the HTTP response ends
15:05:36.100  5569 can be requested
```

**The alternative, `SegmentTimeline`**, lists each segment's exact start and duration (`<S t="…" d="…" r="…"/>`). It tolerates irregular durations but forces a manifest re-read for every new segment and cannot announce early availability, so the testbed disables it (`-use_timeline 0`).

## `UTCTiming`

All of the above needs the player's "now" to be the server's; `UTCTiming` says where to get the correct time.

| Attribute | Value here | Meaning |
| :--- | :--- | :--- |
| `schemeIdUri` | `urn:mpeg:dash:utc:http-xsdate:2014` | The method. |
| `value` | `/media/dash/utc` (as written by FFmpeg) | Method-dependent; here, the URL to query. |

With `http-xsdate`, the player makes a GET request and receives the time as text:

```
GET /media/dash/utc
→ 2030-01-01T15:05:35.940Z
```

`dash.js` applies the offset from its own clock to all its computations. It takes the time as the midpoint of the request, compensating half its round trip. The origin serves the endpoint with the clock it uses to calibrate the AST.

> **Testbed intervention.** The clock is served by the testbed origin, next to the manifest. The URL is relative, so the player resolves it against the manifest's address and queries it through the network-emulation router, like the media: the emulated network acts on the clock sync too.

Other methods defined by the standard:

| Scheme | How the time is obtained |
| :--- | :--- |
| `...:http-xsdate:2014` | Body of an HTTP response, in `xs:dateTime` format. The one used here. |
| `...:http-iso:2014` | Same, in ISO 8601 format. |
| `...:http-head:2014` | `Date` header of an HTTP response. Second precision only. |
| `...:http-ntp:2014`, `...:ntp:2014` | NTP. |
| `...:direct:2014` | The time is written in the `value` itself. |

It appears at the root (which governs playback) and inside `ProducerReferenceTime`; the substitution affects both. Its precision is limited by the request round trip, one reason the testbed measures latency from a burnt-in timecode with its own clock synchronisation (see [latency-measurement.md](../latency-measurement.md)).

## The files it points to

For each Representation:

| File | Content | When it is requested |
| :--- | :--- | :--- |
| `init-stream0.m4s` | `ftyp` and `moov` boxes: file type and decoder configuration (resolution, SPS and PPS). No frames. | Once, at start-up and on a rendition switch. |
| `chunk-stream0-NNNNN.m4s` | A sequence of fragments, each with its `moof` (index and timing of the following frames) and its `mdat` (the frames). | One every segment duration, per component. |

With one rendition the player keeps two downloads in progress: the video segment (`chunk-stream0-…`) and the audio segment (`chunk-stream1-…`). With a ladder, video Representations take ids `0` … *n*−1 and audio takes id *n*. The origin serves the manifest with `Cache-Control: no-cache, no-store, must-revalidate` and the media files with `max-age=5`.

## Summary: what each value depends on

| Field | Set by | Panel control |
| :--- | :--- | :--- |
| `availabilityStartTime` | The origin, by measurement | — |
| `UTCTiming@value` | `-utc_timing_url` (`UTC_TIMING_URL`); the origin serves it | — |
| `SegmentTemplate@duration`, `maxSegmentDuration` | `-seg_duration` | DASH segment (-seg_duration) |
| `availabilityTimeOffset`, `Resync@dT` (type 0) | `-seg_duration` and `-frag_duration` (or `-frag_type every_frame`) | DASH segment and CMAF fragment |
| `Resync@dT` (type 1, video) | The source GOP | GOP |
| `Representation` (how many, `width`, `height`, `bandwidth`) | The ladder (`-b:v:i` declared per rendition) | Rendition ladder |
| `frameRate` | The source | — (follows the source video) |
| `timeShiftBufferDepth` | `-window_size`, ⌈30 s / segment duration⌉ segments | — |
| `ServiceDescription` | Nobody: empty | — (latency is set by the target-latency slider, in the player) |
