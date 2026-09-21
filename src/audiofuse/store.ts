import streamDeck from "@elgato/streamdeck";

import { FuseClient } from "./client";
import { FuseDiscovery } from "./discovery";
import { type FuseChange, FuseEventStream } from "./events";
import { LocalHold } from "./hold";
import { type FuseDeviceKind, SSE_ENDPOINTS, clampToRange, paramById, type ParamSpec } from "./params";

const logger = streamDeck.logger.createScope("fuse");

/** Comfortably under the server's ~50 s subscription expiry. */
const SUBSCRIBE_REFRESH_MS = 35_000;
/** Cadence for endpoints the server never pushes. */
const POLL_MS = 900;
const CONNECT_RETRY_MS = 4000;

/**
 * How long a value set here outranks anything arriving from the device.
 *
 * Every write is echoed back over SSE, but the echo describes a position the
 * dial has already left: writes are throttled to the device's rate limit while
 * detents keep arriving, so an echo lands several steps behind the value now on
 * screen. Applying it drags the reading backwards, then the next local change
 * snaps it forward again, which is what makes the text jitter.
 *
 * While the hold is up, the endpoint is driven locally and echoes are dropped.
 * It is extended by each change, so it only lapses once the dial settles - at
 * which point the device's real value, including any clamping it applied, is
 * accepted again.
 */
const LOCAL_HOLD_MS = 700;

/** Readback for silent endpoints, deliberately later than the local hold. */
const READBACK_MS = 900;

export type ConnectionState = "discovering" | "connecting" | "ready" | "error";

export type FuseSnapshot = {
	readonly state: ConnectionState;
	readonly device: FuseDeviceKind | undefined;
	readonly detail: string;
};

type Listener = () => void;

/**
 * Coerces the API's loose booleans.
 *
 * GET returns real JSON booleans, but the SSE stream reports the same fields as
 * 1 and 0. Anything that reads device state has to go through here or toggles
 * latch on permanently after the first event.
 */
export function asBool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") return value === "true" || value === "1";
	return false;
}

export function asNumber(value: unknown): number | undefined {
	const n = typeof value === "boolean" ? undefined : Number(value);
	return n !== undefined && Number.isFinite(n) ? n : undefined;
}

/**
 * The single connection every action shares.
 *
 * One client, one event stream, one subscription refresh. Actions register the
 * endpoints they display and are notified when a value changes, whether the
 * change came from this plugin, from Control Center, or from the hardware.
 */
class FuseStore {
	readonly #discovery: FuseDiscovery;
	readonly #stream: FuseEventStream;
	#client: FuseClient | undefined;

	#state: ConnectionState = "discovering";
	#detail = "Looking for AudioFuse Control Center";
	#device: FuseDeviceKind | undefined;

	readonly #values = new Map<string, unknown>();
	/** Endpoints this plugin is currently driving; see LocalHold. */
	readonly #hold = new LocalHold(LOCAL_HOLD_MS);
	/** Endpoint path to the actions currently displaying it. */
	readonly #watchers = new Map<string, Set<Listener>>();
	readonly #statusListeners = new Set<Listener>();

	#subscribeTimer: NodeJS.Timeout | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#retryTimer: NodeJS.Timeout | undefined;

