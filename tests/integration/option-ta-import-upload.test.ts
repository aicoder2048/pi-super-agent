import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { importBrokerCsv } from "../../docs/modules/examples/option-ta/broker-import.ts";
import { fetchUpload, saveUpload } from "../../src/host/uploads.ts";
import { createGateway } from "../../src/modules/gateway.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import { moduleDataDir } from "../../src/modules/knowledge.ts";
import { ModuleStore } from "../../src/modules/live.ts";
import type { ComponentName, Digest, ModuleName } from "../../src/modules/manifest.ts";
import type { Json, WorkerCaller } from "../../src/modules/protocol.ts";
import { scanPackage } from "../../src/modules/validate.ts";
import { PACKAGE } from "../helpers/option-ta-ledger-db.ts";

/** The samples and their accounts are made up. */
const FIXTURES = join(PACKAGE, "tools/import/fixtures");
const MODULE = "option-ta" as ModuleName;
const accounts = JSON.parse(readFileSync(join(FIXTURES, "account-aliases.sample.json"), "utf8")).accounts.map((a: Record<string, unknown>) => ({ account_ref: a.account_ref, aliases: JSON.stringify(a.aliases) }));

function world(t: TestContext) {
	const state = mkdtempSync(join(tmpdir(), "psa-option-ta-upload-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	const scan = scanPackage(PACKAGE, { runCases: false, folder: MODULE });
	assert.ok(scan.ok, JSON.stringify(scan));
	const store = new ModuleStore(join(state, "module-store"));
	assert.ok(store.keep(MODULE, scan.scan.digest, PACKAGE));
	const digest = scan.scan.digest as Digest;
	const data = instanceData(state);
	data.write(MODULE, scan.scan.components, "accounts", accounts, "虚构样例", "test");
	const gateway = createGateway({
		copyDir: (module, d) => store.dirOf(module, d),
		serving: () => digest,
		dataDir: (module) => moduleDataDir(state, module),
		rows: data,
		toolCalls: data,
		secret: () => undefined,
		log: () => {},
		fetch: { "upload.file": async (_m, _c, input, dir) => fetchUpload(state, input, dir) },
	});
	const caller: WorkerCaller = { who: "worker", ticket: "tkt_1", pin: { module: MODULE, digest }, basis: "request", member: null, heardOthers: false } as WorkerCaller;
	const importTool = (input: Json) => gateway.call(caller, { kind: "tool", name: "import" as ComponentName, input });
	return { state, importTool };
}

for (const broker of ["jpm", "etrade"] as const) {
	test(`${broker} 导出经网页上传后，导入工具凭上传编号读到同一份文件，结果和直接给文字一样`, async (t) => {
		const { state, importTool } = world(t);
		const bytes = readFileSync(join(FIXTURES, `${broker}-sample.csv`));
		const up = saveUpload(state, { name: `${broker}-export.csv`, type: "text/csv", bytes, at: 1 });
		const reply = await importTool({ broker, upload_id: up.id, import_date: "2026-11-02" });
		assert.ok(reply.ok, JSON.stringify(reply));
		const expected = importBrokerCsv({ broker, csv: bytes.toString("utf8"), import_date: "2026-11-02", fills: [], accounts: accounts.map((a: Record<string, unknown>, i: number) => ({ id: String(i + 1), fields: a })) });
		const output = reply.output as Record<string, unknown>;
		assert.deepEqual(output["fills"], expected.fills);
		assert.ok(expected.fills.length > 0);
		assert.deepEqual(output["file"], { name: `${broker}-export.csv`, size: bytes.length });
	});
}

test("上传编号不对：导入工具不跑，拒绝并说请使用者在网页上重新上传", async (t) => {
	const { importTool } = world(t);
	const reply = await importTool({ broker: "jpm", upload_id: "up-000000000000", import_date: "2026-11-02" });
	assert.ok(!reply.ok);
	assert.match(JSON.stringify(reply.refusal), /没有上传编号.*重新上传/);
});
