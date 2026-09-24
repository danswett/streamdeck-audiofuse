/**
 * Elgato's Marketplace guidelines are checked by a human at submission time,
 * and this artwork is generated, so a regression is invisible until a
 * submission is rejected. These assert the rules a generated file can quietly
 * break.
 *
 * The one that matters most here: the category icon and every action icon are
 * drawn inside the Stream Deck app's action list, which must be a monochrome
 * white stroke on a transparent background. Colour and solid backgrounds are
 * both called out as incorrect. The keys on the deck are exempt, and are where
 * this plugin's colour lives.
 *
 * https://docs.elgato.com/guidelines/stream-deck/plugins#icons
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { beforeAll, describe, expect, it } from "vitest";

const PLUGIN_DIR = path.resolve(__dirname, "..", "com.bad-duck.audiofuse.sdPlugin");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8")) as {
	UUID: string;
	Category: string;
	Author: string;
	Icon: string;
	CategoryIcon: string;
	Actions: { UUID: string; Name: string; Icon: string; States: { Image: string }[] }[];
};

/**
 * Resolves a manifest image reference, which omits the extension.
 *
 * Two files with the same base name is not a tie the manifest can break, so an
 * ambiguous reference is a failure rather than a guess.
 */
function resolveImage(ref: string): string {
	const base = path.join(PLUGIN_DIR, ...ref.split("/"));
	const found = [".svg", ".png"].filter((ext) => existsSync(base + ext));

	expect(found, `${ref}: expected exactly one file`).toHaveLength(1);
	return base + found[0];
}

/** Rasterised at the size the action list draws, doubled for high DPI. */
const LIST_RASTER = 40;
/** Below this alpha the pixel is antialiasing fringe, not artwork. */
const INK = 16;

type Raster = { pixels: Uint8Array; width: number; height: number };

/**
 * Cached, because each icon is measured for colour, coverage and corners, and
 * rasterising is native work that pays a one-off initialization on first use.
 * On a cold CI runner that start-up alone can blow vitest's 5s default timeout
 * and fail whichever assertion happens to go first. Warmed in `beforeAll`.
 */
const rasterCache = new Map<string, Raster>();

function rasterise(file: string): Raster {
	const cached = rasterCache.get(file);
	if (cached) return cached;

	const markup =
		path.extname(file) === ".svg"
			? readFileSync(file, "utf8")
			: // resvg only reads SVG, so a PNG is wrapped in one to be measured.
				`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
				`width="${LIST_RASTER}" height="${LIST_RASTER}" ` +
				`viewBox="0 0 ${LIST_RASTER} ${LIST_RASTER}">` +
				`<image width="${LIST_RASTER}" height="${LIST_RASTER}" xlink:href="data:image/png;base64,` +
				`${readFileSync(file).toString("base64")}"/></svg>`;

	const img = new Resvg(markup, { fitTo: { mode: "width", value: LIST_RASTER } }).render();
	const raster = { pixels: img.pixels, width: img.width, height: img.height };

	rasterCache.set(file, raster);
	return raster;
}

/**
 * Every colour the icon actually puts on screen, as `#rrggbb`.
 *
 * Reading the markup is not enough on its own: it cannot see a PNG at all, and
 * an SVG can reach a colour through a gradient rather than a literal. resvg
 * hands back premultiplied alpha, so white at 12% opacity arrives as
 * rgb(31,31,31); dividing the alpha back out is the difference between reading
 * a glyph's antialiasing as a grey ramp and reading it as the one colour it
 * was drawn in.
 */
function renderedColours(file: string): string[] {
	const img = rasterise(file);
	const seen = new Set<string>();

	for (let i = 0; i < img.width * img.height; i++) {
		const a = img.pixels[i * 4 + 3];
		if (a < INK) continue;

		const hex = [0, 1, 2]
			.map((c) => Math.min(255, Math.round((img.pixels[i * 4 + c] * 255) / a)))
			.map((c) => c.toString(16).padStart(2, "0"))
			.join("");
		seen.add(`#${hex}`);
	}
	return [...seen];
}

/** Share of the canvas carrying ink. A solid background reads as ~1. */
function coverage(file: string): number {
	const img = rasterise(file);
	let inked = 0;
	for (let i = 0; i < img.width * img.height; i++) {
		if (img.pixels[i * 4 + 3] >= INK) inked++;
	}
	return inked / (img.width * img.height);
}

const listIcons: [string, string][] = [
	["category", manifest.CategoryIcon],
	...manifest.Actions.map((a): [string, string] => [a.Name, a.Icon])
];

/**
 * Rasterises every icon up front.
 *
 * Generous, because it is paying for native start-up rather than for the work
 * itself; every assertion after it reads a cached raster.
 */
