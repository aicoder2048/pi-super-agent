/**
 * Two views over the same raw fills and events (tax memo 14.2): a chain view of premium in and out, and a tax view of realized
 * option legs with marks. The tax view stays inside the first-version scope (tax memo 14.3): what needs stock lots, QCC or 1099-B
 * is marked 待确认, never decided. Reads data.db only.
 */
import { readCollections, type DbRow } from "../../data-db.ts";
import { divide, isIsoDate, price4, units } from "../../fills.ts";

type Input = { view?: unknown; year?: unknown; account_ref?: unknown; account_key?: unknown; chain_id?: unknown };
type Collections = { fills: readonly DbRow[]; chains: readonly DbRow[]; accounts: readonly DbRow[] };

type Open = "STO" | "BTO";
type Close = "BTC" | "STC" | "EXPIRE" | "ASSIGNED" | "EXERCISED";
type Base = { row: number; key: string; account: string; symbol: string; underlying: string; right: "put" | "call"; strike: bigint; expiry: string; multiplier: bigint; qty: bigint; date: string; taxClass: string };
/** `fee`: known commission plus fees of the whole row in 1/10000 USD, or null when either is unknown. */
type Fill = Base & { kind: "fill"; side: Open | "BTC" | "STC"; orderKey: string; price: bigint; fee: bigint | null };
type Event = Base & { kind: "event"; type: "EXPIRE" | "ASSIGNED" | "EXERCISED" | "CASH_SETTLED"; fee: bigint | null };
type Lot = { fill: Fill; left: bigint };
type Piece = { lot: Fill; qty: bigint; close: Fill | Event | null; owner: string };

const INDEX_ROOTS = new Set(["SPX", "SPXW", "NDX", "NDXP", "XND", "RUT", "RUTW", "MRUT", "VIX", "VIXW", "XSP", "DJX", "OEX", "XEO"]);
const SHORT_OPENS = new Set(["STO"]);
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const whole = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? BigInt(value) : undefined);

