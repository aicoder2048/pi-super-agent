import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { instanceData } from "../../src/modules/instance-data.ts";
import type { ModuleName } from "../../src/modules/manifest.ts";

const mainSaveFeedState = "INSERT INTO _feeds VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET cursor = COALESCE(excluded.cursor, cursor), last_run_at = COALESCE(excluded.last_run_at, last_run_at)";

test("新代码记过连接器游标的 data.db，回退到 main 的调度器后仍能按三个值写 _feeds", () => {
	const data = instanceData(mkdtempSync(join(tmpdir(), "psa-rollback-")));
	const module = "mail" as ModuleName;
	data.saveFeedState(module, "inbox", { cursor: "c1", connectorCursor: '{"historyId":"42"}', lastRunAt: 1 });
	data.saveFeedState(module, "other", { cursor: "c2", lastRunAt: 1 });

	const db = new DatabaseSync(join(data.dir(module), "data.db"));
	try {
		db.prepare(mainSaveFeedState).run("inbox", "c3", 2);
		db.prepare(mainSaveFeedState).run("fresh", null, 3);
		assert.deepEqual({ ...db.prepare("SELECT cursor, last_run_at FROM _feeds WHERE source = ?").get("inbox") }, { cursor: "c3", last_run_at: 2 });
	} finally {
		db.close();
	}
	assert.deepEqual(data.feedState(module, "inbox"), { cursor: "c3", connectorCursor: '{"historyId":"42"}', lastRunAt: 2 });
});
