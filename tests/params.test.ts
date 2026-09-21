import { describe, expect, it } from "vitest";

import {
	DIAL_TARGETS,
	MONITOR_VOLUME,
	SSE_ENDPOINTS,
	clampToRange,
	formatParts,
	formatValue,
	paramById,
	splitEndpoint
} from "../src/audiofuse/params";

describe("splitEndpoint", () => {
	/**
	 * Writes must target the parent. The documented leaf form
	 * `PUT /monitoring/volume {"volume":n}` answers 404 on firmware 1.0.0;
	 * `PUT /monitoring {"volume":n}` is what actually applies.
	 */
	it("splits a monitoring leaf into its parent and field", () => {
		expect(splitEndpoint("/monitoring/volume")).toEqual({ parent: "/monitoring", field: "volume" });
	});

	it("splits an indexed channel leaf", () => {
		expect(splitEndpoint("/input/analog/1/gain")).toEqual({ parent: "/input/analog/1", field: "gain" });
		expect(splitEndpoint("/output/analog/3/volume")).toEqual({ parent: "/output/analog/3", field: "volume" });
	});

	it("keeps the numeric index on the parent, not the field", () => {
		const { parent, field } = splitEndpoint("/input/analog/16/gain");
		expect(parent).toBe("/input/analog/16");
		expect(field).toBe("gain");
	});
});

describe("clampToRange", () => {
	// The server clamps silently rather than rejecting, so the plugin has to
	// clamp identically or its optimistic display drifts from the device.
	it("clamps the monitor volume to the measured -90..0 dB span", () => {
		expect(clampToRange(-200, MONITOR_VOLUME)).toBe(-90);
		expect(clampToRange(100, MONITOR_VOLUME)).toBe(0);
		expect(clampToRange(-24.296875, MONITOR_VOLUME)).toBe(-24.296875);
	});

	it("clamps output trim to -60..0 dB", () => {
		const out3 = paramById("output.3.volume");
		expect(out3).toBeDefined();
		expect(clampToRange(-999, out3!)).toBe(-60);
		expect(clampToRange(12, out3!)).toBe(0);
	});
});

describe("formatValue", () => {
	it("renders dB to one decimal", () => {
		expect(formatValue(-24.296875, MONITOR_VOLUME)).toBe("-24.3 dB");
	});

	it("renders a value that rounds to zero without a sign", () => {
		expect(formatValue(-0.0078125, MONITOR_VOLUME)).toBe("0.0 dB");
	});

	it("renders sample rate in kHz", () => {
		const rate = paramById("clock.sample_rate");
		expect(formatValue(48000, rate!)).toBe("48.0 kHz");
		expect(formatValue(176400, rate!)).toBe("176.4 kHz");
	});

	it("renders a missing value as a placeholder", () => {
		expect(formatValue(undefined, MONITOR_VOLUME)).toBe("--");
	});
});

describe("formatParts", () => {
	it("separates the number from its unit", () => {
		expect(formatParts(-24.296875, MONITOR_VOLUME)).toEqual({ text: "-24.3", unit: "dB" });
	});

	/**
	 * The panel pins the number's right edge, so a constant decimal count is
	 * what keeps the decimal point from moving as the reading changes.
	 */
	it("always emits exactly one decimal place", () => {
		for (const value of [0, -1, -9.5, -24.296875, -90]) {
			expect(formatParts(value, MONITOR_VOLUME).text).toMatch(/^-?\d+\.\d$/);
		}
	});

	it("gives countable parameters no unit", () => {
		expect(formatParts(3, paramById("preset.slot")!)).toEqual({ text: "3", unit: "" });
	});
});

describe("parameter registry", () => {
	it("marks input and output as not pushed, because the server never emits them", () => {
		for (const spec of DIAL_TARGETS) {
			if (spec.path.startsWith("/input/") || spec.path.startsWith("/output/")) {
				expect(spec.sse, `${spec.id} must be polled`).toBe(false);
				expect(SSE_ENDPOINTS).not.toContain(spec.path);
			}
		}
	});

	it("subscribes to every parameter it claims is pushed", () => {
		for (const spec of DIAL_TARGETS) {
			if (spec.sse) expect(SSE_ENDPOINTS, `${spec.id} must be subscribed`).toContain(spec.path);
		}
	});

	it("gives every dial target a unique id", () => {
		const ids = DIAL_TARGETS.map((spec) => spec.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
