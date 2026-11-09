import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostOptions, modelSelectors } from "../src/host/wiring.ts";
import { Host } from "../src/host/host.ts";
import { Modules } from "../src/modules.ts";
import { until } from "./helpers/fakes.ts";

const config = {
	models: {
		router: { provider: "openai-codex", id: "gpt-6.1-terra" },
		worker: { provider: "openai-codex", id: "gpt-6.1-sol" },
		fallback: { provider: "deepseek", id: "deepseek-flash" },
	},
	probePrimaryMinutes: 15,
};

test("Router 和 Worker 各有一个选择器，主模型分别是各自的配置", () => {
	const { router, worker } = modelSelectors(config, { now: () => 0 });
	assert.deepEqual(router.current().model, config.models.router);
	assert.deepEqual(worker.current().model, config.models.worker);
});

test("Pi 自己的重试用完后，第一次最终的限流错误就切到回退模型", () => {
	const { router } = modelSelectors(config, { now: () => 0 });
	assert.deepEqual(router.onError("429 Too Many Requests"), { switched: true, notify: true });
	assert.deepEqual(router.current().model, config.models.fallback);
});

test("试探主模型的间隔取配置里的分钟数", () => {
	const now = { t: 0 };
	const { worker } = modelSelectors({ ...config, probePrimaryMinutes: 5 }, { now: () => now.t });
	worker.onError("429");
	now.t = 4 * 60_000;
	assert.equal(worker.forTurn().probing, false);
	now.t = 5 * 60_000;
	assert.equal(worker.forTurn().probing, true);
});

test("一个选择器回退不影响另一个", () => {
	const { router, worker } = modelSelectors(config, { now: () => 0 });
	worker.onError("429");
	assert.equal(router.current().fellBack, false);
});


async function fauxRuntime(failOn: (id: string) => boolean) {
	const faux = fauxProvider({ models: [{ id: "router" }, { id: "worker" }, { id: "fallback" }] });
	const reply = (_c: unknown, _o: unknown, _s: unknown, model: { id: string }) =>
		failOn(model.id) ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit reached" }) : fauxAssistantMessage(fauxText("ok"));
	faux.setResponses(Array.from({ length: 50 }, () => reply));
	const modelRuntime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "psa-auth-")), "a.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	return { modelRuntime, provider: faux.getModel().provider };
}

function hostConfig(provider: string, fallbackId = "fallback") {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-wire-"));
	return {
		stateDir, kernel: {}, bgMaxMinutes: 120, fallbackDailyTokens: 1000, retryAttempts: 0, probePrimaryMinutes: 15,
		watchdog: { intervalMinutes: 3, stuckMinutes: 30 }, modulesDirs: [],
		models: { router: { provider, id: "router" }, worker: { provider, id: "worker" }, fallback: { provider, id: fallbackId } },
	};
}

test("入口：配置里的回退模型不存在时，启动前就报错", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	assert.throws(
		() => createHostOptions({ config: hostConfig(provider, "missing"), modules: Modules.load([]), modelRuntime, log: () => {} }),
		/找不到模型 .*missing/,
	);
});

test("入口：按真实接线启动的宿主，Router 遇到最终的限流错误会切到回退模型", async (t) => {
	const { modelRuntime, provider } = await fauxRuntime((id) => id === "router");
	const options = createHostOptions({ config: hostConfig(provider), modules: Modules.load([]), modelRuntime, log: () => {} });
	const host = await Host.start(options);
	t.after(() => host.stop());
	host.say("你好");
	await until(() => (host.router as any).session.model?.id === "fallback", "Router 切到回退模型", 5000);
});
