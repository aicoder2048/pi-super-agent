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
const routerLine = (page: Page) => page.locator(".line.router").last();
const notes = (page: Page) => routerLine(page).locator(".notes .note");

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

const askWholeLine = async (page: Page) => {
	await sayInPage(page, "DIA 波动率贵不贵？");
	await routerLine(page).locator(".bubble", { hasText: "期限结构倒挂" }).waitFor();
	await routerLine(page).hover();
	await routerLine(page).locator(".ask-btn").click();
};

test("简报官（ADR-0033）：「问简报官」或选中几个字后的「问简报官」立刻就问，回答作为批注展开在那句话下面；能收起、能在批注里再问；刷新后还在；右栏没有简报官", (t) =>
	story(
		t,
		{
			router: [
				on("Router 回答 DIA 波动率", /^\[对话\][\s\S]*DIA 波动率贵不贵/, (c) => [reply(c, REPLY)]),
				on("简报官讲整句", /^\[使用者在对话里点了一句话来问\][\s\S]*问题：这句话是什么意思/, () => "这句话是说：近期的保险比远期的贵。"),
				on("简报官讲 IV Rank", /^\[使用者在对话里点了一句话来问\][\s\S]*选中的字：IV Rank[\s\S]*问题：「IV Rank」是什么意思/, () => "IV Rank 就是现在的贵贱在一年里排第几。"),
				on("简报官答再问", /^\[使用者在对话里点了一句话来问\][\s\S]*问题：那对我有什么影响/, () => "对卖方来说，收得多，风险也大。"),
			],
		},
		async ({ step }) => {
			await step("点幕僚长那句话的「问简报官」：不换页，批注直接出现在那句话下面", async (page) => {
				await askWholeLine(page);
				await notes(page).filter({ hasText: "近期的保险比远期的贵" }).waitFor();
				assert.equal(await page.locator("#tab-assistant").count(), 0, "右栏没有简报官标签");
				assert.match(await notes(page).first().locator(".note-who").innerText(), /^简报官$/);
			});
			await step("选中「IV Rank」点浮出的「问简报官」：第二条批注写着关于「IV Rank」", async (page) => {
				assert.ok(await pick(page, "IV Rank"));
				await page.locator("#ask-pick").click();
				const second = notes(page).filter({ hasText: "排第几" });
				await second.waitFor();
				assert.match(await second.locator(".note-who").innerText(), /「IV Rank」/);
			});
			await step("收起第一条只剩抬头，展开回来", async (page) => {
				const first = notes(page).first();
				await first.locator(".note-acts button", { hasText: "收起" }).click();
				assert.equal(await notes(page).first().locator(".note-body").count(), 0);
				await notes(page).first().locator(".note-acts button", { hasText: "展开" }).click();
				await notes(page).first().locator(".note-body", { hasText: "近期的保险比远期的贵" }).waitFor();
			});
			await step("在第一条批注里点「再问」，输入后回车：第三条批注带着问题出现在同一句话下面", async (page) => {
				await notes(page).first().locator(".note-acts button", { hasText: "再问" }).click();
				await notes(page).first().locator("textarea").fill("那对我有什么影响？");
				await notes(page).first().locator("textarea").press("Enter");
				const third = notes(page).filter({ hasText: "收得多，风险也大" });
				await third.waitFor();
				await third.locator(".note-q", { hasText: "问：那对我有什么影响？" }).waitFor();
				assert.equal(await notes(page).count(), 3);
			});
			await step("刷新：三条批注还在那句话下面", async (page) => {
				await page.reload();
				await notes(page).filter({ hasText: "收得多，风险也大" }).waitFor();
				assert.equal(await notes(page).count(), 3);
			});
		},
	));

