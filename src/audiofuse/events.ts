import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("fuse-sse");

const RECONNECT_MS = 2000;

export type FuseChange = { key: string; value: unknown };

/**
 * Reads the /events Server-Sent Events stream.
 *
 * Written against fetch rather than an EventSource package because the stream
 * needs to be torn down the instant Bonjour reports the service gone - sockets
 * to a stopped Control Center hang rather than erroring - and an AbortController
 * is the cleanest way to guarantee that.
 */
export class FuseEventStream {
	#controller: AbortController | undefined;
	#stopped = true;
	#timer: NodeJS.Timeout | undefined;
	readonly #onChanges: (changes: FuseChange[]) => void;
	#baseUrl: string | undefined;

	constructor(onChanges: (changes: FuseChange[]) => void) {
		this.#onChanges = onChanges;
	}

	start(baseUrl: string): void {
		this.#baseUrl = baseUrl;
		this.#stopped = false;
		void this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#controller?.abort();
		this.#controller = undefined;
	}

	async #connect(): Promise<void> {
		if (this.#stopped || !this.#baseUrl) return;

		const controller = new AbortController();
		this.#controller = controller;

		try {
			const res = await fetch(`${this.#baseUrl}/events`, {
				headers: { Accept: "text/event-stream" },
				signal: controller.signal
			});
			if (!res.ok || !res.body) throw new Error(`events returned ${res.status}`);

			logger.info("event stream open");
			await this.#pump(res.body);
			logger.info("event stream closed by server");
		} catch (err) {
			if (!controller.signal.aborted) logger.warn(`event stream error: ${String(err)}`);
		}

		this.#retry();
	}

	#retry(): void {
		if (this.#stopped) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => void this.#connect(), RECONNECT_MS);
	}

	async #pump(body: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = body.getReader();
		let buffer = "";

		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });

			// Frames are separated by a blank line. Tolerate CRLF, since the
			// separator is the one thing a proxy is most likely to rewrite.
			let split = findFrameBreak(buffer);
			while (split >= 0) {
				const frame = buffer.slice(0, split.valueOf());
				buffer = buffer.slice(split + frameBreakLength(buffer, split));
				this.#handleFrame(frame);
				split = findFrameBreak(buffer);
			}
		}
	}

	#handleFrame(frame: string): void {
		let event = "message";
		const data: string[] = [];

		for (const rawLine of frame.split(/\r?\n/)) {
			if (rawLine.startsWith(":")) continue;
			const colon = rawLine.indexOf(":");
			const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
			const rest = colon < 0 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");
			if (field === "event") event = rest;
			else if (field === "data") data.push(rest);
		}

		// The server names its events; an unnamed frame is a keep-alive.
		if (event !== "update" || data.length === 0) return;

		try {
			const parsed = JSON.parse(data.join("\n")) as { payload?: FuseChange[] };
			const payload = parsed.payload;
			// Always an array, even for a single change.
			if (Array.isArray(payload) && payload.length > 0) this.#onChanges(payload);
		} catch (err) {
			logger.warn(`could not parse event payload: ${String(err)}`);
		}
	}
}

function findFrameBreak(buffer: string): number {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf < 0) return crlf;
	if (crlf < 0) return lf;
	return Math.min(lf, crlf);
}

function frameBreakLength(buffer: string, index: number): number {
	return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}
