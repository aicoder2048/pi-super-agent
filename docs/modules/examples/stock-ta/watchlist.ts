export type WatchRow = { id: string; fields: { symbol?: unknown; removedAt?: unknown } };

/** In the order symbols were first added; the latest row of a symbol says whether it is removed. */
export function listedSymbols(rows: readonly WatchRow[]): string[] {
	const removed = new Map<string, boolean>();
	for (const row of [...rows].sort((x, y) => Number(x.id) - Number(y.id))) {
		const symbol = String(row.fields.symbol ?? "").trim().toUpperCase();
		if (symbol !== "") removed.set(symbol, Boolean(row.fields.removedAt));
	}
	return [...removed].filter(([, out]) => !out).map(([symbol]) => symbol);
}
