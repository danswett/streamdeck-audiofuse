/**
 * SVG rendering for the encoder LCD panels and the keys.
 *
 * The encoder strip gives each dial a 200x100 region, painted as a single
 * pixmap so the layout is ours rather than one of the stock arrangements.
 */

const LCD_W = 200;
const LCD_H = 100;

const INK = "#f4f4f5";
const DIM_INK = "#8b8b93";
const ACCENT = "#31c8f0";
const WARN = "#ff4f4f";
const TRACK = "#2c2c31";

export function toPixmap(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type DialFace = {
	readonly label: string;
	readonly value: string;
	/** Drawn small, at a fixed position, so the number never shifts under it. */
	readonly unit?: string;
	/** Fill fraction of the bar, 0..1. Omit for non-continuous parameters. */
	readonly fraction?: number;
	readonly muted?: boolean;
	readonly offline?: boolean;
	readonly badge?: string;
};

/** Right edge of the number, and where the unit begins after it. */
const VALUE_RIGHT = 124;
const UNIT_LEFT = 132;

/**
 * Paints one encoder panel: name on top, value large in the middle, and a
 * fill bar keyed to the parameter's real range.
 *
 * The number is right-aligned against a fixed edge rather than centred. Every
 * reading is formatted to one decimal, so pinning the right edge pins the
 * decimal point too, and gaining a digit grows the number leftwards instead of
 * sliding the whole string sideways on each update.
 */
export function renderDial(face: DialFace): string {
	const label = escapeText(face.label.toUpperCase());
	const value = escapeText(face.value);
	const colour = face.offline ? DIM_INK : face.muted ? WARN : INK;
	const barColour = face.offline ? TRACK : face.muted ? WARN : ACCENT;

	const barWidth = 168;
	const barX = (LCD_W - barWidth) / 2;
	const fraction = Math.min(1, Math.max(0, face.fraction ?? 0));
	const fill = Math.round(barWidth * fraction);

	const bar =
		face.fraction === undefined
			? ""
			: `<rect x="${barX}" y="74" width="${barWidth}" height="8" rx="4" fill="${TRACK}"/>` +
				(fill > 0 ? `<rect x="${barX}" y="74" width="${fill}" height="8" rx="4" fill="${barColour}"/>` : "");

	const reading = face.unit
		? `<text x="${VALUE_RIGHT}" y="58" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="34" font-weight="700" fill="${colour}">${value}</text>` +
			`<text x="${UNIT_LEFT}" y="58" text-anchor="start" font-family="Segoe UI, sans-serif" font-size="19" font-weight="600" fill="${face.offline ? DIM_INK : colour}" opacity="0.7">${escapeText(face.unit)}</text>`
		: `<text x="${LCD_W / 2}" y="58" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="34" font-weight="700" fill="${colour}">${value}</text>`;

	const badge = face.badge
		? `<text x="${LCD_W - 10}" y="22" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="14" font-weight="600" fill="${WARN}">${escapeText(face.badge)}</text>`
		: "";

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${LCD_W}" height="${LCD_H}" viewBox="0 0 ${LCD_W} ${LCD_H}">
<rect width="${LCD_W}" height="${LCD_H}" fill="#121215"/>
<text x="10" y="22" font-family="Segoe UI, sans-serif" font-size="14" font-weight="600" fill="${DIM_INK}" letter-spacing="1.2">${label}</text>
${badge}
${reading}
${bar}
</svg>`;
}

const KEY = 144;

export type KeyFace = {
	readonly label: string;
	readonly value?: string;
	readonly active: boolean;
	readonly offline?: boolean;
	/** Colour used when the key is engaged. */
	readonly tint?: string;
};

/** Paints a toggle key: engaged state is a filled tile, idle is an outline. */
export function renderKey(face: KeyFace): string {
	const tint = face.tint ?? ACCENT;
	const offline = face.offline === true;
	const background = offline ? "#121215" : face.active ? tint : "#17171b";
	const stroke = offline ? "#2a2a30" : face.active ? tint : "#34343c";
	const ink = offline ? "#5a5a63" : face.active ? "#08080a" : INK;

	const value = face.value
		? `<text x="${KEY / 2}" y="104" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="20" font-weight="600" fill="${ink}" opacity="0.85">${escapeText(face.value)}</text>`
		: "";
	const labelY = face.value ? 70 : 82;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}" viewBox="0 0 ${KEY} ${KEY}">
<rect x="8" y="8" width="${KEY - 16}" height="${KEY - 16}" rx="18" fill="${background}" stroke="${stroke}" stroke-width="3"/>
<text x="${KEY / 2}" y="${labelY}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="26" font-weight="700" fill="${ink}">${escapeText(face.label)}</text>
${value}
</svg>`;
}

/** Fraction of a parameter's span, used to fill the LCD bar. */
export function fractionOf(value: number, min: number, max: number): number {
	if (max === min) return 0;
	return Math.min(1, Math.max(0, (value - min) / (max - min)));
}
