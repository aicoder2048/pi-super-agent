// Writes option-ta feeds/watch/fixtures/*.json from scratch. Run: node tests/helpers/option-ta-make-watch-fixtures.mjs docs/modules/examples/option-ta
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.argv[2], "feeds/watch/fixtures");
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) rmSync(join(dir, f));
const BASE = "https://api.massive.com", FH = "https://finnhub.io/api/v1";
const ny = (date, hm) => { const [h, m] = hm.split(":").map(Number); return Date.parse(`${date}T00:00:00Z`) + (h + 5) * 3600e3 + m * 60e3; }; // EST in Nov
const ns = (ms) => ms * 1e6;
const occ = (u, exp, right, strike) => `${u}${exp.slice(2).replaceAll("-", "")}${right === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
let rowId = 0;
function position({ u = "SPY", exp, right = "put", strike, side = "STO", qty = 1, price = "2.0000", date = "2026-11-02" }) {
	const option_symbol = occ(u, exp, right, strike);
	return { id: String(++rowId), from: "fictional-fixture", fields: { record_type: "FILL", fill_id: `${option_symbol}:${side}:${date}:acct-1:cum${qty}`, order_key: `${option_symbol}:${side}:${date}:acct-1`, account_ref: "acct-1", underlying: u, option_symbol, right, strike, expiry: exp, multiplier: 100, side, qty, price, trade_date: date, source: "broker-email" } };
}
function snapshot(p, { spot, mid, spotAt, quoteAt, bid, ask }) {
	const f = p.fields;
	const half = 0.05;
	return { results: { details: { ticker: `O:${f.option_symbol}`, contract_type: f.right, exercise_style: "american", expiration_date: f.expiry, strike_price: f.strike, shares_per_contract: 100 },
		last_quote: mid === null ? { bid: 0, ask: 0, midpoint: 0, last_updated: ns(quoteAt), timeframe: "REAL-TIME" } : { bid: bid ?? +(mid - half).toFixed(2), ask: ask ?? +(mid + half).toFixed(2), midpoint: mid, last_updated: ns(quoteAt), timeframe: "REAL-TIME" },
		last_trade: {}, day: {}, greeks: {}, open_interest: 1000,
		underlying_asset: spot === null ? { ticker: f.underlying, timeframe: "DELAYED" } : { price: spot, last_updated: ns(spotAt), ticker: f.underlying, timeframe: "DELAYED" } }, status: "OK", request_id: "fixture" };
}
const ETF_DIVS = { results: [{ cash_amount: 1.888834, dividend_type: "CD", ex_dividend_date: "2026-09-18", frequency: 4, ticker: "SPY" }, { cash_amount: 1.903516, dividend_type: "CD", ex_dividend_date: "2026-06-18", frequency: 4, ticker: "SPY" }], status: "OK" };
const NO_EARNINGS = { earningsCalendar: [] };
const divUrl = (u) => `${BASE}/v3/reference/dividends?ticker=${u}&limit=10`;
const earnUrl = (u, today) => { const to = new Date(Date.parse(`${today}T00:00:00Z`) + 120 * 864e5).toISOString().slice(0, 10); return `${FH}/calendar/earnings?from=${today}&to=${to}&symbol=${u}`; };
const snapUrl = (p) => `${BASE}/v3/snapshot/options/${p.fields.underlying}/O:${p.fields.option_symbol}`;
function write(name, { today = "2026-11-19", at = "10:00", positions, quotes, divs = ETF_DIVS, earnings = NO_EARNINGS, cursor, extra = {}, net = true }) {
	const now = new Date(ny(today, at)).toISOString();
	const responses = {};
	if (net) {
		for (const u of new Set(positions.map((p) => p.fields.underlying))) {
			responses[divUrl(u)] = typeof divs === "function" ? divs(u) : divs;
			responses[earnUrl(u, today)] = typeof earnings === "function" ? earnings(u, today) : earnings;
		}
		positions.forEach((p, i) => (responses[snapUrl(p)] = quotes[i].status ? quotes[i] : snapshot(p, { spotAt: ny(today, "09:44"), quoteAt: ny(today, at), ...quotes[i] })));
	}
	Object.assign(responses, extra);
	const input = { now, rows: { fills: positions } };
	if (cursor !== undefined) input.cursor = cursor;
	writeFileSync(join(dir, `${name}.json`), JSON.stringify({ input, responses }, null, 1) + "\n");
}
const far = (exp = "2026-12-18") => ({ exp, strike: 100 });
// fills 为空、休市
write("no-positions", { positions: [], quotes: [], net: false });
write("market-closed", { today: "2026-11-21", at: "11:00", positions: [position(far())], quotes: [], net: false });
// 到期临近：11-19 之后第 5 个交易日是 11-27（11-26 感恩节休市）
write("expiry-near-fires", { positions: [position({ exp: "2026-11-27", strike: 100 })], quotes: [{ spot: 120, mid: 1.5 }] });
write("expiry-near-quiet", { positions: [position({ exp: "2026-11-30", strike: 100 })], quotes: [{ spot: 120, mid: 1.5 }] });
// 到期日开盘：11-20 到期，买入的 put（不触发卖方规则）
const expiring = () => position({ exp: "2026-11-20", strike: 100, side: "BTO" });
write("expiry-open-fires", { today: "2026-11-20", at: "09:50", positions: [expiring()], quotes: [{ spot: 102, mid: 0.4, spotAt: ny("2026-11-20", "09:35") }] });
write("expiry-open-before-0945", { today: "2026-11-20", at: "09:40", positions: [expiring()], quotes: [{ spot: 102, mid: 0.4, spotAt: ny("2026-11-20", "09:31") }] });
write("expiry-open-quiet", { today: "2026-11-20", at: "09:50", positions: [expiring()], quotes: [{ spot: 110, mid: 0.05, spotAt: ny("2026-11-20", "09:35") }] });
// 接近、穿过行权价（卖出的 put 100）
write("strike-near-fires", { positions: [position(far())], quotes: [{ spot: 101.5, mid: 1.2 }] });
write("strike-crossed-fires", { positions: [position(far())], quotes: [{ spot: 99, mid: 2.4 }] });
write("strike-quiet", { positions: [position(far())], quotes: [{ spot: 103, mid: 1.2 }] });
// 权利金：开仓 2.00
write("profit-50-fires", { positions: [position(far())], quotes: [{ spot: 120, mid: 0.9 }] });
write("profit-80-fires", { positions: [position(far())], quotes: [{ spot: 120, mid: 0.3 }] });
write("profit-quiet", { positions: [position(far())], quotes: [{ spot: 120, mid: 1.2 }] });
// 财报：NVDA 卖出 put 150，12-18 到期
const nvda = () => position({ u: "NVDA", exp: "2026-12-18", strike: 150 });
const nvdaDivs = { results: [{ cash_amount: 0.01, dividend_type: "CD", ex_dividend_date: "2026-09-11", frequency: 4, ticker: "NVDA" }], status: "OK" };
const cal = (date) => (u) => ({ earningsCalendar: [{ symbol: u, date, hour: "amc", epsActual: null }] });
write("earnings-before-expiry-fires", { positions: [nvda()], quotes: [{ spot: 180, mid: 1.2 }], divs: nvdaDivs, earnings: cal("2026-12-02") });
write("earnings-soon-fires", { positions: [nvda()], quotes: [{ spot: 180, mid: 1.2 }], divs: nvdaDivs, earnings: cal("2026-11-23") });
write("earnings-quiet", { positions: [nvda()], quotes: [{ spot: 180, mid: 1.2 }], divs: nvdaDivs, earnings: cal("2027-01-15") });
// 除息：卖出的 SPY call 680，12-18 到期
const call = () => position({ exp: "2026-12-18", right: "call", strike: 680, price: "25.0000" });
const announced = { results: [{ cash_amount: 1.9, dividend_type: "CD", ex_dividend_date: "2026-11-23", frequency: 4, ticker: "SPY" }, ...ETF_DIVS.results], status: "OK" };
const projected = { results: [{ cash_amount: 1.9, dividend_type: "CD", ex_dividend_date: "2026-08-21", frequency: 4, ticker: "SPY" }], status: "OK" };
write("ex-div-fires", { positions: [call()], quotes: [{ spot: 700, mid: 21 }], divs: announced });
write("ex-div-expected-fires", { positions: [call()], quotes: [{ spot: 700, mid: 21 }], divs: projected });
write("ex-div-quiet", { positions: [call()], quotes: [{ spot: 650, mid: 20 }], divs: announced });
// 缺数据、报价不是今天常规时段的、429 和 5xx
write("missing-data", { positions: [position(far())], quotes: [{ spot: null, mid: null }], divs: { results: [], status: "OK" } });
write("stale-quote", { positions: [position(far())], quotes: [{ spot: 99, mid: 0.3, spotAt: ny("2026-11-18", "15:59"), quoteAt: ny("2026-11-18", "15:59") }] });
write("http-429", { positions: [position(far())], quotes: [{ status: 429, headers: { "retry-after": "30" }, body: { status: "ERROR", error: "too many requests" } }] });
write("http-5xx-third-beat", { positions: [position(far())], quotes: [{ status: 503, body: { status: "ERROR" } }], divs: { status: 502 }, cursor: JSON.stringify({ date: "2026-11-19", decided: [], events: {}, failures: 2 }) });
console.log(readdirSync(dir).join("\n"));
