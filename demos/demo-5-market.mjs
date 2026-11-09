// 真实美股：没人开口，宿主自己每分钟看一遍自选股；程序只把「到档」交给幕僚长；大波动开任务查数据；同一只股票的下一档直达已订阅的助手。
import { existsSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateDir, loadConfig } from "../src/host/config.ts";
import { nyTime as et, sessionAt } from "../src/sources/market/session.ts";
import { Demo, FLAGS, skip, sleep, fmtTicket, fmtTrigger } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Only the path is handed to the host's secretsFile; this script never opens the file.
const SECRETS = process.env.PSA_DEMO_SECRETS_FILE ? resolve(process.env.PSA_DEMO_SECRETS_FILE) : loadConfig(defaultStateDir()).secretsFile;
if (!SECRETS) {
	console.error("demo-market 需要行情密钥文件：设 PSA_DEMO_SECRETS_FILE=<.env 路径>，或在 ~/.pi-super-agent/config.json 写 secretsFile。");
	process.exit(2);
}
const WATCHLIST = ["META", "TSLA", "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "SPY", "QQQ"];
const INDEXES = new Set(["SPY", "QQQ"]);
const MINUTE = 60_000;
const RUN_AFTER_OPEN_MS = 25 * MINUTE;
const DRY = FLAGS.has("--dry");

const OPEN_AT = sessionAt(Date.now()).openAt;
const DEADLINE = OPEN_AT + RUN_AFTER_OPEN_MS;
const left = () => DEADLINE - Date.now();

process.env.PSA_MARKET_TAP = join(HERE, "out", "demo-5-market", "market-tap.jsonl");
const d = new Demo("demo-5-market", {
	port: 45195,
	dwellMs: 8_000,
	preload: join(HERE, "market-tap.mjs"),
	config: { secretsFile: SECRETS },
});
const TAP = process.env.PSA_MARKET_TAP;
writeFileSync(TAP, "");

const tap = () => (existsSync(TAP) ? readFileSync(TAP, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const isPoll = (e) => e.kind === "snapshot" && (e.tickers ?? "").split(",").length === WATCHLIST.length;
const polls = () => tap().filter(isPoll);
const lookups = () => tap().filter((e) => !isPoll(e));
const marketTriggers = (st) => st.triggers.filter((t) => t.source === "us-market");
// The latest kernel state, re-read at most every 5 s by the painter and on demand by the scenes.
let lastSeen = { triggers: [], tickets: [], conversation: [] };
let seenAt = 0;

const BAND = /^(\S+) (?:涨|跌) [+-][\d.]+%，到达 ([+-][\d.]+)% 档/;
function band(t) {
	const m = BAND.exec(t.body);
	if (m) return { symbol: m[1], pct: Number(m[2]), big: Math.abs(Number(m[2])) >= (INDEXES.has(m[1]) ? 2 : 5) };
	return { symbol: t.body.split(" ")[0], pct: null, big: false };
}
const describe = (t) => {
	const b = band(t);
	return `${b.symbol} ${b.pct === null ? "放量" : `${b.pct > 0 ? "+" : ""}${b.pct}% 档`} → ${t.disposition}${t.detail ? `(${t.detail.slice(0, 40)})` : ""}`;
};
const pollsWithTriggers = (st) => {
	const ps = polls();
	const ts = marketTriggers(st);
	return ps.filter((p, i) => ts.some((t) => t.receivedAt >= p.at && t.receivedAt < (ps[i + 1]?.at ?? Infinity))).length;
};

function workerLookups() {
	const dir = join(d.stateDir, "sessions", "workers");
	const found = [];
	const walk = (v) => {
		if (!v || typeof v !== "object") return;
		if (v.type === "toolCall" && v.name === "lookup") found.push(`${v.arguments?.op}${v.arguments?.args?.symbol ? ` ${v.arguments.args.symbol}` : ""}${v.arguments?.args?.symbols ? ` ${v.arguments.args.symbols.join(",")}` : ""}`);
		for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
	};
	const files = (p) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(p, e.name)) : e.name.endsWith(".jsonl") ? [join(p, e.name)] : [])) : []);
	for (const f of files(dir)) for (const line of readFileSync(f, "utf8").split("\n")) if (line.includes('"lookup"')) {
		try {
			walk(JSON.parse(line));
		} catch {}
	}
	return found;
}