	constructor() {
		this.#discovery = new FuseDiscovery({
			onUp: (port) => void this.#onServiceUp(port),
			onDown: () => this.#onServiceDown()
		});
		this.#stream = new FuseEventStream((changes) => this.#onChanges(changes));
	}

	get snapshot(): FuseSnapshot {
		return { state: this.#state, device: this.#device, detail: this.#detail };
	}

	get ready(): boolean {
		return this.#state === "ready";
	}

	get port(): number | undefined {
		return this.#discovery.port;
	}

	start(lastKnownPort?: number): void {
		this.#discovery.start(lastKnownPort);
		this.#pollTimer = setInterval(() => void this.#poll(), POLL_MS);
	}

	/** The port worth trying first on the next launch. */
	get lastKnownPort(): number | undefined {
		return this.#discovery.lastKnownPort;
	}

	setManualPort(port: number | undefined): void {
		this.#discovery.setManualPort(port);
	}

	// -- connection ---------------------------------------------------------

	async #onServiceUp(port: number): Promise<void> {
		if (this.#client?.port === port && this.#state === "ready") return;

		this.#stream.stop();
		this.#setState("connecting", `Connecting on port ${port}`);
		this.#client = new FuseClient(port);

		const version = await this.#client.readRaw("/version", 9);
		if (!version.ok) {
			this.#setState("error", "Control Center is not answering");
			this.#scheduleRetry(port);
			return;
		}

		const devices = await this.#client.readRaw("/devices", 9);
		const serials = ((devices.ok ? devices.value : undefined) as { devices?: string[] } | undefined)?.devices ?? [];
		if (serials.length === 0) {
			this.#setState("error", "No AudioFuse connected");
			this.#scheduleRetry(port);
			return;
		}

		this.#client.serial = serials[0];
		this.#device = await this.#detectDevice();

		this.#setState("ready", `${this.#device === "af16rig" ? "AudioFuse 16Rig" : "AudioFuse Studio"}`);
		logger.info(`connected to ${this.#client.serial} on port ${port} as ${this.#device}`);

		await this.#refreshSubscription();
		this.#stream.start(this.#client.base);
		this.#subscribeTimer = setInterval(() => void this.#refreshSubscription(), SUBSCRIBE_REFRESH_MS);
		await this.#primeCache();
	}

	/**
	 * Presets are 16Rig-only, so /preset/names answering at all identifies the
	 * model. Serial numbers carry no dependable model marker.
	 */
	async #detectDevice(): Promise<FuseDeviceKind> {
		const res = await this.#client?.readRaw("/preset/names", 8);
		return res?.ok ? "af16rig" : "afstudio";
	}

	#scheduleRetry(port: number): void {
		if (this.#retryTimer) clearTimeout(this.#retryTimer);
		this.#retryTimer = setTimeout(() => void this.#onServiceUp(port), CONNECT_RETRY_MS);
	}

	#onServiceDown(): void {
		this.#stream.stop();
		if (this.#subscribeTimer) clearInterval(this.#subscribeTimer);
		this.#subscribeTimer = undefined;
		this.#client = undefined;
		this.#device = undefined;
		this.#values.clear();
		this.#setState("discovering", "Turn on Preferences \u2192 Http Api in Control Center");
		this.#notifyAll();
	}

	async #refreshSubscription(): Promise<void> {
		await this.#client?.subscribe(SSE_ENDPOINTS);
	}

	/** Reads every endpoint an action is currently displaying. */
	async #primeCache(): Promise<void> {
		for (const path of [...this.#watchers.keys()]) await this.#readInto(path, 2);
	}

	// -- values -------------------------------------------------------------

	value(path: string): unknown {
		return this.#values.get(path);
	}

	#set(path: string, value: unknown): void {
		const previous = this.#values.get(path);
		if (previous === value) return;
		this.#values.set(path, value);
		for (const listener of this.#watchers.get(path) ?? []) listener();
	}

	/** Holds an endpoint under local control for a moment after a change. */
	#holdLocal(path: string): void {
		this.#hold.claim(path);
	}

	/**
	 * Applies a value that came from the device.
	 *
	 * Dropped while the endpoint is held, because anything arriving then is an
	 * echo of a write this plugin already superseded.
	 */
	#setRemote(path: string, value: unknown): void {
		if (this.#hold.holds(path)) return;
		this.#set(path, value);
	}

	async #readInto(path: string, priority = 1): Promise<void> {
		const res = await this.#client?.read(path, priority);
		if (res?.ok) this.#setRemote(path, res.value);
	}

	#onChanges(changes: FuseChange[]): void {
		let presetRecalled = false;
		for (const change of changes) {
			this.#setRemote(change.key, change.value);
			if (change.key === "/preset/slot") presetRecalled = true;
		}
		// Recalling a slot rewrites the whole device state, and only a handful of
		// the affected endpoints are pushed. Re-read everything on screen.
		if (presetRecalled) void this.#primeCache();
	}

	/**
	 * Polls the endpoints the server never pushes.
	 *
	 * /input and /output emit nothing even when subscribed, so a gain moved in
	 * Control Center is invisible until it is read back. Only endpoints with a
	 * live watcher are polled, and one per tick, to stay clear of the rate limit.
	 */
	#pollCursor = 0;

	async #poll(): Promise<void> {
		if (!this.ready) return;
		const paths = [...this.#watchers.keys()].filter((path) => !isPushed(path));
		if (paths.length === 0) return;
		this.#pollCursor = (this.#pollCursor + 1) % paths.length;
		await this.#readInto(paths[this.#pollCursor]!, 1);
	}

	// -- subscriptions ------------------------------------------------------

	watch(path: string, listener: Listener): () => void {
		let set = this.#watchers.get(path);
		if (!set) {
			set = new Set();
			this.#watchers.set(path, set);
		}
		set.add(listener);
		if (this.ready && !this.#values.has(path)) void this.#readInto(path, 4);

		return () => {
			const current = this.#watchers.get(path);
			current?.delete(listener);
			if (current && current.size === 0) this.#watchers.delete(path);
		};
	}

	watchStatus(listener: Listener): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	#setState(state: ConnectionState, detail: string): void {
		this.#state = state;
		this.#detail = detail;
		this.#notifyAll();
	}

	#notifyAll(): void {
		for (const listener of this.#statusListeners) listener();
		for (const set of this.#watchers.values()) for (const listener of set) listener();
	}

	// -- writes -------------------------------------------------------------

	/**
	 * Applies a value optimistically, then sends it.
	 *
	 * The cache is updated first so the LCD tracks the dial without waiting for
	 * a round trip, and the endpoint is held so the echo of this write cannot
	 * drag the reading back. The device clamps silently, so the optimistic value
	 * is clamped the same way here and reconciled once the hold lapses.
	 */
	set(spec: ParamSpec, value: number): void {
		if (!this.#client) return;
		const clamped = spec.range ? clampToRange(value, spec) : value;
		this.#holdLocal(spec.path);
		this.#set(spec.path, clamped);
		this.#client.write(spec.path, clamped);
		this.#scheduleReadback(spec.path);
	}

	setBool(path: string, value: boolean): void {
		if (!this.#client) return;
		this.#holdLocal(path);
		this.#set(path, value);
		this.#client.write(path, value);
		this.#scheduleReadback(path);
	}

	setRaw(path: string, value: unknown): void {
		if (!this.#client) return;
		this.#holdLocal(path);
		this.#set(path, value);
		this.#client.write(path, value);
		this.#scheduleReadback(path);
	}

	readonly #readbacks = new Map<string, NodeJS.Timeout>();

	/**
	 * Reconciles an endpoint with the device once the control settles.
	 *
	 * Runs for pushed endpoints too, not just the silent ones. Holding an
	 * endpoint locally means genuine changes made elsewhere during that window -
	 * someone moving the same control in Control Center - are discarded along
	 * with the echoes, and for a pushed endpoint no further event would arrive
	 * to correct it. One read after the hold lapses guarantees the display
	 * converges on the device either way, and also catches any clamping.
	 */
	#scheduleReadback(path: string): void {
		const existing = this.#readbacks.get(path);
		if (existing) clearTimeout(existing);
		this.#readbacks.set(
			path,
			setTimeout(() => {
				this.#readbacks.delete(path);
				void this.#readInto(path, 2);
			}, READBACK_MS)
		);
	}

	nudge(id: string, delta: number): void {
		const spec = paramById(id);
		if (!spec?.range) return;
		const current = asNumber(this.#values.get(spec.path)) ?? spec.range.min;
		this.set(spec, current + delta * spec.range.step);
	}
}

/** True when the server pushes this endpoint over SSE. */
function isPushed(path: string): boolean {
	return SSE_ENDPOINTS.includes(path);
}

export const fuse = new FuseStore();
