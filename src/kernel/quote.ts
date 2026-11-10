export const QUOTE_MAX_CHARS = 200;

const CONTROL = /[^\P{Cc}\s]/gu;

/**
 * The stored form of a quoted line: invisible controls dropped, every whitespace run one space, so no quoted text can
 * start a new line of a Router card or a new [label] block of a helper input; then at most QUOTE_MAX_CHARS characters, "…" when cut.
 */
export function quoteSnapshot(text: string): string {
	const chars = [...text.replace(CONTROL, "").replace(/\s+/gu, " ").trim()];
	return chars.length <= QUOTE_MAX_CHARS ? chars.join("") : `${chars.slice(0, QUOTE_MAX_CHARS).join("")}…`;
}
