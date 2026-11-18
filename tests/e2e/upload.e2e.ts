import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { on, reply } from "./fake-model.ts";
import { closeBrowser, story } from "./harness.ts";

after(closeBrowser);

const CSV = Buffer.from("Trade Date,Type\r\n10/27/2026,Write option\r\n");
const LINE = new RegExp(`附件：export\\.csv（上传编号 (up-[0-9a-f]{12})，${CSV.length} B）`);

test("网页上传（ADR-0032）：点附件按钮选文件，输入框上方显示附件；发话时末尾带上附件那一行，宿主存下原样的文件，发出后附件清掉", (t) =>
	story(
		t,
		{ router: [on("Router 回答收到附件", /^\[对话\][\s\S]*导入这份[\s\S]*附件：export\.csv（上传编号 up-/, (c) => [reply(c, "收到文件。")])] },
		async ({ step, stateDir }) => {
			await step("选一个 CSV：附件条显示文件名和大小", async (page) => {
				await page.locator("#attach-file").setInputFiles({ name: "export.csv", mimeType: "text/csv", buffer: CSV });
				await page.locator("#attach-strip .quote-text", { hasText: `export.csv（${CSV.length} B）` }).waitFor();
			});
			await step("写「导入这份」发出去：对话里这句话末尾是附件那一行，幕僚长收到", async (page) => {
				await page.locator("#composer").fill("导入这份");
				await page.locator("#send").click();
				await page.locator(".line.router .bubble", { hasText: "收到文件。" }).waitFor();
				const said = await page.locator(".line.user .bubble").last().innerText();
				const id = LINE.exec(said)?.[1];
				assert.ok(id, said);
				assert.deepEqual(readFileSync(join(stateDir, "uploads", id)), CSV);
				assert.ok(readdirSync(join(stateDir, "uploads")).includes(`${id}.json`));
			});
			await step("发出后输入框空了，附件条收起", async (page) => {
				assert.equal(await page.locator("#composer").inputValue(), "");
				assert.equal(await page.locator("#attach-strip").isHidden(), true);
			});
		},
	));

test("网页上传：上传中点 ✕ 作废这次上传，传完也不挂上；上传期间附件按钮不能再点；超过 10 MB 的文件在页面里就说太大，不上传", (t) =>
	story(t, { router: [] }, async ({ step, stateDir }) => {
		await step("上传被拖慢时附件按钮禁用；点 ✕ 后附件条收起，传完也不再出现", async (page) => {
			let release = () => {};
			const held = new Promise<void>((done) => (release = done));
			await page.route("**/upload?**", async (route) => {
				await held;
				await route.continue();
			});
			await page.locator("#attach-file").setInputFiles({ name: "wrong.csv", mimeType: "text/csv", buffer: CSV });
			await page.locator("#attach-strip .quote-text", { hasText: "wrong.csv 上传中…" }).waitFor();
			assert.equal(await page.locator("#attach").isDisabled(), true);
			await page.locator("#attach-cancel").click();
			assert.equal(await page.locator("#attach-strip").isHidden(), true);
			assert.equal(await page.locator("#attach").isDisabled(), false);
			release();
			await page.waitForResponse("**/upload?**");
			await page.waitForTimeout(200);
			assert.equal(await page.locator("#attach-strip").isHidden(), true, "作废的上传回来后不挂上");
			await page.unroute("**/upload?**");
		});
		await step("选一个 10 MB 多一点的文件：提示文件太大，不发请求", async (page) => {
			const count = () => (existsSync(join(stateDir, "uploads")) ? readdirSync(join(stateDir, "uploads")).length : 0);
			const before = count();
			await page.locator("#attach-file").setInputFiles({ name: "big.csv", mimeType: "text/csv", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
			await page.locator("#say-status", { hasText: "文件太大" }).waitFor();
			assert.equal(await page.locator("#attach-strip").isHidden(), true);
			assert.equal(count(), before);
		});
	}));
