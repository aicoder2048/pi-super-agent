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

/** Drops format characters (zero-width, direction controls, BOM), then turns control characters, line and paragraph separators and runs of white space into one space. */
const clean = (value: string) =>
	value
		.replace(/\p{Cf}/gu, "")
		.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.trim();

/** Cut on grapheme boundaries, so an emoji is never split into half a surrogate pair. */
function clip(text: string, graphemes: number): string {
	if (text.length <= graphemes) return text;
	const kept: string[] = [];
	let length = 0;
	for (const { segment } of segmenter.segment(text)) {
		if (kept.length === graphemes || length + segment.length > LINE_UNITS) {
			let cut = kept.length;
			while (cut > 0 && (cut === graphemes || length + ELLIPSIS.length > LINE_UNITS)) length -= kept[--cut]!.length;
			return kept.slice(0, cut).join("") + ELLIPSIS;
		}
		kept.push(segment);
		length += segment.length;
	}
	return text;
}

export const oneLine = (text: string, graphemes: number): string => clip(clean(text), graphemes);

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export const placeholders = (template: string): string[] => [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);

/** `{{field}}` is replaced by the field's value, or by nothing. */
export const fill = (template: string, fields: Readonly<Record<string, string>>): string => template.replace(PLACEHOLDER, (_, key: string) => fields[key] ?? "");

/** Fills `template` with the cleaned values: at most three lines, each at most 160 graphemes. */
export function release(template: string, fields: Readonly<Record<string, string>>): string {
	const cleaned = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, clean(value)]));
	return template
		.split("\n")
		.slice(0, LINE_MAX_LINES)
		.map((line) => clip(fill(line, cleaned), LINE_GRAPHEMES))
		.join("\n");
}
