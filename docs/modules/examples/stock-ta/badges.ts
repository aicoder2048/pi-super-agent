/**
 * Level 1 (design section 6, ADR-0028): a hit at level 1 is a mark on the module's card, never a line. The card keeps one badge per
 * symbol, so each symbol's badge lists every level-1 fact it has today, and a new level-1 hit sends the whole list again under a
 * new id. Both feeds call this with all of today's hits they know, so the scan's badge keeps the session's facts.
 */
type Graded = { symbol: string; date: string; at: string; fact: string; level: number; combo?: string };
export type BadgeAlert = { id: string; text: string; at: string; push: "badge"; key: string };

const badged = (h: Graded) => h.level === 1 && h.combo === undefined;

/** `fresh`: this beat's hits; only symbols with a new level-1 hit among them send a badge. */
export function badgeAlerts(today: readonly Graded[], fresh: readonly Graded[]): BadgeAlert[] {
	const symbols = [...new Set(fresh.filter(badged).map((h) => h.symbol))];
	return symbols.map((symbol) => {
		const mine = today.filter((h) => h.symbol === symbol && badged(h));
		const last = mine[mine.length - 1]!;
		return { id: `badge:${symbol}:${last.date}:${mine.length}`, text: [symbol, ...mine.map((h) => h.fact)].join(" · "), at: last.at, push: "badge", key: symbol };
	});
}
