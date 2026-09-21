import { afterEach, describe, expect, it, vi } from "vitest";

import { FuseClient } from "../src/audiofuse/client";

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

/** Records every request and answers with a canned sequence of statuses. */
function stubFetch(statuses: number[] = [], payload: unknown = {}): Call[] {
	const calls: Call[] = [];
	let index = 0;

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({
				url,
				method: init.method ?? "GET",
				body: init.body ? JSON.parse(String(init.body)) : undefined,
				headers: (init.headers ?? {}) as Record<string, string>
			});
			const status = statuses[index++] ?? 200;
			return new Response(status === 200 ? JSON.stringify(payload) : "", { status });
		})
	);

	return calls;
}

const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => vi.unstubAllGlobals());

describe("FuseClient reads", () => {
	it("unwraps the single-key envelope the API returns", async () => {
		stubFetch([], { volume: -24.296875 });
		const client = new FuseClient(60465, "SERIAL123");

		const res = await client.read("/monitoring/volume");
		expect(res).toEqual({ ok: true, value: -24.296875 });
	});

	it("sends the targeted-device header even with one device attached", async () => {
		const calls = stubFetch([], { mute: false });
		const client = new FuseClient(60465, "SERIAL123");

		await client.read("/monitoring/mute");
		expect(calls[0]!.headers["targeted-device"]).toBe("SERIAL123");
	});

	it("reports a failed read rather than throwing", async () => {
		stubFetch([404]);
		const client = new FuseClient(60465);

		const res = await client.read("/preset/names");
		expect(res.ok).toBe(false);
	});
});

describe("FuseClient writes", () => {
	/**
	 * The whole reason this class exists. Firmware 1.0.0 answers 404 to the
	 * documented leaf write and only accepts the field on its parent.
	 */
	it("writes the field to the parent endpoint, never the leaf", async () => {
		const calls = stubFetch();
		const client = new FuseClient(60465, "SERIAL123");

		client.write("/monitoring/volume", -30);
		await settle();

		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe("PUT");
		expect(calls[0]!.url).toBe("http://127.0.0.1:60465/api/v1/monitoring");
		expect(calls[0]!.body).toEqual({ volume: -30 });
	});

	it("writes an indexed channel to its channel parent", async () => {
		const calls = stubFetch();
		const client = new FuseClient(60465);

		client.write("/input/analog/1/gain", 6);
		await settle();

		expect(calls[0]!.url).toBe("http://127.0.0.1:60465/api/v1/input/analog/1");
		expect(calls[0]!.body).toEqual({ gain: 6 });
	});

	/**
	 * A dial detent fires far faster than the device accepts writes, so only
	 * the newest position may be sent. Queueing every intermediate value is
	 * what produces 429s and a laggy, overshooting dial.
	 */
	it("collapses a burst on one endpoint down to the final value", async () => {
		const calls = stubFetch();
		const client = new FuseClient(60465);

		for (let i = 1; i <= 25; i++) client.write("/monitoring/volume", -40 + i);
		await settle(600);

		expect(calls.length).toBeLessThan(25);
		expect(calls.at(-1)!.body).toEqual({ volume: -15 });
	});

	it("keeps writes to different endpoints separate", async () => {
		const calls = stubFetch();
		const client = new FuseClient(60465);

		client.write("/monitoring/volume", -30);
		client.write("/monitoring/dim", true);
		await settle(600);

		const bodies = calls.map((c) => c.body);
		expect(bodies).toContainEqual({ volume: -30 });
		expect(bodies).toContainEqual({ dim: true });
	});

	it("retries after a 429 instead of dropping the value", async () => {
		const calls = stubFetch([429, 200]);
		const client = new FuseClient(60465);

		client.write("/monitoring/volume", -12);
		await settle(1200);

		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls.at(-1)!.body).toEqual({ volume: -12 });
	});

	it("does not retry a rejected value it cannot fix", async () => {
		const calls = stubFetch([403, 200, 200]);
		const client = new FuseClient(60465);

		client.write("/input/analog/1/48v", true);
		await settle(700);

		expect(calls).toHaveLength(1);
	});

	it("sets a JSON content type on writes", async () => {
		const calls = stubFetch();
		const client = new FuseClient(60465);

		client.write("/monitoring/mute", true);
		await settle();

		expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
	});
});

describe("FuseClient subscribe", () => {
	it("posts the endpoint list to /update", async () => {
		const calls = stubFetch();
		const client = new FuseClient(60465);

		await client.subscribe(["/monitoring/mute", "/monitoring/volume"]);

		expect(calls[0]!.url).toBe("http://127.0.0.1:60465/api/v1/update");
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.body).toEqual({ endpoints: ["/monitoring/mute", "/monitoring/volume"] });
	});
});
