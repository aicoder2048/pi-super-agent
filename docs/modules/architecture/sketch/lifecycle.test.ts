import assert from "node:assert/strict";
import { test } from "node:test";
import { cardIdFor, initialRecord, resume, settle, transition } from "./lifecycle.ts";
import type { Effect, ModuleEvent, ModuleRecord, Version } from "./lifecycle.ts";
import type { Digest, ModuleName } from "./manifest.ts";

const NAME = "health" as ModuleName;
const version = (digest: string, grantKey: string, label: string, asks = true): Version => ({
	digest: digest as Digest,
	grantKey: grantKey.padEnd(16, "0") as Digest,
	label,
	asks,
});
const V1 = version("d1", "k1", "0.1.0");
const V1_MARKDOWN = version("d1b", "k1", "0.1.1");
const V2 = version("d2", "k2", "0.2.0");
const CLEAN = { type: "checked", problems: [] } as const;

function play(events: readonly ModuleEvent[], start: ModuleRecord = initialRecord(NAME)): ModuleRecord {
	return events.reduce((record, event) => transition(record, event).record, start);
}

function stageOf(record: ModuleRecord) {
	const state = record.state;
	return state.at === "staging" ? state.stage : state.at === "active" ? state.update : null;
}

function cardOf(record: ModuleRecord): string {
	const stage = stageOf(record);
	assert(stage?.at === "awaiting-grant", `expected a card to be open, the stage is ${stage?.at ?? "none"}`);
	return stage.cardId;
}

function attemptOf(record: ModuleRecord): number {
	const stage = stageOf(record);
	assert(stage?.at === "migrating", `expected a migration to be running, the stage is ${stage?.at ?? "none"}`);
	return stage.attempt;
}

const kinds = (effects: readonly Effect[]): string[] => effects.map((effect) => effect.do);

/** A first enable of `first`, up to the card. */
function asked(first: Version = V1): ModuleRecord {
	return play([{ type: "package-found", version: first }, { type: "enable" }, { ...CLEAN, digest: first.digest }]);
}

/** `first` enabled, granted, migrated and serving, with the outbox drained. */
function serving(first: Version = V1): ModuleRecord {
	const waiting = asked(first);
	const migrating = play([{ type: "granted", cardId: cardOf(waiting), at: "t1" }], waiting);
	const active = play([{ type: "migrated", attempt: attemptOf(migrating) }], migrating);
	assert.equal(active.state.at, "active");
	return { ...active, pending: [] };
}

test("a disable while the package is away keeps the module off when the folder returns", () => {
	const record = play([{ type: "package-gone" }, { type: "disable" }, { type: "package-found", version: V1 }], serving());
	assert.equal(record.state.at, "disabled");
	assert.deepEqual(kinds(record.pending), ["publish", "mark-tickets"]);
});

test("an enable while the package is away starts the check when the folder returns", () => {
	const record = play([{ type: "package-found", version: V1 }, { type: "package-gone" }, { type: "enable" }, { type: "package-found", version: V1 }]);
	assert.equal(record.state.at, "staging");
});

test("a crash after the record is persisted loses no effect: resume returns the outbox in order", () => {
	const disabled = play([{ type: "disable" }], serving());
	assert.deepEqual(resume(disabled), [
		{ do: "publish", serve: null },
		{ do: "mark-tickets", mark: "module-disabled" },
	]);
	assert.deepEqual(kinds(resume(settle(disabled))), ["mark-tickets"]);
	assert.deepEqual(resume(settle(settle(disabled))), []);

	const purged = play([{ type: "package-gone" }, { type: "purge" }], serving());
	assert.deepEqual(kinds(resume(purged)), ["publish", "mark-tickets", "purge-data"]);

	const waiting = asked();
	const withdrawn = play([{ type: "disable" }], { ...waiting, pending: [] });
	assert.deepEqual(resume(withdrawn), [{ do: "withdraw-card", cardId: cardOf(waiting) }]);
});

