import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalHold } from "../src/audiofuse/hold";
import { renderDial } from "../src/render";

describe("LocalHold", () => {
	// Fake timers rather than real sleeps: the window is deliberately short and
	// Windows' timer resolution is coarse enough to make real waits flaky.
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not hold an endpoint that was never claimed", () => {
		expect(new LocalHold(700).holds("/monitoring/volume")).toBe(false);
	});

	/**
	 * The jitter fix. While a dial is being turned, the device echoes each
	 * write back a few steps behind the current position; those echoes must be
	 * dropped rather than applied.
	 */
	it("holds a claimed endpoint so stale echoes can be dropped", () => {
		const hold = new LocalHold(700);
		hold.claim("/monitoring/volume");
		vi.advanceTimersByTime(600);
		expect(hold.holds("/monitoring/volume")).toBe(true);
	});

	it("lapses once the control settles, so the device is trusted again", () => {
		const hold = new LocalHold(700);
		hold.claim("/monitoring/volume");
		vi.advanceTimersByTime(701);
		expect(hold.holds("/monitoring/volume")).toBe(false);
	});

	it("renews on every change, so a slow turn never lets an echo through", () => {
		const hold = new LocalHold(700);
		for (let i = 0; i < 10; i++) {
			hold.claim("/monitoring/volume");
			vi.advanceTimersByTime(500);
			expect(hold.holds("/monitoring/volume")).toBe(true);
		}
		vi.advanceTimersByTime(701);
		expect(hold.holds("/monitoring/volume")).toBe(false);
	});

	it("holds each endpoint independently", () => {
		const hold = new LocalHold(700);
		hold.claim("/monitoring/volume");
		expect(hold.holds("/input/analog/1/gain")).toBe(false);
	});

	it("releases on request", () => {
		const hold = new LocalHold(700);
		hold.claim("/monitoring/volume");
		hold.release("/monitoring/volume");
		expect(hold.holds("/monitoring/volume")).toBe(false);
	});
});

describe("dial panel stability", () => {
	/** Extracts the x and anchor of the large reading. */
	function reading(svg: string): { x: string; anchor: string } {
		const match = /<text x="(\d+)" y="58" text-anchor="(\w+)" [^>]*font-size="34"/.exec(svg);
		if (!match) throw new Error(`no reading found in ${svg}`);
		return { x: match[1]!, anchor: match[2]! };
	}

	/**
	 * A centred reading slides sideways whenever it gains or loses a digit,
	 * which is the other half of the jitter. Pinning the right edge keeps the
	 * decimal point still and grows the number leftwards instead.
	 */
	it("pins the number to the same right edge regardless of width", () => {
		const narrow = renderDial({ label: "Monitor", value: "-9.0", unit: "dB", fraction: 0.9 });
		const wide = renderDial({ label: "Monitor", value: "-24.3", unit: "dB", fraction: 0.7 });

		expect(reading(narrow).anchor).toBe("end");
		expect(reading(narrow)).toEqual(reading(wide));
	});

	it("keeps the unit in one place while the number changes", () => {
		const unitX = (svg: string): string => {
			const match = /<text x="(\d+)" y="58" text-anchor="start"/.exec(svg);
			if (!match) throw new Error("no unit found");
			return match[1]!;
		};

		expect(unitX(renderDial({ label: "In 1", value: "0.0", unit: "dB" }))).toBe(
			unitX(renderDial({ label: "In 1", value: "-60.0", unit: "dB" }))
		);
	});

	it("centres a reading that has no unit", () => {
		expect(reading(renderDial({ label: "Preset", value: "3" })).anchor).toBe("middle");
	});
});
