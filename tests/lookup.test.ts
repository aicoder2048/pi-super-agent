import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostServer } from "../src/host/server.ts";
import { onJsonLines, writeJsonLine } from "../src/jsonl.ts";
import { domainsOf, openOnConversation, startHost, until } from "./helpers/fakes.ts";

test("Worker 连接上的请求可以异步完成：宿主等结果出来再回，出错时回错误信息", async (t) => {
	const server = new HostServer({ onSay: () => "", snapshot: () => ({}) }, async (_ticket, _token, method) => {
		await new Promise((r) => setTimeout(r, 20));
		if (method === "boom") throw new Error("查不到");
		return { price: 142.85 };
	});
	const path = join(mkdtempSync(join(tmpdir(), "psa-srv-")), "h.sock");
	await server.listen(path);
	const socket = connect(path);
	t.after(() => {
		socket.destroy();
		return server.close();
	});
	const replies: any[] = [];
	onJsonLines(socket, (r) => replies.push(r));
	writeJsonLine(socket, { type: "hello", role: "worker", ticketId: "tkt_1", token: "tok" });
	writeJsonLine(socket, { type: "request", id: 1, method: "worker.lookup", params: {} });
	writeJsonLine(socket, { type: "request", id: 2, method: "boom", params: {} });
	await until(() => replies.length === 2, "两个回复");
	assert.deepEqual(replies.sort((a, b) => a.id - b.id), [{ id: 1, ok: true, result: { price: 142.85 } }, { id: 2, ok: false, error: "查不到" }]);
});

const DOMAINS = domainsOf({ quotes: { tools: ["lookup"] }, mail: {} });

async function lookupsIn(t: import("node:test").TestContext, domain: string | undefined) {
	const results: unknown[] = [];
	const asked: unknown[] = [];
	const { host } = await startHost(
		(cards) => (cards.some((c) => c.includes("使用者：")) ? openOnConversation(cards[0], "查价", domain) : []),
		async (worker) => {
			results.push(await Promise.resolve().then(() => worker.request("worker.lookup", { source: "us-market", op: "quote", args: { symbols: ["NVDA"] } })).catch((e: Error) => e.message));
			results.push(await Promise.resolve().then(() => worker.request("worker.lookup", { source: "x-feed", op: "quote" })).catch((e: Error) => e.message));
			worker.report({ status: "ready", summary: "好了" });
			worker.settle();
		},
		{
			domains: DOMAINS,
			feeds: [{
				source: "us-market",
				lookupHelp: "",
				create: () => ({ start() {}, stop() {}, problem: () => undefined, lookup: async (op, args) => (asked.push([op, args]), [{ symbol: "NVDA", price: 142.85 }]) }),
			}],
		},
	);
	t.after(() => host.stop());
	host.say("查一下英伟达");
	await until(() => results.length === 2, "两次查询都有结果", 5000);
	return { results, asked };
}

test("领域开了 lookup 的助手查数据，宿主交给对应来源，结果原样回给它；未知来源报错并列出可查的来源", async (t) => {
	const { results, asked } = await lookupsIn(t, "quotes");
	assert.deepEqual(asked, [["quote", { symbols: ["NVDA"] }]]);
	assert.deepEqual(results[0], [{ symbol: "NVDA", price: 142.85 }]);
	assert.match(String(results[1]), /x-feed.*us-market/);
});

test("领域没开 lookup 的助手和没有领域的助手查数据，宿主一律拒绝，来源收不到请求", async (t) => {
	for (const domain of ["mail", undefined]) {
		const { results, asked } = await lookupsIn(t, domain);
		assert.deepEqual(asked, [], String(domain));
		for (const result of results) assert.match(String(result), /不能用 lookup/, String(domain));
	}
});
