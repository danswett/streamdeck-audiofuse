import streamDeck from "@elgato/streamdeck";

import { FuseDialAction } from "./actions/dial";
import {
	FuseDimAction,
	FuseMonoAction,
	FuseMuteAction,
	FusePresetAction,
	FuseReferenceAction,
	FuseSpeakerSetAction
} from "./actions/keys";
import { fuse } from "./audiofuse/store";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new FuseDialAction());
streamDeck.actions.registerAction(new FuseMuteAction());
streamDeck.actions.registerAction(new FuseDimAction());
streamDeck.actions.registerAction(new FuseMonoAction());
streamDeck.actions.registerAction(new FuseSpeakerSetAction());
streamDeck.actions.registerAction(new FuseReferenceAction());
streamDeck.actions.registerAction(new FusePresetAction());

type GlobalSettings = {
	/** Pins the port instead of searching for it. */
	manualPort?: number;
	/** Last port the API answered on, tried first on the next launch. */
	lastKnownPort?: number;
};

function readPort(value: unknown): number | undefined {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/**
 * Applies a port pinned in the Property Inspector.
 *
 * The settings arrive on the event itself, and must be read from there. Calling
 * getGlobalSettings() in this handler instead is a runaway loop: Stream Deck
 * answers every request with a didReceiveGlobalSettings, which re-enters this
 * handler, which requests again. The SDK suppresses the echo only when
 * useExperimentalMessageIdentifiers is enabled, which it is not by default, so
 * the loop is uncapped - it settles at roughly 385 round trips a second, and
 * the cost lands on Stream Deck rather than here: the host burns a full core
 * serialising replies and leaks about 2 GB an hour while the plugin sits idle.
 */
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
	fuse.setManualPort(readPort(ev.settings?.manualPort));
});

// Connect first: both the settings and the remembered port come from the host.
await streamDeck.connect();

const initial = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
fuse.start(readPort(initial?.lastKnownPort));
fuse.setManualPort(readPort(initial?.manualPort));

/**
 * Remembers the working port.
 *
 * Control Center reallocates its port between sessions, so the plugin has to
 * hunt for it. Writing the last good one back means the next launch confirms it
 * on the first probe instead of scanning every listener on the machine.
 */
let remembered = readPort(initial?.lastKnownPort);
setInterval(() => {
	void (async () => {
		const port = fuse.lastKnownPort;
		if (port === undefined || port === remembered) return;
		remembered = port;
		const current = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		await streamDeck.settings.setGlobalSettings({ ...current, lastKnownPort: port });
	})();
}, 30_000);
