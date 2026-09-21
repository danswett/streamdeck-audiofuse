/**
 * Live check against a running AudioFuse Control Center.
 *
 * Skipped unless FUSE_LIVE=1, because it needs real hardware attached. It
 * exercises the paths that unit tests cannot prove: that Bonjour finds the
 * service, that the parent-endpoint write shape is accepted by the firmware,
 * and that a write comes back over the event stream.
 *
 * Every value it touches is captured first and restored afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FuseClient } from "../src/audiofuse/client";
import { FuseEventStream } from "../src/audiofuse/events";
import { PortFinder } from "../src/audiofuse/ports";
import { asNumber } from "../src/audiofuse/store";

const live = process.env.FUSE_LIVE === "1";
const suite = live ? describe : describe.skip;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

suite("live AudioFuse", () => {
	let client: FuseClient;
	let port: number | undefined;
	let originalVolume: number | undefined;

	beforeAll(async () => {
		port = await new PortFinder().find();
		if (port === undefined) throw new Error("could not locate the AudioFuse HTTP API on any local port");

		client = new FuseClient(port);
		const devices = await client.readRaw("/devices");
		const serials = ((devices.ok ? devices.value : undefined) as { devices?: string[] })?.devices ?? [];
		client.serial = serials[0];

		const volume = await client.read("/monitoring/volume");
		originalVolume = volume.ok ? asNumber(volume.value) : undefined;
	}, 60_000);

	afterAll(async () => {
		if (client && originalVolume !== undefined) {
			client.write("/monitoring/volume", originalVolume);
			await wait(900);
			const check = await client.read("/monitoring/volume");
			expect(check.ok && asNumber(check.value)).toBe(originalVolume);
		}
	}, 15_000);

	it("locates the API by probing local listeners", () => {
		expect(port).toBeGreaterThan(0);
	});

	it("reports an API version", async () => {
		const res = await client.readRaw("/version");
		expect(res.ok).toBe(true);
		expect((res as { value: { version: string } }).value.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("finds a connected device", async () => {
		const res = await client.readRaw("/devices");
		expect(res.ok).toBe(true);
		expect((res as { value: { devices: string[] } }).value.devices.length).toBeGreaterThan(0);
	});

	it("reads the monitor volume as a number", async () => {
		const res = await client.read("/monitoring/volume");
		expect(res.ok).toBe(true);
		expect(asNumber((res as { value: unknown }).value)).toBeTypeOf("number");
	});

	/** The documented leaf write; confirms it really is unusable on this firmware. */
	it("rejects a write to the leaf endpoint", async () => {
		const res = await fetch(`${client.base}/monitoring/volume`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", "targeted-device": client.serial ?? "" },
			body: JSON.stringify({ volume: originalVolume })
		});
		expect(res.status).toBe(404);
	});

	it("applies a write sent to the parent endpoint", async () => {
		const target = (originalVolume ?? -24) - 1;
		client.write("/monitoring/volume", target);
		await wait(900);

		const res = await client.read("/monitoring/volume");
		expect(asNumber((res as { value: unknown }).value)).toBeCloseTo(target, 1);
	}, 15_000);

	it("clamps rather than rejecting an out-of-range value", async () => {
		client.write("/monitoring/volume", -500);
		await wait(900);

		const res = await client.read("/monitoring/volume");
		expect(asNumber((res as { value: unknown }).value)).toBe(-90);
	}, 15_000);

	it("pushes a change over the event stream", async () => {
		const seen: string[] = [];
		const stream = new FuseEventStream((changes) => seen.push(...changes.map((c) => c.key)));

		await client.subscribe(["/monitoring/volume", "/monitoring/dim"]);
		stream.start(client.base);
		await wait(1200);

		client.write("/monitoring/volume", (originalVolume ?? -24) - 2);
		await wait(2000);
		stream.stop();

		expect(seen).toContain("/monitoring/volume");
	}, 20_000);
});
