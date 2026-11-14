import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { instanceData } from "../../src/modules/instance-data.ts";
import type { ModuleName } from "../../src/modules/manifest.ts";

const holdLock = `
const { DatabaseSync } = require("node:sqlite");
const { workerData } = require("node:worker_threads");
const db = new DatabaseSync(workerData.path);
db.exec("BEGIN EXCLUSIVE");
const flag = new Int32Array(workerData.flag);
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
db.exec("COMMIT");
db.close();
`;

test("另一个连接正短暂锁着 data.db 时，模块数据等它放开再写，不报 database is locked", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-busy-"));
	const data = instanceData(stateDir);
	const module = "busy-mod" as ModuleName;
	data.saveFeedState(module, "quotes", { cursor: "a", lastRunAt: 1 });
	const flag = new SharedArrayBuffer(4);
	const worker = new Worker(holdLock, { eval: true, workerData: { path: join(data.dir(module), "data.db"), flag } });
	Atomics.wait(new Int32Array(flag), 0, 0, 5000);
	data.saveFeedState(module, "quotes", { cursor: "b", lastRunAt: 2 });
	await new Promise((r) => worker.once("exit", r));
	assert.deepEqual(data.feedState(module, "quotes"), { cursor: "b", lastRunAt: 2 });
});
