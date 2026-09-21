/**
 * The catalogue of AudioFuse parameters this plugin can drive, and the facts
 * about each one that the shipped API documentation does not state correctly.
 *
 * Verified against AudioFuse Control Center HTTP API 1.0.0 on an AudioFuse
 * 16Rig. Where this file disagrees with the vendor documentation, the device
 * was the source of truth.
 */

export type FuseDeviceKind = "af16rig" | "afstudio";

/** A continuous parameter driven by a dial. */
export type RangeSpec = {
	readonly min: number;
	readonly max: number;
	/** dB moved per detent at normal speed. */
	readonly step: number;
	readonly unit: string;
};

export type ParamSpec = {
	readonly id: string;
	readonly label: string;
	/** Canonical endpoint path, without the /api/v1 prefix. */
	readonly path: string;
	readonly kind: "range" | "boolean" | "enum" | "integer" | "string";
	readonly range?: RangeSpec;
	/**
	 * Whether the server pushes this endpoint over SSE.
	 *
	 * Only /monitoring, /clock and /preset emit events. /input and /output are
	 * silent even when subscribed, which is why they have to be polled. The
	 * endpoint reference hints at this by omitting the SSE column from those
	 * two tables, but never says it outright.
	 */
	readonly sse: boolean;
	readonly devices: readonly FuseDeviceKind[];
	/** Value applied when the dial is pressed, where that is meaningful. */
	readonly resetTo?: number;
};

const BOTH: readonly FuseDeviceKind[] = ["af16rig", "afstudio"];
const RIG: readonly FuseDeviceKind[] = ["af16rig"];

/**
 * Master monitor volume. Measured range on a 16Rig: the server silently clamps
 * to -90 dB at the bottom and 0 dB at the top rather than returning an error.
 */
export const MONITOR_VOLUME: ParamSpec = {
	id: "monitor.volume",
	label: "Monitor",
	path: "/monitoring/volume",
	kind: "range",
	range: { min: -90, max: 0, step: 1, unit: "dB" },
	sse: true,
	devices: BOTH,
	resetTo: -20
};

export const REFERENCE_LEVEL: ParamSpec = {
	id: "monitor.reference_level",
	label: "Reference",
	path: "/monitoring/reference_level",
	kind: "range",
	range: { min: -90, max: 0, step: 1, unit: "dB" },
	sse: true,
	devices: RIG
};

/**
 * Preamp gain. The usable span depends on what the channel's source is set to:
 * a line input reads 0..12 dB, a mic preamp goes considerably higher. The
 * server clamps, so the wide bound here is safe - the device trims it and the
 * poller reports back what was actually applied.
 */
function inputGain(index: number): ParamSpec {
	return {
		id: `input.${index}.gain`,
		label: `In ${index}`,
		path: `/input/analog/${index}/gain`,
		kind: "range",
		range: { min: 0, max: 60, step: 1, unit: "dB" },
		sse: false,
		devices: BOTH,
		resetTo: 0
	};
}

/** Per-output trim. Outputs 1-2 are the mains and live under /monitoring. */
function outputVolume(index: number): ParamSpec {
	return {
		id: `output.${index}.volume`,
		label: `Out ${index}`,
		path: `/output/analog/${index}/volume`,
		kind: "range",
		range: { min: -60, max: 0, step: 1, unit: "dB" },
		sse: false,
		devices: RIG,
		resetTo: 0
	};
}

export const PRESET_SLOT: ParamSpec = {
	id: "preset.slot",
	label: "Preset",
	path: "/preset/slot",
	kind: "integer",
	range: { min: 1, max: 8, step: 1, unit: "" },
	sse: true,
	devices: RIG
};

export const SAMPLE_RATE: ParamSpec = {
	id: "clock.sample_rate",
	label: "Sample Rate",
	path: "/clock/sample_rate",
	kind: "enum",
	sse: true,
	devices: BOTH
};

