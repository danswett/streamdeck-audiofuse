import { vi } from "vitest";

/**
 * Stands in for the Stream Deck SDK.
 *
 * Importing the real module makes it read the registration arguments Stream
 * Deck passes on the command line and open a websocket back to the app, which
 * is not available in a test run. Only the logger is reached from the code
 * under test here.
 */
const noop = (): void => {};

const logger = {
	createScope: () => logger,
	setLevel: () => logger,
	trace: noop,
	debug: noop,
	info: noop,
	warn: noop,
	error: noop
};

vi.mock("@elgato/streamdeck", () => ({
	default: { logger },
	streamDeck: { logger },
	SingletonAction: class {},
	action: () => (target: unknown) => target
}));
