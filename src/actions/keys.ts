import streamDeck, {
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	action
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { asBool, asNumber, fuse } from "../audiofuse/store";
import { MONITOR_VOLUME, type ParamSpec, toggleById } from "../audiofuse/params";
import { type KeyFace, renderKey, toKeyImage } from "../render";

const logger = streamDeck.logger.createScope("keys");

type KeySettings = JsonObject;

type Instance<T extends KeySettings> = {
	readonly key: KeyAction<T>;
	unwatch: (() => void)[];
	painted?: string;
	settings: T;
};

/**
 * Shared plumbing for keys that mirror device state.
 *
 * Every key here is a live indicator, not a fire-and-forget button: it watches
 * the endpoints it displays so a change made in Control Center, on the device's
 * own controls, or by another client is reflected straight away.
 */
abstract class WatchedKeyAction<T extends KeySettings> extends SingletonAction<T> {
	readonly #instances = new Map<string, Instance<T>>();
	#unwatchStatus: (() => void) | undefined;

	/** Endpoints this instance's appearance depends on. */
	protected abstract endpoints(settings: T): readonly string[];

	protected abstract face(settings: T): KeyFace;

	protected abstract press(settings: T): void;

	override onWillAppear(ev: WillAppearEvent<T>): void {
		if (!ev.action.isKey()) return;

		const instance: Instance<T> = { key: ev.action, unwatch: [], settings: ev.payload.settings };
		this.#instances.set(ev.action.id, instance);
		logger.info(`${this.manifestId ?? "key"} appeared`);

		if (!this.#unwatchStatus) {
			this.#unwatchStatus = fuse.watchStatus(() => {
				for (const each of this.#instances.values()) this.#paint(each);
			});
		}

		this.#bind(instance);
	}

	override onWillDisappear(ev: WillDisappearEvent<T>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) return;
		for (const off of instance.unwatch) off();
		this.#instances.delete(ev.action.id);

		if (this.#instances.size === 0) {
			this.#unwatchStatus?.();
			this.#unwatchStatus = undefined;
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) return;
		instance.settings = ev.payload.settings;
		instance.painted = undefined;
		this.#bind(instance);
	}

	override onKeyDown(ev: KeyDownEvent<T>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) {
			logger.warn(`${this.manifestId ?? "key"} pressed but never appeared`);
			return;
		}
		if (!fuse.ready) {
			logger.warn(`${this.manifestId ?? "key"} pressed while ${fuse.snapshot.state}`);
			return;
		}
		logger.info(`${this.manifestId ?? "key"} pressed`);
		this.press(instance.settings);
	}

	#bind(instance: Instance<T>): void {
		for (const off of instance.unwatch) off();
		instance.unwatch = this.endpoints(instance.settings).map((path) =>
			fuse.watch(path, () => this.#paint(instance))
		);
		this.#paint(instance);
	}

	#paint(instance: Instance<T>): void {
		const face = fuse.ready ? this.face(instance.settings) : { ...this.face(instance.settings), offline: true };
		const signature = JSON.stringify(face);
		if (instance.painted === signature) return;
		instance.painted = signature;

		void instance.key.setImage(toKeyImage(renderKey(face))).catch((err) => {
			instance.painted = undefined;
			logger.warn(`setImage failed: ${String(err)}`);
		});
	}
}

// -- monitor toggles --------------------------------------------------------

/**
 * One self-contained key per monitor switch.
 *
 * Deliberately four named actions rather than one configurable "Monitor
 * Toggle": the deck has plenty of keys, and a key whose purpose is only visible
 * after opening its settings is not discoverable. Mute is Mute in the list.
 */
abstract class MonitorToggleAction extends WatchedKeyAction<KeySettings> {
	protected abstract readonly id: string;
	protected abstract readonly tint: string;

	#spec(): ParamSpec | undefined {
		return toggleById(this.id);
	}

	protected override endpoints(): readonly string[] {
		const spec = this.#spec();
		return spec ? [spec.path] : [];
	}

	protected override face(): KeyFace {
		const spec = this.#spec();
		if (!spec) return { label: "?", active: false };
		return { label: spec.label.toUpperCase(), active: asBool(fuse.value(spec.path)), tint: this.tint };
	}

	protected override press(): void {
		const spec = this.#spec();
		if (!spec) return;
		fuse.setBool(spec.path, !asBool(fuse.value(spec.path)));
	}
}

