import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/host/config.ts";
import { formatModelRef } from "../src/models.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const runbook = readFileSync(join(repo, "docs/deploy/home-mac.md"), "utf8");

test("every just recipe the home-Mac runbook names exists in the justfile", () => {
	const recipes = new Set(spawnSync("just", ["--summary"], { cwd: repo, encoding: "utf8" }).stdout.trim().split(/\s+/));
	const named = [...new Set([...runbook.matchAll(/\bjust ([a-z][a-z0-9-]*)/g)].map((m) => m[1]!))];
	assert.ok(named.includes("service-install"), "the runbook names just service-install");
	assert.deepEqual(named.filter((name) => !recipes.has(name)), []);
});

test("the runbook's config.json loads, and each field it sets changes what the host reads", () => {
	const blocks = [...runbook.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!.replace(/<([a-z-]+)>/g, "$1"));
	assert.ok(blocks.length > 0, "the runbook shows a config.json");
	const defaults = loadConfig(mkdtempSync(join(tmpdir(), "psa-runbook-")));
	for (const block of blocks) {
		const raw = JSON.parse(block) as Record<string, unknown>;
		const stateDir = mkdtempSync(join(tmpdir(), "psa-runbook-"));
		writeFileSync(join(stateDir, "config.json"), block);
		if (typeof raw.secretsFile === "string") writeFileSync(join(stateDir, raw.secretsFile), "MASSIVE_API_KEY=fake\n");
		const loaded = loadConfig(stateDir) as unknown as Record<string, unknown>;
		for (const [key, value] of Object.entries(raw)) {
			if (key === "models") {
				for (const [role, model] of Object.entries(value as Record<string, string>)) {
					const ref = (loaded.models as Record<string, Parameters<typeof formatModelRef>[0] | undefined>)[role];
					assert.equal(ref && formatModelRef(ref), model, `models.${role}`);
					assert.ok(model.startsWith("openai-codex/"), `models.${role} is the Codex subscription, not pay-per-use`);
				}
			} else {
				assert.notDeepEqual(loaded[key], (defaults as unknown as Record<string, unknown>)[key], `${key} is a field the host reads`);
			}
		}
	}
});

test("the runbook carries no real machine names, user paths, emails or keys", () => {
	assert.deepEqual(runbook.match(/[\w-]+(\.[\w-]+)*\.ts\.net/g), null, "tailnet names are placeholders");
	assert.deepEqual(runbook.match(/\/Users\/[A-Za-z]/g), null, "home paths use ~ or a placeholder");
	assert.deepEqual(runbook.match(/[\w.+-]+@[\w-]+\.[\w.]+/g), null, "no email addresses");
	assert.deepEqual(runbook.match(/[A-Za-z0-9_-]{32,}/g), null, "no key- or token-like strings");
});
