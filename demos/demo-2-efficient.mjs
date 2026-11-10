// 高效 + 全双工：连说三件事不用等，三件同时在办；中途停止一件，其余照常办完。
import { ACTIVE, DONE, Demo, skip, sleep, fmtTicket } from "./lib.mjs";

const d = new Demo("demo-2-efficient", { port: 45192 });
const ASKS = [
	{ key: "域名", text: "帮我写一段 300 字左右的说明，介绍 example.com 这类保留域名是做什么用的，写完告诉我要点" },
	{ key: "室内", text: "帮我列出 8 个适合周末带孩子去的室内活动，每个配一句理由" },
	{ key: "HTTP", text: "帮我写一份 1500 字的报告，详细比较 HTTP/1.1、HTTP/2 和 HTTP/3，分章节写进 report.md，写完告诉我" },
];
const doing = (st) => st.tickets.filter((t) => ACTIVE.includes(t.stage));

await d.run(async () => {
	const url = await d.startHost();
	await d.openBrowser(url);
	let peak = 0;
	let peakSeen = "";
	const sampler = setInterval(async () => {
		const head = await d.page.locator("#left h2", { hasText: "进行中" }).textContent().catch(() => "");
		const n = Number(/(\d+)/.exec(head ?? "")?.[1] ?? 0);
		if (n > peak) {
			peak = n;
			peakSeen = head;
		}
	}, 500);

	await d.scene("一 · 连说三件事，不用等上一件说完", ["一次只能聊一件事，得等它回完才能问下一句", "输入框从不被占住：说完一件立刻能说下一件，每句都显示「已发送」"], async () => {
		const t0 = Date.now();
		for (const a of ASKS) await d.say(a.text, { delay: 22 });
		const span = Math.round((Date.now() - t0) / 1000);
		return { status: "PASS", evidence: `3 sentences delivered in ${span}s (composer accepted each right after the previous)` };
	});

	await d.scene("二 · 三件事同时在办", ["一件一件排队，前一件不完后一件不动", "幕僚长给每件事各派一个助手，左栏「进行中」同时有三件"], async () => {
		const s = await d.until("3 tickets doing at once", () => {
			const st = d.state();
			return doing(st).length >= 3 ? st : null;
		}, 150_000, 1000);
		await sleep(3000);
		const st = s ?? d.state();
		return Demo.check(Boolean(s) || peak >= 3, `kernel doing=${doing(st).length} [${doing(st).map(fmtTicket).join("; ")}]; page peak「${peakSeen}」`, "never saw 3 tickets in progress together");
	});

	let slow;
	await d.scene("三 · 随时停止其中一件", ["只能等它说完，或者整个对话重来", "点「停止」只是把话填进输入框，由你按发送；幕僚长停掉那个助手"], async () => {
		const st = d.state();
		slow = st.tickets.find((t) => /HTTP|报告/.test(t.title));
		if (!slow) throw new Error(`no HTTP ticket; tickets=${st.tickets.map(fmtTicket).join("; ")}`);
		if (!ACTIVE.includes(slow.stage)) return skip(`slow ticket already ${slow.stage} before stop`);
		const card = d.card(slow.title).first();
		await card.locator("button.stop").click({ timeout: 10_000 });
		await sleep(2500);
		const filled = await d.page.inputValue("#composer");
		await d.page.locator("#send").click();
		const s = await d.untilTicket(slow.id, (t) => t.stage === "stopped", 120_000, 1500);
		await d.openCard(slow.title).catch(() => {});
		await sleep(3000);
		const stopDecision = (s?.st ?? d.state()).decisions.find((x) => x.kind === "stop" && x.decision.ticketId === slow.id);
		return Demo.check(Boolean(s), `composer filled「${filled}」; ${slow.id} stage=stopped; route stop ok=${stopDecision?.ok}`, "ticket not stopped in 120s");
	});

	await d.scene("四 · 其余两件照常办完", ["停止就是把整个对话停掉，别的事也一起断了", "停止只影响那一件；另外两件的结果回到对话里"], async () => {
		const others = () => d.state().tickets.filter((t) => t.id !== slow?.id);
		const ok = await d.until("other two finished", () => {
			const o = others();
			return o.length >= 2 && o.every((t) => DONE.includes(t.stage)) ? o : null;
		}, 240_000, 3000);
		await sleep(3000);
		const o = ok ?? others();
		return Demo.check(Boolean(ok), o.map(fmtTicket).join("; "), "other tickets did not finish in 240s");
	});

	await d.scene("五 · 三个助手，各干各的", ["一个对话里所有事搅在一起", "点开每件事，右栏「执行过程」是那个助手自己的步骤；停止的那件停在半路"], async () => {
		const st = d.state();
		const seen = [];
		for (const t of st.tickets) {
			await d.openCard(t.title).catch(() => {});
			const n = await d.until(`steps for ${t.id}`, async () => (await d.page.textContent("#how-title")) === t.title && (await d.page.locator("#steps .step").count()), 20_000, 500);
			seen.push(`${t.title}:${n ?? 0} steps/${t.stage}`);
			await sleep(4000);
		}
		return Demo.check(seen.length === 3 && seen.every((x) => !x.includes(":0 ")), seen.join("; "), "a ticket showed no steps");
	});

	clearInterval(sampler);
	await d.outro("小结 · 高效", "一次一件，说话和等结果都卡着你", "并行派活、随时插话、随时停止；你说话从不需要排队");
});
