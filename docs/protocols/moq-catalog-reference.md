# MoQ catalog reference

This document walks through the Media over QUIC catalog section by section and field by field, as the [MPD reference](mpd-reference.md) does for the LL-DASH manifest. For how MoQ delivery works as a whole, see [moq.md](moq.md).

The catalog plays the role of the MPD (what is available and how to decode it) but lacks almost everything the MPD devotes to **locating** media: there are no addresses or availability times, the track name is enough to subscribe, and the relay forwards whatever arrives.

**Sources.** Field definitions are read from the catalog schema of `@moq/hang` 0.5.3 and player behaviour from `@moq/watch` 0.6.3 (the versions in `web/package-lock.json`); the `mpegts` section and the meaning of `bitrate` from the publisher source (`moq-cli`, `rs/moq-mux`). The example was captured from a running testbed with one 1080p rendition. Builds from the moq development branch (see [deployment.md](../deployment.md)) may differ; known differences are flagged.

## How it is carried

The catalog is not a file but **one more track of the broadcast**, `catalog.json`, to which the player subscribes; a new version arrives whenever something changes.

| Aspect | Value |
| :--- | :--- |
| Track name | `catalog.json` |
| Subscription priority | 100, the highest: ahead of text (90), audio (80) and video (60) |
| Subscription *max age* | 0: only the latest version matters |
| Format | JSON text |
| Compressed variant | `catalog.json.z`, raw DEFLATE. Optional; the player uses it only when asked to |

The catalog format is inferred from the broadcast name suffix, like a file extension: `live.hang` (the name the testbed publishes and plays) means a hang catalog; `live.msf` would mean the IETF MSF format. A name with no recognised suffix is treated as hang.

**Updates.** In *snapshot* mode each group starts with the complete catalog and the following frames of the group are JSON Merge Patch (RFC 7396) **patches** with only what changed; a new subscriber gets the latest group and the full state. Marking a rendition as stalled, for example (illustrative, not captured):

```json
{ "video": { "renditions": { "0.avc3": { "stalled": true } } } }
```

Removing the mark (`null` means delete):

```json
{ "video": { "renditions": { "0.avc3": { "stalled": null } } } }
```

That is why renditions are a **map** keyed by track name, not a list: a patch can address a map entry, not a list element. Updates can be very frequent: with an irregular source and three renditions, 334 in 30 s were observed, almost all setting and clearing that mark.

## Example catalog

Captured with one 1080p rendition configured at 4000 kbit/s:

```json
{
  "video": {
    "renditions": {
      "0.avc3": {
        "codec": "avc3.42c02a",
        "codedWidth": 1920,
        "codedHeight": 1080,
        "bitrate": 7573296,
        "framerate": 60.0,
        "container": { "kind": "legacy" }
      }
    }
  },
  "audio": {
    "renditions": {
      "1.aac": {
        "codec": "mp4a.40.2",
        "sampleRate": 48000,
        "numberOfChannels": 2,
        "bitrate": 165007,
        "description": "1190",
        "container": { "kind": "legacy" },
        "jitter": 43
      }
    }
  },
  "archive": { "track": "timeline.z", "timescale": 1000 },
  "clock": { "wall": 213718046806804, "timescale": 1000000 },
  "mpegts": {
    "tracks": { "0.avc3": { "pid": 256 }, "1.aac": { "pid": 257 } },
    "program": { "transportStreamId": 1, "programNumber": 1, "pmtPid": 4096 },
    "si": { "17": { "66": { "track": "0x0011-0x42.si", "interval": 2000 } } }
  }
}
```

> **Audio codec.** This example was captured with AAC-LC audio. The source now encodes audio in Opus (`-c:a libopus -b:a 128k`, see `server/app/main.py`), so the audio track is `1.opus` with codec `opus`; the structure is the same. The other audio values below (`description`, `bitrate`, `jitter`) are those of the AAC capture and were not re-captured with Opus.

The publisher (`moq import ts`) writes the whole catalog, deriving it from the MPEG-TS it receives. The testbed sets no field: unlike the DASH manifest, nothing is rewritten or declared by hand.

## Root sections

The catalog is an object with one section per kind of content. A section with no tracks is omitted.

