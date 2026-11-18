import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { AssistantLine, HostToClient } from "../../src/client/protocol.ts";
import { openAssistantSession } from "../../src/host/assistant/session.ts";
import type { Expert } from "../../src/host/assistant/prompt.ts";
import { domainsOf, openOnConversation, startHost, tempStateDir, until, within } from "../helpers/fakes.ts";

type Got = { status: number; body: string };
function post(url: string, origin: string, body: unknown): Promise<Got> {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method: "POST", headers: { origin, "content-type": "application/json" } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c));
			res.on("end", () => resolve({ status: res.statusCode!, body: text }));
		});
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}
function events(url: string) {
	const got: HostToClient[] = [];
	let raw = "";
	const req = http.get(url, (res) => {
		res.setEncoding("utf8");
		res.on("data", (c: string) => {
			raw += c;
			got.splice(0, got.length, ...raw.split("\n\n").slice(0, -1).flatMap((f) => (f.startsWith("data: ") ? [JSON.parse(f.slice(6)) as HostToClient] : [])));
		});
	});
	req.on("error", () => {});
	return { got, close: () => req.destroy() };
}

const expertFor = (domain: string | null): Expert =>
	domain === "option-ta" ? { key: "option-ta", name: "期权研究组简报官", about: "期权", background: "- IV Rank：位置" } : { key: "host", name: "简报官", about: "白宫", background: "- 幕僚长" };

async function world(t: TestContext, speak?: (text: string) => Promise<Buffer | null>) {
	const faux = fauxProvider({ models: [{ id: "explainer" }] });
	const systems: string[] = [];
	faux.setResponses(Array.from({ length: 20 }, () => (context: any) => {
		systems.push(JSON.stringify((context.messages as any[]).filter((m) => m.role === "system")));
		return fauxAssistantMessage(fauxText("讲解完毕。"));
	}));
	const stateDir = tempStateDir();
	const modelRuntime = await ModelRuntime.create({ authPath: join(stateDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const started = await startHost((cards) => (cards.some((c) => c.includes("DIA 贵不贵")) ? openOnConversation(cards.find((c) => c.includes("DIA 贵不贵"))!, "DIA 波动率", "option-ta") : []), () => {}, {
		stateDir,
		webPort: 0,
		domains: domainsOf({ "option-ta": {} }),
		assistant: { open: (expert, fresh) => openAssistantSession({ modelRuntime, model: () => faux.getModel("explainer")!, stateDir, retry: { maxRetries: 0 } }, expert, fresh), expertFor, ...(speak && { speak }) },
	});
	t.after(() => within(started.host.stop(), 5000, "host.stop()"));
	const url = new URL(started.host.webUrl!);
	const token = url.searchParams.get("token")!;
	const at = (path: string) => `${url.origin}${path}?token=${token}`;
	return { ...started, systems, origin: url.origin, at, ask: (body: unknown) => post(at("/assist"), url.origin, body) };
}

const answered = (lines: readonly AssistantLine[] | undefined) => lines?.filter((l) => l.role === "assistant" && l.state === "done") ?? [];

test("网页问简报官（ADR-0033）：问使用者开了期权任务的那句话，由期权研究组简报官答；回答经 SSE 推到网页，刷新后快照里还在", async (t) => {
	const w = await world(t);
	const userLine = w.host.say("DIA 贵不贵？");
	await until(() => w.host.kernel.conversationRoutes()[userLine]?.ticketId, "开了任务");
	const stream = events(w.at("/events"));
	t.after(() => stream.close());
	const res = await w.ask({ question: "「贵」指什么？", lineId: userLine, picked: "贵" });
	assert.equal(res.status, 200, res.body);
	assert.match(JSON.parse(res.body).id, /^[0-9a-f-]{36}$/);
	await until(() => stream.got.some((m) => m.type === "assistant" && m.line.role === "assistant" && m.line.state === "done") || undefined, "SSE 推来回答");
	assert.match(w.systems.at(-1)!, /期权研究组简报官/);
	const lines = w.host.snapshot().assistant!;
	assert.deepEqual(lines.map((l) => [l.role, l.expert]), [["user", "期权研究组简报官"], ["assistant", "期权研究组简报官"]]);
	assert.deepEqual(lines[0]!.about, { picked: "贵", text: "DIA 贵不贵？" });
	assert.equal(answered(lines)[0]!.text, "讲解完毕。");
});

test("网页问简报官：不点哪句话直接问，由简报官答；编号不存在的句子、空问题、只给 picked 不给句子都拒绝；清空后快照里没有了", async (t) => {
	const w = await world(t);
	assert.equal((await w.ask({ question: "幕僚长是谁？" })).status, 200);
	await until(() => answered(w.host.snapshot().assistant).length === 1 || undefined, "简报官答");
	assert.match(w.systems.at(-1)!, /简报官/);
	assert.equal((await w.ask({ question: "这是什么？", lineId: "no-such-line" })).status, 400);
	assert.equal((await w.ask({ question: "   " })).status, 400);
	assert.equal((await w.ask({ question: "这是什么？", picked: "IV" })).status, 400);
	assert.equal((await w.ask({ question: "x", extra: 1 })).status, 400);
	assert.equal((await post(w.at("/assist/clear"), w.origin, {})).status, 204);
	assert.deepEqual(w.host.snapshot().assistant, []);
});

test("网页朗读一句（POST /speak）：合成出来回 audio/mpeg；合成不了回 502，页面改用本机朗读；空的、多余字段、太长的都拒绝", async (t) => {
	const asked: string[] = [];
	const w = await world(t, async (text) => (asked.push(text), text.includes("失败") ? null : Buffer.from("mp3")));
	const speak = (body: unknown) =>
		new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
			const req = http.request(w.at("/speak"), { method: "POST", headers: { origin: w.origin, "content-type": "application/json" } }, (res) => {
				let text = "";
				res.on("data", (c) => (text += c));
				res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], body: text }));
			});
			req.on("error", reject);
			req.end(JSON.stringify(body));
		});
	const ok = await speak({ text: "IV Rank 是 85%。" });
	assert.deepEqual([ok.status, ok.type, ok.body], [200, "audio/mpeg", "mp3"]);
	assert.equal((await speak({ text: "这句会失败。" })).status, 502);
	for (const bad of [{ text: "  " }, { text: "x", voice: "y" }, { text: "长".repeat(401) }, {}]) assert.equal((await speak(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
	assert.deepEqual(asked, ["IV Rank 是 85%。", "这句会失败。"]);
});

test("网页问简报官：被清屏藏起来的那句话（页面上点「显示之前的」还能看到）也能问，照样按它的任务找简报官", async (t) => {
	const w = await world(t);
	const userLine = w.host.say("DIA 贵不贵？");
	await until(() => w.host.kernel.conversationRoutes()[userLine]?.ticketId, "开了任务");
	w.host.clearConversation();
	assert.ok(!w.host.kernel.conversation().some((l) => l.id === userLine), "已经被清屏藏起来");
	assert.equal((await w.ask({ question: "这句话呢？", lineId: userLine })).status, 200);
	await until(() => answered(w.host.snapshot().assistant).length === 1 || undefined, "答了");
	assert.match(w.systems.at(-1)!, /期权研究组简报官/);
});
