/**
 * A trade desk's reply as `fills` rows (spec「成交邮件（`fills`）」). Pure: the letter and the rows already recorded in, rows and skips out.
 * Reads the first table whose first row starts with `Account`, by column name, from the HTML; the plain text is the fallback.
 */
import { aliasRegistry, alignHistoricalAccounts, resolveAccount } from "../../account-aliases.ts";
import type { DbRow } from "../../data-db.ts";
import { contractOf, fillId, increment, isoDate, orderKey, price4, units, type Contract, type Recorded, type Right, type Side } from "../../fills.ts";

export type FillLetter = { id: string; threadId?: string; subject?: string; body?: string; html?: string };
export type StoredRow = { id: string; from: string; fields: Recorded };

export type FillRow = {
	id: string;
	record_type: "FILL";
	fill_id: string;
	order_key: string;
	order_id: null;
	account_ref: string;
	account_key: null;
	instrument: string;
	underlying: string;
	option_symbol: string;
	right: Right;
	strike: number;
	expiry: string;
	multiplier: number;
	side: Side;
	qty: number;
	price: string;
	cum_qty: number;
	partial_fill: "true" | "false";
	limit_price: string | null;
	trade_date: string;
	executed_at: string | null;
	trade_time: null;
	settle_date: string;
	commission: null;
	fees: null;
	source: "broker-email";
	source_message_id: string;
	/** The letter's own short code, only when it was recorded under the registered name it is an alias of. */
	account_alias_seen?: string;
};

export type Skipped =
	| { reason: "working-order" | "not-filled"; account_ref: string; description: string; open_qty: number | null }
	| { reason: "stock-trade-out-of-scope"; account_ref: string; symbol: string; side: string }
	| { reason: "duplicate-order-key"; account_ref: string; order_key: string }
	| { reason: "ambiguous-account"; account_ref: string; order_key: string }
	| { reason: "unparsed"; detail: string; account_ref?: string };

export const HTML_CUT = "\n\n[HTML 超过 256 KB，后面截掉了，全文在 Gmail 里看]";
const BODY_CUT = "\n\n[正文超过 64 KB，后面截掉了，全文在 Gmail 里看]";

const COLUMNS = ["Account", "Side", "Position", "Security", "Security Description", "Exe Qty", "Avg Price", "Open Qty", "Price Instructions", "Trade Date", "Settlement Date"] as const;
const EXECUTED_AT = "Executed At";
type Column = (typeof COLUMNS)[number] | typeof EXECUTED_AT;
/** `misfit`: the row has more or fewer cells than the header, so no cell can be trusted to its column. */
type Cells = Partial<Record<Column, string>> & { misfit?: true };
/** `problem` names why the rest of the table, or all of it, could not be read; the rows in `cells` before it still count. */
type Table = { cells: Cells[]; executedAt: boolean; problem?: string } | undefined;
const broken = (problem: string): Table => ({ cells: [], executedAt: false, problem });