| Section | Content | In this catalog |
| :--- | :--- | :--- |
| `video` | Video renditions | Yes |
| `audio` | Audio renditions | Yes |
| `text` | Subtitles and captions | No |
| `json` | Application data tracks in JSON | No |
| `binary` | Application data tracks in binary | No |
| `archive` | Index of the broadcast's segments and, if any, its recording | Yes |
| `clock` | Mapping between media time and wall-clock time | Yes |
| `mpegts` | Importer extension: data to rebuild the original MPEG-TS | Yes |

The root is **loose**: unknown sections (such as `mpegts`, outside the base schema) are ignored without invalidating the rest, so applications can add their own. An unparsable `archive` only disables seeking and recording, and a `text`, `json` or `binary` value not shaped like a section is read as absent. At most 64 renditions across video, audio and text are accepted in one update.

## The `video` section

```json
"video": {
  "renditions": { "0.avc3": { ... }, "1.avc3": { ... } },
  "display": { "width": 1920, "height": 1080 },
  "rotation": 0,
  "flip": false
}
```

| Field | In this catalog | Meaning |
| :--- | :--- | :--- |
| `renditions` | One entry | Map from track name to configuration. All entries are the same content in interchangeable versions. |
| `display` | Absent | Size at which to render the video, in pixels. If absent, the player uses the frame size. |
| `rotation` | Absent (0) | Rotation in degrees, e.g. for video recorded with a phone held upright. |
| `flip` | Absent (`false`) | Horizontal mirror, typical of a front camera. |

`display`, `rotation` and `flip` apply to all renditions and are kept apart because changing them does not require reinitialising the decoder.

**The map key is the track name.** To play `0.avc3` the player subscribes to track `0.avc3` of broadcast `live.hang`: the direct, much simpler equivalent of `SegmentTemplate`. The publisher chooses the name, here *index.codec* (`0.avc3` is the first elementary stream of the MPEG-TS, H.264); the player does not interpret it.

## Video rendition fields

They mirror WebCodecs `VideoDecoderConfig`, plus a few hang-specific fields, so the player can pass them to the decoder almost unchanged.

| Field | Value here | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `codec` | `avc3.42c02a` | Yes | Codec and its parameters. |
| `container` | `{"kind":"legacy"}` | No (default `legacy`) | How each frame is packaged. |
| `description` | Absent | No | Decoder configuration, in hexadecimal. |
| `codedWidth`, `codedHeight` | `1920`, `1080` | No | Coded resolution, in pixels. |
| `displayAspectWidth`, `displayAspectHeight` | Absent | No | Display aspect ratio. |
| `framerate` | `60.0` | No | Frames per second. |
| `bitrate` | `7573296` | No | Bitrate, in bits per second. |
| `optimizeForLatency` | Absent (`true`) | No | Asks the decoder to prioritise latency. |
| `jitter` | Absent | No | Maximum delay with which the publisher flushes frames, in ms. |
| `delay` | Absent | No | Delay of this rendition behind the earliest one, in ms. |
| `stalled` | Absent | No | The publisher recommends avoiding it for now. |
| `label` | Absent | No | Human-readable name for a quality picker. |
| `broadcast` | Absent | No | The track lives in another broadcast. |

**`codec`.** Same notation as in DASH (see [mpd-reference.md](mpd-reference.md)): `42` is the *Baseline* profile, `c0` its constraint flags and `2a` level 4.2. The difference is the prefix:

| Prefix | Where the decoder parameters (SPS and PPS) travel |
| :--- | :--- |
| `avc1` | Out of band. In DASH, in the initialisation segment; in MoQ, in `description`. |
| `avc3` | In band, repeated before every keyframe. |

Here it is `avc3`, so there is no `description`: the player takes the parameters from the first keyframe, which fits the group model (every group decodable on its own). The source repeats them with x264's `repeat-headers=1`.

**`description`.** Hexadecimal configuration the codec needs before the first frame, so the decoder can be prepared from the catalog alone (example in the audio section).

**`codedWidth` and `codedHeight`.** Used to sort renditions and apply resolution limits; with `avc3` the real resolution is also in band, so they are informative.

**`displayAspectWidth` and `displayAspectHeight`.** For non-square pixels (1440×1080 shown at 16:9 would carry `16` and `9`); absent means square. Equivalent to `sar` in the MPD.