async function paintTap() {
	const ps = polls();
	const last = ps.at(-1);
	const st = lastSeen;
	const today = await d.page.locator("#today").innerText().catch(() => "");
	const lines = [
		`美股行情 · 宿主自己的请求\n（演示脚本只旁听，不另外请求）`,
		`ET 现在 ${et(Date.now())}，开盘 09:30，演示到 ${et(DEADLINE)}`,
		`看盘 ${ps.length} 次，其中产生消息 ${pollsWithTriggers(st)} 次\n到档消息 ${marketTriggers(st).length} 条 · 助手查数据 ${lookups().length} 次`,
	];
	if (last) {
		const fresh = (q) => q.at && q.at >= OPEN_AT;
		lines.push(`最近一次 ${et(last.at)} ET${last.apiStatus === "DELAYED" ? "（延迟行情）" : ""}：`);
		lines.push((last.quotes ?? []).map((q) => `${q.s} ${q.pct > 0 ? "+" : ""}${q.pct}%${fresh(q) ? "" : "*"}`).join("  "));
		if ((last.quotes ?? []).some((q) => !fresh(q))) lines.push("* 报价还是开盘前的，不算当天行情");
	} else lines.push(Date.now() < OPEN_AT ? "开盘前：一次请求都没有" : "等第一次看盘…");
	lines.push(`左栏 ${today.replace(/\s+/g, " ") || "今日暂无来源消息"}`);
	await d.page.evaluate((ls) => {
		let box = document.getElementById("__demo_tap");
		if (!box) {
			box = document.createElement("div");
			box.id = "__demo_tap";
			box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:99998;background:rgba(15,23,42,.92);color:#e2e8f0;padding:8px 10px;border-radius:12px;font:11.5px/1.5 ui-monospace,'SF Mono',Menlo,'PingFang SC',monospace;width:250px;pointer-events:none;white-space:pre-wrap";
			document.body.append(box);
		}
		box.replaceChildren(...ls.map((l, i) => Object.assign(document.createElement("div"), { textContent: l, style: i === 0 ? "color:#7dd3fc;font-weight:600" : "" })));
	}, lines).catch(() => {});
}

function refresh() {
	lastSeen = d.state();
	seenAt = Date.now();
	return lastSeen;
}

