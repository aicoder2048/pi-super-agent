/** Open option positions from the `fills` rows the feed reads, through the ledger's own FIFO lots, so the two never disagree. */
import { facts, pieces } from "../../tools/ledger/index.ts";

export type FeedRow = { id: string; fields: Readonly<Record<string, unknown>> };

/** One account's open lots of one contract on one side. `key` changes when the position is closed and opened again. */
export type Position = {
	key: string;
	account: string;
	occ: string;
	underlying: string;
	right: "put" | "call";
	strike: number;
	expiry: string;
	side: "short" | "long";
	qty: number;
	/** Per share, weighted by the open lots' quantities. */
	openPrice: number;
	openedOn: string;
};

const UNIT = 10_000;

type Pieces = ReturnType<typeof pieces>["pieces"];

/**
 * The date each account, contract and side last went from flat to open. A partial close leaves it as it was, so the
 * position's key and its once-only alerts stay the same until the position is closed out and opened again.
 */
function runStarts(all: Pieces): Map<string, string> {
	const steps = new Map<string, { date: string; row: number; qty: bigint }[]>();
	const lots = new Set<Pieces[number]["lot"]>();
	const at = (lot: Pieces[number]["lot"]) => `${lot.account}|${lot.symbol}|${lot.side === "STO" ? "short" : "long"}`;
	for (const p of all) {
		const list = steps.get(at(p.lot)) ?? [];
		steps.set(at(p.lot), list);
		if (!lots.has(p.lot)) {
			lots.add(p.lot);
			list.push({ date: p.lot.date, row: p.lot.row, qty: p.lot.qty });
		}
		if (p.close !== null) list.push({ date: p.close.date, row: p.close.row, qty: -p.qty });
	}
	const starts = new Map<string, string>();
	for (const [key, list] of steps) {
		let held = 0n;
		for (const step of list.sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row)) {
			if (held === 0n && step.qty > 0n) starts.set(key, step.date);
			held += step.qty;
		}
	}
	return starts;
}

export function openPositions(rows: readonly FeedRow[]): { positions: Position[]; notes: string[] } {
	const { items, notes } = facts(rows.map((r) => ({ ...r.fields, _id: Number(r.id) })));
	const all = pieces(items, (account) => account).pieces;
	const open = all.filter((p) => p.close === null);
	const runStart = runStarts(all);
	const groups = new Map<string, typeof open>();
	for (const p of open) {
		const side = p.lot.side === "STO" ? "short" : "long";
		const at = `${p.lot.account}|${p.lot.symbol}|${side}`;
		groups.set(at, [...(groups.get(at) ?? []), p]);
	}
	const positions = [...groups.values()].map((group): Position => {
		const { lot } = group[0]!;
		const qty = group.reduce((s, p) => s + p.qty, 0n);
		const amount = group.reduce((s, p) => s + p.qty * p.lot.price, 0n);
		const side = lot.side === "STO" ? "short" : "long";
		const openedOn = runStart.get(`${lot.account}|${lot.symbol}|${side}`)!;
		return { key: `${lot.account}|${lot.symbol}|${side}|${openedOn}`, account: lot.account, occ: lot.symbol, underlying: lot.underlying, right: lot.right, strike: Number(lot.strike) / UNIT, expiry: lot.expiry, side, qty: Number(qty), openPrice: Number(amount / qty) / UNIT, openedOn };
	});
	return { positions, notes };
}
