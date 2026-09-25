# AudioFuse Control for Stream Deck

Drives an Arturia AudioFuse 16Rig or Studio from a Stream Deck, over the HTTP
API that AudioFuse Control Center exposes.

Built for the Stream Deck + XL, and works on any deck: dials get the LCD panels,
keys work everywhere.

## Actions

| Action | Controller | What it does |
| --- | --- | --- |
| **AudioFuse Dial** | Encoder | Drives any one parameter — monitor volume, reference level, input gain 1–16, output trim 3–10, preset slot, sample rate. The LCD shows the name, the live value in dB, and a bar scaled to that parameter's real range. Push or tap to mute, jump to reference, or reset. |
| **Mute** | Key | Mutes the main monitor output. Red while muted. |
| **Dim** | Key | Drops the monitors by the device's dim amount. |
| **Mono** | Key | Folds the monitor output to mono, for a mix check. |
| **Speaker Set A/B** | Key | Switches between speaker sets, showing which is live. |
| **Reference Level** | Key | Snaps the monitor to the calibrated reference level, and lights whenever the monitor is sitting at it. |
| **Preset Recall** | Key | Recalls one of the eight slots, showing its stored name. Marks the loaded slot with `*` when the device has unsaved edits. 16Rig only. |

Only Preset Recall needs configuring — pick which slot. The rest do what their
name says as soon as you drop them on a key.

Every key and dial reflects the device rather than the last thing the plugin
sent, so changes made in Control Center or on the unit itself show up too.

## Building

```bash
npm install
npm run build          # draws the icons, then bundles with rollup
npm run validate       # checks the plugin against Elgato's schema
npm test               # unit tests
npm run watch          # rebuild and restart the plugin on change
```

To install a development build:

```bash
npx streamdeck dev
npx streamdeck link com.bad-duck.audiofuse.sdPlugin
```

A newly linked plugin is only picked up when the Stream Deck app next scans, so
restart Stream Deck after the first link.

### Live tests

`tests/live.test.ts` runs against real hardware and is skipped unless asked for:

```bash
$env:FUSE_LIVE = "1"; npx vitest run tests/live.test.ts
```

It captures the monitor volume first and restores it afterwards, asserting the
restore. It does move the monitor volume while running.

### Artwork