test("a purge asked for during a migration is queued behind it, and the migration's late result changes nothing", () => {
	const waiting = asked();
	const migrating = play([{ type: "granted", cardId: cardOf(waiting), at: "t1" }], { ...waiting, pending: [] });
	const attempt = attemptOf(migrating);
	const purged = play([{ type: "disable" }, { type: "purge" }], migrating);
	assert.deepEqual(kinds(purged.pending), ["migrate", "purge-data"]);
	const late = transition(purged, { type: "migration-failed", attempt, reason: "the driver restored its snapshot" });
	assert.equal(late.record, purged);
});

test("a result of an earlier migration attempt is ignored by the attempt that replaced it", () => {
	const waiting = asked();
	const first = play([{ type: "granted", cardId: cardOf(waiting), at: "t1" }], waiting);
	const second = play([{ type: "disable" }, { type: "enable" }, { ...CLEAN, digest: V1.digest }], first);
	assert(attemptOf(second) > attemptOf(first));

	const lateFailure = transition(second, { type: "migration-failed", attempt: attemptOf(first), reason: "attempt 1 was interrupted" });
	assert.equal(lateFailure.record, second);
	const lateSuccess = transition(second, { type: "migrated", attempt: attemptOf(first) });
	assert.equal(lateSuccess.record, second);
	assert.deepEqual(lateSuccess.effects, []);

	const done = transition(second, { type: "migrated", attempt: attemptOf(second) });
	assert.equal(done.record.state.at, "active");
	assert.deepEqual(done.effects, [{ do: "publish", serve: V1 }]);
});

test("when an edit replaces an update that is migrating, the first migration's failure does not touch the second", () => {
	const updating = play([{ type: "package-found", version: V2 }, { ...CLEAN, digest: V2.digest }], serving());
	const first = play([{ type: "granted", cardId: cardOf(updating), at: "t2" }], updating);
	const edited = version("d2b", "k2", "0.2.1");
	const second = play([{ type: "package-found", version: edited }, { ...CLEAN, digest: edited.digest }], first);
	assert.deepEqual(
		second.pending.flatMap((effect) => (effect.do === "migrate" ? [effect.attempt] : [])),
		[attemptOf(first), attemptOf(second)],
	);
	const late = transition(second, { type: "migration-failed", attempt: attemptOf(first), reason: "restored the snapshot taken before 0.2.0" });
	assert.equal(late.record, second);
	const done = play([{ type: "migrated", attempt: attemptOf(second) }], second);
	assert.deepEqual(done.state, { at: "active", serving: edited, update: null });
});

test("a declined card is final: a late click, a Markdown edit and a restart of the switch do not reopen it", () => {
	const waiting = asked();
	const firstCard = cardOf(waiting);
	assert.equal(firstCard, cardIdFor(NAME, V1, 1));
	const declined = play([{ type: "declined", cardId: firstCard }], waiting);
	assert.equal(stageOf(declined)?.at, "declined");

	const lateClick = transition(declined, { type: "granted", cardId: firstCard, at: "late click" });
	assert.equal(lateClick.record, declined);

	const edited = play([{ type: "package-found", version: V1_MARKDOWN }, { ...CLEAN, digest: V1_MARKDOWN.digest }], { ...declined, pending: [] });
	assert.equal(stageOf(edited)?.at, "declined");
	assert.deepEqual(kinds(edited.pending), ["check"]);
	assert.equal(transition(edited, { type: "granted", cardId: firstCard, at: "old card" }).record, edited);

	const toggled = play([{ type: "disable" }, { type: "enable" }, { ...CLEAN, digest: V1_MARKDOWN.digest }], edited);
	assert.equal(stageOf(toggled)?.at, "declined");
});

test("reconsider opens a new card with the next number, and only that card grants", () => {
	const waiting = asked();
	const firstCard = cardOf(waiting);
	const declined = play([{ type: "declined", cardId: firstCard }], waiting);
	const again = transition(declined, { type: "reconsider" });
	const secondCard = cardOf(again.record);
	assert.equal(secondCard, cardIdFor(NAME, V1, 2));
	assert.deepEqual(kinds(again.effects), ["issue-card"]);
	assert.equal(transition(again.record, { type: "granted", cardId: firstCard, at: "old card" }).record, again.record);
	const granted = play([{ type: "granted", cardId: secondCard, at: "t3" }], again.record);
	assert.equal(stageOf(granted)?.at, "migrating");
	assert.deepEqual(granted.declined, []);
});

