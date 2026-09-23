# Marketplace submission

Everything Maker Console asks for, kept beside the product so a submission can
be reproduced rather than reassembled from memory.

Regenerate the images with:

```bash
npm run marketplace
```

They are drawn by the same `renderKey` and `renderDial` the plugin calls at
runtime, with the labels and tints the actions really use, so the listing
cannot advertise artwork the product does not ship. A screenshot would go stale
the first time a colour changed.

| File | Purpose | Required size |
|---|---|---|
| `app-icon-288.png` | App icon | 288 × 288 PNG |
| `thumbnail.png` | Thumbnail | 1920 × 960 PNG |
| `gallery-1-keys.png` | Gallery 1 of 4 | 1920 × 960 PNG |
| `gallery-2-dials.png` | Gallery 2 of 4 | 1920 × 960 PNG |
| `gallery-3-state.png` | Gallery 3 of 4 | 1920 × 960 PNG |
| `gallery-4-offline.png` | Gallery 4 of 4 | 1920 × 960 PNG |

Elgato requires three gallery items and allows up to ten. Four is the point at
which both halves of the plugin — keys and dials — are shown working, and the
two things a buyer actually wants to know are answered: that the state is real,
and that it is honest when the device is missing.

No video. The guidelines allow one and do not require it, and a 55-second clip
of a mute key lighting up would say less than the stills.

Product file: `dist/com.bad-duck.audiofuse.streamDeckPlugin`, built by
`npm run pack` and attached to every GitHub release by the release workflow.

---

## Name

```
AudioFuse Control
```

17 characters. No maker name, no price wording, no product category, no special
characters — see [product guidelines](https://docs.elgato.com/guidelines/products).

## Description

The first 250 characters are what search engines show, so the opening sentences
carry the requirement and the differentiator rather than a preamble.

```
Control an Arturia AudioFuse from your Stream Deck. Mute, dim, mono, speaker set A/B, reference level and preset recall, each on a key that shows what the device is actually doing rather than the last thing you pressed.

Turn a knob on the unit, or change something in AudioFuse Control Center, and the keys follow. State is read from the device over its own HTTP API and pushed live, so two people looking at the desk and the deck see the same thing.

On a Stream Deck + or + XL the dials drive monitor volume, input gain and output trim, with the reading in dB on the touch strip. The number is pinned to its right edge so the decimal point stays still while you turn, and a muted output turns the readout red rather than hiding it.

Keys dim when the AudioFuse is not reachable — Control Center closed, unit unplugged, or the API refused — rather than looking ready and doing nothing.

No driver, no MIDI mapping, no virtual audio device. It talks to AudioFuse Control Center, which you are already running.

Requires Windows 10 or later or macOS 13 or later, Stream Deck 7.1 or later, an AudioFuse 16Rig or AudioFuse Studio, and AudioFuse Control Center running with its HTTP API reachable. Not affiliated with or endorsed by Arturia.
```

1,196 characters, within the 1,500 limit and above the 250 minimum. The opening
sentence runs to 51 characters, so whatever a search engine truncates, it opens
on a complete statement of what the plugin is.

Character counts are asserted by `tests/marketplace.test.ts`, which also checks
the copy does not name a control the plugin no longer ships.

## Tags

`audio`, `audio interface`, `arturia`, `audiofuse`, `monitor controller`,
`studio`, `music production`, `recording`, `mute`, `dim`, `mono`,
`speaker switching`, `windows`, `macos`

## Identity

These must agree, because the `Author` field is shown in both Stream Deck and
Marketplace, and Elgato's guidelines ask for the organization name.

| Where | Value |
|---|---|
| Plugin UUID | `com.bad-duck.audiofuse` |
| Author | Bad Duck Software |
| URL | https://bad-duck.com |
| Support | https://github.com/danswett/streamdeck-audiofuse/issues |

## Pricing

Free.

## Release notes

### Version 1.0.0 — the notes for this submission

First release, so the notes describe the plugin rather than what changed.

```
Control an Arturia AudioFuse from your Stream Deck.

Mute, dim, mono, speaker set A/B, reference level and preset recall, each on a key that shows what the device is actually doing — turn a knob on the unit and the key follows. On a Stream Deck + the dials drive monitor volume, input gain and output trim, with the reading in dB.

Keys dim when the AudioFuse is not reachable, rather than looking ready and doing nothing.

Needs AudioFuse Control Center running. No driver, no MIDI mapping.
```

491 characters.

---

## Before submitting

- `npm test` — the guideline checks live in `tests/marketplace.test.ts`
- `npm run marketplace` — regenerate, and confirm nothing changed unexpectedly
- `npm run pack` — the product file
- Check the packaged plugin installs and works against a real AudioFuse

### Trademark

*Arturia* and *AudioFuse* are Arturia's trademarks. The listing uses them to say
what the plugin works with, which is nominative use, and says plainly that it is
not affiliated with or endorsed by Arturia. The plugin ships no Arturia artwork:
every glyph is drawn here.