await d.run(async () => {
	d.log(`open ${new Date(OPEN_AT).toISOString()}, deadline ${new Date(DEADLINE).toISOString()}${DRY ? " (dry run)" : ""}`);
	const url = await d.startHost();
	await d.openBrowser(url);
	refresh();
	const painter = setInterval(() => {
		if (Date.now() - seenAt > 5000) refresh();
		void paintTap();
	}, 3000);
	try {

		await d.scene("开场 · 关注的来源：美股行情", ["你不问，它就不看；问了也只能现查一次", "左栏「关注的来源」里有「美股行情」：交易时段每分钟看一遍 9 只自选股，开盘前不发一次请求"], async () => {
			const row = d.page.locator("#left .watch", { hasText: "美股行情" }).first();
			await row.waitFor({ timeout: 20_000 });
			const text = (await row.innerText()).replace(/\s+/g, " ");
			const problem = await row.evaluate((n) => n.classList.contains("problem"));
			await sleep(DRY ? 15_000 : 4_000);
			const log = d.host.log();
			const keyLine = /\[us-market\] 美股行情：([^\n]*)/.exec(log)?.[1] ?? "";
			const resting = /\[us-market\] 不在交易时段，暂停请求行情/.test(log);
			const n = tap().length;
			const preOpen = Date.now() < OPEN_AT;
			return Demo.check(!problem && /密钥来自 secretsFile/.test(keyLine) && (!preOpen || (resting && n === 0)), `watch row「${text}」 problem=${problem}; host.log「${keyLine.replace(SECRETS, "<secretsFile>")}」; resting=${resting}; requests so far=${n}; now ${et(Date.now())} ET`, "market source not live or requested before the open");
		});
		if (DRY) return;

		await d.scene("一 · 等开盘：开盘前一次请求都不发", ["一直开着窗口刷新，或者干脆忘了看", "宿主自己算交易时段，09:30 ET 前只等着；开盘后第一分钟开始看盘，用的是宿主自己的 5 次/分钟额度"], async () => {
			if (Date.now() < OPEN_AT) await d.until("open", () => Date.now() >= OPEN_AT, OPEN_AT - Date.now() + 5_000, 1000);
			const first = await d.until("first poll", () => polls()[0], 3 * MINUTE, 2000);
			const before = tap().filter((e) => e.at < OPEN_AT).length;
			if (!first) return skip(`no poll by ${et(Date.now())} ET; requests before open=${before}; host.log tail「${d.host.log().split("\n").filter((l) => l.includes("us-market")).at(-1) ?? ""}」`);
			return Demo.check(before === 0 && first.at >= OPEN_AT, `requests before open=${before}; first poll ${new Date(first.at).toISOString()} (${et(first.at)} ET) status=${first.status}/${first.apiStatus}; ${first.quotes?.length ?? 0} quotes`, "requests happened before the open");
		});

		await d.scene("二 · 每分钟看一遍，没到档就不出声", ["要么你自己盯盘，要么每个数字都推给你", "程序先筛：9 只股票每分钟一遍，只有第一次到达某一档（个股 3/5/8%，SPY、QQQ 1.5/2/3%）才变成一条消息；其余什么都不说"], async () => {
			const st = await d.until("first us-market trigger", () => {
				const x = refresh();
				return marketTriggers(x).length ? x : null;
			}, Math.max(0, left() - 6 * MINUTE), 3000);
			const x = st ?? refresh();
			const ps = polls();
			const fresh = ps.filter((p) => (p.quotes ?? []).some((q) => q.at >= OPEN_AT)).length;
			const evidence = `polls=${ps.length} (with today's quotes ${fresh}, api ${[...new Set(ps.map((p) => p.apiStatus))].join("/")}); polls that produced a message=${pollsWithTriggers(x)}; first trigger「${marketTriggers(x)[0]?.body.slice(0, 50) ?? "none"}」`;
			if (!ps.length) return skip(evidence);
			return Demo.check(ps.length >= 2 && pollsWithTriggers(x) <= Math.ceil(ps.length / 2), evidence, st ? "most polls produced messages" : "no band reached before the scene deadline");
		});

		await d.scene("三 · 第一次到档：交给幕僚长判断", ["每条提醒都原样推给你", "到档消息先到幕僚长：按模块规则，个股 5% 档以上、SPY/QQQ 2% 档以上开任务核实；3% 档只是背景，记一笔不打扰你"], async () => {
			const batch = marketTriggers(refresh());
			if (!batch.length) return skip(`no us-market trigger by ${et(Date.now())} ET`);
			const firstAt = batch[0].receivedAt;
			const ids = batch.filter((t) => t.receivedAt - firstAt < 30_000).map((t) => t.id);
			const st = await d.until("router decided", () => {
				const x = refresh();
				const ts = marketTriggers(x).filter((t) => ids.includes(t.id));
				return ts.every((t) => t.disposition !== "to_router") ? x : null;
			}, Math.min(4 * MINUTE, Math.max(30_000, left())), 2000);
			const x = st ?? refresh();
			const ts = marketTriggers(x).filter((t) => ids.includes(t.id));
			const routerLines = x.conversation.filter((m) => m.who === "router").length;
			const fits = (t) => (band(t).big ? ["opened_ticket", "handed_over", "delivered"] : ["router_ignored", "ignored"]).includes(t.disposition);
			await d.caption("三 · 第一次到档：交给幕僚长判断", "每条提醒都原样推给你", ts.map((t) => `${band(t).symbol} ${band(t).pct ?? "放量"}${band(t).pct === null ? "" : "% 档"}：${t.disposition === "opened_ticket" ? "开任务核实" : t.disposition === "router_ignored" ? "只是背景，不打扰你" : t.disposition}`).join("；"));
			await sleep(6000);
			const evidence = `${ts.map(describe).join("; ")}; 幕僚长 conversation lines=${routerLines}`;
			if (!st) return skip(`幕僚长 had not decided before the demo deadline: ${evidence}`);
			return Demo.check(ts.every(fits), evidence, "a decision did not match modules/us-market/rules.md");
		});

		let rule;
		await d.scene("四 · 大波动：没人开口，开任务去查", ["你得自己去查原因", "到 5% 档（SPY/QQQ 2% 档）时，幕僚长按规则开任务；助手用 lookup 经宿主查报价和分钟 K 线，再用一两句话写结论和报价时间"], async () => {
			const st = await d.until("rule ticket", () => {
				const x = refresh();
				return x.tickets.find((t) => t.basis === "rule") ? x : null;
			}, Math.max(0, left() - 4 * MINUTE), 3000);
			if (!st) {
				const bands = marketTriggers(refresh()).map(describe).join("; ") || "none";
				return skip(`no rule ticket by ${et(Date.now())} ET (no stock reached 5%, no index 2%); triggers: ${bands}`);
			}
			rule = st.tickets.find((t) => t.basis === "rule");
			await d.card("规则触发").first().waitFor({ timeout: 20_000 }).catch(() => {});
			await d.openCard(rule.title).catch(() => {});
			const step = d.page.locator("#steps .step", { hasText: /查询报价|查询 K 线|查询交易时段|lookup/ });
			await d.until("lookup step on page", () => step.count(), Math.min(3 * MINUTE, Math.max(20_000, left())), 1500);
			if (await step.count()) {
				await step.first().scrollIntoViewIfNeeded().catch(() => {});
				await step.first().locator("details > summary").click().catch(() => {});
			}
			const done = await d.until("rule ticket report", () => refresh().tickets.find((t) => t.id === rule.id && t.latest), Math.min(3 * MINUTE, Math.max(20_000, left())), 3000);
			await sleep(4000);
			const calls = workerLookups();
			const trg = marketTriggers(lastSeen).find((t) => t.detail === rule.id);
			return Demo.check(calls.length > 0, `${fmtTicket(done ?? rule)}; threads=${rule.threads.join(",")}; trigger ${trg ? fmtTrigger(trg) : "?"}; lookup calls [${calls.join("; ")}]; host-side lookup requests=${lookups().length}; report「${(done?.latest ?? "").slice(0, 80)}」`, "helper did not call lookup");
		});

		await d.scene("五 · 同一只股票的下一档：直达已订阅的助手", ["每条新提醒都当新问题，从头再问", "任务订阅了这只股票当天的行情线程；它再到下一档时，消息不经过幕僚长，直接送到那个助手（disposition delivered）"], async () => {
			if (!rule) return skip("no rule ticket, so nothing subscribed");
			const before = refresh().tickets.length;
			const t = await d.until("delivered trigger", () => marketTriggers(refresh()).find((x) => x.disposition === "delivered"), Math.max(0, left()), 3000);
			if (!t) {
				const sym = rule.threads.join(",");
				return skip(`no further band on ${sym} by ${et(Date.now())} ET; tickets=${lastSeen.tickets.length}`);
			}
			await d.openCard(rule.title).catch(() => {});
			const shown = await d.until("收到新消息 step", () => d.page.locator("#steps .step-title", { hasText: "收到新消息" }).count(), 60_000, 1500);
			await d.page.locator("#steps .step-title", { hasText: "收到新消息" }).last().scrollIntoViewIfNeeded().catch(() => {});
			await sleep(4000);
			return Demo.check(lastSeen.tickets.length === before, `trigger ${fmtTrigger(t)}; tickets ${before}->${lastSeen.tickets.length}; right panel 收到新消息 shown=${Boolean(shown)}`, "a new ticket was opened instead");
		});

		await d.scene("回看 · 噪音由程序挡掉，只在要紧时开口", ["每次刷新都是一次「回答」，无论有没有变化", "整段开盘：看盘次数、真正变成消息的次数、幕僚长开口的次数，都在下面"], async () => {
			const x = refresh();
			const ps = polls();
			const n = pollsWithTriggers(x);
			const routerLines = x.conversation.filter((m) => m.who === "router").length;
			const log = d.triggerLog().split("\n").filter((l) => l.includes("us-market"));
			d.log(`trigger log (src/cli/log.ts), us-market lines:\n${log.join("\n")}`);
			await d.caption("回看 · 噪音由程序挡掉，只在要紧时开口", "每次刷新都是一次「回答」，无论有没有变化", `看盘 ${ps.length} 次，${n} 次产生消息，共 ${marketTriggers(x).length} 条；任务 ${x.tickets.length} 个；幕僚长开口 ${routerLines} 次`);
			await sleep(8000);
			return Demo.check(ps.length > 0 && n <= ps.length / 2, `polls=${ps.length}; polls with messages=${n}; messages=${marketTriggers(x).length}; tickets=${x.tickets.length}; 幕僚长 lines=${routerLines}; log.ts us-market lines=${log.length}`, "no polls, or most polls produced messages");
		});

		await d.outro("小结 · 主动、事件驱动、订阅、面向人", "你问一句，它查一次，答一句", "没人开口它也在看；程序筛噪音，到档才交给幕僚长；大波动开任务，后续直达订阅的助手；只在要紧时找你");
	} finally {
		clearInterval(painter);
	}
});

const finalState = d.lastState ?? { triggers: [], tickets: [] };
const real = marketTriggers(finalState).map((t) => `  ${new Date(t.receivedAt).toISOString().slice(11, 19)}Z  ${band(t).symbol}  ${band(t).pct === null ? "volume" : `${band(t).pct}%`}  ${t.disposition}${t.detail ? `  ${t.detail}` : ""}`);
const ps = polls();
const lines = [
	`real us-market triggers (${real.length}):`,
	...(real.length ? real : ["  none"]),
	`polls by the host: ${ps.length}${ps.length ? ` (${et(ps[0].at)}-${et(ps.at(-1).at)} ET)` : ""}; host lookup requests: ${lookups().length}; requests before 09:30 ET: ${tap().filter((e) => e.at < OPEN_AT).length}`,
];
for (const l of lines) d.log(l);
appendFileSync(join(d.out, "summary.txt"), `${lines.join("\n")}\n`);
