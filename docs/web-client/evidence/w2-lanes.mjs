// W2 live lanes against real hosts (openai-codex models only) in short temp state dirs.
// Usage: node lanes.mjs <headWorktree> <trunkWorktree> <outDir>
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";

const [HEAD, TRUNK, OUT] = process.argv.slice(2);
const HEAD_PORT = 45240, TRUNK_PORT = 45241, FOREIGN_PORT = 45242;
const EXE = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(OUT, { recursive: true });
const results = [];
const record = (lane, pass, detail, weaker = "") => {
	results.push({ lane, pass, detail, weaker });
	console.log(`${pass ? "PASS" : "FAIL"} lane ${lane}: ${JSON.stringify(detail)}${weaker ? ` [weaker: ${weaker}]` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = { fallback: "openai-codex/gpt-6.1-sol" };

function makeState(port) {
	const dir = spawnSync("mktemp", ["-d", "/tmp/psa-XXXX"], { encoding: "utf8" }).stdout.trim();
	writeFileSync(join(dir, "config.json"), JSON.stringify({ webPort: port, models: MODEL }));
	return dir;
}

function startHost(wt, dir, tag) {
	const log = join(OUT, `host-${tag}.log`);
	const child = spawn("node", ["--import", "./src/pi-runtime.mjs", "src/host/main.ts"], { cwd: wt, env: { ...process.env, PSA_STATE_DIR: dir } });
	console.log(`started ${tag} host pid ${child.pid} state ${dir}`);
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
		child.on("exit", (code) => reject(new Error(`${tag} host exited ${code}: ${text.trim().split("\n").at(-1)}`)));
		setTimeout(() => reject(new Error(`${tag} host start timeout`)), 60_000);
	});
	return { child, url, dir, wt, tag };
}
const stopHost = (h) => new Promise((r) => {
	if (h.child.exitCode !== null) return r();
	try { process.kill(h.child.pid, "SIGCONT"); } catch {}
	const t = setTimeout(() => { try { process.kill(h.child.pid, "SIGKILL"); } catch {} }, 10_000);
	h.child.once("exit", () => { clearTimeout(t); r(); });
	process.kill(h.child.pid, "SIGINT");
});

const cli = (h, args) => {
	const p = spawn("node", ["--import", "./src/pi-runtime.mjs", "src/cli/say.ts", ...args], { cwd: h.wt, env: { ...process.env, PSA_STATE_DIR: h.dir } });
	let out = "";
	p.stdout.on("data", (b) => (out += b));
	p.stderr.on("data", (b) => (out += b));
	return { p, out: () => out };
};

// Node-side SSE recorder on /events of a host.
function sse(url, path) {
	const u = new URL(url);
	const frames = [];
	let req;
	const ready = new Promise((resolve) => {
		req = request({ host: "127.0.0.1", port: u.port, path: `${path}${path.includes("?") ? "&" : "?"}token=${u.searchParams.get("token")}` }, (res) => {
			let b = "";
			res.on("data", (d) => {
				b += d;
				let i;
				while ((i = b.indexOf("\n\n")) >= 0) {
					const f = b.slice(0, i);
					b = b.slice(i + 2);
					const data = f.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data: ?/, "")).join("\n");
					if (!data || f.includes("event: ping")) continue;
					let m;
					try { m = JSON.parse(data); } catch (e) { console.log(`SSE parse error on ${path}: ${String(e)} len=${data.length}`); continue; }
					frames.push({ at: Date.now(), ...m });
					if (m.type === "snapshot" || m.type === "transcript_history") resolve();
				}
			});
		});
		req.on("error", () => {});
		req.end();
	});
	return { frames, ready, close: () => req.destroy() };
}

function curl(args) {
	const r = spawnSync("curl", ["-s", "-o", "/dev/stderr", "-w", "%{http_code}", ...args], { encoding: "utf8" });
	return { status: Number(r.stdout), body: r.stderr };
}

const ES_WRAP = () => {
	window.__es = [];
	window.__longtasks = [];
	try { new PerformanceObserver((l) => window.__longtasks.push(...l.getEntries().map((e) => e.duration))).observe({ type: "longtask", buffered: true }); } catch {}
	const ES = window.EventSource;
	window.EventSource = class extends ES {
		constructor(u, o) {
			super(u, o);
			const rec = { url: String(u), closed: false, frames: [] };
			window.__es.push(rec);
			this.addEventListener("message", (e) => {
				try {
					const m = JSON.parse(e.data);
					rec.frames.push({ at: Date.now(), type: m.type, ticketId: m.ticketId ?? null, n: m.messages?.length ?? null, role: m.message?.role ?? null });
				} catch {}
			});
			const close = this.close.bind(this);
			this.close = () => { rec.closed = true; rec.closedAt = Date.now(); close(); };
		}
	};
};

process.on("uncaughtException", (e) => { console.log(`UNCAUGHT ${e.stack}`); for (const h of [H, T]) try { process.kill(h.child.pid, "SIGCONT"); process.kill(h.child.pid, "SIGINT"); } catch {} setTimeout(() => process.exit(1), 3000); });
const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
await ctx.addInitScript(ES_WRAP);
const shot = (page, name, full = false) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
const composite = async (name, html) => {
	const p = await ctx.newPage();
	await p.setViewportSize({ width: 1800, height: 1000 });
	await p.setContent(html);
	await p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
	await p.close();
};
const b64 = (file) => readFileSync(join(OUT, file)).toString("base64");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const lineTexts = (page) => page.$$eval("#conversation .line", (ns) => ns.map((n) => ({ who: n.className.replace("line ", ""), text: n.querySelector(".bubble")?.textContent ?? n.textContent })));
const userCount = (page, s) => page.$$eval("#conversation .line.user", (ns, s) => ns.filter((n) => n.textContent.includes(s)).length, s);
const replyAfter = (page, s, timeout = 180_000) => page.waitForFunction((s) => {
	const lines = [...document.querySelectorAll("#conversation .line")];
	const i = lines.findIndex((l) => l.classList.contains("user") && l.textContent.includes(s));
	return i >= 0 && lines.slice(i + 1).some((l) => !l.classList.contains("user"));
}, s, { timeout });
const replyTextAfter = (page, s) => page.evaluate((s) => {
	const lines = [...document.querySelectorAll("#conversation .line")];
	const i = lines.findIndex((l) => l.classList.contains("user") && l.textContent.includes(s));
	return lines.slice(i + 1).find((l) => !l.classList.contains("user"))?.textContent.slice(0, 160) ?? "";
}, s);
const sayState = (page) => page.$eval("#say-status", (n) => ({ state: n.dataset.state, text: n.textContent }));
const pageSend = async (page, text) => {
	await page.fill("#composer", text);
	const t0 = Date.now();
	await page.click("#send");
	await page.waitForFunction(() => !["sending", "idle"].includes(document.getElementById("say-status").dataset.state), null, { timeout: 10_000 });
	return { ms: Date.now() - t0, ...(await sayState(page)) };
};

const headDir = makeState(HEAD_PORT);
const trunkDir = makeState(TRUNK_PORT);
const H = startHost(HEAD, headDir, "head");
const T = startHost(TRUNK, trunkDir, "trunk");
const procs = [];
let foreign;
const pageErrors = [];
const sayRequests = [];
try {
	const [hUrl, tUrl] = await Promise.all([H.url, T.url]);
	const token = new URL(hUrl).searchParams.get("token");
	const events = sse(hUrl, "/events");
	await events.ready;
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push({ at: Date.now(), e: String(e) }));
	page.on("console", (m) => m.type() === "error" && pageErrors.push({ at: Date.now(), e: m.text() }));
	page.on("request", (r) => r.url().includes("/say") && sayRequests.push({ at: Date.now(), method: r.method() }));
	await page.goto(hUrl);
	await page.waitForFunction(() => document.getElementById("status").dataset.status === "connected");

	// Lane 6: blank input
	{
		const before = (await lineTexts(page)).length;
		const reqBefore = sayRequests.length;
		for (const blank of ["   ", "\n\n\t ", ""]) {
			await page.fill("#composer", blank);
			await page.click("#send");
			await page.focus("#composer");
			await page.keyboard.press("Enter");
		}
		await sleep(800);
		const after = (await lineTexts(page)).length;
		await shot(page, "w2-empty");
		const st = await sayState(page);
		record(6, after === before && sayRequests.length === reqBefore && st.state === "idle", { linesBefore: before, linesAfter: after, sayPosts: sayRequests.length - reqBefore, sayState: st.state });
	}

	// Lane 2: send from the page
	{
		const s2 = `你好，请用一句话回复我，确认你在线（页面发话 ${Date.now() % 10000}）`;
		const r = await pageSend(page, s2);
		const composerEmpty = (await page.inputValue("#composer")) === "";
		await page.waitForFunction((s) => [...document.querySelectorAll(".line.user")].some((n) => n.textContent.includes(s)), s2, { timeout: 5000 });
		await shot(page, "w2-say-delivered");
		await replyAfter(page, s2);
		const reply = await replyTextAfter(page, s2);
		await shot(page, "w2-say");
		const whoLabels = await page.$$eval("#conversation .line.router .who", (ns) => [...new Set(ns.map((n) => n.textContent))]);
		record(2, r.state === "delivered" && composerEmpty && reply.length > 0 && whoLabels.length === 1 && whoLabels[0] === "幕僚长", { sayStatus: r.text, ackMs: r.ms, composerEmpty, reply, whoLabels },
			`plan wording is 「已送达」; page shows 「${r.text}」 (vocabulary changed in commit 01cdf66)`);
	}

	// Lane 1: same sentence via socket CLI on trunk (W1, ac70ec6) and head
	{
		const tPage = await ctx.newPage();
		await tPage.goto(tUrl);
		await tPage.waitForFunction(() => document.querySelector("#status")?.dataset.status === "connected", null, { timeout: 10_000 });
		const s1 = `回归测试：请回复「收到」两个字 ${Date.now() % 10000}`;
		const ct = cli(T, ["say", s1]);
		const ch = cli(H, ["say", s1]);
		procs.push(ct.p, ch.p);
		const lineAfter = (p) => p.waitForFunction((s) => {
			const lines = [...document.querySelectorAll("#conversation .line")];
			const i = lines.findIndex((l) => l.classList.contains("user") && l.textContent.includes(s));
			return i >= 0 && lines.slice(i + 1).some((l) => !l.classList.contains("user"));
		}, s1, { timeout: 180_000 }).then(() => true, () => false);
		const [tOk, hOk] = await Promise.all([lineAfter(tPage), lineAfter(page)]);
		const tReply = await replyTextAfter(tPage, s1);
		const hReply = await replyTextAfter(page, s1);
		await shot(tPage, "w2-regression-trunk");
		await shot(page, "w2-regression-head");
		await composite("w2-regression", `<div style="display:flex;gap:8px;font:14px sans-serif"><div><b>trunk ac70ec6 (W1)</b><img style="width:880px" src="data:image/png;base64,${b64("w2-regression-trunk.png")}"></div><div><b>head c7dd561</b><img style="width:880px" src="data:image/png;base64,${b64("w2-regression-head.png")}"></div></div>`);
		await sleep(500);
		ct.p.kill(); ch.p.kill();
		record(1, tOk && hOk, { trunk: { userShown: tOk, reply: tReply, cliOut: ct.out().trim().slice(0, 160) }, head: { userShown: hOk, reply: hReply, cliOut: ch.out().trim().slice(0, 160) } });
		await tPage.close();
	}
	await stopHost(T);

	// Lane 3: create a Worker task, click it, watch history then live steps
	let ticketA, titleA;
	{
		const rowsBefore = new Set(events.frames.filter((f) => f.type === "board").flatMap((f) => f.rows.map((r) => r.id)));
		const s3 = "帮我读一下 example.com 的网页标题";
		await pageSend(page, s3);
		await page.waitForSelector("#left .card.doing, #left .card.ask", { timeout: 180_000 });
		const card = page.locator("#left .card.doing, #left .card.ask").first();
		titleA = (await card.locator(".title").textContent()) ?? "";
		const clickAt = Date.now();
		await card.click();
		await page.waitForFunction(() => window.__es.some((r) => r.url.includes("/transcript") && r.frames.length), null, { timeout: 10_000 });
		const samples = [];
		let es;
		for (let k = 0; k < 240; k++) {
			es = await page.evaluate(() => window.__es.filter((r) => r.url.includes("/transcript")).at(-1));
			const steps = await page.locator("#steps li.step").count();
			samples.push({ dt: Date.now() - clickAt, steps, frames: es.frames.length });
			const live = es.frames.filter((f) => f.type === "transcript");
			if (live.some((f) => f.role === "assistant") && live.some((f) => f.role === "toolResult")) break;
			await sleep(500);
		}
		ticketA = es.frames[0].ticketId;
		const rowA = events.frames.filter((f) => f.type === "board").flatMap((f) => f.rows).findLast((r) => r.id === ticketA);
		const histN = es.frames[0].n;
		const histSteps = samples[0].steps;
		const live = es.frames.filter((f) => f.type === "transcript");
		const maxSteps = Math.max(...samples.map((s) => s.steps));
		const stepTitles = await page.locator("#steps .step-title").allTextContents();
		await page.waitForTimeout(800);
		await shot(page, "w2-watch");
		record(3, es.frames[0].type === "transcript_history" && live.length > 0 && maxSteps > histSteps && stepTitles.some((t) => /读取网页|执行命令|调用工具|读取文件/.test(t)), {
			ticketA, newTicket: !rowsBefore.has(ticketA), title: titleA, rowStage: rowA?.stage, firstFrame: es.frames[0].type, historyMessages: histN,
			stepsAtHistory: histSteps, liveFrames: live.map((f) => f.role).join(","), maxSteps, stepTitles, howTitle: await page.textContent("#how-title"), samples: samples.filter((_, i) => i % 4 === 0),
		});
	}

	// Lane 4: switch to another task while watching
	let ticketB;
	{
		const idsBefore = new Set(events.frames.filter((f) => f.type === "board").flatMap((f) => f.rows.map((r) => r.id)));
		const s4 = "帮我读一下 example.org 的网页标题";
		await pageSend(page, s4);
		const deadline = Date.now() + 180_000;
		let rowB;
		while (Date.now() < deadline && !rowB) {
			rowB = events.frames.filter((f) => f.type === "board").flatMap((f) => f.rows).find((r) => !idsBefore.has(r.id));
			if (!rowB) await sleep(500);
		}
		if (!rowB) throw new Error("lane 4: no second ticket");
		ticketB = rowB.id;
		await page.waitForFunction((t) => [...document.querySelectorAll("#left .card")].some((c) => c.querySelector(".title").textContent === t && c.getAttribute("aria-current") !== "true"), rowB.title, { timeout: 30_000 });
		// open #done so a fast-closing card is clickable too
		await page.evaluate(() => { const d = document.getElementById("done"); if (d) d.open = true; });
		const switchAt = Date.now();
		await page.locator("#left .card[aria-current='false']", { has: page.locator(".title", { hasText: rowB.title }) }).first().click();
		await sleep(8000);
		const all = await page.evaluate(() => window.__es.filter((r) => r.url.includes("/transcript")));
		const oldSrc = all.find((r) => r.url.includes(encodeURIComponent(ticketA)));
		const newSrc = all.findLast((r) => r.url.includes(encodeURIComponent(ticketB)));
		const openSources = all.filter((r) => !r.closed);
		const leaked = openSources.flatMap((r) => r.frames).filter((f) => f.ticketId !== ticketB);
		const oldAfterSwitch = (oldSrc?.frames ?? []).filter((f) => f.at > switchAt);
		const clickedAt = Date.now() - 8000;
		const oldAfterClose = (oldSrc?.frames ?? []).filter((f) => f.at > oldSrc.closedAt);
		const oldTiming = (oldSrc?.frames ?? []).filter((f) => f.at > switchAt).map((f) => ({ type: f.type, role: f.role, afterSwitchMs: f.at - switchAt, beforeCloseMs: oldSrc.closedAt - f.at }));
		const stepText = await page.locator("#steps").innerText();
		const howTitle = await page.textContent("#how-title");
		await shot(page, "w2-switch");
		record(4, oldSrc?.closed && openSources.length === 1 && newSrc && !newSrc.closed && leaked.length === 0 && oldAfterClose.length === 0 && howTitle === rowB.title && !stepText.includes("example.com"), {
			ticketA, ticketB, titleB: rowB.title, howTitle, oldClosed: oldSrc?.closed, openSources: openSources.length, newFrames: newSrc?.frames.map((f) => f.type).join(","), leaked: leaked.length,
			oldFramesAfterSwitch: oldAfterSwitch.length, oldFramesAfterClose: oldAfterClose.length, oldTiming, closedAfterSwitchMs: oldSrc?.closedAt - switchAt, stepsMentionExampleCom: stepText.includes("example.com"),
			ticketAStageAtSwitch: events.frames.filter((f) => f.type === "board").flatMap((f) => f.rows).findLast((r) => r.id === ticketA)?.stage,
		}, "old task may already be idle at switch time, so 'no old frames after switch' is only meaningful if A was still producing; source closure is checked directly");
	}

	// Lane 9: closed ticket
	{
		const deadline = Date.now() + 300_000;
		const closedRow = () => events.frames.filter((f) => f.type === "board").at(-1)?.rows.find((r) => r.stage === "closed" || r.stage === "stopped");
		while (Date.now() < deadline && !closedRow()) await sleep(1000);
		const row = closedRow();
		if (!row) throw new Error("lane 9: no closed ticket within 5 min");
		const errsBefore = pageErrors.length;
		await page.evaluate(() => { const d = document.getElementById("done"); if (d) d.open = true; });
		await page.locator("#done .card", { has: page.locator(".title", { hasText: row.title }) }).first().click();
		await page.waitForFunction((t) => window.__es.filter((r) => r.url.includes("/transcript")).at(-1)?.frames.some((f) => f.type === "transcript_history" && f.ticketId === t), row.id, { timeout: 10_000 });
		await sleep(1000);
		// Compare with an independent /transcript fetch.
		const tr = sse(hUrl, `/transcript?ticket=${row.id}`);
		await tr.ready;
		tr.close();
		const histN = tr.frames[0].messages.length;
		const titles = await page.locator("#steps .step-title").allTextContents();
		const empty = await page.locator("#steps li.empty").count();
		await shot(page, "w2-closed-ticket");
		record(9, histN > 0 && titles.length > 0 && empty === 0 && pageErrors.length === errsBefore && (await page.textContent("#how-meta")).includes("已完成"), {
			ticket: row.id, stage: row.stage, historyMessages: histN, steps: titles.length, stepTitles: titles, howMeta: await page.textContent("#how-meta"), smallPrint: await page.textContent("#small-print"), newErrors: pageErrors.slice(errsBefore),
		}, "'完整历史' checked as: history non-empty, steps rendered, no error; not a message-by-message diff");
	}

	// Lane 10: HTML + 2000 chars
	{
		const long = `<b>不是粗体</b><script>alert(1)</script><img src=x onerror=alert(2)>` + "长文本测试".repeat(400);
		let dialogs = 0;
		page.on("dialog", (d) => { dialogs++; d.dismiss(); });
		const r = await pageSend(page, long);
		await page.waitForFunction(() => [...document.querySelectorAll(".line.user .bubble")].some((n) => n.textContent.includes("<b>不是粗体</b>")), null, { timeout: 5000 });
		const t0 = Date.now();
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
		const frameMs = Date.now() - t0;
		const m = await page.evaluate((needle) => {
			const b = [...document.querySelectorAll(".line.user .bubble")].find((n) => n.textContent.includes(needle));
			const conv = document.getElementById("conversation").getBoundingClientRect();
			const br = b.getBoundingClientRect();
			return {
				injected: document.querySelectorAll("#conversation b, #conversation script, #conversation img").length,
				exact: b.textContent.endsWith("长文本测试") && b.textContent.length,
				bubbleRight: Math.round(br.right), convRight: Math.round(conv.right), hScroll: document.documentElement.scrollWidth > innerWidth,
				longtasks: window.__longtasks.filter((d) => d > 50).length, maxLongtask: Math.max(0, ...window.__longtasks),
			};
		}, "<b>不是粗体</b>");
		await page.locator(".line.user .bubble", { hasText: "<b>不是粗体</b>" }).scrollIntoViewIfNeeded();
		await shot(page, "w2-long-text");
		record(10, r.state === "delivered" && m.injected === 0 && dialogs === 0 && m.bubbleRight <= m.convRight && !m.hScroll && frameMs < 200, { sendState: r.state, chars: long.length, ...m, dialogs, rafMs: frameMs },
			"'页面不卡' measured as rAF round-trip and long-task count, not subjective");
	}

	// Lane 8: page + second client (socket CLI; the TUI cannot be scripted)
	{
		const tail = cli(H, ["tail"]);
		procs.push(tail.p);
		await sleep(1500);
		const a = `混合客户端 A（网页）${Date.now() % 10000}`;
		const b = `混合客户端 B（socket 客户端）${Date.now() % 10000}`;
		await pageSend(page, a);
		const sb = cli(H, ["say", b]);
		procs.push(sb.p);
		await page.waitForFunction((b) => [...document.querySelectorAll(".line.user")].some((n) => n.textContent.includes(b)), b, { timeout: 15_000 });
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && !tail.out().includes(b)) await sleep(200);
		await sleep(500);
		const lines = (await lineTexts(page)).map((l) => l.text);
		const pa = lines.findIndex((l) => l.includes(a)), pb = lines.findIndex((l) => l.includes(b));
		const to = tail.out();
		const ta = to.indexOf(a), tb = to.indexOf(b);
		await shot(page, "w2-mixed-clients-page");
		await composite("w2-mixed-clients", `<div style="display:flex;gap:8px;font:13px sans-serif"><div><b>web page</b><img style="width:1000px" src="data:image/png;base64,${b64("w2-mixed-clients-page.png")}"></div><div><b>socket client (src/cli/say.ts tail) output</b><pre style="white-space:pre-wrap;width:760px">${esc(to)}</pre></div></div>`);
		sb.p.kill(); tail.p.kill();
		record(8, pa >= 0 && pb > pa && ta >= 0 && tb > ta, { pageOrder: [pa, pb], tailOrder: [ta, tb], tailExcerpt: to.split("\n").filter((l) => l.includes("混合客户端")) },
			"second client is the socket CLI (say.ts tail + say), same socket protocol as the TUI; the TUI itself was not driven");
	}

	// Lane 5: cross-origin POST /say
	{
		const linesBefore = (await lineTexts(page)).length;
		const convBefore = events.frames.filter((f) => f.type === "user").length;
		foreign = createServer((req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(`<!doctype html><meta charset=utf-8><title>evil</title><h3>foreign origin http://127.0.0.1:${FOREIGN_PORT}</h3><pre id=out></pre><script>
const target = "http://127.0.0.1:${HEAD_PORT}/say?token=${token}";
const out = document.getElementById("out");
const log = (s) => (out.textContent += s + "\\n");
(async () => {
  for (const [name, init] of [
    ["json cors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "CSRF-json" }) }],
    ["text/plain cors", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ text: "CSRF-plain" }) }],
    ["text/plain no-cors", { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ text: "CSRF-nocors" }) }],
    ["form-urlencoded no-cors", { method: "POST", mode: "no-cors", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "text=CSRF-form" }],
  ]) {
    try { const r = await fetch(target, init); log(name + " -> status " + r.status + " type " + r.type); }
    catch (e) { log(name + " -> " + e.name + ": " + e.message); }
  }
  document.title = "done";
})();
</script>`);
		});
		await new Promise((r) => foreign.listen(FOREIGN_PORT, "127.0.0.1", r));
		const evil = await ctx.newPage();
		const seen = [];
		evil.on("response", (r) => r.url().includes("/say") && seen.push(`${r.request().method()} ${r.status()}`));
		evil.on("requestfailed", (r) => r.url().includes("/say") && seen.push(`${r.method()} failed ${r.failure()?.errorText}`));
		await evil.goto(`http://127.0.0.1:${FOREIGN_PORT}/`);
		await evil.waitForFunction(() => document.title === "done", null, { timeout: 15_000 });
		const evilOut = await evil.textContent("#out");
		const base = `http://127.0.0.1:${HEAD_PORT}/say?token=${token}`;
		const c = {
			foreignOriginJson: curl(["-X", "POST", "-H", `Origin: http://127.0.0.1:${FOREIGN_PORT}`, "-H", "content-type: application/json", "--data", '{"text":"CSRF-curl1"}', base]),
			evilDomainJson: curl(["-X", "POST", "-H", "Origin: http://evil.example", "-H", "content-type: application/json", "--data", '{"text":"CSRF-curl2"}', base]),
			noOriginJson: curl(["-X", "POST", "-H", "content-type: application/json", "--data", '{"text":"CSRF-curl3"}', base]),
			sameOriginTextPlain: curl(["-X", "POST", "-H", `Origin: http://127.0.0.1:${HEAD_PORT}`, "-H", "content-type: text/plain", "--data", '{"text":"CSRF-curl4"}', base]),
			foreignOriginTextPlain: curl(["-X", "POST", "-H", `Origin: http://127.0.0.1:${FOREIGN_PORT}`, "-H", "content-type: text/plain", "--data", '{"text":"CSRF-curl5"}', base]),
			preflightOptions: curl(["-X", "OPTIONS", "-H", `Origin: http://127.0.0.1:${FOREIGN_PORT}`, "-H", "Access-Control-Request-Method: POST", "-H", "Access-Control-Request-Headers: content-type", base]),
			noTokenForeign: curl(["-X", "POST", "-H", `Origin: http://127.0.0.1:${FOREIGN_PORT}`, "-H", "content-type: application/json", "--data", '{"text":"CSRF-curl6"}', `http://127.0.0.1:${HEAD_PORT}/say`]),
		};
		await evil.evaluate((t) => (document.getElementById("out").textContent += "\nnetwork as seen by browser: " + t + "\n"), seen.join(" | "));
		await evil.evaluate((t) => (document.getElementById("out").textContent += "curl: " + t), JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.status])), null, 1));
		await sleep(1500);
		const linesAfter = (await lineTexts(page)).length;
		const convAfter = events.frames.filter((f) => f.type === "user").length;
		const csrfLines = (await lineTexts(page)).filter((l) => l.text.includes("CSRF")).length;
		await shot(evil, "w2-csrf-foreign-page");
		await shot(page, "w2-csrf-console");
		await composite("w2-csrf", `<div style="display:flex;gap:8px;font:13px sans-serif"><div><b>foreign page :${FOREIGN_PORT}</b><img style="width:860px" src="data:image/png;base64,${b64("w2-csrf-foreign-page.png")}"></div><div><b>console page after (no CSRF line)</b><img style="width:860px" src="data:image/png;base64,${b64("w2-csrf-console.png")}"></div></div>`);
		await evil.close();
		const statuses = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.status]));
		const browserStatuses = seen.filter((s) => /^POST \d+$/.test(s));
		record(5, statuses.foreignOriginJson === 403 && statuses.evilDomainJson === 403 && statuses.noOriginJson === 403 && statuses.sameOriginTextPlain === 415 && statuses.foreignOriginTextPlain === 403 && statuses.noTokenForeign === 401
			&& linesAfter === linesBefore && convAfter === convBefore && csrfLines === 0 && !/status 200/.test(evilOut) && browserStatuses.every((s) => / 403$/.test(s)), {
			browserFetchResults: evilOut.trim().split("\n"), browserNetwork: seen, curl: statuses, linesBefore, linesAfter, userFramesBefore: convBefore, userFramesAfter: convAfter,
		}, "a JSON fetch from a foreign page never reaches POST: the preflight OPTIONS gets 405 and the browser blocks it, so the page sees a TypeError, not a 403; the 403 is shown on the simple (text/plain, form) requests and via curl");
	}

	// Lane 7: host paused -> timeout wording, text kept; resume -> what shows
	{
		const s7 = `暂停测试：宿主被暂停时发出的这句话 ${Date.now() % 10000}`;
		await page.fill("#composer", s7);
		process.kill(H.child.pid, "SIGSTOP");
		const t0 = Date.now();
		await page.click("#send");
		await page.waitForFunction(() => document.getElementById("say-status").dataset.state === "maybe_lost", null, { timeout: 15_000 });
		const timeoutMs = Date.now() - t0;
		const st = await sayState(page);
		const kept = (await page.inputValue("#composer")) === s7;
		const sendEnabled = await page.isEnabled("#send");
		await shot(page, "w2-ack-timeout");
		process.kill(H.child.pid, "SIGCONT");
		const resumedAt = Date.now();
		const shownAfter = await page.waitForFunction((s) => [...document.querySelectorAll(".line.user")].some((n) => n.textContent.includes(s)), s7, { timeout: 10_000 }).then(() => Date.now() - resumedAt, () => null);
		await sleep(1500);
		const count = await userCount(page, s7);
		const status = await page.getAttribute("#status", "data-status");
		const st2 = await sayState(page);
		await shot(page, "w2-ack-timeout-resumed");
		const composerAfter = await page.inputValue("#composer");
		record(7, st.state === "maybe_lost" && st.text.includes("未收到确认") && timeoutMs <= 6500 && kept && shownAfter !== null && count === 1 && st2.state === "delivered" && st2.text === "已发送" && composerAfter === "", {
			timeoutMs, sayText: st.text, composerKept: kept, sendEnabled, afterResume: { userLineShownMs: shownAfter, occurrences: count, connStatus: status, sayStatus: st2.text, composerStill: (await page.inputValue("#composer")) === s7 },
		});
	}
	record("errors", pageErrors.length === 0, { pageErrors });
	writeFileSync(join(OUT, "events.json"), JSON.stringify(events.frames.map((f) => (f.type === "snapshot" ? { type: f.type, at: f.at } : f)), null, 1));
	events.close();
} catch (error) {
	console.log(`ERROR ${error.stack}`);
	results.push({ lane: "script", pass: false, detail: String(error.stack) });
} finally {
	for (const p of procs) if (p.exitCode === null) p.kill();
	await browser.close();
	foreign?.close();
	await stopHost(H).catch(() => {});
	await stopHost(T).catch(() => {});
	console.log(`stopped hosts ${H.child.pid} ${T.child.pid}`);
	writeFileSync(join(OUT, "results.json"), JSON.stringify({ head: "c7dd561", trunk: "ac70ec6", headDir, trunkDir, results }, null, 2));
	process.exit(0);
}
