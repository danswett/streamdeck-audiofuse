import { describe, expect, it } from "vitest";

import { asBool, asNumber } from "../src/audiofuse/store";
import { fractionOf, renderDial, renderKey, toKeyImage, toPixmap } from "../src/render";

describe("asBool", () => {
	/**
	 * GET returns real JSON booleans but the SSE stream reports the same fields
	 * as 1 and 0. Without this coercion a toggle latches on after its first
	 * event and never clears.
	 */
	it("accepts the numeric booleans the event stream sends", () => {
		expect(asBool(1)).toBe(true);
		expect(asBool(0)).toBe(false);
	});

	it("accepts the real booleans a GET returns", () => {
		expect(asBool(true)).toBe(true);
		expect(asBool(false)).toBe(false);
	});

	it("treats a missing value as off rather than on", () => {
		expect(asBool(undefined)).toBe(false);
		expect(asBool(null)).toBe(false);
	});
});

describe("asNumber", () => {
	it("passes through device floats", () => {
		expect(asNumber(-24.296875)).toBe(-24.296875);
		expect(asNumber(0)).toBe(0);
	});

	/**
	 * GET /monitoring returns `"volume": false` for its float children, a
	 * server bug that would otherwise render as 0 dB - full scale on the bar.
	 */
	it("rejects the bogus boolean the parent endpoint returns for floats", () => {
		expect(asNumber(false)).toBeUndefined();
		expect(asNumber(true)).toBeUndefined();
	});

	it("rejects values that are not numbers", () => {
		expect(asNumber(undefined)).toBeUndefined();
		expect(asNumber("nonsense")).toBeUndefined();
	});
});

describe("fractionOf", () => {
	it("maps a value onto its range", () => {
		expect(fractionOf(-90, -90, 0)).toBe(0);
		expect(fractionOf(0, -90, 0)).toBe(1);
		expect(fractionOf(-45, -90, 0)).toBeCloseTo(0.5);
	});

	it("clamps outside the range", () => {
		expect(fractionOf(-200, -90, 0)).toBe(0);
		expect(fractionOf(50, -90, 0)).toBe(1);
	});
});

describe("rendering", () => {
	it("produces a data URI the layout can display", () => {
		const uri = toPixmap(renderDial({ label: "Monitor", value: "-24.3 dB", fraction: 0.7 }));
		expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
	});

	/**
	 * setImage needs an encoded data URI, not raw markup. These drawings carry
	 * hex colours, and an unencoded `#` starts a URI fragment - so a raw SVG is
	 * truncated at its first fill. Stream Deck reports success and quietly
	 * leaves the manifest icon in place, so the only symptom is a key that
	 * never changes.
	 */
	it("percent-encodes a key image so hex colours survive", () => {
		const uri = toKeyImage(renderKey({ label: "MUTE", active: true, tint: "#ff4f4f" }));
		expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
		expect(uri).not.toContain("#");
		expect(uri).toContain("%23");
	});

	it("round-trips a key image back to the original markup", () => {
		const svg = renderKey({ label: "DIM", active: false });
		const decoded = decodeURIComponent(toKeyImage(svg).slice("data:image/svg+xml,".length));
		expect(decoded).toBe(svg);
	});

	it("draws the label and value onto the panel", () => {
		const svg = renderDial({ label: "Monitor", value: "-24.3 dB", fraction: 0.7 });
		expect(svg).toContain("MONITOR");
		expect(svg).toContain("-24.3 dB");
	});

	it("omits the bar for parameters that have no range", () => {
		expect(renderDial({ label: "Preset", value: "2" })).not.toContain('y="74"');
	});

	// Preset names are user-supplied and land in an SVG document, so anything
	// that could close a tag has to be escaped rather than interpolated.
	it("escapes markup in user-supplied text", () => {
		const svg = renderKey({ label: "1", value: '</text><script>x</script>', active: true });
		expect(svg).not.toContain("<script>");
		expect(svg).toContain("&lt;/text&gt;");
	});

	it("escapes markup on the dial panel too", () => {
		const svg = renderDial({ label: "<bad>", value: "&", fraction: 0 });
		expect(svg).not.toContain("<bad>");
		expect(svg).toContain("&amp;");
	});
});
