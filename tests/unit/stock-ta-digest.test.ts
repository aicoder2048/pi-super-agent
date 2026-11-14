import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../../docs/modules/examples/stock-ta/feeds/scan/digest.ts";
import type { Hit } from "../../docs/modules/examples/stock-ta/hits.ts";

const DATE = "2026-11-12";
const hit = (rule: string, symbol: string, lean: Hit["lean"], level: Hit["level"], fact: string, extra: Partial<Hit> = {}): Hit => ({
	id: `${rule}:${symbol}:${DATE}`, rule, symbol, date: DATE, at: "2026-11-12T16:00:00.000Z", lean, fact, level, text: "", ...extra,
});

test("收盘小结：一行，按代码收在一起；开了任务的写「已开任务」，状态写仍在持续的，0 层只写条数", () => {
	const text = digest(DATE, [
		hit("high-52w", "NVDA", "bull", 2, "创 52 周新高 212.40（此前最高 210.88）"),
		hit("volume", "NVDA", "bull", 2, "放量 3.8 倍（按已过的交易时段折算）"),
		hit("move-1", "TSLA", "bear", 5, "到 -5% 档", { id: `move-1:TSLA:${DATE}:down` }),
		hit("R-MA-2-200", "META", "bear", 5, "收盘跌破 200 日线（收盘 97.00，200 日均线 98.50）"),
		hit("ta-other", "AMD", "bull", 0, "整数关口（ta R-SR-4）"),
		hit("gap", "AMD", "bull", 0, "开盘跳空 +3.40%", { whipsaw: 3 }),
	], ["AAPL 财报还有 3 个交易日，11-17 盘后"], false);
	assert.equal(text, "收盘小结 11-12（美东）：META 收盘跌破 200 日线，已开任务；TSLA 到 -5% 档，已开任务；NVDA 创 52 周新高 212.40、放量 3.8 倍；AAPL 财报还有 3 个交易日，11-17 盘后；AMD 开盘跳空来回翻 3 次。只记录的 2 条，问「今天有哪些信号」看全部。");
});

test("当天没有 1 层以上的命中就不发，只有 0 层的也不发", () => {
	assert.equal(digest(DATE, [], [], false), undefined);
	assert.equal(digest(DATE, [hit("ta-other", "AMD", "bull", 0, "整数关口（ta R-SR-4）")], ["AAPL 财报还有 2 个交易日，11-17 盘后"], false), undefined);
});

test("同根合并：组合只写组合的名字，两档只写高的那档；方向相反的命中分成看多、看空两组，写多空分歧", () => {
	const text = digest(DATE, [
		hit("volume", "NVDA", "bull", 2, "放量 4.0 倍（按已过的交易时段折算）", { combo: "volume+high-52w" }),
		hit("high-52w", "NVDA", "bull", 2, "创 52 周新高 212.40（此前最高 210.88）", { combo: "volume+high-52w" }),
		hit("volume+high-52w", "NVDA", "bull", 5, "放量创 52 周新高"),
		hit("move-1", "AMD", "bull", 2, "到 +5% 档", { id: `move-1:AMD:${DATE}:up` }),
		hit("move-2", "AMD", "bull", 2, "到 +8% 档", { id: `move-2:AMD:${DATE}:up` }),
		hit("R-MA-2-50:down", "AMD", "bear", 2, "收盘跌破 50 日线（收盘 97.00，50 日均线 98.50）"),
	], [], false)!;
	assert.match(text, /NVDA 放量创 52 周新高，已开任务/);
	assert.doesNotMatch(text, /NVDA[^；]*创 52 周新高 212/);
	assert.match(text, /AMD 看多：到 \+8% 档，看空：收盘跌破 50 日线，多空分歧（看多 1 条，看空 1 条）/);
	assert.doesNotMatch(text, /\+5% 档/);
});

test("免打扰时留下的：那一行写明留下，留着的任务写「现在补开任务」", () => {
	const text = digest(DATE, [
		hit("R-MA-2-50:down", "NVDA", "bear", 2, "收盘跌破 50 日线（收盘 97.00，50 日均线 98.50）", { held: true }),
		hit("R-MA-2-200", "META", "bear", 5, "收盘跌破 200 日线（收盘 97.00，200 日均线 98.50）", { held: true }),
	], [], false)!;
	assert.match(text, /META 收盘跌破 200 日线，免打扰时留下，现在补开任务/);
	assert.match(text, /NVDA 收盘跌破 50 日线（免打扰时留下）/);
});

test("扫描失败时照发盘中的命中，加一句收盘规则没有算", () => {
	const text = digest(DATE, [hit("high-52w", "NVDA", "bull", 2, "创 52 周新高 212.40（此前最高 210.88）")], [], true)!;
	assert.match(text, /^收盘小结 11-12（美东）：NVDA 创 52 周新高 212\.40。今天的日线扫描失败，收盘规则没有算。/);
});

test("最长 1000 字、不换行：放不下的从层级低的开始收成「另有 n 条」", () => {
	const many = Array.from({ length: 60 }, (_, i) => hit("gap", `S${String(i).padStart(2, "0")}`, "bull", 1, `开盘跳空 +${(3 + i / 10).toFixed(2)}%`));
	const text = digest(DATE, [hit("move-1", "TSLA", "bear", 5, "到 -5% 档", { id: `move-1:TSLA:${DATE}:down` }), ...many], [], false)!;
	assert.ok([...text].length <= 1000, `${[...text].length} 字`);
	assert.doesNotMatch(text, /[\n\r]/);
	assert.match(text, /^收盘小结 11-12（美东）：TSLA 到 -5% 档，已开任务；/);
	const folded = Number(/另有 (\d+) 条/.exec(text)?.[1]);
	const shown = (text.match(/S\d\d 开盘跳空/g) ?? []).length;
	assert.equal(shown + folded, 60, "列出的加收起来的等于全部");
});
