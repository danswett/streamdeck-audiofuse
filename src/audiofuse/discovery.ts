import streamDeck from "@elgato/streamdeck";

import { PortFinder } from "./ports";

const logger = streamDeck.logger.createScope("fuse-discovery");

/** How often to re-check that the server we found is still there. */
const LIVENESS_MS = 5000;

export type DiscoveryEvents = {
	onUp: (port: number) => void;
	onDown: () => void;
};

/**
 * Keeps track of where the AudioFuse HTTP API is, and whether it is still up.
 *
 * Control Center reallocates its port between sessions and, on Windows,
 * publishes no discoverable record, so the port is found by probing (see
 * PortFinder) and then watched. The last good port is remembered and tried
 * first, which makes the common case - a restart onto the same port -
 * effectively instant.
 */
export class FuseDiscovery {
	readonly #finder = new PortFinder();
	readonly #events: DiscoveryEvents;

	#manualPort: number | undefined;
	#lastKnownPort: number | undefined;
	#current: number | undefined;
	#timer: NodeJS.Timeout | undefined;
	#searching = false;

	constructor(events: DiscoveryEvents) {
		this.#events = events;
	}

	get port(): number | undefined {
		return this.#current;
	}

	/** The port worth trying first next time the plugin starts. */
	get lastKnownPort(): number | undefined {
		return this.#lastKnownPort;
	}

	start(lastKnownPort?: number): void {
		this.#lastKnownPort = lastKnownPort;
		if (this.#timer) return;
		this.#timer = setInterval(() => void this.#tick(), LIVENESS_MS);
		void this.#tick();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	/**
	 * Pins the port instead of searching for it.
	 *
	 * Control Center shows its port under Preferences -> Http Api, so a user
	 * whose machine blocks the scan can still connect. Clearing it returns to
	 * automatic discovery.
	 */
	setManualPort(port: number | undefined): void {
		const valid = port && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
		if (valid === this.#manualPort) return;
		this.#manualPort = valid;
		logger.info(valid ? `manual port override: ${valid}` : "manual port override cleared");
		this.#finder.forget();
		if (this.#current !== undefined) {
			this.#current = undefined;
			this.#events.onDown();
		}
		void this.#tick();
	}

	async #tick(): Promise<void> {
		if (this.#searching) return;
		this.#searching = true;
		try {
			if (this.#manualPort !== undefined) {
				await this.#useManual();
				return;
			}
			if (this.#current !== undefined) {
				// A failed check means Control Center quit or the user switched
				// the API off; drop the port and hunt for it again.
				if (await this.#finder.check(this.#current)) return;
				logger.info(`lost the API on port ${this.#current}`);
				this.#current = undefined;
				this.#events.onDown();
			}
			await this.#search();
		} finally {
			this.#searching = false;
		}
	}

	async #useManual(): Promise<void> {
		const port = this.#manualPort!;
		const alive = await this.#finder.check(port);
		if (alive && this.#current !== port) {
			this.#current = port;
			this.#lastKnownPort = port;
			this.#events.onUp(port);
		} else if (!alive && this.#current !== undefined) {
			this.#current = undefined;
			this.#events.onDown();
		}
	}

	async #search(): Promise<void> {
		const found = await this.#finder.find(this.#lastKnownPort);
		if (found === undefined) return;
		this.#lastKnownPort = found;
		this.#current = found;
		this.#events.onUp(found);
	}
}
