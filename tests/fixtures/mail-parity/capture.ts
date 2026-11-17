/**
 * Writes each mail inbox fixture as it was on main 5c99224 (`given`) beside what the handler then returned for it (`expected`),
 * so the connector version can be held to it.
 * It ran once, before the handler stopped fetching for itself: `node --import ./src/pi-runtime.mjs tests/fixtures/mail-parity/capture.ts`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModuleCode } from "../../../src/modules/run-code.ts";

export const PARITY_NOW = "2026-11-16T12:00:00.000Z";
const PKG = join(import.meta.dirname, "../../../docs/modules/examples/mail");
const FIXTURES = join(PKG, "feeds/inbox/fixtures");
const feed = JSON.parse(readFileSync(join(PKG, "feeds/inbox/feed.json"), "utf8"));
const dataDir = mkdtempSync(join(tmpdir(), "psa-parity-"));
for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))) {
	const fixture = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
	const input = { items: [], watchedKeys: [], now: PARITY_NOW, cursor: null, ...fixture.input, settings: { ...feed.settings, ...fixture.input.settings } };
	const secrets = Object.fromEntries(feed.secrets.map((name: string) => [name, "fixture"]));
	const reply = runModuleCode({ packageDir: PKG, component: "feeds/inbox", dataDir }, "index.ts", input, secrets, { responses: fixture.responses });
	if (!reply.ok) throw new Error(`${file}: ${reply.note}`);
	const { records = [], notices = [], problem, cursor } = reply.output as Record<string, unknown>;
	const historyId = typeof cursor === "string" ? JSON.parse(cursor).historyId : null;
	writeFileSync(join(import.meta.dirname, file), `${JSON.stringify({ given: fixture, expected: { records, notices, problem: problem ?? null, historyId } }, null, 2)}\n`);
}
rmSync(dataDir, { recursive: true, force: true });