test("a granted update whose migration fails leaves the serving version's grant in place", () => {
	const updating = play([{ type: "package-found", version: V2 }, { ...CLEAN, digest: V2.digest }], serving());
	const migrating = play([{ type: "granted", cardId: cardOf(updating), at: "t2" }], updating);
	const failed = play([{ type: "migration-failed", attempt: attemptOf(migrating), reason: "disk" }], migrating);
	assert.equal(failed.state.at, "active");
	assert.deepEqual(failed.grants.map((grant) => grant.grantKey), [V1.grantKey, V2.grantKey]);

	const back = play([{ type: "package-found", version: V1 }, { type: "disable" }, { type: "enable" }, { ...CLEAN, digest: V1.digest }], failed);
	assert.equal(stageOf(back)?.at, "migrating");
	assert.equal(back.cards, 2);
});

test("a version with another grant key never serves before its own card is granted", () => {
	const rulesA = version("ra", "ka", "rules-a");
	const rulesB = version("rb", "kb", "rules-b");
	const changed = play([{ type: "package-found", version: rulesB }, { ...CLEAN, digest: rulesB.digest }], serving(rulesA));
	assert.deepEqual(changed.state, { at: "active", serving: rulesA, update: { at: "awaiting-grant", version: rulesB, cardId: cardIdFor(NAME, rulesB, 2) } });
	assert.equal(changed.pending.some((effect) => effect.do === "publish" || effect.do === "migrate"), false);
});

test("a declined update is reopened by reconsider while the serving version keeps serving", () => {
	const updating = play([{ type: "package-found", version: V2 }, { ...CLEAN, digest: V2.digest }], serving());
	const declined = play([{ type: "declined", cardId: cardOf(updating) }], { ...updating, pending: [] });
	const seenAgain = transition(declined, { type: "package-found", version: V2 });
	assert.equal(seenAgain.record, declined);

	const again = transition(declined, { type: "reconsider" });
	assert.deepEqual(kinds(again.effects), ["issue-card"]);
	assert.equal(again.record.state.at === "active" && again.record.state.serving, V1);
	const granted = play([{ type: "granted", cardId: cardOf(again.record), at: "changed my mind" }], again.record);
	assert.deepEqual(kinds(granted.pending), ["issue-card", "migrate"]);
});

