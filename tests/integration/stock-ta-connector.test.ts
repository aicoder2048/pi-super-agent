import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { startLiveModules, type LiveModules } from "../../src/host/live-modules.ts";
import { createHostOptions } from "../../src/host/wiring.ts";
import { openStore, setModuleSwitch } from "../../src/kernel/store.ts";
import { Modules } from "../../src/modules.ts";
import type { ComponentName, Digest, ModuleName } from "../../src/modules/manifest.ts";
import type { WorkerCaller } from "../../src/modules/protocol.ts";
import { until } from "../helpers/fakes.ts";
import { fakeMassive, SNAPSHOT, snapshotBody, stockTaCopy, tickerRow } from "../helpers/market.ts";

async function tempHost(t: TestContext) {
	const massive = await fakeMassive(t);
	massive.answer({ status: 200, body: snapshotBody([tickerRow("NVDA", 101.5, 100, Date.now() - 20 * 60_000)]) });
	const stateDir = mkdtempSync(join(tmpdir(), "psa-ta-connector-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const root = join(stateDir, "modules");
	const stockTa = stockTaCopy(t, massive.base);
	const pkg = join(root, "stock-ta");
	mkdirSync(root, { recursive: true });
	cpSync(stockTa, pkg, { recursive: true });
	// The quote cases replay replies by address, and this copy points Massive at the fake server.
	const cases = join(pkg, "tools/quote/cases.json");
	writeFileSync(cases, readFileSync(cases, "utf8").replaceAll("https://api.massive.com", massive.base));
	const reader = join(root, "reader");
	mkdirSync(reader);
	writeFileSync(join(reader, "module.json"), JSON.stringify({ schema: 1, name: "reader", version: "0.1.0", description: "只用 stock-ta 的报价", uses: ["stock-ta/tools/quote", "stock-ta/tools/structure"] }));
	mkdirSync(join(stateDir, "modules-data/stock-ta"), { recursive: true });
	writeFileSync(join(stateDir, "modules-data/stock-ta/.env"), "POLYGON_API_KEY=sk-test\n");
	const db = openStore(join(stateDir, "state.db"));
	for (const name of ["stock-ta", "reader"]) setModuleSwitch(db, name, true);
	const discovered = Modules.load([root]);
	const modules = startLiveModules({ db, stateDir, roots: [root], discovered, configSwitches: {}, log: () => {} });
	t.after(() => {
		modules.stop();
		db.close();
	});
	const card = (name: string) => modules.cards().find((c) => c.name === name)!;
	await until(() => card("stock-ta").label === "运行中" && card("reader").label === "运行中", "stock-ta 和 reader 运行中", 60_000).catch((error) => {
		throw new Error(`${error.message}：${JSON.stringify(modules.cards().map((c) => [c.name, c.label, c.reason, c.problems]))}`);
	});
	const faux = fauxProvider({ models: [{ id: "router" }, { id: "worker" }, { id: "fallback" }] });
	const modelRuntime = await ModelRuntime.create({ authPath: join(stateDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const provider = faux.getModel().provider;
	const config = {
		stateDir, kernel: {}, bgMaxMinutes: 120, fallbackDailyTokens: 1000, dispatchTimeoutSeconds: 60, dispatchCodingTimeoutSeconds: 600, dispatchStallSeconds: 45, maxConcurrentExperts: 2, retryAttempts: 0, probePrimaryMinutes: 15,
		heartbeatSeconds: 30, watchdog: { intervalMinutes: 3, stuckMinutes: 30, staleSeconds: 120 }, modulesDirs: [root], webPort: 0, webHosts: [], sources: {}, ocr: { engine: "off" as const },
		models: { router: { provider, id: "router" }, worker: { provider, id: "worker" }, fallback: { provider, id: "fallback" } },
	};
	const gateway = createHostOptions({ config, modules, modelRuntime, log: () => {} }).gateway!;
	const serving = (name: string) => modules.live.current().book.get(name)!.digest as Digest;
	const caller = (module: string): WorkerCaller => ({ who: "worker", ticket: `tkt_${module}`, pin: { module: module as ModuleName, digest: serving(module) }, basis: "request", member: null, heardOthers: false });
	return { modules, card, gateway, caller, pkg };
}

const quote = (name: string) => ({ kind: "tool" as const, name: name as ComponentName, input: { symbols: "NVDA" } });

test("临时宿主：reader 调过 stock-ta/tools/quote 以后，stock-ta 的模块卡「谁在用」列出 reader；stock-ta 自己的调用不列", { timeout: 120_000 }, async (t) => {
	const { card, gateway, caller } = await tempHost(t);
	assert.deepEqual(card("stock-ta").usedBy, []);
	const own = await gateway.call(caller("stock-ta"), quote("quote"));
	assert.equal(own.ok, true, JSON.stringify(own));
	assert.deepEqual(card("stock-ta").usedBy, [], "stock-ta 自己的调用不列");
	const external = await gateway.call(caller("reader"), quote("stock-ta/tools/quote"));
	assert.deepEqual(external, own, "reader 拿到的和 stock-ta 自己调用一样");
	assert.deepEqual(card("stock-ta").usedBy, ["reader"]);
	assert.deepEqual(card("reader").usedBy, []);
});

async function swapTo(modules: LiveModules, card: (name: string) => ReturnType<LiveModules["cards"]>[number], change: () => void): Promise<string[]> {
	const before = card("stock-ta").version.digest;
	change();
	await until(() => card("stock-ta").label === "运行中" && card("stock-ta").version.digest !== before, "stock-ta 换上新版本", 60_000);
	return card("stock-ta").notices;
}

test("临时宿主：stock-ta 换成改了开放工具输出字段的一版，检查以后模块卡提醒「这个工具开放给了别的模块」；没改开放工具的一版没有", { timeout: 180_000 }, async (t) => {
	const { modules, card, pkg } = await tempHost(t);
	const skill = join(pkg, "skills/quick-quote/SKILL.md");
	assert.deepEqual(await swapTo(modules, card, () => writeFileSync(skill, `${readFileSync(skill, "utf8")}\n`)), []);
	const toolJson = join(pkg, "tools/quote/tool.json");
	const descriptor = JSON.parse(readFileSync(toolJson, "utf8"));
	delete descriptor.output.missing;
	assert.deepEqual(await swapTo(modules, card, () => writeFileSync(toolJson, JSON.stringify(descriptor))), [`tools/quote/tool.json: 这个工具开放给了别的模块，output 少了字段 "missing"，用它的模块可能会坏`]);
});
