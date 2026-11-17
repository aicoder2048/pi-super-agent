// Pure parser. Mail connector handles MIME/charset and verifies sender membership.
// No network, database or private state access. Decimal money uses BigInt units of $0.0001.
export type Letter = { id: string; threadId?: string; html?: string; body?: string };
type Fields = Record<string, unknown>;
export type Stored = { id?: string; fields: Fields };
export type Fill = Fields & { id: string; fill_id: string; order_key: string; qty: number; price: string; instrument: Fields };
export type Skipped = Fields & { reason: string; message_id?: string };
type Table = { start: number; rows: string[][]; row?: string[]; cell?: string; complete: boolean; unsafe: boolean };
const REQUIRED = ["Account", "Side", "Position", "Security", "Security Description", "Exe Qty", "Avg Price", "Open Qty", "Price Instructions", "Trade Date", "Settlement Date"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const clean = (s: string) => s.replace(/[\s\u00a0]+/g, " ").trim();

function entities(s: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, key: string) => {
		if (!key.startsWith("#")) return named[key.toLowerCase()] ?? all;
		const n = key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
		return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
	});
}

function firstTable(html: string): Table | undefined {
	// Track each table separately so a nested Account table is not mistaken for its wrapper.
	const stack: Table[] = [], tables: Table[] = [];
	const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
	for (const match of stripped.matchAll(/<[^>]*>|[^<]+/g)) {
		const token = match[0];
		if (/^<table\b/i.test(token)) {
			const table: Table = { start: match.index!, rows: [], complete: false, unsafe: false };
			stack.push(table); tables.push(table); continue;
		}
		const t = stack.at(-1);
		if (!t) continue;
		if (/^<\/table\s*>/i.test(token)) { if (t.row || t.cell !== undefined) t.unsafe = true; t.complete = true; stack.pop(); continue; }
		if (/^<tr\b/i.test(token)) { if (t.row) t.unsafe = true; t.row = []; continue; }
		if (/^<\/(td|th)\s*>/i.test(token)) {
			if (t.cell === undefined || !t.row) t.unsafe = true;
			else t.row.push(clean(entities(t.cell)));
			delete t.cell; continue;
		}
		if (/^<(td|th)\b/i.test(token)) {
			if (t.cell !== undefined || !t.row) t.unsafe = true;
			if (/\b(?:colspan|rowspan)\s*=\s*["']?(?!1(?:["'\s>]))\d/i.test(token)) t.unsafe = true;
			t.cell = ""; continue;
		}
		if (/^<\/tr\s*>/i.test(token)) {
			if (!t.row || t.cell !== undefined) t.unsafe = true;
			if (t.row) t.rows.push(t.row);
			delete t.row; continue;
		}
		if (t.cell !== undefined) t.cell += token.startsWith("<") ? " " : token;
	}
	return tables.sort((a, b) => a.start - b.start).find((t) => t.rows[0]?.[0] === "Account");
}

function isoDate(year: number, month: number, day: number): string {
	if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error("date");
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("date");
	return date.toISOString().slice(0, 10);
}
function mailDate(s: string): string {
	const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
	if (!m) throw new Error("date");
	return isoDate(Number(m[3]), MONTHS.indexOf(m[2]!) + 1, Number(m[1]));
}
function quantity(s: string): number {
	if (!/^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(s)) throw new Error("quantity");
	const n = Number(s.replace(/,/g, ""));
	if (!Number.isSafeInteger(n) || n <= 0) throw new Error("quantity");
	return n;
}
export function money(s: unknown): bigint {
	if (typeof s !== "string" || !/^\d+(?:\.\d{1,4})?$/.test(s)) throw new Error("money");
	const [whole, fraction = ""] = s.split(".");
	return BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, "0"));
}
export function fixed(n: bigint): string { return `${n / 10000n}.${(n % 10000n).toString().padStart(4, "0")}`; }

function contract(symbol: string, description: string): Fields {
	const m = /\b(PUT|CALL)\s+(\d{2})\/(\d{2})\/(\d{4})\s+@\s+(\d+(?:\.\d{1,3})?)$/i.exec(description);
	// Adjusted roots and unknown deliverables remain unconfirmed, never synthesize shares.
	if (!m || !/^[A-Z][A-Z0-9.]{0,5}$/.test(symbol)) throw new Error("contract");
	const expiry = isoDate(Number(m[4]), Number(m[2]), Number(m[3]));
	const scaled = money(m[5]!) / 10n;
	if (scaled <= 0n || scaled > 99999999n) throw new Error("strike");
	const right = m[1]!.toLowerCase();
	return { underlying: symbol, option_symbol: `${symbol}${expiry.slice(2).replace(/-/g, "")}${right === "call" ? "C" : "P"}${scaled.toString().padStart(8, "0")}`, right, strike: Number(scaled) / 1000, expiry, multiplier: null, deliverable: null };
}
function oldNumber(value: unknown): number {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	throw new Error("history");
}

