import { describe, expect, it, vi } from "vitest";

import { ControlCenterArmer } from "../src/audiofuse/arm";

/** An armer that believes Control Center is installed, with a fake shell. */
function armerOn(run: (command: string) => Promise<unknown>, now = () => 0): ControlCenterArmer {
	return new ControlCenterArmer({ run, now, platform: "win32", exists: () => true });
}

describe("ControlCenterArmer", () => {
	it("does nothing where there is no Control Center to run", async () => {
		const run = vi.fn();
		const armer = new ControlCenterArmer({ run, platform: "win32", exists: () => false });

		expect(armer.available).toBe(false);
		expect(await armer.arm()).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	/**
	 * The window hiding and WM_CLOSE below are Win32 calls, and macOS is not
	 * known to need any of this - it publishes the API over DNS-SD.
	 */
	it("stays out of the way on macOS", async () => {
		const run = vi.fn();
		const armer = new ControlCenterArmer({ run, platform: "darwin", exists: () => true });

		expect(armer.available).toBe(false);
		expect(await armer.arm()).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it("reports success when Control Center turned the API on", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		expect(await armerOn(run).arm()).toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
	});

	/**
	 * The script signals "the API never came up" with a non-zero exit, which
	 * exec surfaces as a rejection. That is an expected outcome - there may be
	 * no AudioFuse plugged in - not something to throw out of discovery.
	 */
	it("reports failure without throwing when the API never came up", async () => {
		const run = vi.fn().mockRejectedValue(new Error("Command failed, exit 1"));
		await expect(armerOn(run).arm()).resolves.toBe(false);
	});

	it("passes PowerShell a base64 command, so no quoting can break it", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		await armerOn(run).arm();

		const command = run.mock.calls[0]![0] as string;
		const encoded = /-EncodedCommand (\S+)$/.exec(command)?.[1];
		expect(encoded).toBeDefined();

		const script = Buffer.from(encoded!, "base64").toString("utf16le");
		expect(script).toContain("AudioFuse Control Center.exe");
		expect(script).toContain("api/v1/version");
		// Closed with WM_CLOSE rather than killed, so it saves its preferences.
		expect(script).toContain("0x0010");
	});

	/**
	 * Discovery ticks every few seconds. Without a cooldown, a machine with no
	 * AudioFuse attached would relaunch Control Center forever.
	 */
	it("does not relaunch Control Center while the cooldown is up", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		let clock = 1_000_000;
		const armer = new ControlCenterArmer({
			run,
			now: () => clock,
			cooldownMs: 60_000,
			platform: "win32",
			exists: () => true
		});

		expect(await armer.arm()).toBe(true);

		clock += 59_000;
		expect(await armer.arm()).toBe(false);
		expect(run).toHaveBeenCalledTimes(1);

		clock += 2_000;
		expect(await armer.arm()).toBe(true);
		expect(run).toHaveBeenCalledTimes(2);
	});

	/**
	 * A run takes the better part of a minute; ticks keep arriving throughout.
	 */
	it("refuses to start a second run while one is in flight", async () => {
		let release!: () => void;
		const run = vi.fn().mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
		const armer = armerOn(run, () => 0);

		const first = armer.arm();
		expect(await armer.arm()).toBe(false);
		expect(run).toHaveBeenCalledTimes(1);

		release();
		expect(await first).toBe(true);
	});
});
