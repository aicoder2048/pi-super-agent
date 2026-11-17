import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { scanPackage } from "../../src/modules/validate.ts";

const LIST = { title: "名单", kind: "record", class: "shareable", fields: { address: { type: "text", title: "地址" } } };
const LETTERS = { title: "信", kind: "record", class: "private", fields: { subject: { type: "text", title: "主题" } } };
const SHARED = { ...LETTERS, title: "公开的信", class: "shareable" };
const GOOD = { title: "收信", connector: "mail", handler: "index.ts", every: "5m", settings: { senders: "list" }, into: "letters" };

function problems(t: TestContext, feed: Record<string, unknown>, collections: Record<string, object> = { list: LIST, letters: LETTERS, shared: SHARED }): string[] {
	const dir = mkdtempSync(join(tmpdir(), "psa-mail-check-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pkg = join(dir, "m");
	mkdirSync(join(pkg, "feeds/inbox"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "m", version: "0.1.0" }));
	writeFileSync(join(pkg, "feeds/inbox/feed.json"), JSON.stringify(feed));
	writeFileSync(join(pkg, "feeds/inbox/index.ts"), "export default () => ({});\n");
	for (const [name, collection] of Object.entries(collections)) {
		mkdirSync(join(pkg, "data", name), { recursive: true });
		writeFileSync(join(pkg, "data", name, "collection.json"), JSON.stringify(collection));
	}
	const scan = scanPackage(pkg, { runCases: false });
	return scan.ok ? [] : scan.problems.map((p) => `${p.where}: ${p.reason}`);
}

const without = (key: string) => Object.fromEntries(Object.entries(GOOD).filter(([k]) => k !== key));

test("mail 连接器的 feed 写全了：handler、every、私密的 into、名单，检查通过", (t) => {
	assert.deepEqual(problems(t, GOOD), []);
	assert.deepEqual(problems(t, { ...GOOD, settings: { senders: ["a@example.com", "@broker.example.net"] } }), []);
});

test("mail 连接器的 feed 少了 handler 或 every：检查报错", (t) => {
	assert.match(problems(t, without("handler")).join("\n"), /mail connector needs "handler"/);
	assert.match(problems(t, without("every")).join("\n"), /mail connector needs "every"/);
});

test("mail 连接器的 feed 一律私密：不写 into 或写进可分享的集合，检查报错", (t) => {
	assert.match(problems(t, without("into")).join("\n"), /mail connector must write into a private collection/);
	assert.match(problems(t, { ...GOOD, into: "shared" }).join("\n"), /mail connector must write into a private collection/);
});

test("名单写法不对：没写、空列表、通配符、不是地址、集合不存在、集合没有 address 字段，检查都报错", (t) => {
	assert.match(problems(t, without("settings")).join("\n"), /settings\.senders/);
	assert.match(problems(t, { ...GOOD, settings: { senders: [] } }).join("\n"), /settings\.senders/);
	assert.match(problems(t, { ...GOOD, settings: { senders: ["*@example.com", "nobody"] } }).join("\n"), /\*@example\.com、nobody/);
	assert.match(problems(t, { ...GOOD, settings: { senders: "missing" } }).join("\n"), /no data\/missing/);
	assert.match(problems(t, { ...GOOD, settings: { senders: "letters" } }).join("\n"), /"address"/);
});

function toolProblems(t: TestContext, tool: Record<string, unknown>, feed: Record<string, unknown> | undefined): string[] {
	const dir = mkdtempSync(join(tmpdir(), "psa-fetch-check-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pkg = join(dir, "m");
	mkdirSync(join(pkg, "tools/read"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "m", version: "0.1.0" }));
	writeFileSync(join(pkg, "tools/read/tool.json"), JSON.stringify({ title: "读", description: "读附件", input: { messageId: { type: "text", title: "信" } }, output: { text: { type: "text", title: "字" } }, ...tool }));
	writeFileSync(join(pkg, "tools/read/index.ts"), "export default () => ({});\n");
	for (const [name, collection] of Object.entries({ list: LIST, letters: LETTERS })) {
		mkdirSync(join(pkg, "data", name), { recursive: true });
		writeFileSync(join(pkg, "data", name, "collection.json"), JSON.stringify(collection));
	}
	if (feed !== undefined) {
		mkdirSync(join(pkg, "feeds/inbox"), { recursive: true });
		writeFileSync(join(pkg, "feeds/inbox/feed.json"), JSON.stringify(feed));
		writeFileSync(join(pkg, "feeds/inbox/index.ts"), "export default () => ({});\n");
	}
	const scan = scanPackage(pkg, { runCases: false });
	return scan.ok ? [] : scan.problems.map((p) => `${p.where}: ${p.reason}`);
}

test("工具写 fetch: mail.attachment：要 effect read，模块要有一个 mail 连接器的 feed；可以和 port: ocr 一起写", (t) => {
	assert.deepEqual(toolProblems(t, { effect: "read", fetch: "mail.attachment", port: "ocr" }, GOOD), []);
	assert.match(toolProblems(t, { fetch: "mail.attachment" }, GOOD).join("\n"), /"fetch" mail\.attachment needs "effect": "read"/);
	assert.match(toolProblems(t, { effect: "read", fetch: "mail.attachment" }, undefined).join("\n"), /needs a feed of this module on the mail connector/);
	assert.match(toolProblems(t, { effect: "read", fetch: "drive.file" }, GOOD).join("\n"), /"fetch" must be mail\.attachment/);
});
