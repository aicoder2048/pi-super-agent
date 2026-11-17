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

export function openPositions(rows: readonly FeedRow[]): { positions: Position[]; notes: string[] } {
	const { items, notes } = facts(rows.map((r) => ({ ...r.fields, _id: Number(r.id) })));
	const open = pieces(items, (account) => account).pieces.filter((p) => p.close === null);
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
		const openedOn = group.map((p) => p.lot.date).sort()[0]!;
		const side = lot.side === "STO" ? "short" : "long";
		return { key: `${lot.account}|${lot.symbol}|${side}|${openedOn}`, account: lot.account, occ: lot.symbol, underlying: lot.underlying, right: lot.right, strike: Number(lot.strike) / UNIT, expiry: lot.expiry, side, qty: Number(qty), openPrice: Number(amount / qty) / UNIT, openedOn };
	});
	return { positions, notes };
}
