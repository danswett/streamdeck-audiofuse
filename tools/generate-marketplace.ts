/**
 * Renders the images Marketplace requires for a submission.
 *
 * Elgato asks for an app icon at 288x288, a thumbnail at 1920x960, and at
 * least three gallery items at 1920x960, all PNG. Everything here is drawn by
 * the same `renderKey` and `renderDial` the plugin calls at runtime, with the
 * labels and tints the actions really use, so the listing cannot advertise
 * artwork the product does not ship - a screenshot would go stale the first
 * time a colour changed.
 *
 * Run with: npm run marketplace
 * https://docs.elgato.com/guidelines/products
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import { renderDial, renderKey } from "../src/render.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Committed rather than written to dist/: these are submission deliverables
// that get reviewed and reused, not build output.
const OUT = path.join(ROOT, "marketplace");

const W = 1920;
const H = 960;
const BG = "#141416";
const TEXT = "#F2F2F2";
const MUTED = "#9A9AA2";
const FONT = "Segoe UI, Segoe UI Variable, sans-serif";

/** Tints the actions really use. Wrong here would be wrong in the listing. */
const RED = "#ff4f4f";
const AMBER = "#ffb347";
const CYAN = "#31c8f0";
const GREEN = "#7ee081";
const PURPLE = "#c08bff";

/** Strips the wrapper so a key or panel can be nested in a larger document. */
function inner(svg: string): string {
	return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
}

/** One Stream Deck key: a rounded black tile with the artwork on it. */
function key(x: number, y: number, size: number, svg: string, caption?: string): string {
	const scale = size / 144;
	const label = caption
		? `<text x="${x + size / 2}" y="${y + size + 38}" text-anchor="middle" ` +
			`font-family="${FONT}" font-size="26" fill="${MUTED}">${caption}</text>`
		: "";

	return (
		`<g transform="translate(${x} ${y}) scale(${scale})">${inner(svg)}</g>${label}`
	);
}

/** One touch-strip panel, which is 200x100 on the device. */
function panel(x: number, y: number, scale: number, svg: string, caption?: string): string {
	const label = caption
		? `<text x="${x + (200 * scale) / 2}" y="${y + 100 * scale + 38}" text-anchor="middle" ` +
			`font-family="${FONT}" font-size="26" fill="${MUTED}">${caption}</text>`
		: "";

	return `<g transform="translate(${x} ${y}) scale(${scale})">${inner(svg)}</g>${label}`;
}

function frame(body: string): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
		`<rect width="${W}" height="${H}" fill="${BG}"/>${body}</svg>`
	);
}

function title(text: string, sub?: string): string {
	const subtitle = sub
		? `<text x="${W / 2}" y="300" text-anchor="middle" font-family="${FONT}" ` +
			`font-size="40" fill="${MUTED}">${sub}</text>`
		: "";

	return (
		`<text x="${W / 2}" y="${sub ? 220 : 180}" text-anchor="middle" font-family="${FONT}" ` +
		`font-size="${sub ? 84 : 64}" font-weight="600" fill="${TEXT}">${text}</text>${subtitle}`
	);
}

function footer(text: string): string {
	return (
		`<text x="${W / 2}" y="${H - 80}" text-anchor="middle" font-family="${FONT}" ` +
		`font-size="30" fill="${MUTED}">${text}</text>`
	);
}

/** Lays a row out centred, so adding or removing one keeps it balanced. */
function row(count: number, size: number, gap: number): number[] {
	const total = count * size + (count - 1) * gap;
	const start = (W - total) / 2;
	return Array.from({ length: count }, (_, i) => start + i * (size + gap));
}

/**
 * Centres items of differing widths.
 *
 * A key is square and a touch-strip panel is 2:1, so laying them out as if
 * they were the same width pushes the whole group off centre - which is
 * exactly what the first cut of the state gallery did.
 */
function centre(widths: number[], gap: number): number[] {
	const total = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * gap;
	let x = (W - total) / 2;
	return widths.map((w) => {
		const at = x;
		x += w + gap;
		return at;
	});
}

function write(name: string, svg: string, width: number): void {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
	mkdirSync(OUT, { recursive: true });
	writeFileSync(path.join(OUT, name), png);
	console.log(`  marketplace/${name} (${width}px, ${(png.length / 1024).toFixed(0)} KB)`);
}

console.log("Generating Marketplace media...");

/*
	App icon. The same dial mark tools/build-icons.mjs puts in the plugin icon,
	drawn from the same numbers - the store and the preferences pane showing
	different products is the failure this avoids.
*/
const appIcon =
	`<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="0 0 288 288">` +
	`<rect width="288" height="288" rx="48" fill="#121215"/>` +
	`<circle cx="144" cy="144" r="88" fill="none" stroke="${CYAN}" stroke-width="16"/>` +
	`<line x1="144" y1="66" x2="144" y2="112" stroke="#f4f4f5" stroke-width="16" stroke-linecap="round"/>` +
	`<circle cx="144" cy="144" r="18" fill="#f4f4f5"/></svg>`;

write("app-icon-288.png", appIcon, 288);

