import streamDeck from "@elgato/streamdeck";

import { splitEndpoint } from "./params";

const logger = streamDeck.logger.createScope("fuse-http");

export type FuseResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string };

/**
 * Minimum gap between requests. The firmware, not the HTTP layer, enforces the
 * rate limit, and it answers 429 when writes arrive faster than it can apply
 * them. The documented floor is 200 ms; this starts slightly above it and
 * adapts upward on every 429.
 */
const BASE_GAP_MS = 120;
const MAX_GAP_MS = 600;
const GAP_DECAY_MS = 8;

type Job = {
	readonly run: () => Promise<void>;
	readonly priority: number;
};

/**
 * Serializes every call to the API behind one adaptive-rate queue.
 *
 * A single queue rather than one per endpoint, because the limit is enforced by
 * the device and is therefore global. Interactive writes jump ahead of
 * background polling so a spinning dial never queues behind a refresh.
 */
class RequestQueue {
	#jobs: Job[] = [];
	#running = false;
	#gap = BASE_GAP_MS;
	#lastSent = 0;

	get gap(): number {
		return this.#gap;
	}

	push(priority: number, run: () => Promise<void>): void {
		this.#jobs.push({ run, priority });
		// Stable insertion order within a priority: only reorder across levels.
		this.#jobs.sort((a, b) => b.priority - a.priority);
		void this.#drain();
	}

	penalize(): void {
		this.#gap = Math.min(MAX_GAP_MS, Math.round(this.#gap * 1.6) + 40);
		logger.debug(`rate limited, widening gap to ${this.#gap}ms`);
	}

	reward(): void {
		if (this.#gap > BASE_GAP_MS) this.#gap = Math.max(BASE_GAP_MS, this.#gap - GAP_DECAY_MS);
	}

	async #drain(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			while (this.#jobs.length > 0) {
				const wait = this.#lastSent + this.#gap - Date.now();
				if (wait > 0) await sleep(wait);
				const job = this.#jobs.shift();
				if (!job) break;
				this.#lastSent = Date.now();
				await job.run();
			}
		} finally {
			this.#running = false;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Talks to one AudioFuse Control Center instance.
 *
 * Two behaviours here exist only because the device disagrees with its own
 * documentation, and both are load-bearing:
 *
 *  - Writes go to the *parent* endpoint. `PUT /monitoring/volume {"volume":n}`
 *    is documented and returns 404; `PUT /monitoring {"volume":n}` works. The
 *    same holds for every leaf in the tree.
 *  - Out-of-range values are silently clamped, never rejected, so a write is
 *    not proof of the value that landed. Callers must read back.
 */
export class FuseClient {
	#port: number;
	#serial: string | undefined;
	readonly #queue = new RequestQueue();
	/** Latest pending value per endpoint, so fast dial spins collapse to one write. */
	readonly #pending = new Map<string, unknown>();
	readonly #inflight = new Set<string>();

	constructor(port: number, serial?: string) {
		this.#port = port;
		this.#serial = serial;
	}

	get port(): number {
		return this.#port;
	}

	get serial(): string | undefined {
		return this.#serial;
	}

	set serial(value: string | undefined) {
		this.#serial = value;
	}

	get base(): string {
		return `http://127.0.0.1:${this.#port}/api/v1`;
	}

	#headers(body: boolean): Record<string, string> {
		const headers: Record<string, string> = {};
		if (body) headers["Content-Type"] = "application/json";
		// Sent even with a single device, so a second AudioFuse appearing
		// mid-session cannot silently redirect writes.
		if (this.#serial) headers["targeted-device"] = this.#serial;
		return headers;
	}

	async #send(method: string, path: string, body?: unknown): Promise<FuseResult<unknown>> {
		const init: RequestInit = { method, headers: this.#headers(body !== undefined) };
		if (body !== undefined) init.body = JSON.stringify(body);

		try {
			const res = await fetch(`${this.base}${path}`, init);
			if (res.status === 429) {
				this.#queue.penalize();
				return { ok: false, status: 429, reason: "Too many requests" };
			}
			if (!res.ok) {
				return { ok: false, status: res.status, reason: res.statusText || `HTTP ${res.status}` };
			}
			this.#queue.reward();
			const text = await res.text();
			if (text.length === 0) return { ok: true, value: undefined };
			try {
				return { ok: true, value: JSON.parse(text) };
			} catch {
				return { ok: true, value: undefined };
			}
		} catch (err) {
			return { ok: false, status: 0, reason: String(err) };
		}
	}

	/** Reads one endpoint and unwraps the single-key envelope the API returns. */
	read(path: string, priority = 1): Promise<FuseResult<unknown>> {
		return new Promise((resolve) => {
			this.#queue.push(priority, async () => {
				const res = await this.#send("GET", path);
				if (!res.ok) {
					resolve(res);
					return;
				}
				const { field } = splitEndpoint(path);
				const body = res.value as Record<string, unknown> | undefined;
				resolve({ ok: true, value: body && field in body ? body[field] : body });
			});
		});
	}

	/** Reads without unwrapping, for endpoints whose own name is the key. */
	readRaw(path: string, priority = 1): Promise<FuseResult<unknown>> {
		return new Promise((resolve) => {
			this.#queue.push(priority, async () => resolve(await this.#send("GET", path)));
		});
	}

	/**
	 * Queues a write, collapsing anything already pending for the same endpoint.
	 *
	 * A dial detent fires far faster than the device accepts writes, so only the
	 * newest value for an endpoint is ever sent; intermediate positions are
	 * dropped rather than queued.
	 */
	write(path: string, value: unknown): void {
		this.#pending.set(path, value);
		if (this.#inflight.has(path)) return;
		this.#inflight.add(path);

		this.#queue.push(5, async () => {
			const next = this.#pending.get(path);
			this.#pending.delete(path);
			this.#inflight.delete(path);
			if (next === undefined) return;

			const { parent, field } = splitEndpoint(path);
			const res = await this.#send("PUT", parent, { [field]: next });
			if (!res.ok) {
				if (res.status === 429) {
					// Requeue only if nothing newer has landed meanwhile.
					if (!this.#pending.has(path)) this.write(path, next);
					return;
				}
				logger.warn(`write ${path} failed: ${res.status} ${res.reason}`);
			}
		});
	}

	/** Writes several fields of one parent in a single request. */
	writeMany(parent: string, fields: Record<string, unknown>, priority = 5): Promise<FuseResult<unknown>> {
		return new Promise((resolve) => {
			this.#queue.push(priority, async () => resolve(await this.#send("POST", parent, fields)));
		});
	}

	/** Refreshes the SSE subscription. The server expires it after about 50 s. */
	subscribe(endpoints: readonly string[]): Promise<FuseResult<unknown>> {
		return new Promise((resolve) => {
			this.#queue.push(3, async () => resolve(await this.#send("POST", "/update", { endpoints })));
		});
	}
}
