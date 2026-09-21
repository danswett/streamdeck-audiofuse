import { describe, expect, it, vi } from "vitest";

import { type FuseChange, FuseEventStream } from "../src/audiofuse/events";

/** Feeds a canned byte stream to the parser and returns everything it emitted. */
async function parse(chunks: string[]): Promise<FuseChange[]> {
	const seen: FuseChange[] = [];
	const stream = new FuseEventStream((changes) => seen.push(...changes));

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		}
	});

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
	);

	stream.start("http://127.0.0.1:1/api/v1");
	// Let the reader drain before the reconnect timer is armed.
	await new Promise((resolve) => setTimeout(resolve, 30));
	stream.stop();
	vi.unstubAllGlobals();
	return seen;
}

describe("FuseEventStream", () => {
	it("parses a single named update frame", async () => {
		const seen = await parse(['event: update\ndata: {"id": 6, "payload": [{"key":"/monitoring/dim","value":1}]}\n\n']);
		expect(seen).toEqual([{ key: "/monitoring/dim", value: 1 }]);
	});

	it("parses a coalesced frame carrying several keys", async () => {
		// A preset recall reports slot and name together in one payload.
		const seen = await parse([
			'event: update\ndata: {"id": 14, "payload": [{"key":"/preset/slot","value":2},{"key":"/preset/name","value":"Preset2"}]}\n\n'
		]);
		expect(seen).toEqual([
			{ key: "/preset/slot", value: 2 },
			{ key: "/preset/name", value: "Preset2" }
		]);
	});

	it("reassembles a frame split across chunk boundaries", async () => {
		const seen = await parse(['event: update\ndata: {"payload": [{"key":"/monitor', 'ing/mute","value":1}]}\n\n']);
		expect(seen).toEqual([{ key: "/monitoring/mute", value: 1 }]);
	});

	it("handles several frames in one chunk", async () => {
		const seen = await parse([
			'event: update\ndata: {"payload":[{"key":"/monitoring/volume","value":-25.3}]}\n\n' +
				'event: update\ndata: {"payload":[{"key":"/monitoring/volume","value":-24.3}]}\n\n'
		]);
		expect(seen.map((c) => c.value)).toEqual([-25.3, -24.3]);
	});

	it("accepts CRLF framing", async () => {
		const seen = await parse(['event: update\r\ndata: {"payload":[{"key":"/clock/sync","value":1}]}\r\n\r\n']);
		expect(seen).toEqual([{ key: "/clock/sync", value: 1 }]);
	});

	// The server names every event it cares about; anything else is keep-alive
	// traffic or a future event type, and must not be mistaken for an update.
	it("ignores unnamed and unknown event types", async () => {
		const seen = await parse([
			'data: {"payload":[{"key":"/monitoring/mute","value":1}]}\n\n',
			'event: heartbeat\ndata: {"payload":[{"key":"/monitoring/mute","value":1}]}\n\n',
			": keep-alive comment\n\n"
		]);
		expect(seen).toEqual([]);
	});

	it("survives a malformed payload without dropping later frames", async () => {
		const seen = await parse([
			"event: update\ndata: {not json}\n\n",
			'event: update\ndata: {"payload":[{"key":"/monitoring/dim","value":0}]}\n\n'
		]);
		expect(seen).toEqual([{ key: "/monitoring/dim", value: 0 }]);
	});
});