export function parseLetters(items: Letter[], rows: Stored[] = [], historyIncomplete = false): { fills: Fill[]; skipped: Skipped[] } {
	const fills: Fill[] = [], skipped: Skipped[] = [], known = rows.map((r) => ({ ...r.fields }));
	for (const letter of items) {
		const reject = (detail: string, extra: Fields = {}) => skipped.push({ reason: "unparsed", message_id: letter.id, detail, ...extra });
		if (typeof letter.html !== "string" || letter.html.trim() === "") { reject("HTML_REQUIRED_OR_UNAMBIGUOUS_TEXT_UNAVAILABLE"); continue; }
		if (letter.html.includes("[HTML 超过 256 KB，后面截掉了，全文在 Gmail 里看]")) { reject("TRUNCATED_HTML"); continue; }
		const table = firstTable(letter.html);
		if (!table || !table.complete || table.unsafe) { reject("NO_COMPLETE_ACCOUNT_TABLE"); continue; }
		const header = table.rows[0]!;
		if (new Set(header).size !== header.length || REQUIRED.some((h) => !header.includes(h))) { reject("MISSING_OR_DUPLICATE_COLUMNS"); continue; }
		const seen = new Set<string>();
		for (const cells of table.rows.slice(1)) {
			if (cells.every((c) => c === "")) continue;
			if (cells.length !== header.length) { reject("COLUMN_COUNT"); continue; }
			const r = Object.fromEntries(header.map((h, i) => [h, cells[i]!]));
			const account = r["Account"]!, description = r["Security Description"]!, symbol = r["Security"]!;
			try {
				if (!/^[A-Za-z0-9_-]{1,40}$/.test(account)) throw new Error("account");
				if (r["Position"] === "" && !/\b(PUT|CALL)\b/i.test(description)) {
					skipped.push({ reason: "stock-trade-out-of-scope", account_ref: account, symbol, side: r["Side"]!.toUpperCase() }); continue;
				}
				const instrument = contract(symbol, description);
				const sideWord = /^(Buy|Sell) (Put|Call)$/i.exec(r["Side"]!);
				if (!sideWord || sideWord[2]!.toLowerCase() !== instrument["right"] || !/^(Open|Close)$/.test(r["Position"]!)) throw new Error("side");
				const side = `${sideWord[1]!.toLowerCase() === "buy" ? "B" : "S"}T${r["Position"] === "Open" ? "O" : "C"}`;
				const trade_date = mailDate(r["Trade Date"]!);
				const order_key = `${instrument["option_symbol"]}:${side}:${trade_date}:${account}`;
				if (seen.has(order_key)) { skipped.push({ reason: "duplicate-order-key", account_ref: account, order_key, message_id: letter.id }); continue; }
				seen.add(order_key);
				const exe = r["Exe Qty"]!, open = r["Open Qty"]!;
				const open_qty = open === "" ? null : quantity(open);
				if (exe === "") {
					if (r["Avg Price"] !== "") throw new Error("quantity-price");
					skipped.push({ reason: open_qty === null ? "not-filled" : "working-order", account_ref: account, description, open_qty }); continue;
				}
				if (historyIncomplete) throw new Error("history-incomplete");
				const cum = quantity(exe), avg = money(r["Avg Price"]);
				if (avg <= 0n) throw new Error("nonpositive-price");
				const id = `${order_key}:cum${cum}`;
				const settle_date = mailDate(r["Settlement Date"]!);
				const prior = known.filter((f) => f["order_key"] === order_key);
				let prevQty = 0n, prevAmt = 0n;
				const storedIds = new Set<string>();
				for (const f of prior) {
					const fid = f["fill_id"];
					if (typeof fid !== "string" || !fid.startsWith(`${order_key}:cum`) || storedIds.has(fid) || f["reverses_fill_id"]) throw new Error("history");
					storedIds.add(fid);
					for (const [field, value] of Object.entries({ account_ref: account, side, trade_date })) {
						if (f[field] != null && f[field] !== value) throw new Error("stored-fact-conflict");
					}
					if (fid === id && f["settle_date"] != null && f["settle_date"] !== settle_date) throw new Error("same-id-conflict");
					const q = BigInt(oldNumber(f["qty"])), p = money(f["price"]);
					if (p <= 0n) throw new Error("history");
					prevQty += q; prevAmt += q * p;
					if (fid === id && f["cum_avg"] != null && money(f["cum_avg"]) !== avg) throw new Error("same-id-conflict");
				}
				if (BigInt(cum) <= prevQty) {
					// A same-total repricing is a correction, not permission to overwrite the old fill.
					const difference = BigInt(cum) * avg - prevAmt;
					if (BigInt(cum) === prevQty && (difference < 0n ? -difference : difference) * 2n > prevQty) throw new Error("cumulative-price-conflict");
					continue;
				}
				if (known.some((f) => f["fill_id"] === id)) throw new Error("same-id-conflict");
				const delta = BigInt(cum) - prevQty, numerator = BigInt(cum) * avg - prevAmt;
				if (numerator <= 0n) throw new Error("nonpositive-increment");
				// Positive round-half-up, entirely in integer units.
				const units = (2n * numerator + delta) / (2n * delta);
				if (units <= 0n) throw new Error("nonpositive-increment");
				const limitMatch = /^(\d+(?:\.\d{1,4})?) Limit$/i.exec(r["Price Instructions"]!);
				if (!limitMatch) throw new Error("price-instructions");
				const executed_at = r["Executed At"] ? mailDate(r["Executed At"]!) : null;
				const fill: Fill = {
					id, fill_id: id, order_key, account_ref: account, account_key: null, side, instrument,
					qty: Number(delta), cum_qty: cum, cum_avg: fixed(avg), partial_fill: open_qty !== null, price: fixed(units), limit: fixed(money(limitMatch[1]!)),
					trade_date, settle_date, executed_at, trade_time: null, order_id: null, commission: null, fees: null,
					source: "broker-email", source_message_id: letter.id,
					unconfirmed: ["account_key", "multiplier", "deliverable", "trade_time", "order_id", "commission", "fees"],
				};
				fills.push(fill); known.push(fill);
			} catch (err) { reject(err instanceof Error ? err.message : "INVALID_ROW", { account_ref: account }); }
		}
	}
	return { fills, skipped };
}