/*
	Thumbnail. The six monitor keys in the states a working desk actually shows:
	muted and dimmed engaged, the rest idle.
*/
{
	const size = 150;
	const xs = row(6, size, 44);
	const y = 430;
	const keys = [
		renderKey({ label: "MUTE", active: true, tint: RED }),
		renderKey({ label: "DIM", active: true, tint: AMBER }),
		renderKey({ label: "MONO", active: false, tint: AMBER }),
		renderKey({ label: "A", value: "SPEAKERS", active: false, tint: CYAN }),
		renderKey({ label: "REF", value: "-20 dB", active: false, tint: GREEN }),
		renderKey({ label: "1", value: "PRESET", active: false, tint: PURPLE })
	];

	write(
		"thumbnail.png",
		frame(
			title("AudioFuse Control", "Monitor controls for the Arturia AudioFuse, with live state") +
				keys.map((k, i) => key(xs[i]!, y, size, k)).join("") +
				footer("Reads the device, not the last thing you pressed")
		),
		W
	);
}

/*
	Gallery 1. Every key, captioned, so a reader can see what they get before
	installing rather than after.
*/
{
	const size = 140;
	const xs = row(6, size, 56);
	const y = 420;
	const keys: [string, string][] = [
		[renderKey({ label: "MUTE", active: true, tint: RED }), "Mute"],
		[renderKey({ label: "DIM", active: true, tint: AMBER }), "Dim"],
		[renderKey({ label: "MONO", active: true, tint: AMBER }), "Mono"],
		[renderKey({ label: "B", value: "SPEAKERS", active: true, tint: CYAN }), "Speaker set"],
		[renderKey({ label: "REF", value: "-20 dB", active: true, tint: GREEN }), "Reference level"],
		[renderKey({ label: "3", value: "PRESET", active: true, tint: PURPLE }), "Preset recall"]
	];

	write(
		"gallery-1-keys.png",
		frame(
			title("Six keys for the monitor section") +
				keys.map(([svg, caption], i) => key(xs[i]!, y, size, svg, caption)).join("") +
				footer("Engaged keys light in the colour of the control"),
		),
		W
	);
}

/*
	Gallery 2. The dials, which are the half of this plugin that a screenshot of
	keys cannot show.
*/
{
	const scale = 2.6;
	const width = 200 * scale;
	const gap = 80;
	const total = 3 * width + 2 * gap;
	const start = (W - total) / 2;
	const y = 400;
	const panels: [string, string][] = [
		[renderDial({ label: "Monitor", value: "-24.3", unit: "dB", fraction: 0.62 }), "Monitor volume"],
		[renderDial({ label: "In 1", value: "+18.0", unit: "dB", fraction: 0.35 }), "Input gain"],
		[renderDial({ label: "Out 3", value: "-6.0", unit: "dB", fraction: 0.78 }), "Output trim"]
	];

	write(
		"gallery-2-dials.png",
		frame(
			title("Dials read the device in dB") +
				panels
					.map(([svg, caption], i) => panel(start + i * (width + gap), y, scale, svg, caption))
					.join("") +
				footer("The number is pinned to its right edge, so the decimal point never moves")
		),
		W
	);
}

/*
	Gallery 3. State, which is the point of the plugin: the keys follow the
	AudioFuse whether the change came from here, Control Center, or the unit.
*/
{
	const size = 150;
	const xs = row(3, size, 110);
	const y = 320;
	const keys: [string, string][] = [
		[renderKey({ label: "MUTE", active: false, tint: RED }), "Not muted"],
		[renderKey({ label: "MUTE", active: true, tint: RED }), "Muted"],
		[renderKey({ label: "MUTE", active: false, offline: true, tint: RED }), "No device"]
	];

	// The dial on its own row, centred on its own width. A panel is 2:1 and a
	// key is square, so sharing a row with them needs the widths, not a count.
	const dialScale = 1.8;
	const dialX = (W - 200 * dialScale) / 2;
	// Far enough down to clear the key captions, far enough up that its own
	// caption clears the footer - the first cut had them overlapping.
	const dialY = y + size + 100;

	write(
		"gallery-3-state.png",
		frame(
			title("Every key shows the real state") +
				keys.map(([svg, caption], i) => key(xs[i]!, y, size, svg, caption)).join("") +
				panel(
					dialX,
					dialY,
					dialScale,
					renderDial({ label: "Monitor", value: "-24.3", unit: "dB", fraction: 0.62, muted: true }),
					"Muted shows on the dial too"
				) +
				footer("Turn a knob on the unit and the key follows, because it is read not remembered")
		),
		W
	);
}

/*
	Gallery 4. Offline, because a plugin that dims rather than lying about a
	device it cannot reach is worth saying out loud. "No API" is the text the
	dial really shows while it is looking for Control Center.
*/
{
	const size = 150;
	const dialScale = 1.8;
	const dialW = 200 * dialScale;
	const xs = centre([size, size, size, dialW], 90);
	const y = 430;

	write(
		"gallery-4-offline.png",
		frame(
			title("Dimmed when the AudioFuse is not there", "Rather than a key that looks ready and does nothing") +
				key(xs[0]!, y, size, renderKey({ label: "MUTE", active: false, offline: true, tint: RED }), "Mute") +
				key(xs[1]!, y, size, renderKey({ label: "DIM", active: false, offline: true, tint: AMBER }), "Dim") +
				key(xs[2]!, y, size, renderKey({ label: "MONO", active: false, offline: true, tint: AMBER }), "Mono") +
				panel(
					xs[3]!,
					y + (size - 100 * dialScale) / 2,
					dialScale,
					renderDial({ label: "Monitor", value: "No API", offline: true }),
					"Looking for Control Center"
				) +
				footer("Control Center closed, unit unplugged, or the API unreachable")
		),
		W
	);
}

console.log("Done.");
