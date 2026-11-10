import { oneLine } from "../client/board-format.mjs";

export const QUOTE_MAX_CHARS = 200;

/**
 * The stored form of a quoted line: one line (see oneLine), so no quoted text can start a new line of a Router card or
 * a new [label] block of a helper input; then at most QUOTE_MAX_CHARS characters, "…" when cut.
 */
export function quoteSnapshot(text: string): string {
	const chars = [...oneLine(text)];
	return chars.length <= QUOTE_MAX_CHARS ? chars.join("") : `${chars.slice(0, QUOTE_MAX_CHARS).join("")}…`;
}