beforeAll(() => {
	for (const [, ref] of listIcons) rasterise(resolveImage(ref));
	for (const action of manifest.Actions) rasterise(resolveImage(action.States[0].Image));
}, 120_000);

describe("action list icons", () => {
	it.each(listIcons)("%s is white, and only white", (_name, ref) => {
		expect(renderedColours(resolveImage(ref))).toEqual(["#ffffff"]);
	});

	it.each(listIcons)("%s is drawn on a transparent background", (_name, ref) => {
		const file = resolveImage(ref);
		const img = rasterise(file);

		for (const [x, y] of [
			[0, 0],
			[img.width - 1, 0],
			[0, img.height - 1],
			[img.width - 1, img.height - 1]
		]) {
			expect(img.pixels[(y * img.width + x) * 4 + 3], `corner ${x},${y} is inked`).toBe(0);
		}

		// A mark that fills the canvas is a tile however clear its corners.
		expect(coverage(file)).toBeLessThan(0.8);
	});

	it.each(listIcons)("%s actually draws something", (_name, ref) => {
		expect(coverage(resolveImage(ref))).toBeGreaterThan(0.01);
	});

	it.each(listIcons)("%s uses SVG, the recommended format", (_name, ref) => {
		expect(resolveImage(ref).endsWith(".svg")).toBe(true);
	});
});

describe("keys", () => {
	// The colour lives here, and the guidelines place no restriction on it. The
	// point of the assertion is that the key artwork is a separate file from the
	// list icon: when they were the same file, making the list compliant would
	// have meant giving up the colour on the deck.
	it.each(manifest.Actions.map((a) => [a.Name, a.Icon, a.States[0].Image] as const))(
		"%s draws its key separately from its list icon",
		(_name, icon, image) => {
			expect(resolveImage(image)).not.toBe(resolveImage(icon));
			expect(renderedColours(resolveImage(image)).length).toBeGreaterThan(1);
		}
	);
});

describe("plugin icon", () => {
	it("is a PNG with a high-DPI variant", () => {
		const file = resolveImage(manifest.Icon);

		expect(file.endsWith(".png")).toBe(true);
		expect(existsSync(file.replace(/\.png$/, "@2x.png"))).toBe(true);
	});

	it("is 256px, doubled for high DPI", () => {
		// Read straight out of the IHDR rather than decoded: the width is bytes
		// 16..19 of any PNG, big-endian.
		const widthOf = (file: string): number => readFileSync(file).readUInt32BE(16);
		const file = resolveImage(manifest.Icon);

		expect(widthOf(file)).toBe(256);
		expect(widthOf(file.replace(/\.png$/, "@2x.png"))).toBe(512);
	});
});

describe("category", () => {
	it("does not include the author name", () => {
		// "include author names in category" is explicitly listed as incorrect.
		expect(manifest.Category.toLowerCase()).not.toContain(manifest.Author.toLowerCase());
	});
});

describe("identity", () => {
	it("uses the organization in the UUID and the Author field", () => {
		// Elgato ask for the organization name in both, and list changing a UUID
		// after publishing as something not to do - so this is only ever right
		// before the first submission.
		expect(manifest.UUID.startsWith("com.bad-duck.")).toBe(true);
		expect(manifest.Author).toBe("Bad Duck Software");

		for (const action of manifest.Actions) {
			expect(action.UUID.startsWith(`${manifest.UUID}.`), action.Name).toBe(true);
		}
	});
});

/**
 * The Marketplace listing: assets and copy.
 *
 * These are checked by a human at submission time and the images are
 * generated, so a regression is invisible until a submission is declined.
 */
