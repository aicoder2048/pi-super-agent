import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, initialRecord, settle, transition } from "../src/modules/lifecycle.ts";
import type { Effect, ModuleEvent, ModuleRecord, Version } from "../src/modules/lifecycle.ts";
import type { Digest, ModuleName } from "../src/modules/manifest.ts";

const version = (digest: string): Version => ({ digest: digest as Digest, label: digest });
const [V1, V2, BAD] = [version("v1"), version("v2"), version("bad")];
const found = (found: Version): ModuleEvent => ({ type: "package-found", version: found });

function play(events: readonly ModuleEvent[], start: ModuleRecord = initialRecord("health" as ModuleName)): ModuleRecord {
	return events.reduce((record, event) => transition(record, event).record, start);
}

/** The driver's loop: runs the outbox in order and feeds each result back. `BAD` fails its check. Returns what is published at the end. */
function drive(record: ModuleRecord, published: Version | null = null): { record: ModuleRecord; published: Version | null; ran: string[] } {
	const ran: string[] = [];
	for (let effect = record.pending[0]; effect !== undefined; effect = record.pending[0]) {
		ran.push(effect.do);
		record = settle(record);
		if (effect.do === "publish") published = effect.serve;
		if (effect.do === "check") record = play([{ type: "checked", digest: effect.version.digest, problems: effect.version === BAD ? [{ where: "module.json", reason: "broken" }] : [] }], record);
		if (effect.do === "migrate") record = play([{ type: "migrated", attempt: effect.attempt }], record);
	}
	return { record, published, ran };
}

const serving = (): ModuleRecord => drive(play([found(V1), { type: "enable" }])).record;

test("switching a module on is all it takes: it is checked, migrated and published with no further word from the user", () => {
	const run = drive(play([found(V1), { type: "enable" }]));
	assert.deepEqual(run.ran, ["check", "migrate", "publish"]);
	assert.deepEqual(run.published, V1);
});

test("a saved edit goes live by itself, and the old version serves until it does", () => {
	const edited = play([found(V2)], serving());
	assert.deepEqual(edited.state, { at: "active", serving: V1, update: { at: "checking", version: V2 } });
	assert.deepEqual(drive(edited, V1).record.state, { at: "active", serving: V2, update: null });
});

test("an edit that fails the check leaves the old version serving and says why", () => {
	const run = drive(play([found(BAD)], serving()), V1);
	assert.deepEqual(run.published, V1);
	assert.deepEqual(run.record.state, { at: "active", serving: V1, update: { at: "invalid", version: BAD, problems: [{ where: "module.json", reason: "broken" }] } });
});

test("an update whose migration fails leaves the old version serving", () => {
	const migrating = play([found(V2), { type: "checked", digest: V2.digest, problems: [] }], serving());
	const failed = play([{ type: "migration-failed", attempt: migrating.attempts, reason: "disk full" }], migrating);
	assert.equal(failed.state.at === "active" && failed.state.serving === V1 && failed.state.update?.at, "invalid");
});

test("a disable while the package is away keeps the module off when the folder returns", () => {
	assert.equal(play([{ type: "package-gone" }, { type: "disable" }, found(V1)], serving()).state.at, "disabled");
	assert.equal(play([{ type: "package-gone" }, found(V1)], serving()).state.at, "staging");
});

test("a crash loses nothing: the persisted record carries what is left to do, in order", () => {
	const record = play([found(V1), { type: "enable" }, { type: "disable" }, { type: "purge" }]);
	assert.deepEqual(record.pending.map((effect: Effect) => effect.do), ["check", "purge-data"]);
	assert.deepEqual(settle(record).pending.map((effect: Effect) => effect.do), ["purge-data"]);
});

test("the result of an earlier migration is ignored by the one that replaced it", () => {
	const first = play([found(V1), { type: "enable" }, { type: "checked", digest: V1.digest, problems: [] }]);
	const second = play([found(V2), { type: "checked", digest: V2.digest, problems: [] }], first);
	assert.equal(play([{ type: "migrated", attempt: first.attempts }], second), second);
	assert.equal(play([{ type: "migrated", attempt: second.attempts }], second).state.at, "active");
});

test("a module the user never switched on says so, not that the user switched it off", () => {
	assert.deepEqual(describe(play([found(V1)])), { label: "已停用", reason: "还没打开过" });
	assert.deepEqual(describe(play([found(V1), { type: "enable" }, found(BAD), { type: "disable" }])), { label: "已停用", reason: "你把它关了，数据还留着" });
	assert.deepEqual(describe(play([{ type: "disable" }], serving())), { label: "已停用", reason: "你把它关了，数据还留着" });
	assert.deepEqual(describe(play([{ type: "package-gone" }, found(V1)], play([{ type: "disable" }], serving()))), { label: "已停用", reason: "你把它关了，数据还留着" });
});

test("fuzz: whatever the user and the folder do, the module ends up where the last switch and the last good save say", () => {
	let seed = 20261111;
	const pick = <T>(options: readonly T[]): T => options[(seed = (seed * 1103515245 + 12345) >>> 0) % options.length] as T;
	const events: ModuleEvent[] = [found(V1), found(V2), found(BAD), { type: "package-gone" }, { type: "enable" }, { type: "disable" }, { type: "purge" }];
	for (let round = 0; round < 5000; round++) {
		let run = { record: initialRecord("health" as ModuleName), published: null as Version | null, ran: [] as string[] };
		let on = false;
		let disk: Version | null = null;
		for (let step = 0; step < 30; step++) {
			const event = pick(events);
			if (event.type === "enable" || event.type === "disable") on = event.type === "enable";
			if (event.type === "package-found") disk = event.version;
			if (event.type === "package-gone") disk = null;
			if (event.type !== "purge") assert.equal(transition(transition(run.record, event).record, event).effects.length, 0, "a repeated event adds nothing");
			run = pick([true, false]) ? drive(play([event], run.record), run.published) : { ...run, record: play([event], run.record) };
		}
		run = drive(run.record, run.published);
		const state = run.record.state;
		assert.deepEqual(run.published, state.at === "active" ? state.serving : null, "the registry serves what the record says");
		assert.equal(state.at === "active" || state.at === "staging", on && disk !== null, "on exactly when switched on and the folder is there");
		if (state.at === "active" && disk !== BAD) assert.deepEqual(state.serving, disk, "the last good save is what serves");
	}
});
