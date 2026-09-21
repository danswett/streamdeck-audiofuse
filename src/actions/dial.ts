import streamDeck, {
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	action
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { asBool, asNumber, fuse } from "../audiofuse/store";
import { MONITOR_VOLUME, formatParts, paramById, type ParamSpec } from "../audiofuse/params";
import { type DialFace, fractionOf, renderDial, toPixmap } from "../render";

const logger = streamDeck.logger.createScope("dial");

const LAYOUT = "layouts/fuse.json";

/**
 * Floor on how often a panel is repainted.
 *
 * Detents and events both arrive faster than the LCD usefully updates, and
 * every repaint is a round trip to Stream Deck. Painting on the leading edge
 * keeps the dial feeling immediate, and the trailing paint guarantees the
 * settled value is the one left on screen.
 */
const PAINT_MS = 60;

export type DialSettings = {
	/** Parameter id from the registry, e.g. "monitor.volume". */
	target?: string;
	/** Units moved per detent. Overrides the parameter's own default. */
	step?: number;
	press?: "mute" | "reset" | "reference" | "none";
};

type Instance = {
	readonly dial: DialAction<DialSettings & JsonObject>;
	unwatch: (() => void)[];
	painted?: string;
	settings: DialSettings;
	paintTimer?: NodeJS.Timeout;
	lastPaint?: number;
};

/**
 * One dial action that drives any parameter.
 *
 * A single configurable action rather than one per parameter: the device has
 * six encoders but well over thirty continuous parameters, so fixing the
 * mapping in the manifest would make most of them unreachable.
 */
@action({ UUID: "com.dswett.audiofuse.dial" })
export class FuseDialAction extends SingletonAction<DialSettings & JsonObject> {
	readonly #instances = new Map<string, Instance>();
	#unwatchStatus: (() => void) | undefined;

	override onWillAppear(ev: WillAppearEvent<DialSettings & JsonObject>): void {
		if (!ev.action.isDial()) return;

		const instance: Instance = { dial: ev.action, unwatch: [], settings: ev.payload.settings ?? {} };
		this.#instances.set(ev.action.id, instance);

		if (!this.#unwatchStatus) {
			this.#unwatchStatus = fuse.watchStatus(() => this.#paintAll());
		}

		void ev.action
			.setFeedbackLayout(LAYOUT)
			.catch((err) => logger.warn(`setFeedbackLayout failed: ${String(err)}`))
			.then(() => {
				instance.painted = undefined;
				this.#bind(instance);
			});
	}

	override onWillDisappear(ev: WillDisappearEvent<DialSettings & JsonObject>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) return;
		for (const off of instance.unwatch) off();
		if (instance.paintTimer) clearTimeout(instance.paintTimer);
		this.#instances.delete(ev.action.id);

		if (this.#instances.size === 0) {
			this.#unwatchStatus?.();
			this.#unwatchStatus = undefined;
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<DialSettings & JsonObject>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) return;
		instance.settings = ev.payload.settings ?? {};
		instance.painted = undefined;
		this.#bind(instance);
	}

	/** Re-points an instance's watchers at whatever parameter it now targets. */
	#bind(instance: Instance): void {
		for (const off of instance.unwatch) off();
		instance.unwatch = [];

		const spec = this.#spec(instance);
		if (spec) {
			logger.info(`dial ${instance.dial.coordinates?.column ?? "?"} drives ${spec.id}`);
			instance.unwatch.push(fuse.watch(spec.path, () => this.#paint(instance)));
		}

		// The mute badge is drawn on the monitor dial, so it has to follow mute
		// even though mute is not the dial's own parameter.
		if (spec?.id === MONITOR_VOLUME.id) {
			instance.unwatch.push(fuse.watch("/monitoring/mute", () => this.#paint(instance)));
		}

		this.#paint(instance);
	}

	#spec(instance: Instance): ParamSpec | undefined {
		return paramById(instance.settings.target) ?? MONITOR_VOLUME;
	}

	#step(instance: Instance, spec: ParamSpec): number {
		const configured = Number(instance.settings.step);
		if (Number.isFinite(configured) && configured > 0) return configured;
		return spec.range?.step ?? 1;
	}

	// -- interaction --------------------------------------------------------

	override onDialRotate(ev: DialRotateEvent<DialSettings & JsonObject>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance || !fuse.ready) return;

		const spec = this.#spec(instance);
		if (!spec?.range) return;

		const current = asNumber(fuse.value(spec.path)) ?? spec.range.min;
		const delta = ev.payload.ticks * this.#step(instance, spec);
		const next = spec.kind === "integer" ? Math.round(current + ev.payload.ticks) : current + delta;

		fuse.set(spec, next);
	}

	override onDialDown(ev: DialDownEvent<DialSettings & JsonObject>): void {
		this.#press(ev.action.id);
	}

	override onTouchTap(ev: TouchTapEvent<DialSettings & JsonObject>): void {
		this.#press(ev.action.id);
	}

	#press(id: string): void {
		const instance = this.#instances.get(id);
		if (!instance || !fuse.ready) return;

		const spec = this.#spec(instance);
		if (!spec) return;

		// Default to the behaviour that suits the parameter: muting is the
		// obvious press for the monitor, and a reset for everything else.
		const mode = instance.settings.press ?? (spec.id === MONITOR_VOLUME.id ? "mute" : "reset");

		if (mode === "none") return;
		if (mode === "mute") {
			fuse.setBool("/monitoring/mute", !asBool(fuse.value("/monitoring/mute")));
			return;
		}
		if (mode === "reference") {
			const reference = asNumber(fuse.value("/monitoring/reference_level"));
			if (reference !== undefined) fuse.set(MONITOR_VOLUME, reference);
			return;
		}
		if (spec.resetTo !== undefined) fuse.set(spec, spec.resetTo);
	}

	// -- painting -----------------------------------------------------------

	#paintAll(): void {
		for (const instance of this.#instances.values()) this.#paint(instance);
	}

	/** Paints now if the panel is due, otherwise schedules the trailing frame. */
	#paint(instance: Instance): void {
		const since = Date.now() - (instance.lastPaint ?? 0);
		if (since >= PAINT_MS) {
			this.#paintNow(instance);
			return;
		}
		if (instance.paintTimer) return;
		instance.paintTimer = setTimeout(() => {
			instance.paintTimer = undefined;
			this.#paintNow(instance);
		}, PAINT_MS - since);
	}

	#paintNow(instance: Instance): void {
		instance.lastPaint = Date.now();
		const face = this.#face(instance);
		// Stream Deck redraws on every setFeedback, so identical frames are
		// dropped rather than sent.
		const signature = JSON.stringify(face);
		if (instance.painted === signature) return;
		instance.painted = signature;

		void instance.dial.setFeedback({ canvas: toPixmap(renderDial(face)) }).catch((err) => {
			instance.painted = undefined;
			logger.warn(`setFeedback failed: ${String(err)}`);
		});
	}

	#face(instance: Instance): DialFace {
		const spec = this.#spec(instance);
		const status = fuse.snapshot;

		if (!spec) return { label: "AudioFuse", value: "--", offline: true };
		if (status.state !== "ready") {
			return {
				label: spec.label,
				value: status.state === "discovering" ? "No API" : "...",
				offline: true
			};
		}

		const raw = fuse.value(spec.path);
		if (raw === undefined) return { label: spec.label, value: "--", offline: true };

		const numeric = asNumber(raw);
		const range = spec.range;
		const muted = spec.id === MONITOR_VOLUME.id && asBool(fuse.value("/monitoring/mute"));
		const { text, unit } = formatParts(raw, spec);

		return {
			label: spec.label,
			value: text,
			unit,
			fraction: numeric !== undefined && range ? fractionOf(numeric, range.min, range.max) : undefined,
			muted,
			badge: muted ? "MUTE" : undefined
		};
	}
}