/** `Side` plus `Position` as the order's direction; the right must agree with the description. */
const SIDES: Record<string, { side: Side; right: Right }> = {
	"Sell Put|Open": { side: "STO", right: "put" },
	"Buy Put|Open": { side: "BTO", right: "put" },
	"Buy Put|Close": { side: "BTC", right: "put" },
	"Sell Put|Close": { side: "STC", right: "put" },
	"Sell Call|Open": { side: "STO", right: "call" },
	"Buy Call|Open": { side: "BTO", right: "call" },
	"Buy Call|Close": { side: "BTC", right: "call" },
	"Sell Call|Close": { side: "STC", right: "call" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ACCOUNT = /^[A-Za-z][A-Za-z0-9]{1,19}$/;
const QUANTITY = /^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/;
const DESCRIPTION = /^.*\S\s+(PUT|CALL)\s+(\d{2})\/(\d{2})\/(\d{4})\s+@\s+(\d+(?:\.\d+)?)$/;
const LIMIT = /^(\d+(?:\.\d{1,4})?) Limit$/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
		const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
const squash = (text: string) => text.replace(/[\s  ]+/g, " ").trim();

function mailDate(text: string | undefined): string | undefined {
	const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(text ?? "");
	return m ? isoDate(Number(m[3]), MONTHS.indexOf(m[2]!) + 1, Number(m[1])) : undefined;
}

const quantity = (text: string | undefined) => (text !== undefined && QUANTITY.test(text) ? Number(text.replace(/,/g, "")) : undefined);

function byName(header: readonly string[], rows: readonly string[][], problem?: string): Table {
	if (new Set(header).size !== header.length) return broken("duplicate-columns");
	if (COLUMNS.some((c) => !header.includes(c))) return broken("missing-columns");
	const at = (row: readonly string[]) => ({ ...Object.fromEntries(header.map((name, i) => [name, row[i] ?? ""])), ...(row.length !== header.length && { misfit: true as const }) }) as Cells;
	return { cells: rows.filter((row) => row.some((c) => c !== "")).map(at), executedAt: header.includes(EXECUTED_AT), ...(problem !== undefined && { problem }) };
}

type HtmlTable = { rows: string[][]; closed: boolean; row?: string[]; cell?: string };

/** HTML lets `</td>` and `</tr>` go unwritten; the next cell, row or the table's end closes them. */
function closeCell(table: HtmlTable): void {
	if (table.cell !== undefined) table.row?.push(squash(decode(table.cell)));
	delete table.cell;
}

function closeRow(table: HtmlTable): void {
	closeCell(table);
	if (table.row !== undefined) table.rows.push(table.row);
	delete table.row;
}

/** Tables are tracked on a stack, so a desk table set inside a layout table's cell is found as itself. */
function htmlTable(html: string): { header: string[]; rows: string[][]; closed: boolean } | undefined {
	const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "");
	const stack: HtmlTable[] = [];
	const found: HtmlTable[] = [];
	for (const [token] of text.matchAll(/<[^>]*>|[^<]+/g)) {
		const tag = /^<(\/?)([a-z]+)/i.exec(token);
		const name = tag?.[2]!.toLowerCase();
		const top = stack.at(-1);
		const opening = tag?.[1] === "";
		if (name === "table" && opening) {
			const table: HtmlTable = { rows: [], closed: false };
			stack.push(table);
			found.push(table);
		} else if (top === undefined) continue;
		else if (name === "table") {
			closeRow(top);
			top.closed = true;
			stack.pop();
		} else if (name === "tr") {
			closeRow(top);
			if (opening) top.row = [];
		} else if (name === "td" || name === "th") {
			closeCell(top);
			if (opening) top.cell = "";
		} else if (tag === null && top.cell !== undefined) top.cell += token;
		else if (top.cell !== undefined) top.cell += " ";
	}
	const desk = found.find((t) => t.rows[0]?.[0] === "Account");
	return desk && { header: desk.rows[0]!, rows: desk.rows.slice(1), closed: desk.closed };
}

/**
 * The plain text keeps one cell per line and drops empty cells, so a row is read by its shape: between the description and
 * `<price> Limit`, no value is not filled, one is the open quantity, two are the fill and its average, three a partial fill.
 */
function textTable(body: string): Table {
	const truncated = body.endsWith(BODY_CUT);
	const lines = (truncated ? body.slice(0, -BODY_CUT.length) : body).split(/\r?\n/).map(squash);
	const start = lines.indexOf("Account");
	if (start < 0) return undefined;
	const known = new Set<string>([...COLUMNS, EXECUTED_AT]);
	let at = start;
	const header: string[] = [];
	while (at < lines.length && known.has(lines[at]!)) header.push(lines[at++]!);
	const executedAt = header.at(-1) === EXECUTED_AT;
	if (header.join("|") !== [...COLUMNS, ...(executedAt ? [EXECUTED_AT] : [])].join("|")) return broken("text-columns");
	const rows: string[][] = [];
	const failed = () => byName(header, rows, "text-row");
	while (at < lines.length && lines[at] !== "") {
		const take = () => lines[at++] ?? "";
		const [account, side] = [take(), take()];
		const position = /^(Open|Close)$/.test(lines[at] ?? "") ? take() : "";
		const [security, description] = [take(), take()];
		const values: string[] = [];
		while (at < lines.length && lines[at] !== "" && !LIMIT.test(lines[at]!) && values.length <= 3) values.push(take());
		if (values.length > 3 || !LIMIT.test(lines[at] ?? "")) return failed();
		const limit = take();
		const dates = Array.from({ length: executedAt ? 3 : 2 }, take);
		const [exe, avg, open] = values.length === 1 ? ["", "", values[0]!] : [values[0] ?? "", values[1] ?? "", values[2] ?? ""];
		if (values.length === 1 && quantity(open) === undefined) return failed();
		if (values.length >= 2 && (quantity(exe) === undefined || units(avg) === undefined || (open !== "" && quantity(open) === undefined))) return failed();
		rows.push([account, side, position, security, description, exe, avg, open, limit, ...dates]);
	}
	if (truncated && at >= lines.length) return broken("text-truncated");
	return byName(header, rows);
}

function tableOf(letter: FillLetter): Table {
	const html = typeof letter.html === "string" ? letter.html : "";
	const truncated = html.endsWith(HTML_CUT);
	const found = html === "" ? undefined : htmlTable(truncated ? html.slice(0, -HTML_CUT.length) : html);
	if (found?.closed) return byName(found.header, found.rows);
	if (html !== "" && found === undefined && !truncated) return undefined;
	const text = textTable(letter.body ?? "");
	if (text !== undefined) return text;
	if (truncated) return broken("html-truncated");
	return found === undefined ? undefined : broken("html-table");
}

/** `key` is the order key whenever the row got that far, filled or not: only the first row of a key in a table counts. */
type Row = { fill: Omit<FillRow, "id" | "fill_id" | "qty" | "price" | "cum_qty"> & { cum: number; avg: bigint } } | { skipped: Skipped; key?: string };

function rowOf(cells: Cells, executedAt: boolean, letterId: string): Row {
	const account = cells.Account ?? "";
	const unparsed = (detail: string): Row => ({ skipped: { reason: "unparsed", detail, ...(ACCOUNT.test(account) && { account_ref: account }) } });
	if (cells.misfit) return unparsed("row-shape");
	if (!ACCOUNT.test(account)) return unparsed("account");
	const description = cells["Security Description"] ?? "";
	const security = cells.Security ?? "";
	const [exe, avg, open] = [cells["Exe Qty"] ?? "", cells["Avg Price"] ?? "", cells["Open Qty"] ?? ""];
	if (cells.Position === "" && !/\b(PUT|CALL)\b/.test(description)) {
		if (!/^(Buy|Sell)$/.test(cells.Side ?? "")) return unparsed("side");
		return { skipped: { reason: "stock-trade-out-of-scope", account_ref: account, symbol: security, side: cells.Side!.toUpperCase() } };
	}
	const direction = SIDES[`${cells.Side}|${cells.Position}`];
	const described = DESCRIPTION.exec(description);
	if (direction === undefined || described === null || described[1]!.toLowerCase() !== direction.right) return unparsed("side-or-description");
	const expiry = isoDate(Number(described[4]), Number(described[2]), Number(described[3]));
	const contract: Contract | undefined = expiry === undefined ? undefined : contractOf(security, direction.right, expiry, described[5]!);
	if (contract === undefined) return unparsed("contract");
	const [trade_date, settle_date] = [mailDate(cells["Trade Date"]), mailDate(cells["Settlement Date"])];
	const executed_at = executedAt && cells[EXECUTED_AT] !== "" ? mailDate(cells[EXECUTED_AT]) : null;
	if (trade_date === undefined || settle_date === undefined || executed_at === undefined) return unparsed("date");
	const order_key = orderKey(contract, direction.side, trade_date, account);
	const openQty = open === "" ? null : quantity(open);
	if (openQty === undefined) return { ...unparsed("open-qty"), key: order_key };
	if (exe === "") {
		if (avg !== "") return { ...unparsed("avg-without-qty"), key: order_key };
		return { skipped: { reason: openQty === null ? "not-filled" : "working-order", account_ref: account, description, open_qty: openQty }, key: order_key };
	}
	const cum = quantity(exe);
	const average = units(avg);
	if (cum === undefined || average === undefined || average <= 0n) return { ...unparsed("fill-qty-or-price"), key: order_key };
	const limit = LIMIT.exec(cells["Price Instructions"] ?? "");
	const limitUnits = limit ? units(limit[1]) : undefined;
	return {
		fill: {
			record_type: "FILL",
			order_key,
			order_id: null,
			account_ref: account,
			account_key: null,
			instrument: JSON.stringify(contract),
			...contract,
			side: direction.side,
			partial_fill: openQty === null ? "false" : "true",
			limit_price: limitUnits === undefined ? null : price4(limitUnits),
			trade_date,
			executed_at,
			trade_time: null,
			settle_date,
			commission: null,
			fees: null,
			source: "broker-email",
			source_message_id: letterId,
			cum,
			avg: average,
		},
	};
}

const account = (s: Skipped) => ("account_ref" in s ? (s.account_ref ?? "") : "");

/**
 * `accounts` is the registry. Once it has aliases, a short code it knows is recorded under its registered name and checked against
 * the order's rows under either name; a code it maps to several names is skipped; a code it does not know is recorded as written,
 * so the fill is kept and lines up once the user registers the alias.
 */
export function parseFills(letter: FillLetter, recorded: readonly StoredRow[], accounts: readonly DbRow[] = []): { fills: FillRow[]; skipped: Skipped[] } {
	const fills: FillRow[] = [];
	const skipped: Skipped[] = [];
	const table = tableOf(letter);
	if (table === undefined) return { fills, skipped };
	const known = recorded.map((row) => row.fields);
	const registry = aliasRegistry(accounts);
	const seen = new Set<string>();
	/** A letter can write one account two ways, so a key repeats within the letter when it repeats under the registered name. */
	const resolve = (key: string, code: string) => {
		const resolution = registry.length === 0 ? undefined : resolveAccount(code, registry);
		return { resolution, key: resolution?.status === "matched" ? key.slice(0, -code.length) + resolution.account_ref : key };
	};
	for (const cells of table.cells) {
		const row = rowOf(cells, table.executedAt, letter.id);
		if ("skipped" in row) {
			const key = row.key === undefined ? undefined : resolve(row.key, account(row.skipped)).key;
			if (key !== undefined && seen.has(key)) skipped.push({ reason: "duplicate-order-key", account_ref: account(row.skipped), order_key: row.key! });
			else skipped.push(row.skipped);
			if (key !== undefined) seen.add(key);
			continue;
		}
		const { cum, avg, ...fill } = row.fill;
		const code = fill.account_ref;
		const { resolution, key: order_key } = resolve(fill.order_key, code);
		if (seen.has(order_key)) {
			skipped.push({ reason: "duplicate-order-key", account_ref: code, order_key: fill.order_key });
			continue;
		}
		seen.add(order_key);
		if (resolution?.status === "ambiguous-account") {
			skipped.push({ reason: "ambiguous-account", account_ref: code, order_key: fill.order_key });
			continue;
		}
		const registered = resolution?.status === "matched" ? resolution.account_ref : code;
		const history = registry.length === 0 ? { rows: known, ambiguous: false, reversed: false } : alignHistoricalAccounts(known, registry, order_key);
		if (history.ambiguous) {
			skipped.push({ reason: "ambiguous-account", account_ref: code, order_key });
			continue;
		}
		const step = history.reversed ? ({ kind: "unparsed", detail: "reversed-order" } as const) : increment(order_key, cum, avg, history.rows);
		if (step.kind === "unparsed") skipped.push({ reason: "unparsed", detail: step.detail, account_ref: code });
		if (step.kind !== "new") continue;
		const id = fillId(order_key, cum);
		fills.push({ id, fill_id: id, ...fill, order_key, account_ref: registered, qty: step.qty, price: price4(step.price), cum_qty: cum, ...(registered !== code && { account_alias_seen: code }) });
	}
	if (table.problem !== undefined) skipped.push({ reason: "unparsed", detail: table.problem });
	return { fills, skipped };
}
