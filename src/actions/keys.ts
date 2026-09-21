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
import { MONITOR_VOLUME, toggleById } from "../audiofuse/params";
import { type KeyFace, renderKey } from "../render";

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
		if (!instance || !fuse.ready) return;
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

		void instance.key.setImage(renderKey(face)).catch((err) => {
			instance.painted = undefined;
			logger.warn(`setImage failed: ${String(err)}`);
		});
	}
}

// -- monitor toggles --------------------------------------------------------

type ToggleSettings = { target?: string } & JsonObject;

/** Mute, dim, mono and A/B speaker switching, all of which push over SSE. */
@action({ UUID: "com.dswett.audiofuse.monitor" })
export class FuseMonitorToggleAction extends WatchedKeyAction<ToggleSettings> {
	protected override endpoints(settings: ToggleSettings): readonly string[] {
		const spec = toggleById(settings.target) ?? toggleById("monitor.mute");
		return spec ? [spec.path] : [];
	}

	protected override face(settings: ToggleSettings): KeyFace {
		const spec = toggleById(settings.target) ?? toggleById("monitor.mute");
		if (!spec) return { label: "?", active: false };

		const active = asBool(fuse.value(spec.path));
		// A/B is a selector rather than an on/off, so it reads as A or B.
		if (spec.id === "monitor.ab_speaker_set") {
			return { label: active ? "B" : "A", value: "SPEAKERS", active, tint: "#31c8f0" };
		}
		return { label: spec.label.toUpperCase(), active, tint: spec.id === "monitor.mute" ? "#ff4f4f" : "#ffb347" };
	}

	protected override press(settings: ToggleSettings): void {
		const spec = toggleById(settings.target) ?? toggleById("monitor.mute");
		if (!spec) return;
		fuse.setBool(spec.path, !asBool(fuse.value(spec.path)));
	}
}

// -- reference level --------------------------------------------------------

/**
 * Snaps the monitor to the calibrated reference level.
 *
 * The device reports whether it is currently at reference, so the key lights
 * up whenever the monitor happens to be there, however it got there.
 */
@action({ UUID: "com.dswett.audiofuse.reference" })
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
@action({ UUID: "com.dswett.audiofuse.preset" })
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
