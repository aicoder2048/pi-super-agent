import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ids, startHost, until, type Brain, type FakeWorker } from "./helpers/fakes.ts";

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
