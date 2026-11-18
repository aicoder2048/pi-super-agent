import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
