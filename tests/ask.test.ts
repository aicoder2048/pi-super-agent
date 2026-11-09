import assert from "node:assert/strict";
import test from "node:test";
import { openOnConversation, startHost, until, type Brain } from "./helpers/fakes.ts";

const openOnly: Brain = (cards) => cards.flatMap((card) => (card.startsWith("[对话]") ? openOnConversation(card) : []));

test("Worker 汇报的选项不合规时工具报错，说清规则，这份汇报不记录", async (t) => {
	const errors: string[] = [];
	const bad: Record<string, unknown>[] = [
		{ options: ["只有一个"] },
		{ options: ["一", "二", "三", "四", "五"] },
		{ options: ["好", "好"] },
		{ options: ["好", "这个选项写得太长了超过了二十个字的上限啊啊"] },
		{ options: ["好", " "] },
		{ options: ["好", 3] },
		{ options: "好,不好" },
	];
	const { host } = await startHost(openOnly, (w) => {
		for (const over of bad) {
			try {
				w.report({ status: "blocked", summary: "要你选", question: "选哪个？", ...over });
			} catch (error) {
				errors.push((error as Error).message);
			}
		}
		try {
			w.report({ status: "progress", summary: "没问题却给了选项", options: ["甲", "乙"] });
		} catch (error) {
			errors.push((error as Error).message);
		}
		w.report({ status: "blocked", summary: "要你选", question: "选哪个？", options: [" 甲 ", "乙"] });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("帮我选");
	await until(() => host.kernel.listTickets()[0]?.stage === "awaiting_answer", "合规的提问被记下");
	assert.equal(errors.length, bad.length + 1, JSON.stringify(errors));
	for (const message of errors.slice(0, 2)) assert.match(message, /2 到 4 个/);
	assert.match(errors[2], /重复/);
	assert.match(errors[3], /20 个字/);
	assert.match(errors[4], /空/);
	assert.match(errors[5], /文字/);
	assert.match(errors[6], /列表/);
	assert.match(errors[7], /question/);
	const found = host.kernel.read(host.kernel.listTickets()[0].id);
	assert.ok(found?.type === "ticket");
	assert.deepEqual(found.recentReports.map((r) => r.options), [["甲", "乙"]], "只有合规的一份汇报，选项去掉首尾空白");
});