**`framerate`.** Informative, and it also affects latency: if the rendition declares no `jitter`, the player assumes one frame interval (`ceil(1000 / framerate)`, 17 ms at 60 fps) as the minimum irregularity.

**`bitrate`.** The field used by automatic adaptation: the player picks the rendition with the highest `bitrate` that fits in 80 % of the estimated receive rate, excluding stalled renditions; if none fits, the one with the lowest `bitrate` (see [moq.md](moq.md) and [adaptation-and-experiments.md](../adaptation-and-experiments.md)).

> **Confounder: the catalog bitrate is a measured maximum, not the nominal rate.** The publisher source documents it as the track's **maximum** bitrate; per the comments in `rs/moq-mux` it is measured over 1 s windows and the peak is kept (never lowered), so keyframes push it above nominal. Measured: 6.7-7.6 Mbit/s for 1080p configured at 4000 kbit/s and 3.6 Mbit/s for 720p at 2000 kbit/s, about 1.85 times nominal. For the same video the MPD declares the nominal 4 Mbit/s, so the two players do not see the same ladder; with the 80 % margin, keeping 1080p in MoQ needs an estimate above about 9.3 Mbit/s. Declare it in any comparison (see [limitations.md](../limitations.md)).

**`optimizeForLatency`.** Passed to the decoder; with `true` (the default) it outputs each frame as soon as it can.

**`label`.** Text for a picker, such as "1080p"; if absent, the picker builds one from the resolution.

**`broadcast`.** Points to a track published in another broadcast, by relative path, so renditions can be spread across publishers:

```json
"720p": { "codec": "avc3.42c01f", "broadcast": "../transcoded" }
```

Read from `live.hang`, that track is looked up in broadcast `transcoded`; a reference climbing above the root invalidates the update. `jitter`, `delay` and `stalled` have their own sections below.

## The `audio` section

Same shape as video: a `renditions` map with one entry per version. Fields mirror WebCodecs `AudioDecoderConfig`.

| Field | Value here | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `codec` | `mp4a.40.2` | Yes | AAC-LC in the captured example (`opus` with the current source). |
| `sampleRate` | `48000` | Yes | Samples per second. |
| `numberOfChannels` | `2` | Yes | Channel count: stereo. |
| `bitrate` | `165007` | No | Bitrate, in bits per second. |
| `description` | `1190` | No | Decoder configuration, in hexadecimal. |
| `container` | `{"kind":"legacy"}` | No | As in video. |
| `jitter` | `43` | No | As in video (see below). |
| `delay`, `label`, `broadcast` | Absent | No | As in video. |

**`description: "1190"`.** Two bytes, `0x11` and `0x90`, forming the standard AAC configuration (*AudioSpecificConfig*):

```
0x11 0x90  =  00010 0011 0010 000
              │     │    │    └─ padding
              │     │    └────── 2  → 2 channels
              │     └─────────── 3  → 48 000 Hz (index 3 of the frequency table)
              └───────────────── 2  → AAC-LC
```

It repeats `codec`, `sampleRate` and `numberOfChannels` in the form the decoder requires; AAC, unlike H.264 in `avc3`, does not carry it in band. **`bitrate: 165007`**: the source encodes audio at 128 kbit/s, so, as with video, the catalog value exceeds nominal. Audio has no `stalled` field.

## The `container` field

It says how to interpret the bytes of each MoQ frame. Three kinds are known:

| `kind` | Frame layout |
| :--- | :--- |
| `legacy` (used by the testbed, and the default when the field is absent) | A QUIC variable-length integer with the timestamp in microseconds, followed by the raw encoded frame. |
| `cmaf` | Each MoQ frame is a complete CMAF fragment (`moof` + `mdat`), as in DASH. The initialisation segment (`ftyp` + `moov`), a separate file in DASH, travels in the field `init`, base64-encoded. Lets media already packaged for DASH or HLS be reused. |
| `loc` | *Low Overhead Container*, from the IETF draft: a small property block followed by the encoded frame. |

```json
"container": { "kind": "legacy" }
"container": { "kind": "cmaf", "init": "AAAAHGZ0eXBpc281AAAC..." }
"container": { "kind": "loc" }
```

