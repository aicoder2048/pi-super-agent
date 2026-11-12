import { clip, oneLine } from "../client/board-format.mjs";

export const QUOTE_MAX_CHARS = 200;

export function quoteSnapshot(text: string): string {
	return clip(oneLine(text), QUOTE_MAX_CHARS);
}
