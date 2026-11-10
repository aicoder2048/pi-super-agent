import { oneLine } from "../client/board-format.mjs";

export const QUOTE_MAX_CHARS = 200;

export function quoteSnapshot(text: string): string {
	const chars = [...oneLine(text)];
	return chars.length <= QUOTE_MAX_CHARS ? chars.join("") : `${chars.slice(0, QUOTE_MAX_CHARS).join("")}…`;
}
