/**
 * Tracks which endpoints are currently being driven from this plugin.
 *
 * Every write is echoed back by the device, but an echo describes a position
 * the control has already left: writes are paced to the hardware's rate limit
 * while input keeps arriving, so the echo lands several steps behind whatever
 * is now on screen. Applying it drags the reading backwards and the next local
 * change snaps it forward again, which reads as jitter.
 *
 * Claiming an endpoint makes local values authoritative for a short window.
 * Each change renews it, so it only lapses once the control settles - at which
 * point the device's own value, including any clamping it applied, is trusted
 * again.
 */
export class LocalHold {
	readonly #until = new Map<string, number>();
	readonly #ms: number;

	constructor(ms: number) {
		this.#ms = ms;
	}

	/** Takes, or renews, local control of an endpoint. */
	claim(path: string): void {
		this.#until.set(path, Date.now() + this.#ms);
	}

	/** True while local values for this endpoint outrank the device's. */
	holds(path: string): boolean {
		const until = this.#until.get(path);
		if (until === undefined) return false;
		if (Date.now() < until) return true;
		this.#until.delete(path);
		return false;
	}

	release(path: string): void {
		this.#until.delete(path);
	}

	clear(): void {
		this.#until.clear();
	}
}
