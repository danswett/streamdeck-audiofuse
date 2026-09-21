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

streamDeck.settings.onDidReceiveGlobalSettings(async () => {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	fuse.setManualPort(readPort(settings?.manualPort));
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