function cents(value: bigint): string {
	const c = divide(value < 0n ? -value : value, 100n);
	return `${value < 0n ? "-" : ""}${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
}

function feeOf(row: DbRow): bigint | null {
	const [commission, fees] = [row["commission"], row["fees"]].map((v) => (v === null || v === undefined || v === "" ? null : units(v)));
	return commission === null || fees === null || commission === undefined || fees === undefined ? null : commission + fees;
}

function parse(row: DbRow): Fill | Event | undefined {
	const account = text(row["account_ref"]);
	const symbol = text(row["option_symbol"]);
	const right = row["right"];
	const strike = units(row["strike"]);
	const multiplier = whole(row["multiplier"]);
	const qty = whole(row["qty"]);
	if (account === undefined || symbol === undefined || (right !== "put" && right !== "call") || strike === undefined || multiplier === undefined || qty === undefined || !isIsoDate(row["expiry"])) return undefined;
	const base = { row: Number(row["_id"]), account, symbol, underlying: text(row["underlying"]) ?? "", right, strike, expiry: row["expiry"] as string, multiplier, qty, taxClass: text(row["tax_class"]) ?? "", fee: feeOf(row) };
	const type = row["record_type"] ?? "FILL";
	if (type === "FILL") {
		const side = row["side"];
		const price = units(row["price"]);
		const id = text(row["fill_id"]);
		const orderKey = text(row["order_key"]);
		if (!["STO", "BTO", "BTC", "STC"].includes(side as string) || price === undefined || id === undefined || orderKey === undefined || !isIsoDate(row["trade_date"])) return undefined;
		return { ...base, kind: "fill", key: id, side: side as Fill["side"], orderKey, price, date: row["trade_date"] as string };
	}
	if (type === "EVENT") {
		const id = text(row["event_id"]);
		if (id === undefined || !["EXPIRE", "ASSIGNED", "EXERCISED", "CASH_SETTLED"].includes(row["type"] as string) || !isIsoDate(row["event_date"])) return undefined;
		return { ...base, kind: "event", key: id, type: row["type"] as Event["type"], date: row["event_date"] as string };
	}
	return undefined;
}

/** Facts in, plus what could not be read: rows without an account, unreadable rows, and repeated keys (counted once). */
function facts(rows: readonly DbRow[]) {
	const items: (Fill | Event)[] = [];
	const seen = new Set<string>();
	const duplicates: string[] = [];
	let missingAccount = 0;
	let unreadable = 0;
	for (const row of rows) {
		const type = row["record_type"] ?? "FILL";
		if (type !== "FILL" && type !== "EVENT") continue;
		if (text(row["account_ref"]) === undefined) {
			missingAccount++;
			continue;
		}
		const item = parse(row);
		if (item === undefined) {
			unreadable++;
			continue;
		}
		if (seen.has(item.key)) {
			duplicates.push(item.key);
			continue;
		}
		seen.add(item.key);
		items.push(item);
	}
	items.sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);
	const notes = [
		...(missingAccount > 0 ? [`${missingAccount} 行缺账户，没有算进链和税务视图，要问使用者`] : []),
		...(unreadable > 0 ? [`${unreadable} 行读不懂，没有算进去`] : []),
		...(duplicates.length > 0 ? [`重复的 fill_id 只算一次：${duplicates.join("、")}`] : []),
	];
	return { items, notes, duplicates };
}

function accountsOf(input: Input, accounts: readonly DbRow[]): Set<string> | undefined {
	const ref = text(input.account_ref);
	const key = text(input.account_key);
	if (ref === undefined && key === undefined) return undefined;
	const refs = new Set<string>(ref === undefined ? [] : [ref]);
	for (const a of accounts) if (key !== undefined && a["account_key"] === key && text(a["account_ref"])) refs.add(text(a["account_ref"])!);
	return refs;
}

const amount = (qty: bigint, price: bigint, multiplier: bigint) => qty * price * multiplier;
const signed = (side: string) => (side === "STO" || side === "STC" ? 1n : -1n);

function chainView(items: readonly (Fill | Event)[], chains: readonly DbRow[], chainId: string | undefined) {
	const member = new Map<string, string>();
	for (const c of chains) if (c["record_type"] === "CHAIN_LEG" && text(c["chain_id"])) for (const k of [c["fill_id"], c["event_id"]]) if (text(k)) member.set(k as string, c["chain_id"] as string);
	const groups = new Map<string, (Fill | Event)[]>();
	for (const item of items) {
		const id = member.get(item.key) ?? `未归链:${item.account}:${item.symbol}`;
		if (chainId !== undefined && id !== chainId) continue;
		groups.set(id, [...(groups.get(id) ?? []), item]);
	}
	return [...groups].map(([chain_id, members]) => {
		const fills = members.filter((m): m is Fill => m.kind === "fill");
		const orders = new Map<string, Fill[]>();
		for (const f of fills) orders.set(f.orderKey, [...(orders.get(f.orderKey) ?? []), f]);
		const position = new Map<string, bigint>();
		for (const m of members) {
			const now = position.get(m.symbol) ?? 0n;
			if (m.kind === "fill") position.set(m.symbol, now + (m.side === "STO" || m.side === "STC" ? -m.qty : m.qty));
			else position.set(m.symbol, now > 0n ? now - (m.qty < now ? m.qty : now) : now + (m.qty < -now ? m.qty : -now));
		}
		const received = fills.filter((f) => signed(f.side) > 0n).reduce((s, f) => s + amount(f.qty, f.price, f.multiplier), 0n);
		const paid = fills.filter((f) => signed(f.side) < 0n).reduce((s, f) => s + amount(f.qty, f.price, f.multiplier), 0n);
		const open = [...position].filter(([, n]) => n !== 0n).map(([option_symbol, n]) => ({ option_symbol, contracts: Number(n) }));
		const feesUnknown = members.some((m) => m.fee === null);
		const feesKnown = members.reduce((s, m) => s + (m.fee ?? 0n), 0n);
		return {
			chain_id,
			accounts: [...new Set(members.map((m) => m.account))],
			orders: [...orders].map(([order_key, rows]) => {
				const qty = rows.reduce((s, r) => s + r.qty, 0n);
				const total = rows.reduce((s, r) => s + r.qty * r.price, 0n);
				return { order_key, side: rows[0]!.side, qty: Number(qty), avg_price: price4(divide(total, qty)), amount: cents(total * rows[0]!.multiplier), rows: rows.length };
			}),
			events: members.filter((m): m is Event => m.kind === "event").map((e) => ({ type: e.type, option_symbol: e.symbol, qty: Number(e.qty), date: e.date })),
			premium_received: cents(received),
			premium_paid: cents(paid),
			net: cents(received - paid),
			fees: feesUnknown ? "未知" : cents(feesKnown),
			net_after_fees: feesUnknown ? null : cents(received - paid - feesKnown),
			open,
			state: open.length === 0 ? "closed" : "open",
		};
	});
}

/** Holding "more than 1 year": the close comes after the same month and day a year later. */
const longHeld = (open: string, close: string) => close > `${Number(open.slice(0, 4)) + 1}${open.slice(4)}`;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const share = (fee: bigint | null, part: bigint, of: bigint) => (fee === null ? null : divide(fee * part, of));

function sideOf(lot: Fill): "short" | "long" {
	return SHORT_OPENS.has(lot.side) ? "short" : "long";
}

/** FIFO per account and contract; a close takes the lots on its side, an expiry any lot. */
function pieces(items: readonly (Fill | Event)[], ownerOf: (account: string) => string): { pieces: Piece[]; orphans: (Fill | Event)[] } {
	const lots = new Map<string, Lot[]>();
	const out: Piece[] = [];
	const orphans: (Fill | Event)[] = [];
	for (const item of items) {
		const at = `${item.account}|${item.symbol}`;
		const queue = lots.get(at) ?? [];
		lots.set(at, queue);
		if (item.kind === "fill" && (item.side === "STO" || item.side === "BTO")) {
			queue.push({ fill: item, left: item.qty });
			continue;
		}
		const wants = item.kind === "fill" ? (item.side === "BTC" ? "short" : "long") : item.type === "ASSIGNED" ? "short" : item.type === "EXERCISED" ? "long" : undefined;
		let need = item.qty;
		for (const lot of queue) {
			if (need === 0n) break;
			if (lot.left === 0n || (wants !== undefined && sideOf(lot.fill) !== wants)) continue;
			const take = lot.left < need ? lot.left : need;
			lot.left -= take;
			need -= take;
			out.push({ lot: lot.fill, qty: take, close: item, owner: ownerOf(item.account) });
		}
		if (need > 0n) orphans.push(item);
	}
	for (const queue of lots.values()) for (const lot of queue) if (lot.left > 0n) out.push({ lot: lot.fill, qty: lot.left, close: null, owner: ownerOf(lot.fill.account) });
	return { pieces: out, orphans };
}

/** `today` bounds "past expiry" in a year still running. */
function taxView(items: readonly (Fill | Event)[], year: number, accounts: readonly DbRow[], today: string) {
	const owners = new Map(accounts.filter((a) => text(a["account_ref"]) && text(a["tax_owner_key"])).map((a) => [a["account_ref"] as string, a["tax_owner_key"] as string]));
	const ownerOf = (account: string) => owners.get(account) ?? `account:${account}`;
	const { pieces: all, orphans } = pieces(items, ownerOf);
	const yearEnd = `${year}-12-31`;
	const cutoff = today < yearEnd ? today : yearEnd;
	const closeDate = (p: Piece) => (p.close === null ? null : p.close.date);
	const overlaps = (a: Piece, b: Piece) => a.lot.date <= (closeDate(b) ?? "9999-12-31") && b.lot.date <= (closeDate(a) ?? "9999-12-31");
	const spreadMates = (p: Piece) => all.filter((q) => q !== p && q.owner === p.owner && q.lot.underlying === p.lot.underlying && q.lot.right === p.lot.right && sideOf(q.lot) !== sideOf(p.lot) && overlaps(p, q));
	const opens = items.filter((i): i is Fill => i.kind === "fill" && (i.side === "STO" || i.side === "BTO"));

	function classMarks(p: Piece): { nonequity: boolean; marks: string[] } {
		if (p.lot.taxClass === "nonequity") return { nonequity: true, marks: [] };
		if (p.lot.taxClass === "" && INDEX_ROOTS.has(p.lot.underlying)) return { nonequity: false, marks: ["§1256 类别待核实"] };
		return { nonequity: false, marks: [] };
	}

	const commonMarks = (p: Piece) => [
		...(sideOf(p.lot) === "short" && p.lot.right === "call" ? ["QCC 待确认"] : []),
		...(spreadMates(p).length > 0 ? ["价差跨式标记"] : []),
		...classMarks(p).marks,
	];

	const legs = all
		.filter((p) => p.close !== null && !(p.close.kind === "event" && (p.close.type === "ASSIGNED" || p.close.type === "EXERCISED")) && Number(p.close.date.slice(0, 4)) === year)
		.map((p) => {
			const close = p.close!;
			const m = p.lot.multiplier;
			const premium = amount(p.qty, p.lot.price, m);
			const closing = close.kind === "fill" ? amount(p.qty, close.price, m) : 0n;
			const [proceeds, cost] = sideOf(p.lot) === "short" ? [premium, closing] : [closing, premium];
			const fees = [share(p.lot.fee, p.qty, p.lot.qty), share(close.fee, p.qty, close.qty)];
			const feeTotal = fees.includes(null) ? null : fees.reduce<bigint>((s, f) => s + f!, 0n);
			const gain = proceeds - cost - (feeTotal ?? 0n);
			const { nonequity } = classMarks(p);
			const held = longHeld(p.lot.date, close.date);
			const putOverYear = sideOf(p.lot) === "long" && p.lot.right === "put" && held && !nonequity;
			const term = nonequity ? "60/40" : classMarks(p).marks.length > 0 || putOverYear ? "待确认" : sideOf(p.lot) === "short" || !held ? "短期" : "长期";
			const marks = commonMarks(p);
			if (putOverYear) marks.push("长短期待确认（持有超过一年的买入 put，§1233(b)(1)）");
			if (feeTotal === null) marks.push("费用未知，未扣");
			if (close.kind === "event" && close.type === "CASH_SETTLED") marks.push("现金交割金额没记，盈亏待确认");
			if (gain < 0n) {
				const window = opens.filter((o) => o !== p.lot && ownerOf(o.account) === p.owner && o.underlying === p.lot.underlying && o.date >= addDays(close.date, -30) && o.date <= addDays(close.date, 30));
				if (window.some((o) => o.symbol === p.lot.symbol)) marks.push("期权间 wash sale 标记（同一合约）");
				else if (window.length > 0) marks.push("期权间 wash sale 标记（实质相同未证实）");
				if (window.length > 0 && close.kind === "fill" && close.side === "BTC") marks.push("BTC 亏损算不算 wash sale 的卖出未证实");
				marks.push("涉及股票的 wash sale 待确认");
				if (marks.includes("价差跨式标记") && spreadMates(p).some((q) => q.close === null || q.close.date > yearEnd)) marks.push("跨式损失递延待确认（缺年末收盘快照）");
			}
			return {
				account_ref: p.lot.account,
				option_symbol: p.lot.symbol,
				open_side: p.lot.side,
				open_date: p.lot.date,
				close_kind: close.kind === "fill" ? close.side : close.type,
				close_date: close.date,
				qty: Number(p.qty),
				proceeds: cents(proceeds),
				cost: cents(cost),
				fees: feeTotal === null ? "未知" : cents(feeTotal),
				gain: cents(gain),
				term,
				tax_year: year,
				marks,
			};
		});

	const stock = all
		.filter((p): p is Piece & { close: Event } => p.close?.kind === "event" && (p.close.type === "ASSIGNED" || p.close.type === "EXERCISED") && Number(p.close.date.slice(0, 4)) === year)
		.map((p) => {
			const shares = p.qty * p.lot.multiplier;
			const strikeAmount = p.qty * p.lot.strike * p.lot.multiplier;
			const premium = amount(p.qty, p.lot.price, p.lot.multiplier);
			const buys = (p.lot.right === "put") === (sideOf(p.lot) === "short");
			const value = sideOf(p.lot) === "short" ? (p.lot.right === "put" ? strikeAmount - premium : strikeAmount + premium) : p.lot.right === "call" ? strikeAmount + premium : strikeAmount - premium;
			const marks = ["涉及股票的 wash sale 待确认"];
			if (buys) {
				const longPutOpen = all.some((q) => q.owner === p.owner && q.lot.underlying === p.lot.underlying && q.lot.right === "put" && sideOf(q.lot) === "long" && q.lot.date <= p.close.date && (closeDate(q) ?? "9999-12-31") > p.close.date);
				if (longPutOpen) marks.push("持有期待确认（同一股票上还有买入的 put）");
			} else marks.push("交出的股票批次待确认（成本和长短期）");
			if (p.lot.fee === null || p.close.fee === null) marks.push("费用未知，未扣");
			return {
				account_ref: p.lot.account,
				option_symbol: p.lot.symbol,
				event: p.close.type,
				date: p.close.date,
				stock: buys ? "BUY" : "SELL",
				shares: Number(shares),
				...(buys ? { basis: cents(value), holding_starts: addDays(p.close.date, 1) } : { proceeds: cents(value) }),
				marks,
			};
		});

	const open = all
		.filter((p) => p.lot.date <= yearEnd && (p.close === null || p.close.date > yearEnd))
		.map((p) => {
			const marks = commonMarks(p);
			if (classMarks(p).nonequity) marks.push("§1256 年末计价待确认（缺年末收盘快照）");
			if (p.close === null && p.lot.expiry < cutoff) marks.push("过了到期日，到期、指派或行权没记");
			return { account_ref: p.lot.account, option_symbol: p.lot.symbol, open_side: p.lot.side, open_date: p.lot.date, qty: Number(p.qty), marks };
		});

	const unowned = [...new Set(items.map((i) => i.account))].filter((a) => !owners.has(a)).sort();
	const notes = [
		...(unowned.length > 0 ? [`${unowned.join("、")} 没有税务归属人，wash sale 和跨式只在本账户里找`] : []),
		...(orphans.length > 0 ? [`${orphans.length} 笔平仓或事件找不到开仓记录，没有算`] : []),
	];
	const pending = [...new Set([...legs, ...stock, ...open].flatMap((r) => r.marks))].filter((m) => /待确认|待核实|未证实|未知|没记/.test(m)).sort();
	return { legs, stock, open, pending, notes };
}

export function ledgerView(input: Input, data: Collections, today = new Date().toISOString().slice(0, 10)) {
	const view = text(input.view);
	if (view !== "chain" && view !== "tax") return { status: "needs-input", missing: ["view"], ask: ["要哪种视图：chain（交易链）还是 tax（税务）"] };
	const year = typeof input.year === "number" && Number.isSafeInteger(input.year) ? input.year : undefined;
	if (view === "tax" && year === undefined) return { status: "needs-input", missing: ["year"], ask: ["税务视图要给税年"] };
	const { items, notes } = facts(data.fills);
	const wanted = accountsOf(input, data.accounts);
	const mine = wanted === undefined ? items : items.filter((i) => wanted.has(i.account));
	const scope = "第一版范围 B：只看期权记录和指派、行权；要股票批次、QCC 或 1099-B 的判断标待确认。只是标记，不是税务建议";
	if (view === "chain") return { status: "ok", view, chains: chainView(mine, data.chains, text(input.chain_id)), notes: [...notes, "链盈亏不含指派后的股票，也不含费用未知的部分"] };
	const tax = taxView(mine, year!, data.accounts, today);
	return { status: "ok", view, year, scope, legs: tax.legs, stock: tax.stock, open: tax.open, pending: tax.pending, notes: [...notes, ...tax.notes] };
}

export default function ledger(input: Input) {
	return ledgerView(input ?? {}, readCollections(["fills", "chains", "accounts"]));
}
