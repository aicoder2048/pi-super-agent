/**
 * What a private feed's `line` lets off this machine. Every value is someone else's text (a mail's sender,
 * subject, first sentence), so it is cleaned here, at the host's edge, and clipped instead of refused.
 */

export const LINE_MAX_LINES = 3;
const LINE_GRAPHEMES = 160;
/** A grapheme can carry any number of combining marks, so a line is also capped in UTF-16 units. */
const LINE_UNITS = 600;
const ELLIPSIS = "…";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const clean = (value: string) =>
	value
		.replace(/\p{Cf}/gu, "")
		.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.trim();

function clip(text: string, graphemes: number): string {
	const parts: string[] = [];
	for (const { segment } of segmenter.segment(text)) if (parts.push(segment) > graphemes) break;
	if (parts.length <= graphemes && text.length <= LINE_UNITS) return text;
	let kept = "";
	for (const part of parts.slice(0, graphemes - 1)) {
		if (kept.length + part.length > LINE_UNITS - ELLIPSIS.length) break;
		kept += part;
	}
	return kept + ELLIPSIS;
}

export const oneLine = (text: string, graphemes: number): string => clip(clean(text), graphemes);

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export const placeholders = (template: string): string[] => [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);

export const fill = (template: string, fields: Readonly<Record<string, string>>): string => template.replace(PLACEHOLDER, (_, key: string) => (Object.hasOwn(fields, key) ? fields[key]! : ""));

export function release(template: string, fields: Readonly<Record<string, string>>): string {
	const cleaned = Object.fromEntries(placeholders(template).flatMap((key) => (Object.hasOwn(fields, key) ? [[key, clean(fields[key]!)]] : [])));
	return template
		.split("\n")
		.slice(0, LINE_MAX_LINES)
		.map((line) => clip(fill(line, cleaned), LINE_GRAPHEMES))
		.join("\n");
}
