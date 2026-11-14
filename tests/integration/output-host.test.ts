import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { MemberRun } from "../../src/host/dispatch.ts";
import { ModelSelector } from "../../src/model-selector.ts";
import type { Member } from "../../src/teams.ts";
import { domainsOf, ids, startHost, until, type Brain, type FakeWorker } from "../helpers/fakes.ts";

const openAs = (basis: "request" | "inference"): Brain => (cards) =>
	cards.filter((c) => c.startsWith("[对话]")).map((card) => ({ name: "route", args: { decisions: [{ kind: "open_ticket", basis, triggerId: ids(card, "trg"), title: "做扩展", brief: "做一个讲笑话的扩展" }] } }));

async function helperOf(t: test.TestContext, basis: "request" | "inference", outputDir?: string) {
	let helper: FakeWorker | undefined;
	const started = await startHost(openAs(basis), (w) => void (helper ??= w), outputDir ? { outputDir } : {});
	t.after(() => started.host.stop());
	started.host.say("做一个讲笑话的扩展");
	await until(() => helper !== undefined, "助手开始工作");
	return { ...started, helper: helper! };
}

test("宿主启动时建好成品目录；助手用 new_app 要到 apps/ 下的新目录", async (t) => {
	const outputDir = join(mkdtempSync(join(tmpdir(), "psa-made-")), "made");
	const { helper } = await helperOf(t, "request", outputDir);
	assert.ok(existsSync(join(outputDir, "README.md")), "启动时写了 README.md");
	const app = helper.request("worker.new_app", { short: "joke" }) as { app: string; dir: string; isNew: boolean };
	assert.deepEqual(app, { app: "app-001-joke", dir: join(outputDir, "apps", "app-001-joke"), isNew: true });
	assert.ok(existsSync(app.dir));
});

test("推断开的任务只读，助手调 new_app 被拒绝", async (t) => {
	const { helper } = await helperOf(t, "inference");
	assert.throws(() => helper.request("worker.new_app", { short: "joke" }), /推断/);
});

test("能写文件的助手拿到写着成品目录的规则；推断开的任务的助手没有", async (t) => {
	const outputDir = join(mkdtempSync(join(tmpdir(), "psa-made-")), "made");
	const request = await helperOf(t, "request", outputDir);
	assert.match(request.helper.spec.outputRule ?? "", new RegExp(`${outputDir}/apps/`));
	assert.match(request.helper.spec.outputRule ?? "", /new_app/);
	const inference = await helperOf(t, "inference");
	assert.equal(inference.helper.spec.outputRule, undefined);
});

const member = (name: string, tools: string[]): Member => ({ name, title: name, description: name, tools, skills: [], model: undefined, prompt: name, file: `/agents/${name}.md` });

test("派活时，能写文件或跑命令的成员拿到成员版的规则；只读的成员没有", async (t) => {
	const crew = [member("coder", ["read", "bash"]), member("reader", ["read", "web_get"])];
	const runs: MemberRun[] = [];
	let helper: FakeWorker | undefined;
	const started = await startHost(
		(cards) => cards.filter((c) => c.startsWith("[对话]")).map((card) => ({ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "做扩展", brief: "做扩展", domain: "dev" }] } })),
		(w) => void (helper ??= w),
		{ domains: domainsOf({ dev: { team: "开发队", crew } }), dispatch: { timeoutMs: 5000, codingTimeoutMs: 5000, stallMs: 5000, maxConcurrent: 4 } },
	);
	t.after(() => started.host.stop());
	started.spawner.runner = async (run) => {
		runs.push(run);
		return "好";
	};
	started.host.say("做个扩展");
	await until(() => helper !== undefined, "助手开始工作");
	await helper!.request("worker.dispatch", { agent: "coder", task: "写", callId: "c1" });
	await helper!.request("worker.dispatch", { agent: "reader", task: "读", callId: "c2" });
	const ruleOf = (name: string) => runs.find((r) => r.member.name === name)!.outputRule;
	assert.match(ruleOf("coder") ?? "", /请领队给/);
	assert.doesNotMatch(ruleOf("coder") ?? "", /new_app/);
	assert.equal(ruleOf("reader"), undefined);
});

