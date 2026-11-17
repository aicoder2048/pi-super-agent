/**
 * Builds the option-ta `record` and `ledger` fixture data.db from its seed through the host's own data store, so the tables
 * have the columns the host would make. Rewrite the committed copy after changing the seed or the collections:
 *   node --import ./src/pi-runtime.mjs tests/helpers/option-ta-ledger-db.ts
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { instanceData } from "../../src/modules/instance-data.ts";
import type { ModuleName } from "../../src/modules/manifest.ts";
import type { Json } from "../../src/modules/protocol.ts";
import { scanPackage } from "../../src/modules/validate.ts";

export const PACKAGE = fileURLToPath(new URL("../../docs/modules/examples/option-ta/", import.meta.url));
export const FIXTURE = join(PACKAGE, "tools/ledger/fixtures");
export const SEED: Record<string, Json[]> = JSON.parse(readFileSync(join(FIXTURE, "seed.json"), "utf8"));

/** Returns the path of a fresh data.db; the caller removes its folder. */
export function buildLedgerDb(): { db: string; drop(): void } {
	const scan = scanPackage(PACKAGE, { runCases: false });
	if (!scan.ok) throw new Error(`option-ta does not scan: ${JSON.stringify(scan.problems)}`);
	const state = mkdtempSync(join(tmpdir(), "psa-option-ta-db-"));
	const data = instanceData(state);
	const module = "option-ta" as ModuleName;
	for (const [collection, rows] of Object.entries(SEED)) data.write(module, scan.scan.components, collection, rows, "虚构夹具", "fixture");
	return { db: join(data.dir(module), "data.db"), drop: () => rmSync(state, { recursive: true, force: true }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const built = buildLedgerDb();
	copyFileSync(built.db, join(FIXTURE, "data/data.db"));
	built.drop();
	console.log(`wrote ${join(FIXTURE, "data/data.db")}`);
}
