/**
 * Draws every piece of the plugin's artwork from one source.
 *
 * There are two audiences here and they have different rules.
 *
 * The keys on the deck may be any colour, and the tints below are the ones the
 * runtime paints when a control is engaged, so a key looks like itself before
 * the device has answered as well as after.
 *
 * The action list inside the Stream Deck app may not. Elgato require the
 * category icon and every action icon to be a monochrome white stroke on a
 * transparent background, and call out both colour and solid backgrounds as
 * incorrect. So each glyph is emitted twice: white for the list, tinted for
 * the key.
 *
 * https://docs.elgato.com/guidelines/stream-deck/plugins#icons
 *
 * Run with: node tools/build-icons.mjs
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Resvg } from "@resvg/resvg-js";

const PLUGIN = "com.dswett.audiofuse.sdPlugin";
const ACTIONS = path.join(PLUGIN, "imgs", "actions");
const PLUGIN_IMGS = path.join(PLUGIN, "imgs", "plugin");

/** Key canvas. The glyphs are drawn on it and scaled down for the list. */
const SIZE = 72;

const INK = "#f4f4f5";
const WHITE = "#ffffff";

/**
 * The glyphs, each drawn from two colours: `accent` carries the identity of
 * the control, `ink` the neutral parts. The list icon passes white for both,
 * which is the whole reason they are parameters rather than literals.
 */
const GLYPHS = {
	dial: {
		accent: "#31c8f0",
		body: (accent, ink) =>
			`<circle cx="36" cy="36" r="24" fill="none" stroke="${accent}" stroke-width="5"/>` +
			`<line x1="36" y1="16" x2="36" y2="30" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>` +
			`<circle cx="36" cy="36" r="5" fill="${ink}"/>`
	},
	mute: {
		accent: "#ff4f4f",
		body: (accent) =>
			`<path d="M20 28 h10 l12 -10 v36 l-12 -10 h-10 z" fill="none" stroke="${accent}" stroke-width="5" stroke-linejoin="round"/>` +
			`<line x1="48" y1="26" x2="62" y2="46" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>` +
			`<line x1="62" y1="26" x2="48" y2="46" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>`
	},
	dim: {
		accent: "#ffb347",
		body: (accent) =>
			`<path d="M20 28 h10 l12 -10 v36 l-12 -10 h-10 z" fill="none" stroke="${accent}" stroke-width="5" stroke-linejoin="round"/>` +
			`<path d="M50 30 a10 10 0 0 1 0 12" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>`
	},
	mono: {
		accent: "#ffb347",
		body: (accent) =>
			`<circle cx="36" cy="36" r="20" fill="none" stroke="${accent}" stroke-width="5"/>` +
			`<circle cx="36" cy="36" r="6" fill="${accent}"/>`
	},
	speakers: {
		accent: "#31c8f0",
		body: (accent) =>
			`<rect x="10" y="18" width="22" height="36" rx="4" fill="none" stroke="${accent}" stroke-width="5"/>` +
			`<rect x="40" y="18" width="22" height="36" rx="4" fill="${accent}"/>`
	},
	reference: {
		accent: "#7ee081",
		body: (accent) =>
			`<path d="M14 46 L30 46 L36 22 L42 58 L48 46 L58 46" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`
	},
	preset: {
		accent: "#c08bff",
		body: (accent) =>
			`<rect x="14" y="14" width="44" height="44" rx="7" fill="none" stroke="${accent}" stroke-width="5"/>` +
			`<line x1="14" y1="30" x2="58" y2="30" stroke="${accent}" stroke-width="5"/>` +
			`<circle cx="24" cy="44" r="4" fill="${accent}"/>` +
			`<circle cx="38" cy="44" r="4" fill="${accent}"/>`
	}
};

/** The dial mark, shared by the category icon and the plugin icon. */
function mark(accent, ink) {
	return (
		`<circle cx="144" cy="144" r="88" fill="none" stroke="${accent}" stroke-width="16"/>` +
		`<line x1="144" y1="66" x2="144" y2="112" stroke="${ink}" stroke-width="16" stroke-linecap="round"/>` +
		`<circle cx="144" cy="144" r="18" fill="${ink}"/>`
	);
}

function svg(size, viewBox, body) {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
		`viewBox="0 0 ${viewBox} ${viewBox}">${body}</svg>`
	);
}

async function writeSvg(file, contents) {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${contents}\n`, "utf8");
	console.log(`  ${file}`);
}

async function writePng(file, markup, size) {
	const png = new Resvg(markup, { fitTo: { mode: "width", value: size } }).render().asPng();
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, png);
	console.log(`  ${file} (${size}px)`);
}

console.log("Generating icons...");

for (const [name, { accent, body }] of Object.entries(GLYPHS)) {
	const dir = path.join(ACTIONS, name);

	// White on transparent for the action list, tinted for the key.
	await writeSvg(path.join(dir, "icon.svg"), svg(SIZE, SIZE, body(WHITE, WHITE)));
	await writeSvg(path.join(dir, "key.svg"), svg(SIZE, SIZE, body(accent, INK)));

	// The flat file this folder replaced. The manifest names images without an
	// extension, so anything left beside the one meant to win is ambiguous.
	await rm(path.join(ACTIONS, `${name}.svg`), { force: true });
}

// The category icon follows the same rule as the actions, so the mark loses
// its tile and its colour here. SVG rather than PNG: it is the format Elgato
// recommend, and it makes the separate high-DPI file a raster would need
// unnecessary.
await writeSvg(path.join(PLUGIN_IMGS, "category-icon.svg"), svg(28, 288, mark(WHITE, WHITE)));
for (const stale of ["category-icon.png", "category-icon@2x.png"]) {
	await rm(path.join(PLUGIN_IMGS, stale), { force: true });
}

// The plugin icon is the exception, and the guidelines allow it: this one
// appears in Stream Deck's preferences pane and on Marketplace, where it is the
// product's mark rather than a list glyph. It must be PNG, at 256px and 512px.
const logo =
	`<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="0 0 288 288">` +
	`<rect width="288" height="288" rx="48" fill="#121215"/>${mark("#31c8f0", INK)}</svg>`;

await writePng(path.join(PLUGIN_IMGS, "marketplace.png"), logo, 256);
await writePng(path.join(PLUGIN_IMGS, "marketplace@2x.png"), logo, 512);

console.log("Done.");