`tools/build-icons.mjs` draws everything from one source, because the list and
the deck follow different rules. Elgato require the category icon and every
action icon — the ones inside the Stream Deck app's
[action list](https://docs.elgato.com/guidelines/stream-deck/plugins#icons) — to
be a monochrome white stroke on a transparent background, and call out colour
and solid backgrounds as incorrect. Keys have no such restriction, and are where
this plugin's colour lives.

So each glyph is emitted twice: `imgs/actions/<name>/icon.svg` in white for the
list, `key.svg` in the control's tint for the deck. `tests/marketplace.test.ts`
rasterises every list icon and fails on any colour but white, on a solid
background, or on an icon that draws nothing — pixels rather than markup, so a
PNG cannot slip past by having no fills to read.

## Notes on the AudioFuse HTTP API

Everything below was measured against **API 1.0.0** on an **AudioFuse 16Rig**,
because the shipped documentation is wrong or silent on each point. The code
depends on all of it.

### Writes go to the parent endpoint, not the leaf

The documented leaf form returns **404**:

```http
PUT /api/v1/monitoring/volume     {"volume": -30}   → 404
PUT /api/v1/monitoring            {"volume": -30}   → 200 OK
```

The same applies throughout: write `gain` to `/input/analog/1`, not to
`/input/analog/1/gain`. Reads work on leaves normally. `splitEndpoint()` in
`src/audiofuse/params.ts` does this mapping and `FuseClient.write` applies it.

### Out-of-range values are clamped, never rejected

The docs say an out-of-range value yields `400 Invalid Value`. It does not — the
server accepts it, clamps it, and returns `200 OK`. A successful write is
therefore not evidence of the value that landed, and anything displaying a value
has to read it back.

Measured ranges:

| Endpoint | Min | Max |
| --- | --- | --- |
| `/monitoring/volume` | −90.0 dB | 0.0 dB |
| `/output/analog/:i/volume` | −60.0 dB | 0.0 dB |
| `/input/analog/:i/gain` (line source) | 0 dB | 12 dB |

Input gain depends on the channel's source, so the registry allows a wider span
and lets the device trim it.

### Booleans arrive as `1` and `0` over SSE

`GET` returns real JSON booleans. The event stream reports the same fields as
integers:

```text
event: update
data: {"id": 7, "payload": [{"key":"/monitoring/dim","value":0}]}
```

The documented example shows `"value": true`. Anything reading state has to
coerce, or toggles latch on after their first event. That is `asBool()`.

The payload also carries an `id` field that the documentation does not mention.

### `/input` and `/output` never push events

Only `/monitoring`, `/clock` and `/preset` emit SSE. Subscribing to
`/input/analog/1/gain` is accepted and silently produces nothing — the endpoint
reference hints at this by omitting the SSE column from the input and output
tables, but never says so. Those endpoints are polled instead, one per tick,
and only while something is displaying them.

### Recalling a preset rewrites unrelated state

`PUT /preset {"slot": 2}` emitted a coalesced payload of `/preset/slot` and
`/preset/name` — and separately changed `/monitoring/mute`. A recall restores
the whole device state, and most of what it changes is not pushed. The store
re-reads everything on screen whenever the slot changes.

Recalling also discards unsaved edits, which is worth knowing before binding a
slot to a key.

### The rate limit is real and enforced by the firmware

Writes sent back to back return **429**. The documented floor is 200 ms between
writes. `FuseClient` serializes every request through one adaptive queue that
widens on each 429 and narrows again on success, and collapses a burst on a
single endpoint down to its newest value — a dial detent fires far faster than
the device will accept.

### Echoes arrive behind the control that caused them

Every write is echoed back over SSE. Because writes are paced to the rate limit
while detents keep arriving, that echo describes a position the dial has already
left, so applying it drags the reading backwards until the next local change
snaps it forward — visible as the LCD text jittering while you turn.

`LocalHold` fixes this: writing an endpoint claims it for 700 ms, during which
echoes for it are dropped and the local value drives the display. Each change
renews the claim, so it only lapses once the control settles.

Dropping echoes also drops any genuine change made elsewhere in that window, and
for a pushed endpoint nothing further would arrive to correct it. So every write
also schedules a read 900 ms later — after the hold lapses — which reconciles
the display with the device and picks up any clamping it applied.

Panels are repainted at most every 60 ms, on the leading edge with a guaranteed
trailing frame, and the reading's right edge is pinned so gaining a digit grows
the number leftwards instead of sliding the whole string sideways.

### `setImage` needs an encoded data URI, not raw SVG markup

Not an API quirk, a Stream Deck one, but it cost an afternoon. The SDK
documents `setImage` as accepting "an SVG string", and passing one resolves
successfully — but the key never changes. These drawings carry hex colours, and
an unencoded `#` begins the fragment of a data URI, so the image is truncated at
the first `fill`. Stream Deck then quietly leaves the manifest icon in place.

The failure reports success at every layer, so the only visible symptom is a key
that renders its static icon forever. `toKeyImage()` percent-encodes; `toPixmap()`
uses base64 for the encoder layouts, which accept nothing else.

### Option lists differ from the documented shape

```http
GET /clock/sample_rate_options
→ {"sample_rate_options": {"keys": ["44100", ...], "labels": ["44.1 kHz", ...]}}
```

The keys are **strings** even though `/clock/sample_rate` reads and writes an
**integer**, and the companion array is `labels`, not `values` as documented.
The 16Rig reported clock sources `internal`, `adat`, `word` — not the
`word_clock` / `spdif` shown in the docs. Read these at runtime; do not
hard-code them.

### `GET /monitoring` reports `false` for its float children

The parent endpoint returns `"volume": false` and `"reference_level": false`
rather than the actual dB values, while the leaf endpoints return them
correctly. Read floats from the leaf. `asNumber()` rejects booleans so a bad
parent read cannot render as 0 dB, which is full scale.

### `GET /update/endpoints` is missing

Documented as returning the active subscription set; returns **404** on this
build. There is no way to read back what you are subscribed to, so the plugin
re-posts its full list every 35 seconds against the ~50 second expiry.

### The API is off after every reboot, and only Control Center can turn it on

The agent that hosts the API, `AudioFuseControlCenterAgent.exe`, is started at
logon by a shortcut the installer puts in the common Startup folder. It loads
the API's own `server.dll` and `httpfuse.dll` — and then never starts the
server. A machine that has just booted has an agent running and nothing
listening, which is the `No API` state.

Whether the server runs is recorded in the agent's
`C:\ProgramData\Arturia\AudioFuse Control Center\resources\httpapi\config.json`:

```json
{ "enabled": false, "port": 60465 }
```

The agent writes `enabled: false` there as it shuts down, so every session
starts with the flag off. The flag cannot be set back on disk either: an agent
that finds it already `true` at startup exits within a couple of seconds and
rewrites it to `false`. Nor does the agent watch the file — flipping it under a
running agent does nothing at all. The user's actual preference lives somewhere
else entirely, as `EnableHttpApi` in `resources\tmp\af.pref.xml`, and only
Control Center reads it.

Control Center is the only thing that turns the server on. It signals the agent
that is already running rather than starting its own — the agent keeps the same
pid across a launch — and the server then stays up inside the agent after the
window closes. Hence the folklore fix of opening Control Center once after a
reboot and closing it again.

`ControlCenterArmer` in `src/audiofuse/arm.ts` does that launch instead of the
user. After three empty searches — grace for a machine still finishing logon, or
for someone opening Control Center themselves — it starts Control Center, hides
the window as soon as it appears, waits for `/version` to answer, then closes it
and leaves the agent serving. Two details matter:

- Hiding a window zeroes `Process.MainWindowHandle`, so the handle is captured
  before hiding; otherwise there is no way to close the window afterwards.
- The API is armed a second or two after launch, well before Control Center has
  finished starting, and a `WM_CLOSE` sent that early is silently dropped —
  leaving the window on screen until it is killed. `WaitForInputIdle` first,
  then close.

Windows only. macOS is not known to need it, and the window handling has no
equivalent there.

### Discovery does not work on Windows

The documentation says to find the port over DNS-SD (`_audiofusehttp._tcp.`).
On Windows, Control Center advertises nothing: browsing mDNS on this machine
returned 111 services from other responders and no Arturia record, while the
API was serving normally on 127.0.0.1:60465. Apple's Bonjour service is also
not present on a typical Windows install.

So the plugin finds the port by asking the OS which loopback ports are being
listened on and asking each one whether it answers `/version`. That is slower
than a service record but self-validating — a port is only accepted once it
identifies itself as the AudioFuse API — and it works whether or not anything
is advertised. The working port is remembered, so later launches confirm it on
the first probe instead of scanning.

If that ever fails, the port is shown in Control Center under
**Preferences → Http Api** and can be pinned in any AudioFuse Dial's property
inspector, under *Connection*.

## Prerequisites

- AudioFuse Control Center installed, with its agent running.
- **Preferences → Http Api → Server: On.** Off by default; nothing works without it.
  The agent also leaves the server off after every reboot, so on Windows the
  plugin runs Control Center itself to turn it back on — see
  [the API is off after every reboot](#the-api-is-off-after-every-reboot-and-only-control-center-can-turn-it-on).
- An AudioFuse 16Rig or Studio connected. Other models are refused by the API.