An unknown `kind` does not invalidate the catalog: that rendition is ignored and the others remain available.

## `jitter` and `delay`: what the publisher tells the buffer

These two fields act directly on latency and have no counterpart in the testbed's MPD. **`jitter`** is the maximum delay, in whole milliseconds rounded up, between a frame being ready and the publisher flushing it. The publisher measures it on itself (encoder latency, segment size, reordering), never on the network. Examples from the schema:

| How the publisher sends | `jitter` |
| :--- | :--- |
| Each frame as soon as it is ready, at 60 fps | One frame interval: 17 ms |
| Up to 3 consecutive B-frames that force reordering | 3 intervals: 50 ms |
| Accumulates 2 s segments before sending | 2000 ms |

Two properties matter: it **only grows** over the life of a broadcast (if the publisher was once 65 ms late, the value stays at 65 until restart), and **0 is treated as absent**.

**`delay`** is how far this rendition reaches the transport behind the earliest one (which omits it): a 720p transcoded from 1080p in 80 ms declares `"delay": 80`. It also only grows, and 0 means absent.

**What the player does with them** (read from `@moq/watch` 0.6.3). For each active track it computes a hold time, takes the largest over all registered tracks and adds it to its own jitter-buffer value (the `delay` option: the slider value, or in auto `max(20 ms, 1.25 × minimum RTT)`, 100 ms until an RTT is known):

| Track | Hold time |
| :--- | :--- |
| Video | `delay` + `jitter`, or `delay` + `ceil(1000 / framerate)` if there is no `jitter` |
| Audio | `delay` + (`jitter`, or one codec frame if absent: 20 ms for Opus, `ceil(1024 / sampleRate)` for AAC) + one 128-sample audio render quantum (3 ms at 48 kHz) |

In the captured catalog the video term is 17 ms and the audio term 43 + 3 = 46 ms, so the audio sets it. Things worth knowing:

- **Audio sets it even when muted**: the audio track registers its hold time whether or not it is played (read from the code, consistent with observation). With video only it would be 17 ms.
- **It varies**: 43, 46 and 65 ms were observed for the audio `jitter`, the last with the server overloaded.
- **It is a floor** the slider cannot go below.

The AAC capture's 43 ms is two AAC frames (1024 / 48 000 = 21.3 ms each), consistent with the publisher seeing audio arrive in pairs; that cause was not verified. The resulting value is the "effective delay" shown next to the MoQ slider (see [moq.md](moq.md)): a target, not a measurement.

## `stalled`: the publisher's warning about a rendition

Set to `true` by the publisher on a video rendition it cannot deliver on time (written only when `true`). The schema calls it a recommendation to avoid the rendition temporarily; the track remains available.

**When it is set**, according to the detector in `@moq/hang` 0.5.3 (`catalog/stalled`): someone must be subscribed to that rendition and the broadcast must not be idle, and the larger of these two lags must exceed 3 frame intervals:

- how far the latest data received from the source is ahead of what has been handed to the transport, or
- how long the source has gone without delivering a frame of that rendition.

**When it is cleared:** after 3 consecutive frames delivered on time (lag of at most one interval), or as soon as there is no subscriber.

| Frame rate | Interval | Threshold to set |
| :--- | :--- | :--- |
| 60 fps | 16.7 ms | 50 ms |
| 24 fps | 41.7 ms | 125 ms |
| No `framerate` declared | 33 ms (assumed) | 99 ms |

**What the player does** (`@moq/watch` 0.6.3): in automatic mode it discards stalled renditions, and if all are stalled keeps the lowest-bitrate one. A rendition chosen by hand is kept even when stalled.

With no DASH equivalent, **the publisher can take a rendition out of every player's selection at once**, without any player measuring anything. In the testbed it is the cause of most of the continuous quality switching observed in MoQ with several renditions, when the publisher falls behind on its input (see [moq.md](moq.md) and [limitations.md](../limitations.md)).

> **Version dependence.** In the moq development branch, `stalled` is no longer written and is ignored on read; it is replaced by a field `enabled` with a different meaning (if `false`, no frames arrive and the player must not select that rendition). This was read from the development-branch source; the released `@moq/hang` 0.5.3 still uses `stalled`. When the testbed runs builds from the development branch, the flag does not exist.

