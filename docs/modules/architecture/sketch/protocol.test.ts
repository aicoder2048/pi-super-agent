import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_CLASSES, SERVED_EFFECTS, toolEffect } from "./manifest.ts";
import type { ComponentName, DataClass, DeclaredEffect, Digest, ModuleName } from "./manifest.ts";
import { allowed, AUTHORITY, effectOf, mayContinueOn, mayRead, moduleCodeReader, SENDERS, senderOf, triggerBodyFor, WITHHELD_NOTICE } from "./protocol.ts";
import type { Caller, DataRoutes, Effect, Reader, Request, Sender } from "./protocol.ts";

const PROVIDERS = ["openai-codex", "deepseek", "ollama"];
const READERS: Record<string, Reader> = {
	page: { clearance: "local-only", provider: null },
	"worker@openai-codex": { clearance: "local-only", provider: "openai-codex" },
	"worker@deepseek": { clearance: "local-only", provider: "deepseek" },
	"router@deepseek": { clearance: "local-only", provider: "deepseek" },
	"code without network": moduleCodeReader({}),
	"code with network": moduleCodeReader({ network: [{}] }),
	telegram: { clearance: "shareable", provider: null },
};
const NOTHING: DataRoutes = { shareable: [], private: [], "local-only": [] };

/** Every routing table over 3 providers and 3 classes: 512 tables. */
function everyRoutes(): DataRoutes[] {
	const tables: DataRoutes[] = [];
	for (let mask = 0; mask < 512; mask++) {
		tables.push(Object.fromEntries(DATA_CLASSES.map((name, row) => [name, PROVIDERS.filter((_, column) => mask & (1 << (row * 3 + column)))])) as DataRoutes);
	}
	return tables;
}

test("mayRead over 7 readers, 3 classes and 512 routing tables: nothing leaves the machine and no model reads an unrouted class", () => {
	let checked = 0;
	for (const routes of everyRoutes()) {
		for (const [name, reader] of Object.entries(READERS)) {
			for (const dataClass of DATA_CLASSES) {
				checked++;
				const got = mayRead(reader, dataClass, routes);
				const leaves = (name === "telegram" || name === "code with network") && dataClass !== "shareable";
				const unrouted = reader.provider !== null && !(routes[dataClass] ?? []).includes(reader.provider);
				assert.equal(got, !leaves && !unrouted, `${name} reads ${dataClass} under ${JSON.stringify(routes)}`);
			}
		}
	}
	assert.equal(checked, 10752);
});

test("mayRead refuses what it does not know", () => {
	const worker = READERS["worker@deepseek"] as Reader;
	assert.equal(mayRead(worker, "private", { shareable: ["deepseek"] }), false, "a class with no route entry is readable by no model");
	assert.equal(mayRead(READERS["page"] as Reader, "private", { shareable: ["deepseek"] }), true, "the page is not a model, so the routes do not apply to it");
	for (const reader of Object.values(READERS)) {
		assert.equal(mayRead(reader, "secret" as DataClass, NOTHING), false, "a class that is not in DATA_CLASSES");
		assert.equal(mayRead(reader, "constructor" as DataClass, { constructor: ["deepseek"] } as DataRoutes), false, "a class named like an inherited key");
	}
	assert.equal(mayRead({ clearance: "top" as DataClass, provider: null }, "shareable", NOTHING), false, "a clearance that is not in DATA_CLASSES");
	assert.equal(mayRead(READERS["worker@openai-codex"] as Reader, "private", { ...NOTHING, private: ["openai-codex/gpt-5.2"] }), false, "routes name providers, not models");
});

test("mayContinueOn: a session moves to another provider only if that provider may read everything the session has read", () => {
	const routes: DataRoutes = { shareable: ["openai-codex", "deepseek"], private: ["openai-codex"], "local-only": [] };
	assert.equal(mayContinueOn(null, "deepseek", routes), true, "a session that has read no module data");
	assert.equal(mayContinueOn("shareable", "deepseek", routes), true);
	assert.equal(mayContinueOn("private", "deepseek", routes), false, "the fallback provider is not routed for private");
	assert.equal(mayContinueOn("private", "openai-codex", routes), true);
	assert.equal(mayContinueOn("local-only", "openai-codex", routes), false);
	assert.equal(mayContinueOn("private", "deepseek", { shareable: ["deepseek"] }), false, "no route entry");
	assert.equal(mayContinueOn("secret" as DataClass, "deepseek", routes), false, "an unknown class");
	for (const routes of everyRoutes()) {
		for (const provider of PROVIDERS) {
			for (const dataClass of DATA_CLASSES) {
				assert.equal(mayContinueOn(dataClass, provider, routes), mayRead({ clearance: "local-only", provider }, dataClass, routes));
			}
		}
	}
});

test("a trigger of a feed reaches the Router only when the Router's provider may read the feed's class", () => {
	const router = READERS["router@deepseek"] as Reader;
	const routes: DataRoutes = { shareable: ["deepseek"], private: [], "local-only": [] };
	assert.equal(triggerBodyFor("新论文：某某（pubmed）", "shareable", router, routes), "新论文：某某（pubmed）");
	assert.equal(triggerBodyFor("邮箱里有一份医院发来的报告已经归档。", "private", router, routes), WITHHELD_NOTICE);
	assert.equal(triggerBodyFor("医院来信：复查结果 CEA 7.9", "local-only", router, routes), WITHHELD_NOTICE);
	assert.equal(triggerBodyFor("邮箱里有一份医院发来的报告已经归档。", "private", router, { ...routes, private: ["deepseek"] }), "邮箱里有一份医院发来的报告已经归档。");
});

