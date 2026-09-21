/**
 * Rasterizes the plugin's SVG artwork into the PNG sizes Stream Deck requires.
 *
 * Action icons may stay as SVG, but the plugin Icon and CategoryIcon must be
 * PNG, and the CategoryIcon needs a @2x companion. Generated rather than
 * checked in so the artwork has one source of truth.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Resvg } from "@resvg/resvg-js";

const OUT = "com.dswett.audiofuse.sdPlugin/imgs/plugin";

/** The dial mark, drawn on a fixed viewBox and scaled to each target size. */
function logo(size) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 288 288">
<rect width="288" height="288" rx="48" fill="#121215"/>
<circle cx="144" cy="144" r="88" fill="none" stroke="#31c8f0" stroke-width="16"/>
<line x1="144" y1="66" x2="144" y2="112" stroke="#f4f4f5" stroke-width="16" stroke-linecap="round"/>
<circle cx="144" cy="144" r="18" fill="#f4f4f5"/>
</svg>`;
}

async function render(name, size) {
	const resvg = new Resvg(logo(size), { fitTo: { mode: "width", value: size } });
	const png = resvg.render().asPng();
	const file = path.join(OUT, name);
	await writeFile(file, png);
	console.log(`${file} (${size}x${size}, ${png.length} bytes)`);
}

await mkdir(OUT, { recursive: true });
await render("marketplace.png", 288);
await render("marketplace@2x.png", 576);
await render("category-icon.png", 28);
await render("category-icon@2x.png", 56);
