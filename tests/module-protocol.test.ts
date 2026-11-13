import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComponentName, Digest, ModuleName, ToolEffect } from "../src/modules/manifest.ts";
import { allowed, SENDERS, senderOf, telegramText } from "../src/modules/protocol.ts";
import type { Caller, Request, Sender } from "../src/modules/protocol.ts";

const C = "c" as ComponentName;
const M = "m" as ModuleName;
const worker = (basis: "request" | "rule" | "inference", heardOthers: boolean): Caller => ({ who: "worker", ticket: "t", pin: { module: M, digest: "d" as Digest }, basis, member: null, heardOthers });
const CALLERS: Record<Sender, Caller> = {
	"request-user-only": worker("request", false),
	request: worker("request", true),
	rule: worker("rule", true),
	inference: worker("inference", true),
	page: { who: "page", module: M },
};

const EVERYONE = SENDERS;
const NOT_INFERENCE: readonly Sender[] = ["request-user-only", "request", "rule", "page"];
const THE_USER: readonly Sender[] = ["request-user-only", "page"];
/** The table of design.md section 5, written out by hand: each request, the tool's effect, and who may send it. */
const TABLE: readonly [Request, ToolEffect, readonly Sender[]][] = [
	[{ kind: "tool", name: C, input: null }, "pure", EVERYONE],
	[{ kind: "tool", name: C, input: null }, "read", EVERYONE],
	[{ kind: "tool", name: C, input: null }, "write", NOT_INFERENCE],
	[{ kind: "knowledge", op: "search", query: "q" }, "pure", EVERYONE],
	[{ kind: "knowledge", op: "read", doc: C, section: "1" }, "pure", EVERYONE],
	[{ kind: "data", collection: C, op: "query", query: {} }, "pure", EVERYONE],
	[{ kind: "data", collection: C, op: "open-blob", row: "r", field: "f" }, "pure", EVERYONE],
	[{ kind: "data", collection: C, op: "write", rows: [], from: "test" }, "pure", NOT_INFERENCE],
	[{ kind: "watch", collection: C, op: "list" }, "pure", EVERYONE],
	[{ kind: "watch", collection: C, op: "set", watch: { key: "CEA", condition: { when: "above", value: 5 } } }, "pure", THE_USER],
	[{ kind: "watch", collection: C, op: "remove", id: "w" }, "pure", THE_USER],
];

test("allowed agrees with the written table for every request and every kind of caller", () => {
	for (const [request, tool, senders] of TABLE) {
		for (const sender of SENDERS) {
			assert.equal(allowed(CALLERS[sender], request, tool), senders.includes(sender), `${JSON.stringify(request)} (${tool}) from ${sender}`);
		}
	}
});

test("only a request ticket that has heard nobody but the user carries the user's authority", () => {
	for (const sender of SENDERS) assert.equal(senderOf(CALLERS[sender]), sender);
	assert.equal(senderOf(worker("rule", false)), "rule");
});

test("Telegram gets the full text unless the ticket has touched private data", () => {
	assert.equal(telegramText("CEA 5.2", null), "CEA 5.2");
	assert.equal(telegramText("CEA 5.2", "个人医疗健康"), "个人医疗健康 有新内容，请在网页上查看");
});