/** Every dial-assignable target, in the order the Property Inspector lists them. */
export const DIAL_TARGETS: readonly ParamSpec[] = [
	MONITOR_VOLUME,
	REFERENCE_LEVEL,
	...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(inputGain),
	...[3, 4, 5, 6, 7, 8, 9, 10].map(outputVolume),
	PRESET_SLOT,
	SAMPLE_RATE
];

const BY_ID = new Map(DIAL_TARGETS.map((p) => [p.id, p]));

export function paramById(id: string | undefined): ParamSpec | undefined {
	return id ? BY_ID.get(id) : undefined;
}

/** Monitor switches exposed as keys, all of which push over SSE. */
export const MONITOR_TOGGLES: readonly ParamSpec[] = [
	{ id: "monitor.mute", label: "Mute", path: "/monitoring/mute", kind: "boolean", sse: true, devices: BOTH },
	{ id: "monitor.dim", label: "Dim", path: "/monitoring/dim", kind: "boolean", sse: true, devices: BOTH },
	{ id: "monitor.mono", label: "Mono", path: "/monitoring/mono", kind: "boolean", sse: true, devices: BOTH },
	{
		id: "monitor.ab_speaker_set",
		label: "A/B",
		path: "/monitoring/ab_speaker_set",
		kind: "boolean",
		sse: true,
		devices: BOTH
	}
];

const TOGGLES_BY_ID = new Map(MONITOR_TOGGLES.map((p) => [p.id, p]));

export function toggleById(id: string | undefined): ParamSpec | undefined {
	return id ? TOGGLES_BY_ID.get(id) : undefined;
}

/**
 * Every endpoint worth subscribing to. Sent wholesale because the server
 * ignores endpoints that the connected device does not expose, so there is no
 * benefit to tailoring the list per model.
 */
export const SSE_ENDPOINTS: readonly string[] = [
	"/monitoring/mute",
	"/monitoring/dim",
	"/monitoring/mono",
	"/monitoring/volume",
	"/monitoring/ab_speaker_set",
	"/monitoring/reference_level",
	"/monitoring/is_at_reference_level",
	"/clock/sample_rate",
	"/clock/current_source",
	"/clock/preferred_source",
	"/clock/sync",
	"/preset/slot",
	"/preset/name",
	"/preset/saved"
];

/**
 * A device is a 16Rig if it answers /preset/names, which the Studio does not
 * implement. Serial numbers carry no model marker we can rely on.
 */
export function clampToRange(value: number, spec: ParamSpec): number {
	const range = spec.range;
	if (!range) return value;
	return Math.min(range.max, Math.max(range.min, value));
}

/** Splits an endpoint into the parent to POST to and the field name to send. */
export function splitEndpoint(path: string): { parent: string; field: string } {
	const cut = path.lastIndexOf("/");
	return { parent: path.slice(0, cut), field: path.slice(cut + 1) };
}

/**
 * Splits a reading into the number and its unit.
 *
 * Kept apart so the panel can pin each one independently; a single string
 * would have to be centred, and centring makes the text slide sideways every
 * time the reading gains or loses a digit.
 */
export function formatParts(value: unknown, spec: ParamSpec): { text: string; unit: string } {
	if (value === undefined || value === null) return { text: "--", unit: "" };
	if (spec.kind === "integer") return { text: String(value), unit: "" };
	if (spec.kind === "enum") {
		const hz = Number(value);
		return Number.isFinite(hz) ? { text: (hz / 1000).toFixed(1), unit: "kHz" } : { text: String(value), unit: "" };
	}

	const n = Number(value);
	if (!Number.isFinite(n)) return { text: String(value), unit: "" };
	// Device values land on 1/128 dB steps, so one decimal is the honest amount.
	const text = Math.abs(n) < 0.05 ? "0.0" : n.toFixed(1);
	return { text, unit: spec.range?.unit ?? "" };
}

export function formatValue(value: unknown, spec: ParamSpec): string {
	const { text, unit } = formatParts(value, spec);
	return unit ? `${text} ${unit}` : text;
}
