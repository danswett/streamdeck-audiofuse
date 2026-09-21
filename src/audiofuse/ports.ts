import { exec } from "node:child_process";
import { promisify } from "node:util";

import streamDeck from "@elgato/streamdeck";

const run = promisify(exec);
const logger = streamDeck.logger.createScope("fuse-ports");

const PROBE_TIMEOUT_MS = 400;
const PROBE_CONCURRENCY = 24;

/**
 * Locates the Control Center HTTP server.
 *
 * The vendor documentation says to discover the port over DNS-SD. That works on
 * macOS, but on Windows the agent publishes no `_audiofusehttp._tcp` record at
 * all - browsing the local network returns every other responder on it and
 * nothing from Arturia - and Apple's Bonjour service is not present on a
 * typical Windows machine either. Relying on it there means never connecting.
 *
 * So the port is found by asking the operating system which loopback ports are
 * being listened on and asking each one whether it is the AudioFuse API. That
 * is slower than a service record but it is self-validating: a candidate is
 * only accepted once it answers /version, so it can never latch onto the wrong
 * process.
 */
export class PortFinder {
	#verified: number | undefined;

	get verified(): number | undefined {
		return this.#verified;
	}

	forget(): void {
		this.#verified = undefined;
	}

	/** Confirms a port is still the AudioFuse API. */
	async check(port: number): Promise<boolean> {
		const ok = await probe(port);
		if (ok) this.#verified = port;
		else if (this.#verified === port) this.#verified = undefined;
		return ok;
	}

	/**
	 * Finds the API, preferring ports already known to work.
	 *
	 * @param preferred Port to try first, e.g. the one used last session.
	 */
	async find(preferred?: number): Promise<number | undefined> {
		for (const port of [this.#verified, preferred]) {
			if (port !== undefined && (await probe(port))) {
				this.#verified = port;
				return port;
			}
		}

		const candidates = await listeningPorts();
		logger.debug(`probing ${candidates.length} loopback listeners`);

		for (let i = 0; i < candidates.length; i += PROBE_CONCURRENCY) {
			const batch = candidates.slice(i, i + PROBE_CONCURRENCY);
			const results = await Promise.all(batch.map(async (port) => ({ port, ok: await probe(port) })));
			const hit = results.find((r) => r.ok);
			if (hit) {
				logger.info(`found AudioFuse HTTP API on port ${hit.port}`);
				this.#verified = hit.port;
				return hit.port;
			}
		}

		return undefined;
	}
}

/** Asks a port whether it is the AudioFuse API. */
async function probe(port: number): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/v1/version`, { signal: controller.signal });
		if (!res.ok) return false;
		const body = (await res.json()) as { version?: string };
		return typeof body?.version === "string";
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Lists loopback TCP ports in the listening state, highest first.
 *
 * Control Center allocates from the ephemeral range, so descending order
 * reaches it within the first handful of probes in practice.
 */
async function listeningPorts(): Promise<number[]> {
	const ports = new Set<number>();

	try {
		const command =
			process.platform === "win32"
				? "netstat -ano -p TCP"
				: "lsof -nP -iTCP@127.0.0.1 -sTCP:LISTEN -Fn";
		const { stdout } = await run(command, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });

		for (const line of stdout.split(/\r?\n/)) {
			if (process.platform === "win32") {
				// "  TCP    127.0.0.1:60465    0.0.0.0:0    LISTENING    42712"
				if (!line.includes("LISTENING")) continue;
				const match = /\s(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)\s/.exec(line);
				if (match) ports.add(Number(match[1]));
			} else {
				const match = /^n.*:(\d+)$/.exec(line.trim());
				if (match) ports.add(Number(match[1]));
			}
		}
	} catch (err) {
		logger.warn(`could not list listening ports: ${String(err)}`);
	}

	return [...ports].filter((p) => p > 1024 && p < 65536).sort((a, b) => b - a);
}
