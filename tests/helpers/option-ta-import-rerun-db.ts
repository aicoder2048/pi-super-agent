/**
 * Rebuilds the option-ta `import` rerun fixtures (`*-rerun/data.db`) through the host's own data store: each keeps its
 * accounts and its non-export history, then gets what one import of the case's CSV would have written. A rerun case then
 * asserts that importing the same file again writes nothing. Run after changing the importer's output:
 *   node --import ./src/pi-runtime.mjs tests/helpers/option-ta-import-rerun-db.ts
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importBrokerCsv } from "../../docs/modules/examples/option-ta/broker-import.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import type { ModuleName } from "../../src/modules/manifest.ts";
import type { Json } from "../../src/modules/protocol.ts";
import { scanPackage } from "../../src/modules/validate.ts";
import { PACKAGE } from "./option-ta-ledger-db.ts";

const TOOL = join(PACKAGE, "tools/import");
const RERUNS = ["jpm-rerun", "etrade-rerun", "jpm-split-rerun", "jpm-partial-enrich-rerun"];
type Row = Record<string, Json>;

/** Stored rows reduced to the collection's declared fields: drops host bookkeeping, nulls, and the extra columns (`id`, `broker`, `web_last4`) the first hand-made fixtures carried. */
function rows(db: string, table: string): Row[] {
	const declared = Object.keys(JSON.parse(readFileSync(join(PACKAGE, "data", table, "collection.json"), "utf8")).fields);
	const sql = new DatabaseSync(db, { readOnly: true });
	try {
		const has = (sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) !== undefined;
		if (!has) return [];
		return (sql.prepare(`SELECT * FROM "${table}" ORDER BY _id`).all() as Row[]).map((r) =>
			Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== null && declared.includes(k))));
	} finally {
		sql.close();
	}
}

const scan = scanPackage(PACKAGE, { runCases: false });
if (!scan.ok) throw new Error(`option-ta does not scan: ${JSON.stringify(scan.problems)}`);
const cases: { name: string; input: { broker: "jpm" | "etrade"; csv: string; import_date: string } }[] = JSON.parse(readFileSync(join(TOOL, "cases.json"), "utf8"));
const module = "option-ta" as ModuleName;
for (const name of RERUNS) {
	const target = join(TOOL, "fixtures", name, "data.db");
	const input = cases.find((c) => c.name === name)!.input;
	const accounts = rows(target, "accounts");
	const base = rows(target, "fills").filter((r) => r["source"] !== "broker-export");
	const state = mkdtempSync(join(tmpdir(), "psa-option-ta-import-"));
	try {
		const data = instanceData(state);
		if (accounts.length) data.write(module, scan.scan.components, "accounts", accounts, "虚构夹具", "fixture");
		if (base.length) data.write(module, scan.scan.components, "fills", base, "虚构夹具", "fixture");
		const stored = base.length ? data.query(module, scan.scan.components, "fills", { limit: 500 }, "fixture").rows : [];
		const out = importBrokerCsv({ ...input, fills: stored, accounts });
		if (out.fills.length) data.write(module, scan.scan.components, "fills", out.fills as Row[], `${name} 首次导入`, "fixture");
		copyFileSync(join(data.dir(module), "data.db"), target);
		console.log(`${name}: ${accounts.length} accounts, ${base.length} history rows + ${out.fills.length} imported`);
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
}
