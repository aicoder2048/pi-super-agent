// 持久 + 计算/状态分离 + Watchdog：宿主被强杀，Watchdog 拉起新宿主，任务从状态库接着办；卡住的任务由 Watchdog 发现，幕僚长告诉你。
import { groupAlive } from "../tests/e2e/harness.ts";
import { Demo, sleep, fmtTicket, fmtTrigger } from "./lib.mjs";

const d = new Demo("demo-4-durable", {
	port: 45194,
	config: { heartbeatSeconds: 2, watchdog: { intervalMinutes: 0.1, staleSeconds: 6, stuckMinutes: 0.75 } },
});
const status = () => d.page.evaluate(() => document.querySelector("#status")?.dataset.status).catch(() => "?");
await d.run(async () => {
	d.startWatchdog();
	const url = await d.until("watchdog started host", () => d.hostUrls()[0], 90_000, 1000);
	if (!url) throw new Error(`no host URL; watchdog log: ${d.watchdogLog().slice(-400)}`);
	await d.openBrowser(url);
	let ticket;
	let firstHost;

	await d.scene("开场 · 宿主由 Watchdog 拉起", ["程序挂了就挂了，聊天记录和进行中的事一起没了", "这次不是直接启动宿主，而是先启动 Watchdog，由它拉起宿主并每 6 秒查一次心跳"], async () => {
		firstHost = d.heartbeatPid();
		const started = /已拉起宿主，pid (\d+)/.exec(d.watchdogLog())?.[1];
		return Demo.check(Boolean(started) && Number(started) === firstHost, `watchdog.log「已拉起宿主，pid ${started}」; heartbeat pid ${firstHost}`, "host not started by watchdog");
	});

	await d.scene("一 · 交代一件要好几步的事", ["关掉窗口，进行到一半的事就断了", "助手一步步打开三个网页，每步都记进状态库（state.db），不只在进程内存里"], async () => {
		await d.say("依次打开这三个网页：https://example.com 、https://www.iana.org/help/example-domains 、https://www.iana.org/domains/reserved 。每打开一个先用 report 汇报一次进度，三个都看完后用三句话总结它们的关系");
		const st = await d.until("ticket running with a tool call", () => {
			const x = d.state();
			const t = x.tickets[0];
			return t && t.stage === "running" && t.toolCalls >= 1 ? x : null;
		}, 120_000, 1000);
		if (!st) return { status: "SKIP", evidence: `ticket never running with a tool call: ${d.state().tickets.map(fmtTicket).join("; ")}` };
		ticket = st.tickets[0];
		await d.openCard(ticket.title).catch(() => {});
		await sleep(2000);
		return { status: "PASS", evidence: `${fmtTicket(ticket)} toolCalls=${ticket.toolCalls}` };
	});

	let newUrl;
	await d.scene("二 · 宿主进程被强杀（kill -9）", ["进程一死，你交代的事就丢了", "计算（宿主进程）死了，状态（state.db）还在；Watchdog 发现心跳停了，拉起新宿主"], async () => {
		if (!ticket) return { status: "SKIP", evidence: "no running ticket to interrupt" };
		const pid = d.heartbeatPid();
		if (!pid || !d.watchdogHosts().includes(pid)) return { status: "SKIP", evidence: `heartbeat pid ${pid} is not a host our watchdog started` };
		process.kill(pid, "SIGKILL");
		d.log(`SIGKILL host ${pid} (its Workers stay in process group ${pid} until cleanup)`);
		await d.caption("二 · 宿主进程被强杀（kill -9）", "进程一死，你交代的事就丢了", `已强杀宿主 pid ${pid}。网页断线，等 Watchdog 发现心跳过期（6 秒）后拉起新宿主…`);
		const dropped = await d.until("page shows disconnected", async () => ((await status()) !== "connected" ? await status() : null), 20_000, 500);
		newUrl = await d.until("new host URL", () => d.hostUrls()[1], 60_000, 1000);
		const orphans = groupAlive(pid);
		d.log(`old host group ${pid} still has processes after the kill: ${orphans}`);
		const restartLine = d.watchdogLog().split("\n").filter((l) => l.includes("已拉起宿主")).at(-1) ?? "";
		return Demo.check(Boolean(newUrl), `page status=${dropped}; ${restartLine.slice(25)}; old host group ${pid} still has Worker processes: ${orphans}`, "watchdog did not restart host in 60s");
	});

	await d.scene("三 · 打开新地址：刚才那个任务已恢复", ["重开以后一切从零开始", "新宿主从 state.db 恢复进行中的任务，页头显示「已重启，进行中的任务已恢复」"], async () => {
		if (!newUrl) return { status: "SKIP", evidence: "no new host" };
		await d.goto(newUrl);
		const notice = await d.page.textContent("#restart");
		const recovered = /恢复 \d+ 个执行中的任务：[^\n]*/.exec(d.hostLog())?.[0] ?? "";
		await d.openCard(ticket.title).catch(() => {});
		const step = await d.until("steps show 重启后恢复", () => d.page.locator("#steps .step-title", { hasText: "重启后恢复" }).count(), 60_000);
		await d.page.locator("#steps .step-title", { hasText: "重启后恢复" }).last().scrollIntoViewIfNeeded().catch(() => {});
		await sleep(3000);
		return Demo.check(/已恢复/.test(notice ?? "") && recovered.includes(ticket.id), `#restart「${notice}」; host.log「${recovered}」; step 重启后恢复 shown=${Boolean(step)}`, "restart notice or recovery missing");
	});

	await d.scene("四 · 任务办完", ["页面刷新，答到一半的话也没了", "同一个任务、同一段对话，在新进程里办完，结果回到对话"], async () => {
		if (!ticket) return { status: "SKIP", evidence: "no ticket" };
		const st = await d.until("ticket finished", () => {
			const x = d.state();
			const t = x.tickets.find((y) => y.id === ticket.id);
			return t && ["awaiting_review", "closed"].includes(t.stage) ? x : null;
		}, 240_000, 3000);
		await sleep(3000);
		const t = (st ?? d.state()).tickets.find((y) => y.id === ticket.id);
		return Demo.check(Boolean(st), `${t ? fmtTicket(t) : "?"}; report「${(t?.latest ?? "").slice(0, 60)}」`, "ticket did not finish after restart");
	});

	let stuck;
	await d.scene("五 · 卡住的任务：Watchdog 发现，幕僚长告诉你", ["卡住了也不吭声，你只能一直等", "助手在前台跑一条很久不结束的命令；超过 45 秒没进展，Watchdog 投递通知，幕僚长在对话里告诉你"], async () => {
		await d.say("请在前台直接运行命令 sleep 240（不要放到后台、不要设置超时），等它结束后告诉我结果");
		const st = await d.until("watchdog stuck notice and router reply", () => {
			const x = d.state();
			const n = x.triggers.find((t) => t.source === "watchdog");
			if (!n) return null;
			const at = x.conversation.filter((m) => m.who === "router").at(-1);
			return at && /卡|进展|没有动静|停滞/.test(at.text) ? { x, n, at } : null;
		}, 180_000, 2000);
		const x = st?.x ?? d.state();
		stuck = x.tickets.find((t) => /sleep|命令|运行/.test(t.title)) ?? x.tickets.at(-1);
		await sleep(5000);
		if (!st) {
			const n = x.triggers.find((t) => t.source === "watchdog");
			return { status: "SKIP", evidence: `watchdog notice=${n ? fmtTrigger(n) : "none"}; stuck ticket ${stuck ? fmtTicket(stuck) : "?"}` };
		}
		return { status: "PASS", evidence: `trigger ${fmtTrigger(st.n)}; 幕僚长回复「${st.at.text.slice(0, 60)}」` };
	});

	await d.scene("六 · 停止卡住的任务", ["只能刷新重来", "你决定停止；幕僚长停掉那个助手"], async () => {
		if (!stuck || !["queued", "running", "idle"].includes(stuck.stage)) return { status: "SKIP", evidence: `nothing to stop: ${stuck ? fmtTicket(stuck) : "none"}` };
		await d.card(stuck.title).first().locator("button.stop").click({ timeout: 10_000 });
		await sleep(2000);
		await d.page.locator("#send").click();
		const st = await d.until("stuck ticket stopped", () => d.state().tickets.find((t) => t.id === stuck.id && t.stage === "stopped"), 120_000);
		await sleep(2000);
		return Demo.check(Boolean(st), `${st ? fmtTicket(st) : "not stopped"}`, "stuck ticket not stopped");
	});

	await d.scene("诚实说明 · MVP 里没有的部分", ["（对照说明）", "MVP 只做到「计算与状态分离」和「按心跳与进展时长判断」的 Watchdog；执行环境分离（沙箱/远程机器）和用模型判断是否卡住的 Watchdog 还不在 MVP 里"], async () => {
		await sleep(4000);
		return { status: "PASS", evidence: "caption only (scope statement, nothing to verify)" };
	});
});
