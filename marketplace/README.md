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

A video is separate, and not optional for this product: Elgato require one
before approving anything that depends on hardware, and it goes to
maker@elgato.com by email rather than being uploaded with the listing. See
[what is reviewed](https://docs.elgato.com/maker-console/review-process#what-is-reviewed).

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
carry the requirement and the differentiator rather than a preamble. After that
the copy works through what the product does, what is included, and how it
works, in that order, under headings a reader can skim.

```
AudioFuse Control turns a Stream Deck into a monitor controller for the Arturia AudioFuse 16Rig and Studio. Mute, dim, mono, speaker A/B, reference level and preset recall each get a key, and Stream Deck + dials drive monitor volume, input gain and output trim in dB.

Seven actions, six of them keys that work on any Stream Deck:
- Mute: mutes the main monitor output, red while muted.
- Dim: drops the monitors by the device's dim amount.
- Mono: folds the monitors to mono for a mix check.
- Speaker Set A/B: switches speaker sets, showing which is live.
- Reference Level: snaps the monitor to your calibrated level, and lights while it sits there.
- Preset Recall: recalls any of the eight slots by its stored name. 16Rig only.
- AudioFuse Dial: on a Stream Deck + encoder, drives one parameter — monitor volume, reference level, input gain 1-16, output trim 3-10, preset slot or sample rate — showing its name, the live dB reading and a range-scaled bar. Push to mute, jump to reference or reset.

How it works: the plugin finds AudioFuse Control Center's local HTTP API automatically and reads state back from the hardware, so turning a knob on the unit or changing something in Control Center moves the keys too. Keys dim when the AudioFuse is unreachable. No driver, MIDI mapping or virtual audio device.

Requires an AudioFuse 16Rig or Studio, and AudioFuse Control Center running with Preferences > Http Api > Server set to On. Not affiliated with or endorsed by Arturia.
```

1,482 characters, within the 1,500 limit and above the 250 minimum. The opening
sentence runs to 107 characters, so whatever a search engine truncates, it
opens on a complete statement of what the plugin is, and the first 250
characters stay unformatted as the guidelines ask.

Naming every action is deliberate: the action list is the product's inventory,
and a reviewer cannot confirm that a listing matches a plugin from prose that
gestures at "keys". It also puts each action's name where Marketplace search
can index it.

The operating systems and the Stream Deck version are omitted here because
Maker Console takes them from the manifest and shows them beside the
description. Repeating them spends characters on something already on screen —
the AudioFuse and Control Center requirements are not, so they stay.

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
