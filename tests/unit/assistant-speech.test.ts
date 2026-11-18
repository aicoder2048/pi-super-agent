import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { pronounced, pronounceTable, PRONOUNCE, Speech, SPEAK_MAX_CHARS } from "../../src/host/assistant/speech.ts";
import { speechChunks } from "../../src/web/view.mjs";

test("朗读前按读音表换读法：只换整词，紧挨数字也换，不碰词的一部分", () => {
	const table = { "IV Rank": "I V 排名", IV: "I V", DIA: "D I A", HV: "H V" };
	assert.equal(pronounced("DIA 的 IV Rank 是 71%，IV/HV20 约 0.96", table), "D I A 的 I V 排名 是 71%，I V/H V20 约 0.96");
	assert.equal(pronounced("IVY 和 DIAS 不换", table), "IVY 和 DIAS 不换");
});

test("仓库里的读音表只有通用术语，不写股票代码；状态目录的私人读音表补上代码、盖过同名词，坏了就只用通用的", (t) => {
	for (const word of ["IV Rank", "IV", "HV", "GEX"]) assert.ok(PRONOUNCE[word], word);
	assert.ok(Object.keys(PRONOUNCE).every((w) => !/^[A-Z]{2,5}$/.test(w) || ["IV", "HV", "GEX", "OI", "OCC", "CSP", "ETF"].includes(w)), JSON.stringify(Object.keys(PRONOUNCE)));
	const dir = mkdtempSync(join(tmpdir(), "psa-pronounce-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "pronounce.json");
	assert.deepEqual(pronounceTable(file), PRONOUNCE);
	writeFileSync(file, JSON.stringify({ _说明: "私人", DIA: "D I A", IV: "隐含波动率" }));
	const own = pronounceTable(file);
	assert.deepEqual([own["DIA"], own["IV"], own["HV"], own["_说明"]], ["D I A", "隐含波动率", "H V", undefined]);
	writeFileSync(file, "{坏的");
	assert.deepEqual(pronounceTable(file), PRONOUNCE);
});

test("页面切句：去掉 Markdown 符号，按句号、问号、叹号、分号和换行切，太短的并到前一句，太长的再按逗号切", () => {
	const text = "**IV Rank** 是当前 IV 在一年里的位置。\n\n- 85% 偏贵；\n- `HV20` 是 20 日历史波动率！好。";
	assert.deepEqual(speechChunks(text), ["IV Rank 是当前 IV 在一年里的位置。", "85% 偏贵；", "HV20 是 20 日历史波动率！好。"]);
	const long = `${"很长的一句，".repeat(40)}完。`;
	const chunks = speechChunks(long);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every((c) => c.length <= 120), JSON.stringify(chunks.map((c) => c.length)));
	assert.equal(chunks.join(""), long);
	assert.deepEqual(speechChunks("  \n "), []);
});

test("合成：按「声音 + 换过读法的文字」缓存，同一句只合成一次；合成失败交回 null；太长或空的不合成", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-tts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const asked: string[] = [];
	let fail = false;
	const speech = new Speech({ dir, voice: "zh-CN-XiaoyiNeural", table: () => ({ DIA: "D I A" }), synthesize: async (text) => (asked.push(text), fail ? null : Buffer.from(`mp3:${text}`)) });
	assert.deepEqual(await speech.speak("DIA 涨了。"), Buffer.from("mp3:D I A 涨了。"));
	assert.deepEqual(await speech.speak("DIA 涨了。"), Buffer.from("mp3:D I A 涨了。"));
	assert.deepEqual(asked, ["D I A 涨了。"]);
	assert.equal(readdirSync(dir).length, 1);
	fail = true;
	assert.equal(await speech.speak("另一句。"), null);
	assert.equal(await speech.speak(""), null);
	assert.equal(await speech.speak("长".repeat(SPEAK_MAX_CHARS + 1)), null);
	assert.equal(asked.length, 2);
});