describe("the Marketplace listing", () => {
	const MARKET_DIR = path.resolve(__dirname, "..", "marketplace");
	const readme = readFileSync(path.join(MARKET_DIR, "README.md"), "utf8");

	/**
	 * Every fenced block, the heading it sits under, and the first non-empty
	 * line after it - which is where each piece of copy states its own length.
	 */
	function fencedBlocks(): { lang: string; heading: string; text: string; after: string }[] {
		const out: { lang: string; heading: string; text: string; after: string }[] = [];
		const lines = readme.split(/\r?\n/);
		let inFence = false;
		let lang = "";
		let heading = "";
		let buf: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const fence = /^```(\w*)\s*$/.exec(lines[i]!);
			if (fence) {
				if (!inFence) {
					inFence = true;
					lang = fence[1]!;
					buf = [];
				} else {
					const after = lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
					out.push({ lang, heading, text: buf.join("\n"), after: after.trim() });
					inFence = false;
				}
				continue;
			}
			if (inFence) {
				buf.push(lines[i]!);
				continue;
			}
			const title = /^#{2,3}\s+(.*?)\s*$/.exec(lines[i]!);
			if (title) heading = title[1]!;
		}
		return out;
	}

	const plain = fencedBlocks().filter((b) => b.lang === "");

	/**
	 * Copy is found by the heading above it rather than by its own opening
	 * words. This file exists to be rewritten, and a block matched on the text
	 * it starts with stops being found the first time that text changes -
	 * which silently detaches every assertion below from the copy it guards
	 * while the suite stays green.
	 */
	const copyUnder = (section: string): string => plain.find((b) => b.heading === section)?.text ?? "";

	const name = copyUnder("Name");
	const description = copyUnder("Description");

	/** Reads width and height out of a PNG's IHDR, no decoder needed. */
	function pngSize(file: string): { width: number; height: number } {
		const buf = readFileSync(file);
		expect(buf.subarray(1, 4).toString("ascii"), `${file} is not a PNG`).toBe("PNG");
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}

	it("names the product the same way the manifest does", () => {
		expect(name, 'no copy under "## Name"').not.toBe("");
		expect(name).toBe(manifest.Name);
		expect(name.length).toBeLessThanOrEqual(30);
	});

	it("keeps the description within 250 and 1500 characters", () => {
		expect(description, 'no copy under "## Description"').not.toBe("");
		expect(description.length).toBeGreaterThanOrEqual(250);
		expect(description.length).toBeLessThanOrEqual(1500);
	});

	it("names every action the plugin ships", () => {
		// The guidelines ask for features and actions in the description, and
		// the action list is that inventory. Asserted both ways round: copy
		// that stops naming an action fails, and so does an action added later
		// that the listing never mentions.
		for (const action of manifest.Actions) {
			expect(description, `description omits "${action.Name}"`).toContain(action.Name);
		}
	});

	it("says how the plugin reaches the device", () => {
		// The guidelines ask a listing to state its requirements. A plugin that
		// needs a companion app running has to say so, or the first thing a
		// buyer meets is a deck of dimmed keys.
		expect(description).toContain("AudioFuse Control Center");
		expect(description).toMatch(/http api/i);
	});

	it("says what it does in a first sentence short enough to survive truncation", () => {
		// Search engines cut the description at roughly 250 characters, and that
		// cut lands mid-word for any copy longer than that - it cannot be helped.
		// What can be helped is the opening sentence being complete and saying
		// what the product is, well before anything gets cut.
		const first = /^.*?\.\s/.exec(description)?.[0]?.trim() ?? "";
		expect(first, "no sentence ends in the description").not.toBe("");
		expect(first.length).toBeLessThanOrEqual(120);
		expect(first.toLowerCase()).toContain("stream deck");
	});

	it("states a character count that matches the copy it describes", () => {
		// Maker Console enforces a limit against the number, so a stale count is
		// worse than none. Matched on a word boundary rather than to end of
		// line, because the sentence that states a count usually goes on to say
		// what the count means - and anchoring to `$` silently skipped every
		// block that did, leaving the counts unchecked.
		const counted = plain
			.map((b) => ({ block: b, stated: /^([\d,]+) characters\b/.exec(b.after) }))
			.filter((x) => x.stated !== null);

		expect(counted.length, "no block states its own length").toBe(plain.length);

		for (const { block, stated } of counted) {
			const actual = block.text.replace(/\n+$/, "").length;
			expect(actual, `"${block.text.slice(0, 40)}..." is ${actual}`).toBe(
				Number(stated![1]!.replace(/,/g, ""))
			);
		}
	});

	it("ships an app icon, a thumbnail and at least three gallery items", () => {
		expect(pngSize(path.join(MARKET_DIR, "app-icon-288.png"))).toEqual({ width: 288, height: 288 });
		expect(pngSize(path.join(MARKET_DIR, "thumbnail.png"))).toEqual({ width: 1920, height: 960 });

		const gallery = [...new Set([...readme.matchAll(/`(gallery-[\w-]+\.png)`/g)].map((m) => m[1]!))];
		expect(gallery.length, "Elgato require three").toBeGreaterThanOrEqual(3);
		expect(gallery.length, "Elgato allow ten").toBeLessThanOrEqual(10);

		for (const item of gallery) {
			expect(pngSize(path.join(MARKET_DIR, item)), item).toEqual({ width: 1920, height: 960 });
		}
	});

	it("never names a control the plugin does not ship", () => {
		// A feature word in the listing has to correspond to an action.
		const actions = manifest.Actions.map((a) => a.Name.toLowerCase()).join(" ");
		for (const claim of ["talkback", "headphone", "phantom", "loopback", "crossfade"]) {
			if (actions.includes(claim)) continue;
			expect(description.toLowerCase(), `description claims "${claim}"`).not.toContain(claim);
		}
	});

	it("says it is not affiliated with Arturia", () => {
		// The listing uses Arturia's marks to say what the plugin works with,
		// which is nominative use and needs the disclaimer to stay that way.
		expect(description).toMatch(/not affiliated with or endorsed by Arturia/i);
	});
});
