import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MemberRun } from "../src/host/dispatch.ts";
import type { Member } from "../src/teams.ts";
import { domainsOf, ids, startHost, until, type Brain, type FakeWorker } from "./helpers/fakes.ts";

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