/** mulberry32. The seed is fixed, so a failure names a run that fails again. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

test("fuzz: random events against a driver that runs the outbox in order", () => {
	const next = random(20261111);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	const versions = [V1, V1_MARKDOWN, V2, version("d4", "k0", "0.0.1", false)];
	const RUNS = 30000;
	const STEPS = 40;
	const reached = new Set<string>();

	for (let run = 0; run < RUNS; run++) {
		let record = initialRecord("m" as ModuleName);
		let switchedOn = false;
		/** What the simulated registry serves: the last `publish` the driver ran. */
		let published: Digest | null = null;
		const cardsSeen = new Set<string>();
		const cardsDeclined = new Set<string>();
		const attemptsSeen = new Set<number>();
		const trace: string[] = [];
		const where = (): string => `run ${run}\n  ${trace.join("\n  ")}`;

		const feed = (event: ModuleEvent): void => {
			const before = record;
			const step = transition(record, event);
			record = step.record;
			trace.push(`${JSON.stringify(event)} -> ${record.state.at} [${kinds(step.effects).join(",")}]`);
			const stage = stageOf(record);
			reached.add(stage === null ? record.state.at : `${record.state.at}/${stage.at}`);

			assert.deepEqual(record.pending, [...before.pending, ...step.effects], `the outbox is the old outbox plus this step's effects\n${where()}`);
			if (event.type === "enable") switchedOn = true;
			if (event.type === "disable") switchedOn = false;
			const on = record.state.at === "active" || record.state.at === "staging";
			assert(switchedOn || !on, `the user's last word was off, and the module is on\n${where()}`);
			if (event.type === "disable" || event.type === "package-gone") assert(record.state.at !== "active", `still serving after ${event.type}\n${where()}`);
			if (record.state.at === "active" && record.state.serving.asks) {
				const key = record.state.serving.grantKey;
				assert(record.grants.some((grant) => grant.grantKey === key), `serving a version no grant covers\n${where()}`);
			}
			if (before.state.at === "active" && record.state.at !== "active") {
				assert(event.type === "disable" || event.type === "package-gone", `the serving version was dropped by ${event.type}\n${where()}`);
			}
			if ((event.type === "migrated" || event.type === "migration-failed") && before !== record) {
				const was = stageOf(before);
				assert(was?.at === "migrating" && was.attempt === event.attempt, `a result of another attempt changed the record\n${where()}`);
			}
			if (event.type === "declined" && before !== record) cardsDeclined.add(event.cardId);
			if (event.type === "granted" && before !== record) assert(!cardsDeclined.has(event.cardId), `a declined card was granted later\n${where()}`);
			for (const effect of step.effects) {
				if (effect.do === "issue-card") {
					assert(!cardsSeen.has(effect.cardId), `card id ${effect.cardId} was issued twice\n${where()}`);
					cardsSeen.add(effect.cardId);
				}
				if (effect.do === "migrate") {
					assert(!attemptsSeen.has(effect.attempt), `attempt ${effect.attempt} was used twice\n${where()}`);
					attemptsSeen.add(effect.attempt);
				}
				if (effect.do === "purge-data") assert(!on, `purge-data while the module is on\n${where()}`);
			}
			if (event.type !== "purge") {
				const again = transition(record, event);
				assert.equal(again.record, record, `a repeated ${event.type} changed the record\n${where()}`);
			}
		};

		/** The driver: run the first pending effect, settle, feed its result. */
		const runOne = (): void => {
			const effect = record.pending[0];
			if (effect === undefined) return;
			record = settle(record);
			trace.push(`ran ${effect.do}`);
			if (effect.do === "publish") published = effect.serve?.digest ?? null;
			if (effect.do === "check") feed({ type: "checked", digest: effect.version.digest, problems: next() < 0.15 ? [{ where: "x", reason: "bad" }] : [] });
			if (effect.do === "migrate") feed(next() < 0.8 ? { type: "migrated", attempt: effect.attempt } : { type: "migration-failed", attempt: effect.attempt, reason: "disk" });
		};

		const outside = (): ModuleEvent => {
			const stage = stageOf(record);
			if (stage?.at === "awaiting-grant" && next() < 0.6) return next() < 0.7 ? { type: "granted", cardId: stage.cardId, at: "t" } : { type: "declined", cardId: stage.cardId };
			const anyCard = pick([...cardsSeen, "ask_mod_m_k100000000000000_1"]);
			return pick<ModuleEvent>([
				{ type: "package-found", version: pick(versions) },
				{ type: "package-found", version: pick(versions) },
				{ type: "package-gone" },
				{ type: "enable" },
				{ type: "enable" },
				{ type: "disable" },
				{ type: "reconsider" },
				{ type: "granted", cardId: anyCard, at: "t" },
				{ type: "declined", cardId: anyCard },
				{ type: "checked", digest: pick(versions).digest, problems: [] },
				{ type: "migrated", attempt: Math.floor(next() * (record.attempts + 2)) },
				{ type: "migration-failed", attempt: Math.floor(next() * (record.attempts + 2)), reason: "stale" },
				{ type: "purge" },
			]);
		};

		for (let step = 0; step < STEPS; step++) {
			if (next() < 0.5) runOne();
			else feed(outside());
		}
		while (record.pending.length > 0) runOne();
		const serves = record.state.at === "active" ? record.state.serving.digest : null;
		assert.equal(published, serves, `with the outbox drained, the registry serves what the record says\n${where()}`);
	}
	const stages = ["checking", "invalid", "awaiting-grant", "declined", "migrating"];
	const every = ["missing", "disabled", "active", ...stages.flatMap((stage) => [`staging/${stage}`, `active/${stage}`])];
	assert.deepEqual([...reached].sort(), every.sort(), "the fuzz reached every state and stage");
});
