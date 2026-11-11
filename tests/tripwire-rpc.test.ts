import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { FeedSpec } from "../src/sources/feeds.ts";
import { domainsOf, ids, openOnConversation, startHost, until, type Brain, type FakeWorker } from "./helpers/fakes.ts";

const DOMAINS = domainsOf({ "us-market": { tools: ["lookup", "tripwire"] }, mail: { tools: ["lookup"] } });
const SET = { source: "us-market", op: "set", args: { symbol: "NVDA", condition: { kind: "day", pct: 5 } } };
const SOURCE_TEXT = "NVDA 涨了 5%（来源正文）";

function tripwireFeed() {
	const asked: unknown[] = [];
	const spec: FeedSpec = {
		source: "us-market",
		lookupHelp: "",
		tripwireHelp: "",
		create: () => ({
			start() {},
			stop() {},
			problem: () => undefined,
			lookup: async () => null,
			tripwires: (op, args) => (asked.push([op, args]), { echo: "已添加：NVDA。现在共 1 条。", tripwires: [] }),
		}),
	};
	return { asked, spec };
}

async function call(worker: FakeWorker): Promise<unknown> {
	return Promise.resolve()
		.then(() => worker.request("worker.tripwire", SET))
		.catch((e: Error) => e.message);
}

async function tripwireIn(t: TestContext, brain: Brain, act: (host: Awaited<ReturnType<typeof startHost>>["host"]) => unknown, when: (input: string) => boolean = () => true) {
	const feed = tripwireFeed();
	const results: unknown[] = [];
	const { host } = await startHost(
		brain,
		async (worker, input) => {
			if (when(input)) results.push(await call(worker));
			worker.report({ status: "progress", summary: "好了" });
			worker.settle();
		},
		{ domains: DOMAINS, feeds: [feed.spec], ruleAllows: () => true },
	);
	t.after(() => host.stop());
	await act(host);
	await until(() => results.length === 1, "助手调了一次 tripwire", 5000);
	return { result: results[0], asked: feed.asked };
}

const onConversation = (domain?: string, threads?: string[]): Brain => (cards) =>
	cards.flatMap((card) => {
		if (!card.startsWith("[对话]")) return [];
		const [route, reply] = openOnConversation(card, "盯盘", domain);
		(route.args.decisions as Record<string, unknown>[])[0].threads = threads;
		return [route, reply];
	});
const fromSource = (host: Awaited<ReturnType<typeof startHost>>["host"], thread = "thr_us-market:NVDA") =>
	host.kernel.submitTrigger({ source: "us-market", externalId: `m${Date.now()}`, threads: [{ id: thread }], sender: "us-market", body: SOURCE_TEXT, occurredAt: Date.now() });

test("使用者在对话里开的、领域开了 tripwire、从没收到过来源正文的任务：宿主把 op 和 args 原样交给来源，回复原样给助手", async (t) => {
	const { result, asked } = await tripwireIn(t, onConversation("us-market"), (host) => host.say("帮我盯英伟达，涨跌 5% 提醒"));
	assert.deepEqual(asked, [["set", SET.args]]);
	assert.deepEqual(result, { echo: "已添加：NVDA。现在共 1 条。", tripwires: [] });
});

test("领域没开 tripwire 的任务和没有领域的任务改盯盘条件，宿主拒绝，来源收不到", async (t) => {
	for (const domain of ["mail", undefined]) {
		const { result, asked } = await tripwireIn(t, onConversation(domain), (host) => host.say("帮我盯英伟达"));
		assert.deepEqual(asked, [], String(domain));
		assert.match(String(result), /领域没有在 module\.json 的 tools 里开 tripwire/, String(domain));
	}
});

test("规则开的任务和推断开的任务改盯盘条件，宿主拒绝，说明只有使用者在对话里开的任务能改", async (t) => {
	for (const basis of ["rule", "inference"] as const) {
		const brain: Brain = (cards) =>
			cards.flatMap((card) =>
				card.startsWith("[候选触发]")
					? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis, ruleId: basis === "rule" ? "us-market/big-move" : undefined, domain: "us-market", triggerId: ids(card, "trg"), title: "t", brief: "b" }] } }]
					: [],
			);
		const { result, asked } = await tripwireIn(t, brain, (host) => fromSource(host));
		assert.deepEqual(asked, [], basis);
		assert.match(String(result), /只有使用者在对话里开的任务能改盯盘条件/, basis);
		assert.match(String(result), /在对话里再说一次/, basis);
	}
});

test("使用者开的任务收到过来源正文（订阅的线程投进来、或幕僚长转交进来）之后改盯盘条件，宿主拒绝，请使用者在对话里重新说一次", async (t) => {
	const subscribed = await tripwireIn(
		t,
		onConversation("us-market", ["thr_us-market:NVDA"]),
		async (host) => {
			host.say("帮我盯英伟达");
			await until(() => host.kernel.listTickets().some((r) => r.stage === "idle"), "任务先空闲");
			fromSource(host);
		},
		(input) => input.includes(SOURCE_TEXT),
	);
	let ticketId = "";
	const handedOver = await tripwireIn(
		t,
		(cards) =>
			cards.flatMap((card) => {
				if (card.startsWith("[对话]")) return openOnConversation(card, "盯盘", "us-market");
				if (card.startsWith("[候选触发]")) return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: ids(card, "trg"), ticketId }] } }];
				return [];
			}),
		async (host) => {
			host.say("帮我盯英伟达");
			await until(() => host.kernel.listTickets().some((r) => r.stage === "idle"), "任务先空闲");
			ticketId = host.kernel.listTickets()[0].id;
			fromSource(host, "thr_us-market:other");
		},
		(input) => input.includes(SOURCE_TEXT),
	);
	for (const [how, { result, asked }] of [["订阅", subscribed], ["转交", handedOver]] as const) {
		assert.deepEqual(asked, [], how);
		assert.match(String(result), /收到过来源发来的内容/, how);
		assert.match(String(result), /请使用者在对话里重新说一次/, how);
	}
});
