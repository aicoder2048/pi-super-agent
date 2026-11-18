/** Broker CSV preview. Pure, append-only reconciliation; account aliases and price units share the mail/record implementation. */
import { resolveAccount } from "./account-aliases.ts";
import { contractOf, divide, isoDate, isIsoDate, price4, units } from "./fills.ts";
import { CALENDAR_THROUGH, isTradingDay, shiftDate } from "./market-days.ts";

type Row = Record<string, any>;
export type BrokerImportInput = { broker: "jpm" | "etrade"; csv: string; import_date: string; fills: any[]; accounts: any[] };
type CsvRow = { line: number; cells: string[] };
const blank = (v: unknown) => v === undefined || v === null || v === "";
const factId = (r: Row): string => String(r.fill_id || r.event_id || r.id || r._id || "");
const unwrap = (r: Row): Row => r.fields ? { ...r.fields, _id: r.id } : { ...r };
function historical(r: Row): Row {
 const row = unwrap(r);
 let instrument: Row = {};
 try { instrument = typeof row.instrument === "string" ? JSON.parse(row.instrument) : row.instrument || {}; } catch { /* malformed historical facts are not invented */ }
 const m = /^([A-Z.]+)(\d{2})(\d{2})(\d{2})([PC])(\d{8})$/.exec(row.option_symbol || "");
 const parsed = m ? contractOf(m[1]!, m[5] === "P" ? "put" : "call", `20${m[2]}-${m[3]}-${m[4]}`, String(Number(m[6]) / 1000)) : undefined;
 return { ...parsed, ...instrument, ...row };
}
const abs = (n: bigint) => n < 0n ? -n : n;
const money = (s: string): bigint | undefined => {
 const t = s.trim().replace(/[$,]/g, "");
 const negative = t.startsWith("-");
 const n = units(negative ? t.slice(1) : t);
 return n === undefined ? undefined : negative ? -n : n;
};
const date = (s: string): string | undefined => {
 const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
 return m ? isoDate(Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]), Number(m[2])) : undefined;
};
/** RFC4180 cells, quoted commas/newlines and physical source line numbers. */
function csvRows(csv: string): CsvRow[] {
 const out: CsvRow[] = []; let cells: string[] = [], cell = "", quoted = false, line = 1, start = 1, endedQuote = false;
 csv = csv.replace(/^\uFEFF/, "");
 for (let i = 0; i < csv.length; i++) {
  const c = csv[i]!;
  if (quoted) {
   if (c === '"') { if (csv[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; endedQuote = true; } }
   else { cell += c; if (c === "\n") line++; }
  } else if (c === '"') { if (cell !== "" || endedQuote) throw new Error("invalid-csv-quote"); quoted = true; }
  else if (c === ",") { cells.push(cell); cell = ""; endedQuote = false; }
  else if (c === "\r" || c === "\n") {
   if (c === "\r" && csv[i + 1] === "\n") i++;
   cells.push(cell); out.push({ line: start, cells }); cells = []; cell = ""; endedQuote = false; line++; start = line;
  } else { if (endedQuote) throw new Error("invalid-csv-quote"); cell += c; }
 }
 if (quoted) throw new Error("unterminated-csv-quote");
 if (cell !== "" || cells.length || endedQuote) out.push({ line: start, cells: [...cells, cell] });
 return out;
}
function contract(r: Row, broker: string) {
 const d = r.Description || "";
 const m = broker === "jpm" ? /\b(PUT|CALL)\s+(\d{2}\/\d{2}\/\d{2})\s*@\s*(\d+(?:\.\d+)?)/.exec(d) : /^(PUT|CALL)\s+(\S+)\s+(\d{2}\/\d{2}\/\d{2})\s+(\d+(?:\.\d+)?)\s*$/.exec(d.trim());
 if (!m) return undefined;
 const expiry = date(m[broker === "jpm" ? 2 : 3]);
 const symbol = (broker === "jpm" ? r.Ticker : r.Symbol).trim();
 if (broker === "etrade" && symbol !== m[2]) return undefined;
 return expiry ? contractOf(symbol, m[1] === "PUT" ? "put" : "call", expiry, m[broker === "jpm" ? 3 : 4]!) : undefined;
}
const baseKey = (r: Row) => `${r.option_symbol || r.underlying}:${r.side}:${r.trade_date}`;
const exportKey = (r: Row) => r.record_type === "EVENT" ? r.event_id : `${baseKey(r)}:${r.account_ref}`;
const candidateId = (r: Row) => factId(r) || `${exportKey(r)}:cum${r.qty}`;

export function importBrokerCsv(input: BrokerImportInput) {
 const fills: Row[] = [], skipped: Row[] = [], needs_confirmation: Row[] = [], reconciliation: Row[] = [];
 const result = () => ({ fills, skipped, needs_confirmation, reconciliation });
 if (!input || !["jpm", "etrade"].includes(input.broker) || typeof input.csv !== "string" || !isIsoDate(input.import_date) || !Array.isArray(input.fills) || !Array.isArray(input.accounts)) {
  needs_confirmation.push({ reason: "unknown-row-type", detail: "invalid-import-input" }); return result();
 }
 const accounts = input.accounts.map(unwrap), history = input.fills.map(historical);
 const reversed = new Set(history.filter(r => r.record_type === "REVERSAL").map(r => String(r.reversal_of)));
 const active = history.filter(r => r.record_type !== "REVERSAL" && !reversed.has(factId(r)) && !reversed.has(String(r._id)));
 const resolution = (r: Row) => resolveAccount(r.account_ref, accounts);
 let rows: CsvRow[];
 try { rows = csvRows(input.csv); } catch (e) { needs_confirmation.push({ reason: "unknown-row-type", detail: String(e) }); return result(); }
 const jpm = input.broker === "jpm";
 const headerIndex = jpm ? 0 : rows.findIndex(r => r.cells[0] === "Activity/Trade Date");
 const header = rows[headerIndex]?.cells;
 const required = jpm ? ["Trade Date", "Settlement Date", "Account Name", "Account Type", "Account Number", "Type", "Description", "Ticker", "Price USD", "Quantity", "Amount USD", "Commissions USD", "Tran Code"] : ["Activity/Trade Date", "Settlement Date", "Activity Type", "Description", "Symbol", "Quantity #", "Price $", "Amount $", "Commission"];
 if (!header || required.some(h => !header.includes(h)) || new Set(header).size !== header.length) {
  needs_confirmation.push({ reason: "unknown-row-type", detail: "invalid-csv-header" }); return result();
 }
 const accountLabel = rows.map(r => r.cells[0]?.match(/^Account Activity for\s+(.+?)\s+from LAST \d+ Days\s*$/)?.[1]).find(Boolean);
 const records: Row[] = [], stocks: Row[] = [], observedDates: string[] = [], scope = new Set<string>();
 for (const row of rows.slice(headerIndex + 1)) {
  if (row.cells.every(c => c === "")) { if (!jpm) break; else continue; }
  const r: Row = Object.fromEntries(header.map((h, i) => [h, row.cells[i] ?? ""]));
  const line = row.line, type = r[jpm ? "Type" : "Activity Type"], trade = date(r[jpm ? "Trade Date" : "Activity/Trade Date"]);
  const fail = (reason: string, detail?: string) => {
   const alias = jpm ? { kind: "jpm-export" as const, account_name: r["Account Name"], account_type: r["Account Type"], account_number: r["Account Number"] } : { kind: "etrade-export" as const, account_label: accountLabel || "" };
   const ref = resolveAccount(alias, accounts);
   needs_confirmation.push({ line, type, reason, trade_date: trade, ...(ref.status === "matched" && { account_ref: ref.account_ref }), ...(detail && { detail }) });
  };
  if (row.cells.length !== header.length || !trade) { fail("unknown-row-type", "invalid-csv-row"); continue; }
  observedDates.push(trade);
  const stock = jpm ? ["Purchase", "Sale"].includes(type) : ["Sold", "Bought"].includes(type);
  const known = jpm ? ({ "Write option": "166", "Buy back option": "671", "Expired option": "668", Purchase: "651", Sale: "151" } as Row)[type] : ["Sold Short", "Bought To Cover", "Option Assigned", "Sold", "Bought"].includes(type);
  if (!known || (jpm && r["Tran Code"] !== known)) { fail("unknown-row-type"); continue; }
  const alias = jpm ? { kind: "jpm-export" as const, account_name: r["Account Name"], account_type: r["Account Type"], account_number: r["Account Number"] } : { kind: "etrade-export" as const, account_label: accountLabel || "" };
  const account = resolveAccount(alias, accounts);
  if (stock) { stocks.push({ line, type, raw: r, trade, account }); continue; }
  // Ordinary securities alone do not establish an option export coverage window.
  if (account.status === "matched") scope.add(account.account_ref);
  if (account.status !== "matched") { needs_confirmation.push({ line, type, trade_date: trade, reason: account.status === "ambiguous-account" ? "account-unconfirmed" : "unknown-account", candidates: account.candidates }); continue; }
  const c = contract(r, input.broker);
  const qtyText = r[jpm ? "Quantity" : "Quantity #"].trim();
  const signedQty = /^-?\d+(?:\.0+)?$/.test(qtyText) ? Number(qtyText) : NaN;
  const qty = Math.abs(signedQty);
  if (!c || !Number.isSafeInteger(qty) || qty <= 0) { fail("unknown-row-type", "invalid-contract-or-quantity"); continue; }
  const common: Row = { line, lines: [line], account_ref: account.account_ref, ...c, instrument: JSON.stringify(c), qty, source: "broker-export" };
  if (type === "Expired option" || type === "Option Assigned") {
   const eventType = jpm ? "EXPIRE" : "ASSIGNED";
   const days = (Date.parse(trade) - Date.parse(c.expiry)) / 86400000;
   if (!jpm && days > 4) { fail("unknown-row-type", "assignment-date-outside-expiry-window"); continue; }
   const eventDate = jpm || days >= 0 ? c.expiry : trade;
   const id = `${c.option_symbol}:${eventType}:${eventDate}:${account.account_ref}`;
   records.push({ ...common, id, event_id: id, record_type: "EVENT", type: eventType, event_date: eventDate, trade_date: eventDate, activity_date: trade }); continue;
  }
  const sell = type === "Write option" || type === "Sold Short";
  const p = money(r[jpm ? "Price USD" : "Price $"]), commission = money(r[jpm ? "Commissions USD" : "Commission"]), amount = money(r[jpm ? "Amount USD" : "Amount $"]);
  if (p === undefined || p <= 0n || commission === undefined || commission < 0n || amount === undefined || (sell ? signedQty >= 0 : signedQty <= 0)) { fail("amount-mismatch"); continue; }
  const gross = p * BigInt(qty) * 100n;
  const fees = sell ? gross - commission - amount : -amount - gross - commission;
  if ((sell ? amount < 0n : amount > 0n) || fees < 0n || (jpm ? fees * 100n > gross : fees !== 0n)) { fail("amount-mismatch"); continue; }
  const settle = date(r["Settlement Date"]);
  if (!settle) { fail("unknown-row-type", "invalid-settlement-date"); continue; }
  records.push({ ...common, record_type: "FILL", side: sell ? "STO" : "BTC", price: price4(p), trade_date: trade, settle_date: settle, commission: price4(commission), fees: jpm ? price4(fees) : null, order_id: jpm ? /\bJUNO:\s*(\S+)/.exec(r.Description)?.[1] ?? null : null, partial_fill: "false" });
 }
 // Aggregate split CSV executions before identifying either fills or assignment deliveries.
 const grouped = new Map<string, Row>();
 const blocked = new Set<string>();
 for (const r of records) {
  const key = exportKey(r), prev = grouped.get(key);
  if (!prev) { grouped.set(key, { ...r }); continue; }
  if (r.record_type === "EVENT") { prev.qty += r.qty; prev.lines.push(...r.lines); continue; }
  if (prev.settle_date !== r.settle_date || (prev.order_id && r.order_id && prev.order_id !== r.order_id)) {
   blocked.add(key); needs_confirmation.push({ line: r.line, reason: "conflict", detail: "multiple-orders-or-settlement-dates", order_key: key }); continue;
  }
  const total = prev.qty + r.qty;
  // Keep exact numerator until all partial executions have been collected.
  prev._amount = (prev._amount ?? units(prev.price)! * BigInt(prev.qty)) + units(r.price)! * BigInt(r.qty);
  prev.qty = total; prev.price = price4(divide(prev._amount, BigInt(total)));
  prev.commission = price4(units(prev.commission)! + units(r.commission)!);
  if (jpm) prev.fees = price4(units(prev.fees)! + units(r.fees)!);
  prev.order_id ||= r.order_id; prev.lines.push(...r.lines);
 }
 const candidates = [...grouped].filter(([key]) => !blocked.has(key)).map(([, r]) => r);
 const assigned = candidates.filter(r => r.type === "ASSIGNED");
 const assignmentStocks = new Map<string, Row[]>();
 // Stock delivery legs can also be split into several executions in the same export.
 const stockGroups = new Map<string, Row>();
 for (const s of stocks) {
  const raw = s.raw, quantityKey = jpm ? "Quantity" : "Quantity #", priceKey = jpm ? "Price USD" : "Price $", amountKey = jpm ? "Amount USD" : "Amount $", commissionKey = jpm ? "Commissions USD" : "Commission";
  const key = JSON.stringify([s.trade, s.type, s.account, raw[jpm ? "Ticker" : "Symbol"], raw[priceKey], raw.Description]);
  const previous = stockGroups.get(key);
  const q = Number(raw[quantityKey]), a = money(raw[amountKey]), c = money(raw[commissionKey]);
  if (!previous || !Number.isSafeInteger(q) || a === undefined || c === undefined) { stockGroups.set(previous ? `${key}:${s.line}` : key, { ...s, raw: { ...raw }, lines: [s.line] }); continue; }
  const pa = money(previous.raw[amountKey]), pc = money(previous.raw[commissionKey]), pq = Number(previous.raw[quantityKey]);
  if (pa === undefined || pc === undefined || !Number.isSafeInteger(pq) || Math.sign(pq) !== Math.sign(q)) { stockGroups.set(`${key}:${s.line}`, { ...s, raw: { ...raw }, lines: [s.line] }); continue; }
  const totalAmount = pa + a;
  previous.raw[quantityKey] = String(pq + q);
  previous.raw[amountKey] = `${totalAmount < 0n ? "-" : ""}${price4(abs(totalAmount))}`;
  previous.raw[commissionKey] = price4(pc + c);
  previous.lines.push(s.line);
 }
 const historicalOrders = new Map<string, Row>();
 for (const h of active.filter(h => h.side === "STO")) {
  const ref = resolution(h);
  if (ref.status !== "matched" || !Number.isSafeInteger(h.qty) || h.qty <= 0) continue;
  const key = `${baseKey(h)}:${ref.account_ref}`;
  const previous = historicalOrders.get(key);
  if (previous) previous.qty += h.qty;
  else historicalOrders.set(key, { ...h, account_ref: ref.account_ref });
 }
 for (const s of stockGroups.values()) {
  const r = s.raw, symbol = r[jpm ? "Ticker" : "Symbol"], qty = Math.abs(Number(r[jpm ? "Quantity" : "Quantity #"])), p = money(r[jpm ? "Price USD" : "Price $"]);
  const sell = s.type === "Sale" || s.type === "Sold";
  const reason = /FUND/i.test(r.Description) && /XX$/.test(symbol) ? "money-market-fund" : !symbol && /DTD/i.test(r.Description) ? "bond" : "stock-trade-out-of-scope";
  const skip = () => skipped.push({ line: s.line, type: s.type, reason });
  if (!Number.isSafeInteger(qty) || qty <= 0 || p === undefined) { skip(); continue; }
  if (jpm) {
   const possible = [...candidates, ...historicalOrders.values()].filter(o => {
    const ref = o.source === "broker-export" && candidates.includes(o) ? o.account_ref : resolution(o).status === "matched" ? (resolution(o) as any).account_ref : undefined;
    return s.account.status === "matched" && ref === s.account.account_ref && o.side === "STO" && o.underlying === symbol && o.expiry === s.trade && units(o.strike) === p && o.qty * 100 === qty && o.right === (sell ? "call" : "put");
   });
   if (possible.length) needs_confirmation.push({ line: s.line, type: s.type, account_ref: s.account.account_ref, reason: "possible-assignment", candidates: [...new Set(possible.map(candidateId))] }); else skip();
   continue;
  }
  const matches = assigned.filter(o => s.account.status === "matched" && o.account_ref === s.account.account_ref && o.underlying === symbol && o.activity_date === s.trade && o.qty * 100 === qty && units(o.strike) === p && o.right === (sell ? "call" : "put"));
  if (matches.length !== 1) {
   if (matches.length > 1) needs_confirmation.push({ line: s.line, reason: "conflict", detail: "ambiguous-assignment-delivery" }); else skip();
   continue;
  }
  const event = matches[0]!, commission = money(r.Commission), settle = date(r["Settlement Date"]), amount = money(r["Amount $"]);
  if (commission === undefined || commission < 0n || !settle || amount === undefined || amount !== (sell ? p * BigInt(qty) - commission : -(p * BigInt(qty) + commission))) {
   needs_confirmation.push({ line: s.line, reason: "amount-mismatch" }); continue;
  }
  const instrument = { underlying: symbol, multiplier: 1 };
  const stockRow = { line: s.line, lines: s.lines, record_type: "FILL", account_ref: event.account_ref, ...instrument, instrument: JSON.stringify(instrument), side: sell ? "SELL" : "BUY", qty, price: price4(p), trade_date: s.trade, settle_date: settle, commission: price4(commission), fees: null, order_id: null, partial_fill: "false", source: "broker-export", caused_by_event: event.event_id };
  const deliveries = assignmentStocks.get(event.event_id) ?? []; deliveries.push(stockRow); assignmentStocks.set(event.event_id, deliveries);
 }
 for (const [id, deliveries] of assignmentStocks) {
  if (deliveries.length === 1) candidates.push(deliveries[0]!);
  else needs_confirmation.push({ reason: "conflict", event_id: id, detail: "multiple-assignment-deliveries", lines: deliveries.map(r => r.line) });
 }
 const touched = new Set<Row>();
 const acceptedEvents = new Map<string, string>();
 const clean = (r: Row): Row => {
  // `id` is only a working key here: a lead's data write treats `id` as "update host row _id", so rows carry fill_id/event_id instead.
  const { line, lines, activity_date, _amount, id, ...fields } = r;
  return fields;
 };
 const emit = (r: Row) => {
  if (!history.some(h => factId(h) === r.id) && !fills.some(h => factId(h) === r.id)) fills.push(clean(r));
 };
 const dependencyLine = (r: Row) => r.caused_by_event ? Math.max(r.line, assigned.find(e => e.event_id === r.caused_by_event)?.line ?? r.line) + 0.1 : r.line;
 for (const r of candidates.sort((a, b) => dependencyLine(a) - dependencyLine(b))) {
  if (r.record_type === "FILL") { r.order_key = exportKey(r); r.cum_qty = r.qty; r.id = `${r.order_key}:cum${r.qty}`; r.fill_id = r.id; }
  const action = (name: string, extra: Row = {}) => reconciliation.push({ line: r.line, lines: r.lines, id: r.id, action: name, ...extra });
  if (r.caused_by_event) {
   const eventId = acceptedEvents.get(r.caused_by_event);
   if (!eventId) { action("conflict"); needs_confirmation.push({ line: r.line, reason: "conflict", detail: "assignment-event-not-accepted", event_id: r.caused_by_event }); continue; }
   r.caused_by_event = eventId;
  }
  let matches = active.filter(h => {
   if (r.record_type === "EVENT") return h.record_type === "EVENT" && (h.event_id === r.event_id || (h.option_symbol === r.option_symbol && h.type === r.type && h.event_date === r.event_date));
   return (h.record_type ?? "FILL") === "FILL" && baseKey(h) === baseKey(r);
  }).filter(h => {
   const ref = resolution(h);
   return ref.status === "matched" ? ref.account_ref === r.account_ref : ref.candidates.includes(r.account_ref) || h.account_ref === r.account_ref;
  });
  // A shared mail alias must not block a different, nonmatching registered order.
  matches = matches.filter(h => {
   if (resolution(h).status === "matched") return true;
   const ref = resolution(h);
   const suggestions = candidates.filter(o => o.record_type === r.record_type && baseKey(o) === baseKey(r) && ref.status !== "matched" && ref.candidates.includes(o.account_ref) && o.qty === Number(h.qty) && (r.record_type === "EVENT" || units(o.price) === units(h.price)));
   return suggestions.length !== 1 || suggestions[0]!.account_ref === r.account_ref;
  });
  matches.forEach(h => touched.add(h));
  const ambiguous = matches.filter(h => resolution(h).status !== "matched");
  if (ambiguous.length) {
   const suggestion = candidates.filter(o => o.record_type === r.record_type && baseKey(o) === baseKey(r) && o.qty === ambiguous.reduce((n, h) => n + Number(h.qty), 0) && (r.record_type === "EVENT" || o.price === r.price));
   const extra = { candidates: [...new Set(ambiguous.flatMap(h => { const v = resolution(h); return v.status === "matched" ? [] : v.candidates; }))], ...(suggestion.length === 1 && { suggested: suggestion[0]!.account_ref }), existing: ambiguous.map(factId) };
   action("account-unconfirmed", extra); needs_confirmation.push({ line: r.line, reason: "account-unconfirmed", ...extra }); continue;
  }
  if (r.record_type === "EVENT") {
   if (matches.length > 1 || (matches.length === 1 && Number(matches[0]!.qty) !== r.qty)) { action("conflict"); needs_confirmation.push({ line: r.line, reason: "conflict", existing: matches.map(factId), exported: clean(r) }); }
   else if (matches.length) { action("already-recorded"); acceptedEvents.set(r.id, String(matches[0]!.event_id || factId(matches[0]!))); }
   else if (history.some(h => factId(h) === r.id)) { action("conflict"); needs_confirmation.push({ line: r.line, reason: "conflict", detail: "event-id-already-reversed-or-inconsistent" }); }
   else { emit(r); action("add"); acceptedEvents.set(r.id, r.event_id); }
   continue;
  }
  if (matches.length) {
   const qty = matches.reduce((n, h) => n + Number(h.qty), 0);
   const valid = matches.every(h => Number.isSafeInteger(h.qty) && h.qty > 0 && units(h.price) !== undefined);
   const average = valid ? divide(matches.reduce((n, h) => n + units(h.price)! * BigInt(h.qty), 0n), BigInt(qty)) : undefined;
   if (qty !== r.qty || average !== units(r.price)) {
    action("conflict"); needs_confirmation.push({ line: r.line, reason: "conflict", existing: matches.map(factId), exported: clean(r), detail: "quantity-or-price-mismatch" }); continue;
   }
   // Existing known metadata must agree, never silently replace a conflicting fact.
   const badMeta = matches.some(h => (!blank(h.settle_date) && h.settle_date !== r.settle_date) || (!blank(h.order_id) && !blank(r.order_id) && h.order_id !== r.order_id) || (!blank(h.caused_by_event) && h.caused_by_event !== r.caused_by_event));
   const badFees = ["commission", "fees"].some(key => matches.every(h => !blank(h[key])) && !blank(r[key]) && (matches.some(h => units(h[key]) === undefined) || matches.reduce((n, h) => n + (units(h[key]) ?? 0n), 0n) !== units(r[key])));
   if (!badMeta && !badFees && matches.length === 1 && factId(matches[0]!) === r.id) { action("already-recorded"); continue; }
   if (badMeta || badFees || history.some(h => factId(h) === r.id)) { action("conflict"); needs_confirmation.push({ line: r.line, reason: "conflict", detail: "metadata-or-replacement-id-conflict", existing: matches.map(factId) }); continue; }
   if (matches.some(h => !factId(h))) { action("conflict"); needs_confirmation.push({ line: r.line, reason: "conflict", detail: "missing-historical-fact-id" }); continue; }
   for (const h of matches) {
    const old = factId(h), id = `${old}:reversed-by-export`;
    emit({ record_type: "REVERSAL", id, fill_id: id, reversal_of: old, trade_date: h.trade_date, source: "broker-export" });
   }
   // Retain independently known historical facts not supplied by a broker CSV.
   const enriched = { ...r };
   for (const key of ["account_key", "underlying_kind", "deliverable", "settlement", "exercise_style", "tax_class", "executed_at", "trade_time", "limit_price"]) {
    const values = [...new Set(matches.map(h => h[key]).filter(v => !blank(v)))];
    if (values.length === 1 && blank(enriched[key])) enriched[key] = values[0];
   }
   emit(enriched); action("enrich", { reversed: matches.map(factId) });
  } else if (history.some(h => factId(h) === r.id)) { action("conflict"); needs_confirmation.push({ line: r.line, reason: "conflict", detail: "export-id-already-reversed-or-inconsistent" }); }
  else { emit(r); action("add"); }
 }
 const earliest = observedDates.sort()[0];
 for (const h of active) {
  if (touched.has(h) || (h.record_type ?? "FILL") !== "FILL" || !["broker-email", "manual"].includes(h.source) || !isIsoDate(h.trade_date)) continue;
  const ref = resolution(h);
  if (ref.status !== "matched" || !scope.has(ref.account_ref)) continue;
  if (!earliest || h.trade_date < earliest) { reconciliation.push({ id: factId(h), action: "outside-export-window" }); continue; }
  let settle = h.settle_date;
  if (blank(settle)) {
   if (h.trade_date < "2025-01-01" || h.trade_date >= CALENDAR_THROUGH) { needs_confirmation.push({ reason: "missing-from-export", id: factId(h), detail: "settlement-calendar-out-of-range" }); continue; }
   settle = shiftDate(h.trade_date, 1); while (!isTradingDay(settle)) settle = shiftDate(settle, 1);
  }
  if (!isIsoDate(settle)) { needs_confirmation.push({ reason: "missing-from-export", id: factId(h), detail: "invalid-historical-settlement-date" }); continue; }
  // A rejected CSV row on this date/account might be the missing execution; never assert its absence.
  const uncertain = needs_confirmation.some(n => ["unknown-row-type", "unknown-account", "amount-mismatch"].includes(n.reason) && (!n.trade_date || n.trade_date === h.trade_date) && (!n.account_ref || n.account_ref === ref.account_ref));
  if (settle >= input.import_date) reconciliation.push({ id: factId(h), action: "pending-settlement" });
  else if (uncertain) reconciliation.push({ id: factId(h), action: "export-coverage-unconfirmed" });
  else { reconciliation.push({ id: factId(h), action: "missing-from-export" }); needs_confirmation.push({ reason: "missing-from-export", id: factId(h), account_ref: ref.account_ref, settle_date: settle }); }
 }
 return result();
}
