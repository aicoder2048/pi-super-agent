// W1 live lanes against a real host (openai-codex models) in a short temp state dir.
// Usage: node lanes.mjs <worktree> <outDir>
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

const [WT, OUT] = process.argv.slice(2);
const PORT = 45170;
const EXE = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(OUT, { recursive: true });
const results = [];
const record = (lane, pass, detail) => {
	results.push({ lane, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} lane ${lane}: ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stateDir = mkdtempSync("/tmp/psa-");
writeFileSync(join(stateDir, "config.json"), JSON.stringify({ webPort: PORT, models: { fallback: "openai-codex/gpt-6.1-sol" } }));
const env = { ...process.env, PSA_STATE_DIR: stateDir };
const run = (args) => spawnSync("node", ["--import", "./src/pi-runtime.mjs", ...args], { cwd: WT, env, encoding: "utf8" });

function startHost(dir = stateDir) {
	const log = join(OUT, `host-${Date.now()}.log`);
	const child = spawn("node", ["--import", "./src/pi-runtime.mjs", "src/host/main.ts"], { cwd: WT, env: { ...env, PSA_STATE_DIR: dir } });
	let text = "";
	const url = new Promise((resolve, reject) => {
		const onData = (b) => {
			text += b;
			appendFileSync(log, b);
			const m = text.match(/\[host\] 网页 (http\S+)/);
			if (m) resolve(m[1]);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code) => reject(new Error(`host exited ${code}: ${text.trim().split("\n").at(-1)}`)));
		setTimeout(() => reject(new Error("host start timeout")), 60_000);
	});
	return { child, url, output: () => text };
}
const stopHost = (h) => new Promise((r) => { h.child.once("exit", r); h.child.kill("SIGINT"); });

function rawGet(path, host) {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: PORT, path, headers: { host } }, (res) => {
			let body = "";
			res.on("data", (d) => (body += d));
			res.on("end", () => resolve({ status: res.statusCode, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
let dialogs = 0;
ctx.on("page", (p) => p.on("dialog", (d) => { dialogs++; d.dismiss(); }));
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const status = (page) => page.locator("#status").getAttribute("data-status");
const convText = (page) => page.locator("#conversation").innerText();

let host = startHost();
let url;
try {
	url = await host.url;
	const token = new URL(url).searchParams.get("token");

	// Lane 2: first load
	const page = await ctx.newPage();
	await page.goto(url);
	await page.waitForFunction(() => document.querySelector("#status")?.dataset.status === "connected", null, { timeout: 10_000 });
	await shot(page, "w1-first-load");
	record(2, (await status(page)) === "connected" && (await page.locator("#board").count()) === 1, `status=${await status(page)}`);

	// Lane 3: no token
	const bare = await ctx.newPage();
	const resp = await bare.goto(`http://127.0.0.1:${PORT}/`);
	await shot(bare, "w1-no-token");
	const bareText = await bare.locator("body").innerText();
	record(3, resp.status() === 401 && !bareText.includes("Router"), `status=${resp.status()} body=${bareText.slice(0, 40)}`);
	const ev = await rawGet("/events", `127.0.0.1:${PORT}`);
	record("3b", ev.status === 401, `/events without token -> ${ev.status}`);
	await bare.close();

	// Lane 4: bad Host header with the right token
	const bad = await rawGet(`/?token=${token}`, `evil.example:${PORT}`);
	const badPage = await ctx.newPage();
	await badPage.setContent(`<pre>curl -H 'Host: evil.example:${PORT}' /?token=… → ${bad.status}\n${bad.body}</pre>`);
	await shot(badPage, "w1-bad-host");
	await badPage.close();
	record(4, bad.status === 403, `status=${bad.status}`);

	// Lane 8 setup: second tab
	const tab2 = await ctx.newPage();
	await tab2.goto(url);
	await tab2.waitForFunction(() => document.querySelector("#status")?.dataset.status === "connected", null, { timeout: 10_000 });

	// Lane 5 + Lane 1: say through the socket CLI (same protocol as the TUI); page shows it fast, then the reply.
	const sayText = `你好，这是网页测试 ${Date.now() % 10000}`;
	const t0 = Date.now();
	const say = spawn("node", ["--import", "./src/pi-runtime.mjs", "src/cli/say.ts", "say", sayText], { cwd: WT, env });
	let sayOut = "";
	say.stdout.on("data", (b) => (sayOut += b));
	await page.waitForFunction((t) => document.querySelector("#conversation").innerText.includes(t), sayText, { timeout: 10_000 });
	const shownMs = Date.now() - t0;
	const before = (await convText(page)).split(sayText)[1] ?? "";
	await page.waitForFunction(
		(t) => {
			const lines = [...document.querySelectorAll("#conversation .line")];
			const i = lines.findIndex((l) => l.innerText.includes(t));
			return i >= 0 && lines.slice(i + 1).some((l) => !l.classList.contains("user"));
		},
		sayText,
		{ timeout: 120_000 },
	);
	await shot(page, "w1-live-say");
	// shownMs includes CLI process start (~1s of node + pi-runtime boot), so it bounds the gateway path from above.
	record(5, shownMs < 4000, `user line shown ${shownMs} ms after CLI spawn (includes CLI boot); router reply shown`);
	await sleep(1500);
	say.kill();
	const cliGotReply = /Router|>/.test(sayOut) && sayOut.length > sayText.length;
	record(1, cliGotReply, `trunk has no page (recorded). socket CLI output: ${sayOut.trim().slice(0, 120).replace(/\n/g, " | ")}`);
	void before;

	// Lane 8: two tabs identical
	await sleep(500);
	const [c1, c2] = [await convText(page), await convText(tab2)];
	const [b1, b2] = [await page.locator("#board").innerText(), await tab2.locator("#board").innerText()];
	await shot(tab2, "w1-two-tabs");
	record(8, c1 === c2 && b1.replace(/\d+秒|\d+分\d+秒/g, "") === b2.replace(/\d+秒|\d+分\d+秒/g, ""), `conversation equal=${c1 === c2}`);
	await tab2.close();

	// Lane 6: drop a trigger that should create a task; board gains a card.
	const cardsBefore = await page.locator("#board .card").count();
	const drop = { stdout: "request via say (external drops are data, not authority)" };
	const say3 = spawn("node", ["--import", "./src/pi-runtime.mjs", "src/cli/say.ts", "say", "请帮我读取 https://example.com 的网页标题，然后告诉我"], { cwd: WT, env });
	await page.waitForFunction((n) => document.querySelectorAll("#board .card").length > n, cardsBefore, { timeout: 180_000 }).catch(() => {});
	await sleep(3000);
	await shot(page, "w1-board-update");
	say3.kill();
	const cardsAfter = await page.locator("#board .card").count();
	record(6, cardsAfter > cardsBefore, `cards ${cardsBefore} -> ${cardsAfter}; ${drop.stdout.trim()}`);

	// Lane 9: HTML/script text and newlines render literally.
	const evil = "<script>alert(1)</script>\n第二行 <img src=x onerror=alert(2)>";
	const say2 = spawn("node", ["--import", "./src/pi-runtime.mjs", "src/cli/say.ts", "say", evil], { cwd: WT, env });
	await page.waitForFunction(() => document.querySelector("#conversation").innerText.includes("<script>alert(1)</script>"), null, { timeout: 10_000 });
	await sleep(1500);
	say2.kill();
	await shot(page, "w1-escape");
	const injected = await page.evaluate(() => document.querySelectorAll("#conversation script, #conversation img").length);
	record(9, dialogs === 0 && injected === 0, `dialogs=${dialogs} injected elements=${injected}`);

	// Lane 10: port busy -> one-line error, non-zero exit, running host untouched.
	const other = mkdtempSync("/tmp/psa-");
	writeFileSync(join(other, "config.json"), JSON.stringify({ webPort: PORT }));
	const busy = spawnSync("node", ["--import", "./src/pi-runtime.mjs", "src/host/main.ts"], { cwd: WT, env: { ...env, PSA_STATE_DIR: other }, encoding: "utf8", timeout: 60_000 });
	const errLines = (busy.stderr + busy.stdout).trim().split("\n").filter(Boolean);
	const busyPage = await ctx.newPage();
	await busyPage.setContent(`<pre>exit=${busy.status}\n${(busy.stderr + busy.stdout).replace(/</g, "&lt;")}</pre>`);
	await shot(busyPage, "w1-port-busy");
	await busyPage.close();
	await page.reload();
	await page.waitForFunction(() => document.querySelector("#status")?.dataset.status === "connected", null, { timeout: 10_000 }).catch(() => {});
	record(10, busy.status !== 0 && /^网页端口 45170 已被占用/.test(errLines.at(-1)) && !/\bat \S+:\d+/.test(busy.stderr) && (await status(page)) === "connected", `exit=${busy.status} error line: ${errLines.at(-1)}; first host still connected=${(await status(page)) === "connected"}`);

	// Lane 7: stop host -> disconnected; restart (new token) -> old page says token expired; new URL works.
	await stopHost(host);
	await page.waitForFunction(() => document.querySelector("#status")?.dataset.status !== "connected", null, { timeout: 10_000 });
	const downStatus = await status(page);
	await shot(page, "w1-reconnect-down");
	host = startHost();
	const url2 = await host.url;
	await page.waitForFunction(() => document.querySelector("#status")?.dataset.status === "expired", null, { timeout: 20_000 }).catch(() => {});
	const expiredStatus = await status(page);
	const expiredText = await page.locator("#status").innerText();
	await shot(page, "w1-reconnect-expired");
	await page.goto(url2);
	await page.waitForFunction(() => document.querySelector("#status")?.dataset.status === "connected", null, { timeout: 10_000 }).catch(() => {});
	await shot(page, "w1-reconnect");
	record(7, downStatus === "disconnected" && expiredStatus === "expired" && (await status(page)) === "connected" && url2 !== url, `down=${downStatus} after-restart=${expiredStatus} (${expiredText}) new-url=${await status(page)}`);
} catch (error) {
	console.log(`ERROR ${error.stack}`);
} finally {
	await browser.close();
	await stopHost(host).catch(() => {});
	writeFileSync(join(OUT, "results.json"), JSON.stringify({ stateDir, results }, null, 2));
	console.log(`state dir ${stateDir}; screenshots in ${OUT}`);
	process.exit(results.every((r) => r.pass) && results.length >= 11 ? 0 : 1);
}