## The `clock` section

Maps media time to wall-clock time for the whole broadcast: the equivalent of `availabilityStartTime` and `ProducerReferenceTime` in the MPD.

| Field | Value here | Meaning |
| :--- | :--- | :--- |
| `wall` | `213718046806804` | Wall-clock time of media time (PTS) 0, counted from the MoQ epoch. |
| `timescale` | `1000000` | Units per second of `wall`. Default 1 000 000 (microseconds); zero is refused. |

The **MoQ epoch** is 2020-01-01T00:00:00Z (Unix ms 1 577 836 800 000), not the Unix epoch:

```
wall / timescale            = 213 718 046.806804 s after the MoQ epoch
Unix time of PTS 0 (ms)     = 1 577 836 800 000 + 213 718 046 806.804
wall-clock time of a frame  = Unix time of PTS 0 + the frame's timestamp
```

The publisher fixes it once and never changes it, not even if the system clock is adjusted. The player **does not use it to decide when to paint**: it schedules frames from their arrival times (see [moq.md](moq.md)). That is the deep difference with DASH, where without the clock-to-media mapping the player does not know which segment to request; in MoQ it is optional, useful to align broadcasts with each other or with external data.

## The `archive` section

Announces the segment index, an auxiliary track for locating past content to request with FETCH.

| Field | Value here | Meaning |
| :--- | :--- | :--- |
| `track` | `timeline.z` | Name of the track carrying the index. |
| `timescale` | `1000` | Units per second of its timestamps (default: milliseconds). |
| `durationMax` | Absent | Upper bound on a segment's duration, in timescale units. |
| `replay` | Absent | Broadcast the recording is served from, relative to this catalog, if different. |
| `store` | Absent | URL of the object store holding the recording. |
| `version` | Absent | Recording object format version. Present only with a store. |

Only the first two are present: a live publisher with an index of recent content and nothing stored. The `.z` suffix is a naming convention; the schema warns never to infer compression from a name. The testbed player does not use this section: it plays only the live edge.

## The `mpegts` section

Not part of the base schema: the importer adds it to be able to **rebuild the original MPEG-TS** on output (`moq export ts`), keeping what the generic description does not cover. Definitions read from the publisher source.

| Field | Value here | Meaning |
| :--- | :--- | :--- |
| `tracks` | `0.avc3` → 256, `1.aac` → 257 | PID each track had in the original MPEG-TS. |
| `program.transportStreamId` | `1` | Transport stream identifier. |
| `program.programNumber` | `1` | Program number within the stream. |
| `program.pmtPid` | `4096` | PID of the table describing the program (PMT). |
| `si` | PID 17, table 66 | Service information tables preserved verbatim. |

PIDs, PMT and SDT are explained in [mpeg-ts.md](mpeg-ts.md). The PIDs match FFmpeg's output in the source, 256 (`0x100`) for the first video and the next ones in order, the same ones `tsgate.py` uses to recognise each rendition. In `si` the keys are decimal strings: PID 17 (`0x0011`), table id 66 (`0x42`), the Service Description Table, with service and provider names; its content travels in a separate track (`0x0011-0x42.si`) and `interval` is how often (ms) to repeat it. Nothing in this section affects playback.

## Sections this catalog does not carry

**`text`**: subtitles and captions, one rendition per language or variant.

```json
"text": {
  "renditions": {
    "subs-es": { "format": "vtt", "role": "subtitle", "lang": "es", "label": "Español" }
  }
}
```

| Field | Meaning |
| :--- | :--- |
| `format` | Cue format: `vtt` (WebVTT), `ttml` (TTML/IMSC1) or `utf8` (plain text). Other values are ignored. Required. |
| `role` | `subtitle` (dialogue only) or `caption` (all audio, for deaf and hard-of-hearing viewers). Default `subtitle`; unknown values are treated as `subtitle`. |
| `lang` | Language, as a BCP 47 tag: `es`, `en`, `es-419`. |
| `label`, `container`, `jitter`, `delay`, `broadcast` | As in video and audio. |

**`json` and `binary`**: application data that is not media, such as a sports scoreboard, a drone's position or a chat.

