import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importBrokerCsv } from "../../docs/modules/examples/option-ta/broker-import.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import type { ModuleName } from "../../src/modules/manifest.ts";
import { scanPackage } from "../../src/modules/validate.ts";
import { PACKAGE } from "../helpers/option-ta-ledger-db.ts";

/** The samples and their accounts are made up. */
const FIXTURES = join(PACKAGE, "tools/import/fixtures");
const accounts = JSON.parse(readFileSync(join(FIXTURES, "account-aliases.sample.json"), "utf8")).accounts
	.map((a: Record<string, unknown>) => ({ ...a, aliases: JSON.stringify(a.aliases) }));

for (const broker of ["jpm", "etrade"] as const) {
	test(`${broker} 导入预览的行照原样用 data 写进 fills 能写进去；用库里的行再预览一次，一行也不新增`, () => {
		const scan = scanPackage(PACKAGE, { runCases: false });
		assert.ok(scan.ok);
		const state = mkdtempSync(join(tmpdir(), "psa-option-ta-import-"));
		try {
			const data = instanceData(state);
			const module = "option-ta" as ModuleName;
			const csv = readFileSync(join(FIXTURES, `${broker}-sample.csv`), "utf8");
			const first = importBrokerCsv({ broker, csv, import_date: "2026-11-17", fills: [], accounts });
			assert.ok(first.fills.length > 0);
			data.write(module, scan.scan.components, "fills", first.fills, `${broker}-sample.csv`, "fixture");
			const stored = data.query(module, scan.scan.components, "fills", { limit: 500 }, "fixture").rows;
			assert.equal(stored.length, first.fills.length);
			const again = importBrokerCsv({ broker, csv, import_date: "2026-11-17", fills: stored, accounts });
			assert.deepEqual(again.fills, []);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
}