function writeHelperSession(host: { kernel: { getTicket(id: string): { workerSessionId: string } | undefined } }, stateDir: string, ticketId: string, cwd: string, paths: string[]) {
	const file = join(stateDir, "sessions", "workers", `2026-11-11T00-00-00_${host.kernel.getTicket(ticketId)!.workerSessionId}.jsonl`);
	mkdirSync(dirname(file), { recursive: true });
	const lines = [{ type: "session", cwd }, ...paths.map((path) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path, content: "x" } }] } }))];
	writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

const outsidePaths = (r: { outsideWrites: { kind: string; path?: string }[] }) => r.outsideWrites.map((w) => w.path);

test("会通知 Router 的汇报带上宿主检查的结果；进度汇报不检查，那段时间的写入留到下一条会通知的汇报", async (t) => {
	const { host, helper } = await helperOf(t, "request");
	const ticketId = helper.spec.ticketId;
	const stateDir = dirname(dirname(helper.spec.workdir));
	writeHelperSession(host, stateDir, ticketId, helper.spec.workdir, ["/psa-not-a-repo/a.ts", "draft.md"]);
	helper.report({ status: "progress", summary: "做着" });
	helper.report({ status: "blocked", summary: "卡住了" });
	writeHelperSession(host, stateDir, ticketId, helper.spec.workdir, ["/psa-not-a-repo/a.ts", "draft.md", "/psa-not-a-repo/b.ts"]);
	helper.report({ status: "ready", summary: "做好了" });
	const found = host.kernel.read(ticketId);
	assert.ok(found?.type === "ticket");
	assert.deepEqual(found.recentReports.map((r) => [r.summary, outsidePaths(r)]), [
		["做好了", ["/psa-not-a-repo/b.ts"]],
		["卡住了", ["/psa-not-a-repo/a.ts"]],
		["做着", []],
	]);
});

test("进程中途退出、模型出错时宿主替它写的 failed 汇报，也带上外写", async (t) => {
	for (const end of ["crash", "error"] as const) {
		const { host, helper } = await helperOf(t, "request");
		const ticketId = helper.spec.ticketId;
		writeHelperSession(host, dirname(dirname(helper.spec.workdir)), ticketId, helper.spec.workdir, [`/psa-not-a-repo/${end}.ts`]);
		if (end === "crash") helper.crash();
		else helper.settle("500 服务器出错");
		await until(() => host.kernel.getTicket(ticketId)?.latestReport?.status === "failed", `${end} 后有 failed 汇报`);
		assert.deepEqual(outsidePaths(host.kernel.getTicket(ticketId)!.latestReport!), [`/psa-not-a-repo/${end}.ts`], end);
	}
});

test("回退模型用量到上限时宿主写的受阻汇报，也带上外写", async (t) => {
	const selector = new ModelSelector({ primary: { provider: "openai-codex", id: "p" }, fallback: { provider: "deepseek", id: "f" }, probeEveryMs: 15 * 60_000, clock: { now: () => Date.now() } });
	selector.onError("429");
	const started = await startHost(openAs("request"), (w) => {
		writeHelperSession(started.host, dirname(dirname(w.spec.workdir)), w.spec.ticketId, w.spec.workdir, ["/psa-not-a-repo/capped.ts"]);
		started.host.kernel.recordUsage(w.spec.ticketId, { provider: "deepseek", tokensIn: 150, tokensOut: 0 });
		w.settle();
	}, { workerModels: { selector, fallbackDailyTokens: 100 } });
	t.after(() => started.host.stop());
	started.host.say("做一个讲笑话的扩展");
	await until(() => started.host.kernel.listTickets()[0]?.stage === "blocked_or_failed", "上限受阻");
	const latest = started.host.kernel.getTicket(started.host.kernel.listTickets()[0].id)!.latestReport!;
	assert.match(latest.summary, /上限/);
	assert.deepEqual(outsidePaths(latest), ["/psa-not-a-repo/capped.ts"]);
});