```json
"json": {
  "tracks": {
    "scoreboard": { "mode": "snapshot", "schema": "https://example.org/scoreboard.schema.json" }
  }
}
```

| Field | Meaning |
| :--- | :--- |
| `mode` | `snapshot`: each group replaces the previous one and only the latest value matters (a JSON track may follow a group's first frame with merge-patch deltas). `stream`: a lossless log in a single group, where every value matters in order. Required, with no default. |
| `compression` | `deflate` if frames are compressed (raw DEFLATE per group, flushed at each frame); absent if not. |
| `schema` (`json` only) | Identifier of the data shape, typically a JSON Schema URL. Descriptive only. |
| `mime` (`binary` only) | Media type of each payload, e.g. `image/jpeg`. Descriptive only. |
| `bitrate`, `jitter`, `delay`, `broadcast` | As in video and audio. |

The map is `tracks`, not `renditions`: entries are distinct tracks, not alternatives.

## With several renditions

With the three-rendition ladder the importer publishes three video renditions. The full catalog was not captured; the names and bitrates the player saw were:

| Track | Rendition | Nominal bitrate | Catalog `bitrate` (two broadcasts) |
| :--- | :--- | :--- | :--- |
| `0.avc3` | 1080p | 4000 kbit/s | 6950 and 6648 kbit/s |
| `1.avc3` | 720p | 2000 kbit/s | 3393 and 3259 kbit/s |
| `2.avc3` | 360p | 700 kbit/s | 1249 and 1111 kbit/s |

None declared `jitter` or `delay`; audio is the next track in MPEG-TS order. The order is the source's (highest to lowest); the player sorts renditions itself.

## What the player uses, and comparison with the MPD

**What `@moq/watch` uses from this catalog to play video:**

| Field | Purpose |
| :--- | :--- |
| `renditions` key | Name of the track to subscribe to. |
| `codec`, `description`, `optimizeForLatency`, `displayAspect*` | Configure the decoder, and first check that the browser supports it. |
| `container` | Choose how to extract the frame and its timestamp. |
| `codedWidth`, `codedHeight` | Sort renditions and apply resolution limits. |
| `bitrate` | Automatic adaptation. |
| `stalled` | Exclude renditions from automatic adaptation. |
| `framerate`, `jitter`, `delay` | Size the buffer. |
| `display`, `rotation`, `flip` | Paint the canvas. |

It does not use `archive`, `clock` or `mpegts`. The testbed dashboard also reads the selected rendition's `bitrate` to report it (`renditionKbps` in `web/src/components/MoqPlayer.tsx`).

**The two documents side by side:**

| Function | MPD (DASH) | Catalog (MoQ) |
| :--- | :--- | :--- |
| How it is obtained | HTTP request, re-fetched periodically | Subscription to a track; changes are pushed |
| Format | XML | JSON |
| Group of interchangeable versions | `AdaptationSet` | `video` or `audio` section |
| One concrete version | `Representation` | `renditions` entry |
| Codec | `codecs` | `codec` |
| Decoder configuration | Initialisation segment | `description`, or in band |
| Resolution | `width`, `height` | `codedWidth`, `codedHeight` |
| Bitrate | `bandwidth` (here, the nominal value set by the testbed) | `bitrate` (here, a measured maximum) |
| Locating media | `SegmentTemplate`: template, numbering and duration | The track name |
| When each piece exists | `availabilityStartTime`, `availabilityTimeOffset` | Not needed: the relay pushes |
| Common clock | `UTCTiming`, essential | Not needed |
| Media time and wall clock | `availabilityStartTime`, `ProducerReferenceTime` | `clock`, optional |
| Entry points | `startWithSAP`, `Resync` | Implicit: every group starts at one |
| Latency suggested by the service | `ServiceDescription` (empty here) | `jitter` and `delay`, always added by the player |
| Live state of a rendition | Does not exist | `stalled` |
| Past content | `timeShiftBufferDepth` | `archive` |

The size difference reflects the two models: in DASH the client pulls, so the manifest must let it compute what to request and when, with a reliable clock; in MoQ the server pushes, and the catalog only says what exists and how to decode it. In exchange it carries two things the MPD does not: the live state of each rendition and the publisher's own irregularity.