test("简报官朗读：批注上「▶ 朗读」按句交给宿主合成（先换读法，私人读音表也算），读的时候「⏸ 暂停」，空格键暂停、继续，读完回到「▶ 朗读」；第二次读用缓存", (t) => {
	const log = join(mkdtempSync(join(tmpdir(), "psa-tts-log-")), "said.jsonl");
	const said = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string) : []);
	const play = (page: Page) => notes(page).first().locator(".note-play");
	return story(
		t,
		{
			router: [
				on("Router 回答 DIA 波动率", /^\[对话\][\s\S]*DIA 波动率贵不贵/, (c) => [reply(c, REPLY)]),
				on("简报官讲整句", /^\[使用者在对话里点了一句话来问\][\s\S]*这句话是什么意思/, () => "**DIA** 的 IV Rank 是 71%。\n\n这说明期权偏贵。"),
				on("简报官再讲一遍", /^\[使用者在对话里点了一句话来问\][\s\S]*问题：再说一遍/, () => "第二遍：近期贵。\n\n远期便宜。"),
			],
		},
		async ({ step }) => {
			await step("问一句，等批注答完", async (page) => {
				await askWholeLine(page);
				await notes(page).filter({ hasText: "这说明期权偏贵" }).waitFor();
			});
			await step("点「▶ 朗读」变「⏸ 暂停」；焦点不在按钮上时按空格变「▶ 继续」，再按空格接着读；读完回到「▶ 朗读」；两句换过读法交给宿主", async (page) => {
				// What the user hears: the host's audio, sentence by sentence, not the device's fallback voice.
				await page.evaluate(() => {
					const w = window as unknown as { heard: { ended: number; local: number } };
					w.heard = { ended: 0, local: 0 };
					// The page's audio element is not in the document, so its ended events are counted on the element itself, once per element.
					const watched = new WeakSet<HTMLMediaElement>();
					const play = HTMLMediaElement.prototype.play;
					HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
						if (!watched.has(this)) {
							watched.add(this);
							this.addEventListener("ended", () => this.src.startsWith("blob:") && w.heard.ended++);
						}
						return play.call(this);
					};
					const speak = speechSynthesis.speak.bind(speechSynthesis);
					speechSynthesis.speak = (u) => (w.heard.local++, speak(u));
				});
				await play(page).click();
				await play(page).filter({ hasText: "⏸ 暂停" }).waitFor();
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
				await page.keyboard.press("Space");
				await play(page).filter({ hasText: "▶ 继续" }).waitFor();
				await page.keyboard.press("Space");
				await play(page).filter({ hasText: "⏸ 暂停" }).waitFor();
				await play(page).filter({ hasText: "▶ 朗读" }).waitFor({ timeout: 15_000 });
				assert.deepEqual(said(), ["D I A 的 I V 排名 是 71%。", "这说明期权偏贵。"]);
				assert.deepEqual(await page.evaluate(() => (window as unknown as { heard: unknown }).heard), { ended: 2, local: 0 }, "两句都由宿主的音频放完，没有退回本机朗读");
			});
			await step("再读一次：两句都在缓存里，不再合成；读的时候点「■ 停止」，回到「▶ 朗读」", async (page) => {
				await play(page).click();
				await play(page).filter({ hasText: "⏸ 暂停" }).waitFor();
				await notes(page).first().locator(".note-acts button", { hasText: "■ 停止" }).click();
				await play(page).filter({ hasText: "▶ 朗读" }).waitFor();
				assert.equal(said().length, 2);
			});
			await step("刚点「朗读」、第一句还在合成时就按暂停：合成回来也不出声，按「继续」才读，两句读完", async (page) => {
				await page.evaluate(() => ((window as unknown as { heard: { ended: number } }).heard.ended = 0));
				await page.locator("#composer").fill("");
				const fresh = notes(page).first();
				await fresh.locator(".note-acts button", { hasText: "再问" }).click();
				await fresh.locator("textarea").fill("再说一遍");
				await fresh.locator("textarea").press("Enter");
				const again = notes(page).filter({ hasText: "第二遍" });
				await again.waitFor();
				const againPlay = again.locator(".note-play");
				await againPlay.click();
				await againPlay.click();
				await againPlay.filter({ hasText: "▶ 继续" }).waitFor();
				await page.waitForTimeout(1500);
				assert.equal(await page.evaluate(() => (window as unknown as { heard: { ended: number } }).heard.ended), 0, "暂停时没有出声");
				await againPlay.click();
				await againPlay.filter({ hasText: "▶ 朗读" }).waitFor({ timeout: 15_000 });
				assert.equal(await page.evaluate(() => (window as unknown as { heard: { ended: number } }).heard.ended), 2);
			});
		},
		{ env: { PSA_TTS_COMMAND: JSON.stringify([process.execPath, join(import.meta.dirname, "fake-tts.mjs")]), PSA_TTS_LOG: log }, files: { "pronounce.json": JSON.stringify({ DIA: "D I A" }) } },
	);
});