const NAME = "c" as ComponentName;
const REQUESTS: Record<string, { request: Request; tool: "pure" | DeclaredEffect; effect: Effect }> = {
	"tool without network": { request: { kind: "tool", name: NAME, input: null }, tool: "pure", effect: "pure" },
	"tool with network, read": { request: { kind: "tool", name: NAME, input: null }, tool: "read", effect: "read" },
	"tool with network, write": { request: { kind: "tool", name: NAME, input: null }, tool: "write", effect: "write" },
	"tool served by authoring": { request: { kind: "tool", name: NAME, input: null }, tool: toolEffect({ servedBy: "authoring" }), effect: "write" },
	"knowledge search": { request: { kind: "knowledge", op: "search", query: "q" }, tool: "pure", effect: "read" },
	"knowledge read": { request: { kind: "knowledge", op: "read", doc: NAME, section: "1" }, tool: "pure", effect: "read" },
	"data query": { request: { kind: "data", collection: NAME, op: "query", query: {} }, tool: "pure", effect: "read" },
	"data open-blob": { request: { kind: "data", collection: NAME, op: "open-blob", row: "r", field: "f" }, tool: "pure", effect: "read" },
	"data put": { request: { kind: "data", collection: NAME, op: "put", rows: [] }, tool: "pure", effect: "write" },
	"data confirm": { request: { kind: "data", collection: NAME, op: "confirm", row: "r", corrected: { value: 1 } }, tool: "pure", effect: "user-authority" },
	"watch list": { request: { kind: "watch", collection: NAME, op: "list" }, tool: "pure", effect: "read" },
	"watch set": { request: { kind: "watch", collection: NAME, op: "set", watch: { key: "CEA", condition: { when: "above", value: 5 } } }, tool: "pure", effect: "user-authority" },
	"watch remove": { request: { kind: "watch", collection: NAME, op: "remove", id: "w" }, tool: "pure", effect: "user-authority" },
	"feed collect": { request: { kind: "feed", name: NAME, op: "collect", items: [] }, tool: "pure", effect: "write" },
};

const MODULE = "m" as ModuleName;
function worker(basis: "request" | "rule" | "inference", heardOthers: boolean): Caller {
	return { who: "worker", ticket: "t", pin: { module: MODULE, digest: "d" as Digest }, basis, member: null, provider: "deepseek", heardOthers };
}
const CALLERS: Record<Sender, Caller> = {
	"request-user-only": worker("request", false),
	request: worker("request", true),
	rule: worker("rule", false),
	inference: worker("inference", false),
	page: { who: "page", module: MODULE },
	scheduler: { who: "scheduler", module: MODULE },
};

/** The whole table, written out. `allowed` must agree with every cell. */
const WORKERS_THAT_READ: Sender[] = ["request-user-only", "request", "rule", "inference", "page"];
const WORKERS_THAT_WRITE: Sender[] = ["request-user-only", "request", "rule", "page"];
const EXPECTED: Record<keyof typeof REQUESTS, Sender[]> = {
	"tool without network": WORKERS_THAT_READ,
	"tool with network, read": WORKERS_THAT_READ,
	"tool with network, write": WORKERS_THAT_WRITE,
	"tool served by authoring": WORKERS_THAT_WRITE,
	"knowledge search": WORKERS_THAT_READ,
	"knowledge read": WORKERS_THAT_READ,
	"data query": WORKERS_THAT_READ,
	"data open-blob": WORKERS_THAT_READ,
	"data put": WORKERS_THAT_WRITE,
	"data confirm": ["page"],
	"watch list": WORKERS_THAT_READ,
	"watch set": ["request-user-only", "page"],
	"watch remove": ["request-user-only", "page"],
	"feed collect": ["scheduler"],
};

test("senderOf names each caller kind, and only a request ticket that heard nobody else carries the user's authority", () => {
	for (const sender of SENDERS) assert.equal(senderOf(CALLERS[sender]), sender);
	assert.equal(senderOf(worker("rule", true)), "rule");
	assert.equal(senderOf(worker("inference", true)), "inference");
});

test("effectOf gives every request its effect, and the host fixes the effect of a tool it serves", () => {
	for (const [label, row] of Object.entries(REQUESTS)) assert.equal(effectOf(row.request, row.tool), row.effect, label);
	assert.equal(toolEffect({ servedBy: "authoring" }), SERVED_EFFECTS.authoring);
	assert.equal(toolEffect({ servedBy: "authoring", effect: "read" }), "write", "a stated effect cannot lower what the host fixed");
	assert.equal(toolEffect({}), "pure");
	assert.equal(toolEffect({ effect: "read" }), "read");
});

test("allowed agrees with the written table for every request and every caller kind", () => {
	for (const [label, row] of Object.entries(REQUESTS)) {
		for (const sender of SENDERS) {
			const expected = (EXPECTED[label] as Sender[]).includes(sender);
			assert.equal(allowed(CALLERS[sender], row.request, row.tool), expected, `${sender} sends ${label}`);
		}
	}
});

test("the authority table: an inference ticket never writes, and the scheduler is in no row", () => {
	assert.equal(AUTHORITY.write.includes("inference"), false);
	assert.equal(AUTHORITY["user-authority"].includes("inference"), false);
	for (const senders of Object.values(AUTHORITY)) assert.equal(senders.includes("scheduler"), false);
	assert.deepEqual(AUTHORITY["user-authority"], ["request-user-only", "page"]);
});
