import streamDeck from "@elgato/streamdeck";

import { ControlCenterArmer } from "./arm";
import { PortFinder } from "./ports";

const logger = streamDeck.logger.createScope("fuse-discovery");

/** How often to re-check that the server we found is still there. */
const LIVENESS_MS = 5000;

/**
 * Consecutive empty searches before Control Center is run to turn the API on.
 *
 * A few ticks of grace first, so a machine that is still finishing logon - or a
 * user who is opening Control Center themselves - is left alone.
 */
const ARM_AFTER_MISSES = 3;

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
	readonly #armer: ControlCenterArmer;
	readonly #events: DiscoveryEvents;

	#manualPort: number | undefined;
	#lastKnownPort: number | undefined;
	#current: number | undefined;
	#timer: NodeJS.Timeout | undefined;
	#searching = false;
	#misses = 0;

	constructor(events: DiscoveryEvents, armer: ControlCenterArmer = new ControlCenterArmer()) {
		this.#events = events;
		this.#armer = armer;
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
		this.#misses = 0;
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
			await this.#locate();
			if (this.#current !== undefined) {
				this.#misses = 0;
				return;
			}

			// Nothing is listening. After a reboot that is the normal state:
			// Control Center's agent is running but has not started the HTTP
			// server, and only Control Center itself will start it. Run it once,
			// then look again straight away rather than waiting a tick.
			this.#misses += 1;
			if (this.#misses >= ARM_AFTER_MISSES && (await this.#armer.arm())) {
				this.#misses = 0;
				this.#finder.forget();
				await this.#locate();
			}
		} finally {
			this.#searching = false;
		}
	}

	/** One pass of finding, or re-confirming, the API. */
	async #locate(): Promise<void> {
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
