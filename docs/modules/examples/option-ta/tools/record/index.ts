/**
 * Checks one fill the user reports and hands back the row the lead writes with `data/fills`. Same keys and increment as the
 * `fills` feed (spec「订单键和 `id`」); reads data.db only to find what the order already has and which account short codes
 * are known. Writes nothing.
 */
import { readCollections, type DbRow } from "../../data-db.ts";
import { contractOf, count, fillId, increment, isIsoDate, orderKey, price4, units, type Right, type Side } from "../../fills.ts";

type Input = Partial<Record<"account_ref" | "account_key" | "side" | "underlying" | "right" | "strike" | "expiry" | "avg_price" | "trade_date" | "settle_date" | "commission" | "fees", unknown>> & {
	cum_qty?: unknown;
	open_qty?: unknown;
	multiplier?: unknown;
};

const REQUIRED = ["account_ref", "side", "underlying", "right", "strike", "expiry", "cum_qty", "avg_price", "trade_date"] as const;
const ASK: Record<(typeof REQUIRED)[number], string> = {
	account_ref: "缺账户：问使用者记在哪个账户（账户短码）",
	side: "缺方向：STO、BTO、BTC 或 STC",
	underlying: "缺标的代码",
	right: "缺 put 还是 call",
	strike: "缺行权价",
	expiry: "缺到期日",
	cum_qty: "缺累计成交张数：只成交了一部分时问清到现在一共成交几张",
	avg_price: "缺累计成交均价",
	trade_date: "缺成交日",
};
const SIDES = new Set<Side>(["STO", "BTO", "BTC", "STC"]);
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const blank = (value: unknown) => value === undefined || value === null || value === "";
const text = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : undefined);

type Recorded = { fills: readonly DbRow[]; accounts: readonly DbRow[] };

/** Short codes in `accounts` or in recorded fills. A code outside them is asked about, so a typo never opens a second account beside the emailed one. */
function knownAccounts({ fills, accounts }: Recorded): string[] {
	return [...new Set([...accounts, ...fills].map((row) => text(row["account_ref"])).filter((ref): ref is string => ref !== undefined && ref !== ""))].sort();
}

export function recordFill(input: Input, recorded: Recorded) {
	const missing = REQUIRED.filter((name) => blank(input[name]));
	if (missing.length > 0) return { status: "needs-input", missing, ask: missing.map((name) => ASK[name]) };
	const problems: string[] = [];
	const account = text(input.account_ref) ?? "";
	if (!ACCOUNT.test(account)) problems.push("account_ref 只能是字母、数字、短横线和下划线");
	const side = text(input.side)?.toUpperCase() as Side;
	if (!SIDES.has(side)) problems.push("side 要是 STO、BTO、BTC 或 STC");
	const right = text(input.right)?.toLowerCase() as Right;
	if (right !== "put" && right !== "call") problems.push("right 要是 put 或 call");
	const multiplier = blank(input.multiplier) ? 100 : count(input.multiplier);
	if (multiplier === undefined) problems.push("multiplier 要是正整数");
	const contract = right === "put" || right === "call" ? contractOf((text(input.underlying) ?? "").toUpperCase(), right, text(input.expiry) ?? "", text(input.strike) ?? "", multiplier ?? 100) : undefined;
	if (contract === undefined) problems.push("合约拼不出 OCC 代码：看标的代码、到期日（YYYY-MM-DD）、行权价（最多 3 位小数）");
	const cum = count(input.cum_qty);
	if (cum === undefined) problems.push("cum_qty 要是正整数");
	const open = blank(input.open_qty) ? 0 : (count(input.open_qty) ?? -1);
	if (open < 0) problems.push("open_qty 要是正整数，没有挂着的就不给");
	const avg = units(text(input.avg_price));
	if (avg === undefined || avg <= 0n) problems.push("avg_price 要是正数，最多 4 位小数");
	const tradeDate = text(input.trade_date) ?? "";
	if (!isIsoDate(tradeDate)) problems.push("trade_date 要是 YYYY-MM-DD");
	const settle = blank(input.settle_date) ? null : (text(input.settle_date) ?? "");
	if (settle !== null && !isIsoDate(settle)) problems.push("settle_date 要是 YYYY-MM-DD");
	const [commission, fees] = [input.commission, input.fees].map((value) => (blank(value) ? null : units(text(value))));
	if (commission === undefined || fees === undefined) problems.push("commission、fees 要是不带符号的金额，最多 4 位小数；不知道就不给");
	if (problems.length > 0 || contract === undefined || cum === undefined || avg === undefined) return { status: "invalid", problems };
	const known = knownAccounts(recorded);
	if (known.length > 0 && !known.includes(account)) {
		return { status: "needs-input", missing: ["account_ref"], known_accounts: known, ask: [`账户短码 ${account} 没见过，已知的是 ${known.join("、")}：问使用者是其中哪一个；使用者确认是新账户，先用 data 往 accounts 写一行再记`] };
	}

	const order_key = orderKey(contract, side, tradeDate, account);
	const fill_id = fillId(order_key, cum);
	const existing = recorded.fills.find((row) => row["fill_id"] === fill_id);
	if (existing !== undefined) return { status: "duplicate", fill_id, order_key, existing_row: String(existing["_id"]) };
	const step = increment(order_key, cum, avg, recorded.fills);
	if (step.kind === "covered") return { status: "covered", fill_id, order_key, note: "这一单已记的张数不少于这个累计数，不用再记" };
	if (step.kind === "unparsed") return { status: "conflict", fill_id, order_key, detail: step.detail };
	const unknown = [...(commission === null ? ["commission"] : []), ...(fees === null ? ["fees"] : []), "order_id", "trade_time"];
	const money = (value: bigint | null | undefined) => (value === null || value === undefined ? null : price4(value));
	return {
		status: "ok",
		fill_id,
		order_key,
		qty: step.qty,
		price: price4(step.price),
		unknown,
		notes: [
			...(commission === null || fees === null ? ["费用未知：留空，不当零"] : []),
			...(blank(input.multiplier) ? ["合约乘数按标准 100 记；调整合约要问清乘数和交割物"] : []),
			...(known.length === 0 ? [`这是第一个账户短码（${account}），以后手动记账和邮件都要用同一个`] : []),
		],
		row: {
			record_type: "FILL",
			fill_id,
			order_key,
			order_id: null,
			account_ref: account,
			account_key: blank(input.account_key) ? null : text(input.account_key)!,
			instrument: JSON.stringify(contract),
			...contract,
			side,
			qty: step.qty,
			price: price4(step.price),
			cum_qty: cum,
			partial_fill: open > 0 ? "true" : "false",
			trade_date: tradeDate,
			trade_time: null,
			settle_date: settle,
			commission: money(commission),
			fees: money(fees),
			source: "manual",
		},
	};
}

export default function record(input: Input) {
	return recordFill(input ?? {}, readCollections(["fills", "accounts"]));
}
