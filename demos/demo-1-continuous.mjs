// 连续 + 双层 Router/Worker + 多渠道：只和幕僚长说话，它派助手；「刚才那个」接回同一件事；换个渠道改要求也接得上。
import { DONE, Demo, skip, sleep, fmtTicket, fmtTrigger } from "./lib.mjs";

const d = new Demo("demo-1-continuous", { port: 45191 });
const handedTo = (s, ticketId) => s.triggers.filter((t) => t.source === "conversation" && t.disposition === "handed_over" && t.detail === ticketId);

await d.run(async () => {
	const url = await d.startHost();
	await d.openBrowser(url);
	let ticket;

	await d.scene("开场 · 一个对话框背后有两层", ["你问一句，它在这个窗口里答一句，关掉就没了", "你只和幕僚长（Router）说话；真正干活的是它在后台安排的助手（Worker）"], async () => {
		const duty = await d.page.textContent("#duty");
		return Demo.check(/在线/.test(duty), `header「${duty}」, page connected`, "header not online");
	});

	await d.scene("一 · 交代一件事，它派助手去办", ["回答完就结束，干活要你自己盯着", "幕僚长只接话和分派，开一个任务交给后台助手，自己回一句确认"], async () => {
		await d.say("帮我打开 https://example.com 和 https://www.iana.org/help/example-domains 两个网页，各用一句话说它们讲了什么，最后给我一个三点小结");
		const s = await d.until("ticket opened", () => {
			const st = d.state();
			return st.tickets.length && st.conversation.some((m) => m.who === "router") ? st : null;
		}, 120_000);
		await d.card("").first().waitFor({ timeout: 20_000 }).catch(() => {});
		await sleep(3000);
		if (!s) throw new Error("no ticket or router reply within 120s");
		ticket = s.tickets[0];
		const reply = s.conversation.find((m) => m.who === "router")?.text ?? "";
		await d.openCard(ticket.title).catch(() => {});
		return Demo.check(ticket.basis === "request", `${fmtTicket(ticket)}; 幕僚长回复「${reply.slice(0, 40)}」`, "ticket basis is not request");
	});

	await d.scene("二 · 「刚才那个」：不报编号也接得上", ["新问题就是新对话，要你把上下文再贴一遍", "幕僚长读一下进行中的任务，把补充交给同一个助手，不另开新任务"], async () => {
		if (!ticket) return skip("no ticket from scene 一");
		await d.say("刚才那个，小结里再加一条：这两个网站分别是谁在维护");
		const s = await d.until("hand_over to same ticket", () => {
			const st = d.state();
			return handedTo(st, ticket.id).length >= 1 ? st : null;
		}, 120_000);
		await d.openCard(ticket.title).catch(() => {});
		await d.until("steps show 收到你的补充说明", () => d.page.locator("#steps .step-title", { hasText: "收到你的补充说明" }).count(), 60_000);
		await sleep(3000);
		const st = s ?? d.state();
		const last = st.triggers.filter((t) => t.source === "conversation").at(-1);
		return Demo.check(Boolean(s) && st.tickets.length === 1, `trigger ${last ? fmtTrigger(last) : "none"}; tickets=${st.tickets.length}`, "follow-up was not handed to the same ticket");
	});

	await d.scene("三 · 换个渠道改要求，同一件事跟着调整", ["换个窗口或设备，就是另一段对话，前面的都不认识", "另一个客户端（命令行 say）说一句，进到同一个对话和同一个任务，网页上也看得到"], async () => {
		if (!ticket) return skip("no ticket from scene 一");
		const phrase = "（从命令行）刚才那个改一下：最后的小结用英文写";
		d.secondChannelSay(phrase);
		const shown = await d.until("page shows second-channel line", () => d.page.locator(".line.user", { hasText: "从命令行" }).count(), 30_000);
		const s = await d.until("second hand_over", () => {
			const st = d.state();
			return handedTo(st, ticket.id).length >= 2 ? st : null;
		}, 120_000);
		await d.openCard(ticket.title).catch(() => {});
		await sleep(2000);
		const st = s ?? d.state();
		return Demo.check(Boolean(shown) && Boolean(s) && st.tickets.length === 1, `page shows CLI line=${Boolean(shown)}; handed_over to ${ticket.id} x${handedTo(st, ticket.id).length}; tickets=${st.tickets.length}`, "second channel not routed to same ticket");
	});

	await d.scene("四 · 办完了，结果回到对话里", ["要你一直开着窗口等它说完", "助手办完汇报，幕僚长用一句话告诉你，左栏这个任务的状态随之更新（已完成或待确认）"], async () => {
		if (!ticket) return skip("no ticket from scene 一");
		const s = await d.untilTicket(ticket.id, (t) => DONE.includes(t.stage), 240_000);
		await d.openCard(ticket.title).catch(() => {});
		await sleep(4000);
		const t = s?.t ?? d.state().tickets.find((x) => x.id === ticket.id);
		const english = /[A-Za-z]{4,}.*[A-Za-z]{4,}/.test(t?.latest ?? "");
		return Demo.check(Boolean(s), `${t ? fmtTicket(t) : "?"}; report「${(t?.latest ?? "").slice(0, 80)}」; english=${english}`, "ticket did not finish in 240s");
	});

	await d.scene("五 · 回看：一个助手接住了三句话", ["每句话各自独立，谁也不记得谁", "点开这件事，右栏「执行过程」里同一个助手先后「收到你的补充说明」两次，最后按英文改完"], async () => {
		if (!ticket) return skip("no ticket from scene 一");
		await d.openCard(ticket.title).catch(() => {});
		const n = await d.until("two 收到你的补充说明 steps", async () => {
			const c = await d.page.locator("#steps .step-title", { hasText: "收到你的补充说明" }).count();
			return c >= 2 ? c : null;
		}, 30_000);
		const steps = d.page.locator("#steps .step-title", { hasText: "收到你的补充说明" });
		for (let i = 0; i < (n ?? 0); i++) {
			await steps.nth(i).scrollIntoViewIfNeeded().catch(() => {});
			await sleep(2500);
		}
		const inputs = d.state().tickets.find((t) => t.id === ticket.id)?.inputs.filter((x) => x.kind === "user_message").length ?? 0;
		return Demo.check(Boolean(n), `right panel 收到你的补充说明 x${n ?? 0}; kernel user_message inputs on ${ticket.id}: ${inputs}`, "steps did not show both hand-overs");
	});

	await d.outro("小结 · 连续", "一问一答，每次从头来", "一个总入口持续接话；后续补充、换渠道改要求都接回同一件事");
});
