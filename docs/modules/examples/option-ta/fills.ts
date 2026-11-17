/**
 * What the `fills` feed and the `record` tool share: contract and order keys, and the cumulative increment of an order
 * (spec「订单键和 `id`」). Prices are integers of 1/10000 USD, so no float ever touches a fill.
 */
export type Side = "STO" | "BTO" | "BTC" | "STC";
export type Right = "put" | "call";
export type Contract = { underlying: string; option_symbol: string; right: Right; strike: number; expiry: string; multiplier: number };
/** A stored `fills` row's fields, as the feed gets them in `rows` and the tools read them from `data.db`. */
export type Recorded = Readonly<Record<string, unknown>>;

const UNIT = 10_000n;
const DECIMAL = /^\d+(?:\.\d{1,4})?$/;
const ROOT = /^[A-Z][A-Z0-9.]{0,5}$/;

export function units(value: unknown): bigint | undefined {
	const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
	if (typeof text !== "string" || !DECIMAL.test(text)) return undefined;
	const [whole, fraction = ""] = text.split(".");
	return BigInt(whole!) * UNIT + BigInt(fraction.padEnd(4, "0"));
}

export const price4 = (value: bigint): string => `${value / UNIT}.${(value % UNIT).toString().padStart(4, "0")}`;

/** Round half up; both sides positive. */
export const divide = (numerator: bigint, denominator: bigint): bigint => (2n * numerator + denominator) / (2n * denominator);

export const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);

export function isoDate(year: number, month: number, day: number): string | undefined {
	if (year < 2000 || year > 2099) return undefined;
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : undefined;
}

export const isIsoDate = (text: unknown): text is string => {
	const m = typeof text === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : null;
	return m !== null && isoDate(Number(m[1]), Number(m[2]), Number(m[3])) === text;
};

/** The OCC symbol without the root's space padding, as the spec writes it: `AAPL260320C00250000`. */
export function contractOf(underlying: string, right: Right, expiry: string, strike: string, multiplier = 100): Contract | undefined {
	const milli = units(strike);
	if (!ROOT.test(underlying) || !isIsoDate(expiry) || milli === undefined || milli % 10n !== 0n || milli <= 0n || milli / 10n > 99_999_999n) return undefined;
	const code = (milli / 10n).toString().padStart(8, "0");
	const option_symbol = `${underlying}${expiry.slice(2).replace(/-/g, "")}${right === "call" ? "C" : "P"}${code}`;
	return { underlying, option_symbol, right, strike: Number(milli / 10n) / 1000, expiry, multiplier };
}

export const orderKey = (contract: Pick<Contract, "option_symbol">, side: Side, tradeDate: string, account: string): string => `${contract.option_symbol}:${side}:${tradeDate}:${account}`;

export const fillId = (key: string, cum: number): string => `${key}:cum${cum}`;

export type Increment =
	| { kind: "new"; qty: number; price: bigint }
	| { kind: "covered" }
	| { kind: "unparsed"; detail: "recorded-rows" | "reversed-order" | "conflicts-with-recorded" | "nonpositive-increment" };

/**
 * `cum` and `avg` are the order's cumulative quantity and average price as one letter (or the user) reports them. Rows already
 * recorded for the order count toward it whichever source wrote them, so a repeated table adds nothing and a later fill adds only its part.
 */
export function increment(key: string, cum: number, avg: bigint, recorded: readonly Recorded[]): Increment {
	const mine = recorded.filter((row) => row["order_key"] === key);
	if (mine.some((row) => row["record_type"] === "REVERSAL")) return { kind: "unparsed", detail: "reversed-order" };
	let prevQty = 0n;
	let prevAmount = 0n;
	for (const row of mine) {
		const qty = count(row["qty"]);
		const price = units(row["price"]);
		if ((row["record_type"] ?? "FILL") !== "FILL" || qty === undefined || price === undefined || price <= 0n) return { kind: "unparsed", detail: "recorded-rows" };
		prevQty += BigInt(qty);
		prevAmount += BigInt(qty) * price;
	}
	if (BigInt(cum) <= prevQty) return { kind: "covered" };
	if (mine.some((row) => row["fill_id"] === fillId(key, cum))) return { kind: "unparsed", detail: "conflicts-with-recorded" };
	const delta = BigInt(cum) - prevQty;
	const numerator = BigInt(cum) * avg - prevAmount;
	if (numerator <= 0n) return { kind: "unparsed", detail: "nonpositive-increment" };
	return { kind: "new", qty: Number(delta), price: divide(numerator, delta) };
}
