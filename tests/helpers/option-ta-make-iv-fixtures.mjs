// Writes option-ta feeds/iv/fixtures/*.json from scratch. Run: node tests/helpers/option-ta-make-iv-fixtures.mjs docs/modules/examples/option-ta
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.argv[2], "feeds/iv/fixtures");
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) rmSync(join(dir, f));
const B = "https://api.massive.com";
const ny = (date, hm) => { const [h, m] = hm.split(":").map(Number); return Date.parse(`${date}T00:00:00Z`) + (h + 5) * 3600e3 + m * 60e3; };
const iso = (date, hm) => new Date(ny(date, hm)).toISOString();
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const occ = (exp, k) => `O:SPY${exp.slice(2).replaceAll("-", "")}P${String(Math.round(k * 1000)).padStart(8, "0")}`;
const watch = [{ id: "1", from: "fictional-fixture", fields: { symbol: "SPY", added_at: "2026-11-19T21:00:00.000Z" } }];
const stockBars = (bars) => ({ ticker: "SPY", adjusted: false, results: Object.entries(bars).map(([d, c]) => ({ o: c, h: c, l: c, c, v: 1000000, t: ny(d, "00:00") })), status: "OK" });
const underlyingUrl = (from, to) => `${B}/v2/aggs/ticker/SPY/range/1/day/${from}/${to}?adjusted=false&sort=asc&limit=50000`;
const band = (spot) => [(spot * 0.95).toFixed(2), (spot * 1.05).toFixed(2)];
const contractsUrl = (d, spot, expired) => { const [lo, hi] = band(spot); return `${B}/v3/reference/options/contracts?underlying_ticker=SPY&contract_type=put&expiration_date.gte=${shift(d, 21)}&expiration_date.lte=${shift(d, 45)}&strike_price.gte=${lo}&strike_price.lte=${hi}${expired ? "&expired=true" : ""}&sort=expiration_date&order=asc&limit=250`; };
const contract = (exp, k) => ({ ticker: occ(exp, k), underlying_ticker: "SPY", contract_type: "put", exercise_style: "american", expiration_date: exp, strike_price: k, shares_per_contract: 100 });
const binary = (exp) => ({ ticker: `O:B1SPY${exp.slice(2).replaceAll("-", "")}P00001000`, underlying_ticker: "SPY", contract_type: "put", exercise_style: "european", expiration_date: exp, strike_price: 1, type: "binary" });
const list = (rows) => ({ results: rows, status: "OK" });
const barUrl = (ticker, d) => `${B}/v2/aggs/ticker/${ticker}/range/1/day/${d}/${d}?adjusted=false`;
const optBar = (d, c) => ({ ticker: "x", resultsCount: c === null ? 0 : 1, ...(c === null ? {} : { results: [{ o: c, h: c, l: c, c, v: 10, t: ny(d, "00:00") }] }), status: "OK" });
const cursor = (done, failures = 0) => JSON.stringify({ methodology: "option-ta-iv-close-v1", done, failures });
function write(name, { now, rows = { watchlist: watch }, cursor: c, settings, responses = {} }) {
	const input = { now, rows };
	if (c !== undefined) input.cursor = c;
	if (settings) input.settings = settings;
	writeFileSync(join(dir, `${name}.json`), JSON.stringify({ input, responses }, null, 1) + "\n");
}
write("empty-watchlist", { now: iso("2026-11-19", "16:40"), rows: { watchlist: [] } });
write("already-saved", { now: iso("2026-11-19", "17:00"), cursor: cursor({ SPY: "2026-11-19" }) });
write("market-closed", { now: iso("2026-11-21", "12:00"), cursor: cursor({ SPY: "2026-11-20" }) });
write("holiday", { now: iso("2026-11-26", "17:00"), cursor: cursor({ SPY: "2026-11-25" }) });
write("before-close-wait", { now: iso("2026-11-19", "16:20"), cursor: cursor({ SPY: "2026-11-18" }) });
// 日常：11-19 收盘后存一行，带中间价
const D = "2026-11-19";
const daily = {
	[underlyingUrl(D, D)]: stockBars({ [D]: 740 }),
	[contractsUrl(D, 740, false)]: list([binary("2026-12-10"), contract("2026-12-10", 740), contract("2026-12-11", 740)]),
	[barUrl(occ("2026-12-10", 740), D)]: optBar(D, 12.3),
	[`${B}/v3/snapshot/options/SPY/${occ("2026-12-10", 740)}`]: { results: { details: { ticker: occ("2026-12-10", 740) }, last_quote: { bid: 12.3, ask: 12.4, midpoint: 12.35, last_updated: ny(D, "16:14") * 1e6, timeframe: "REAL-TIME" } }, status: "OK" },
};
write("daily", { now: iso(D, "16:40"), cursor: cursor({ SPY: "2026-11-18" }), responses: daily });
write("daily-option-bars-not-ready", { now: iso(D, "16:40"), cursor: cursor({ SPY: "2026-11-18" }), responses: { ...daily, [barUrl(occ("2026-12-10", 740), D)]: optBar(D, null), [barUrl(occ("2026-12-11", 740), D)]: optBar(D, null) } });
write("daily-not-ready", { now: iso(D, "16:40"), cursor: cursor({ SPY: "2026-11-18" }), responses: { [underlyingUrl(D, D)]: stockBars({}) } });
// 回填：新加的标的，每拍有请求上限，这一拍做完 4 个交易日
const start = shift(D, -365); // 2025-11-19
const bf = {
	[underlyingUrl(start, D)]: stockBars({ "2025-11-19": 660, "2025-11-20": 655, "2025-11-21": 650, "2025-11-24": 670 }),
	[contractsUrl("2025-11-19", 660, true)]: list([binary("2025-12-10"), contract("2025-12-10", 660), contract("2025-12-10", 661), contract("2025-12-10", 659), contract("2025-12-12", 660)]),
	[barUrl(occ("2025-12-10", 660), "2025-11-19")]: optBar("2025-11-19", null),
	[barUrl(occ("2025-12-10", 659), "2025-11-19")]: optBar("2025-11-19", 9.5),
	[contractsUrl("2025-11-20", 655, true)]: list([contract("2025-12-11", 655)]),
	[barUrl(occ("2025-12-11", 655), "2025-11-20")]: optBar("2025-11-20", 10),
	[contractsUrl("2025-11-21", 650, true)]: list([]),
	[contractsUrl("2025-11-24", 670, true)]: list([contract("2025-12-15", 680)]),
	[barUrl(occ("2025-12-15", 680), "2025-11-24")]: optBar("2025-11-24", 9),
};
write("backfill-new-symbol", { now: iso(D, "16:40"), settings: { requestsPerTick: 15 }, responses: bf });
// 按 2025-12-01 QQQ 的实测应答缩写：不带 as_of 的列表把那天还没挂牌的 12-22 周一到期也列出来，日线一根没有；那天挂牌的最近到期日是 12-26
const Q = "2025-12-01";
const qocc = (exp, k) => occ(exp, k).replace("O:SPY", "O:QQQ");
const qcontract = (exp, k) => ({ ...contract(exp, k), ticker: qocc(exp, k), underlying_ticker: "QQQ" });
const qcontracts = (extra) => `${B}/v3/reference/options/contracts?underlying_ticker=QQQ&contract_type=put&expiration_date.gte=2025-12-22&expiration_date.lte=2026-01-15&strike_price.gte=579.50&strike_price.lte=640.50${extra}&sort=expiration_date&order=asc&limit=250`;
const qqq = {
	[underlyingUrl(Q, D).replace("/SPY/", "/QQQ/")]: { ...stockBars({ [Q]: 610, "2025-12-02": 612 }), ticker: "QQQ" },
	[qcontracts("&expired=true")]: list([610, 609, 611, 608].map((k) => qcontract("2025-12-22", k)).concat([qcontract("2025-12-26", 610)])),
	...Object.fromEntries([610, 609, 611, 608].map((k) => [barUrl(qocc("2025-12-22", k), Q), optBar(Q, null)])),
	[qcontracts(`&as_of=${Q}`)]: list([qcontract("2025-12-26", 610), qcontract("2025-12-26", 609), qcontract("2025-12-26", 611), qcontract("2025-12-31", 610)]),
	[barUrl(qocc("2025-12-26", 610), Q)]: optBar(Q, 6.4),
};
write("backfill-unlisted-expiration", { now: iso(D, "16:40"), rows: { watchlist: [{ ...watch[0], fields: { ...watch[0].fields, symbol: "QQQ" } }] }, cursor: cursor({ QQQ: "2025-11-28" }), settings: { requestsPerTick: 10 }, responses: qqq });
write("backfill-no-bars", { now: iso(D, "16:40"), responses: { [underlyingUrl(start, D)]: stockBars({}) } });
// 429 和 5xx
write("http-429", { now: iso(D, "16:40"), cursor: cursor({ SPY: "2026-11-18" }), responses: { [underlyingUrl(D, D)]: stockBars({ [D]: 740 }), [contractsUrl(D, 740, false)]: { status: 429, headers: { "retry-after": "30" }, body: { status: "ERROR", error: "too many requests" } } } });
write("http-5xx-third-beat", { now: iso(D, "16:45"), cursor: cursor({ SPY: "2026-11-18" }, 2), responses: { [underlyingUrl(D, D)]: { status: 503 } } });
console.log(readdirSync(dir).join("\n"));