/** Mutes the main monitor output. */
@action({ UUID: "com.bad-duck.audiofuse.mute" })
export class FuseMuteAction extends MonitorToggleAction {
	protected override readonly id = "monitor.mute";
	protected override readonly tint = "#ff4f4f";
}

/** Drops the monitors by the device's dim amount. */
@action({ UUID: "com.bad-duck.audiofuse.dim" })
export class FuseDimAction extends MonitorToggleAction {
	protected override readonly id = "monitor.dim";
	protected override readonly tint = "#ffb347";
}

/** Folds the monitor output to mono, for a mix sanity check. */
@action({ UUID: "com.bad-duck.audiofuse.mono" })
export class FuseMonoAction extends MonitorToggleAction {
	protected override readonly id = "monitor.mono";
	protected override readonly tint = "#ffb347";
}

/**
 * Switches between speaker sets A and B.
 *
 * Reads as the set currently selected rather than as on/off, because this is a
 * two-way selector and "A/B: off" would say nothing useful.
 */
@action({ UUID: "com.bad-duck.audiofuse.speakers" })
export class FuseSpeakerSetAction extends WatchedKeyAction<KeySettings> {
	protected override endpoints(): readonly string[] {
		return ["/monitoring/ab_speaker_set"];
	}

	protected override face(): KeyFace {
		const onB = asBool(fuse.value("/monitoring/ab_speaker_set"));
		return { label: onB ? "B" : "A", value: "SPEAKERS", active: onB, tint: "#31c8f0" };
	}

	protected override press(): void {
		fuse.setBool("/monitoring/ab_speaker_set", !asBool(fuse.value("/monitoring/ab_speaker_set")));
	}
}

// -- reference level --------------------------------------------------------

/**
 * Snaps the monitor to the calibrated reference level.
 *
 * The device reports whether it is currently at reference, so the key lights
 * up whenever the monitor happens to be there, however it got there.
 */
@action({ UUID: "com.bad-duck.audiofuse.reference" })
export class FuseReferenceAction extends WatchedKeyAction<KeySettings> {
	protected override endpoints(): readonly string[] {
		return ["/monitoring/is_at_reference_level", "/monitoring/reference_level"];
	}

	protected override face(): KeyFace {
		const at = asBool(fuse.value("/monitoring/is_at_reference_level"));
		const level = asNumber(fuse.value("/monitoring/reference_level"));
		return {
			label: "REF",
			value: level === undefined ? undefined : `${level.toFixed(0)} dB`,
			active: at,
			tint: "#7ee081"
		};
	}

	protected override press(): void {
		const level = asNumber(fuse.value("/monitoring/reference_level"));
		if (level !== undefined) fuse.set(MONITOR_VOLUME, level);
	}
}

// -- presets ----------------------------------------------------------------

type PresetSettings = { slot?: number } & JsonObject;

/**
 * Recalls one of the eight preset slots (16Rig only).
 *
 * Recalling rewrites most of the device state, and the server pushes only the
 * slot and name, so the store re-reads everything on screen when the slot
 * changes rather than trusting the event alone.
 */
@action({ UUID: "com.bad-duck.audiofuse.preset" })
export class FusePresetAction extends WatchedKeyAction<PresetSettings> {
	protected override endpoints(): readonly string[] {
		return ["/preset/slot", "/preset/names", "/preset/saved"];
	}

	protected override face(settings: PresetSettings): KeyFace {
		const slot = this.#slot(settings);
		const current = asNumber(fuse.value("/preset/slot"));
		const names = fuse.value("/preset/names");
		const name = Array.isArray(names) ? String(names[slot - 1] ?? "") : "";
		const active = current === slot;
		// A loaded slot with unsaved edits is flagged, so the key never implies
		// the device matches the stored preset when it does not.
		const dirty = active && fuse.value("/preset/saved") !== undefined && !asBool(fuse.value("/preset/saved"));

		return {
			label: `${slot}${dirty ? "*" : ""}`,
			value: name.slice(0, 12) || undefined,
			active,
			tint: "#c08bff"
		};
	}

	protected override press(settings: PresetSettings): void {
		fuse.setRaw("/preset/slot", this.#slot(settings));
	}

	#slot(settings: PresetSettings): number {
		const slot = Number(settings.slot);
		return Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : 1;
	}
}
