import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { on, reply } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const REPLY = "DIA 历史收盘IV Rank为71.40%，期限结构倒挂。";
const ANSWER = "IV Rank 是当前隐含波动率在过去一年区间里的位置：85% 说明比一年里大多数日子都贵。";

/** Selects `words` inside the last 幕僚长 bubble, the way a mouse drag does. */
const pick = (page: Page, words: string) =>
	page.evaluate((w) => {
		const bubbles = [...document.querySelectorAll(".line.router .bubble")];
		const bubble = bubbles[bubbles.length - 1]!;
		const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const at = node.textContent!.indexOf(w);
			if (at < 0) continue;
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + w.length);
			getSelection()!.removeAllRanges();
			getSelection()!.addRange(range);
			return true;
		}
		return false;
	}, words);

test("简报官（ADR-0033）：对话里一句话旁的「问简报官」和选中几个字后的「问简报官」都打开右栏简报官页并预填问题；回答出现在简报官页，刷新后还在，清空后没了", (t) =>
	story(
		t,
		{
			router: [
				on("Router 回答 DIA 波动率", /^\[对话\][\s\S]*DIA 波动率贵不贵/, (c) => [reply(c, REPLY)]),
				on("简报官讲 IV Rank", /^\[使用者在对话里点了一句话来问\][\s\S]*选中的字：IV Rank[\s\S]*IV Rank为71\.40%/, () => ANSWER),
			],
		},
		async ({ step, fake }) => {
			await step("问「DIA 波动率贵不贵」，幕僚长回一句带术语的话", async (page) => {
				await sayInPage(page, "DIA 波动率贵不贵？");
				await page.locator(".line.router .bubble", { hasText: "期限结构倒挂" }).waitFor();
			});
			await step("点这句话的「问简报官」：右栏切到简报官页，问题已预填，上方写着关于哪句话", async (page) => {
				const line = page.locator(".line.router").last();
				await line.hover();
				await line.locator(".ask-btn").click();
				await page.locator("#assistant").waitFor();
				assert.equal(await page.locator("#assistant-input").inputValue(), "这句话是什么意思？里面的术语和数字怎么理解？");
				await page.locator("#assistant-about .quote-text", { hasText: "期限结构倒挂" }).waitFor();
				await page.locator("#assistant-about-cancel").click();
			});
			await step("选中「IV Rank」：浮出「问简报官」，点了预填这个词的问题；发出后简报官的回答出现", async (page) => {
				assert.ok(await pick(page, "IV Rank"));
				await page.locator("#ask-pick").waitFor();
				await page.locator("#ask-pick").click();
				assert.equal(await page.locator("#assistant-input").inputValue(), "「IV Rank」是什么意思？在这句话里指什么？");
				await page.locator("#assistant-send").click();
				await page.locator(".as-a.done .bubble", { hasText: "85% 说明比一年里大多数日子都贵" }).waitFor();
				await page.locator(".as-q .quoted", { hasText: "关于「IV Rank」" }).waitFor();
				assert.equal(await page.locator("#assistant-input").inputValue(), "");
				assert.match(fake.systemPromptOf("router"), /简报官/);
			});
			await step("刷新页面：还在简报官页，问答还在", async (page) => {
				await page.reload();
				await page.locator(".as-a.done .bubble", { hasText: "85% 说明比一年里大多数日子都贵" }).waitFor();
			});
			await step("点「清空」：问答没了，显示怎么用的提示", async (page) => {
				await page.locator("#assistant-clear").click();
				await page.locator("#assistant-lines .empty").waitFor();
				assert.equal(await page.locator(".as-a").count(), 0);
			});
		},
	));

test("简报官朗读（ADR-0033）：答完的回答下有「朗读」，按句交给宿主合成（先换读法），读的时候显示「停止」，读完回到「朗读」；同一句第二次读用缓存", (t) => {
	const log = join(mkdtempSync(join(tmpdir(), "psa-tts-log-")), "said.jsonl");
	const said = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string) : []);
	return story(
		t,
		{
			router: [
				on("Router 回答 DIA 波动率", /^\[对话\][\s\S]*DIA 波动率贵不贵/, (c) => [reply(c, REPLY)]),
				on("简报官讲 IV Rank", /^\[使用者在对话里点了一句话来问\][\s\S]*这句话是什么意思/, () => "**DIA** 的 IV Rank 是 71%。\n\n这说明期权偏贵。"),
			],
		},
		async ({ step }) => {
			await step("问一句，等简报官答完", async (page) => {
				await sayInPage(page, "DIA 波动率贵不贵？");
				const line = page.locator(".line.router").last();
				await line.locator(".bubble", { hasText: "期限结构倒挂" }).waitFor();
				await line.hover();
				await line.locator(".ask-btn").click();
				await page.locator("#assistant-send").click();
				await page.locator(".as-a.done .bubble", { hasText: "这说明期权偏贵" }).waitFor();
			});
			await step("点「朗读」：按钮变「停止」，两句先后交给宿主，IV Rank 按通用读音表、DIA 按状态目录里的私人读音表换成读法；读完按钮回到「朗读」", async (page) => {
				await page.locator(".as-a.done .as-read").click();
				await page.locator(".as-a.done .as-read", { hasText: "停止" }).waitFor();
				await page.locator(".as-a.done .as-read", { hasText: "朗读" }).waitFor({ timeout: 15_000 });
				assert.deepEqual(said(), ["D I A 的 I V 排名 是 71%。", "这说明期权偏贵。"]);
			});
			await step("再读一次：两句都在缓存里，不再合成", async (page) => {
				await page.locator(".as-a.done .as-read").click();
				await page.locator(".as-a.done .as-read", { hasText: "朗读" }).waitFor({ timeout: 15_000 });
				assert.equal(said().length, 2);
			});
		},
		{ env: { PSA_TTS_COMMAND: JSON.stringify([process.execPath, join(import.meta.dirname, "fake-tts.mjs")]), PSA_TTS_LOG: log }, files: { "pronounce.json": JSON.stringify({ DIA: "D I A" }) } },
	);
});
