import assert from "node:assert/strict";
import test from "node:test";
import { listed, senderList, type SenderRow } from "../../docs/modules/examples/mail/senders.ts";
import { parseFrom } from "../../docs/modules/examples/mail/feeds/inbox/message.ts";
import { decodeEntities, htmlToText, parseFrom as hostParseFrom } from "../../src/modules/connectors/letter.ts";
import { listed as hostListed, senderList as hostSenderList } from "../../src/modules/connectors/senders.ts";
import * as moduleMessage from "../../docs/modules/examples/mail/feeds/inbox/message.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const rows = (...fields: SenderRow["fields"][]): SenderRow[] => fields.map((f, i) => ({ id: String(i + 1), fields: f }));

test("名单的地址先做 NFKC、去掉零宽字符再比：从聊天里粘来的全角或带零宽空格的地址照样收", () => {
	for (const address of ["ann​@example.com", "﻿ann@example.com‍", "ａｎｎ＠ｅｘａｍｐｌｅ．ｃｏｍ", "@ｅｘａｍｐｌｅ.com"]) {
		assert.equal(listed(senderList(rows({ address }), NOW), "ann@example.com"), true, JSON.stringify(address));
	}
});

test("划掉的行也先归一再比：带零宽空格的划掉照样划掉，不算读不出来", () => {
	const senders = senderList(rows({ address: "ann@example.com" }, { address: "ann@exa​mple.com", removedAt: "2026-11-14T09:00:00Z" }), NOW);
	assert.equal(listed(senders, "ann@example.com"), false);
	assert.deepEqual(senders.unreadable, []);
});

const HOUR = 3_600_000;
const iso = (offset: number) => new Date(NOW + offset).toISOString();

test("宿主和 mail 模块的名单规则是两份代码，同样的名单回答一样", () => {
	const lists: SenderRow["fields"][][] = [
		[{ address: "ann@example.com" }],
		[{ address: "@example.com" }, { address: "ann@example.com", removedAt: iso(-HOUR) }],
		[{ address: "ann@example.com", removedAt: iso(-2 * HOUR) }, { address: "ann@example.com", addedAt: iso(-HOUR) }],
		[{ address: "ann@example.com", removedAt: "yes" }, { address: "ann@example.com", addedAt: iso(-HOUR) }],
		[{ address: "ann@example.com" }, { address: "mailto:bob@example.org", removedAt: iso(-HOUR) }],
		[{ address: "*@example.org" }, { address: "Ann <ann@example.com>" }],
		[{ address: "ann@example.com", removedAt: iso(30 * 24 * HOUR) }, { address: "ann@example.com", addedAt: iso(-HOUR) }],
	];
	for (const fields of lists) {
		const mine = senderList(rows(...fields), NOW);
		const host = hostSenderList(rows(...fields), NOW);
		assert.deepEqual({ ...host, list: [...host.list] }, { ...mine, list: [...mine.list] }, JSON.stringify(fields));
		for (const address of ["ann@example.com", "bob@example.org", "x@example.com"]) assert.equal(hostListed(host, address), listed(mine, address), `${JSON.stringify(fields)} ${address}`);
	}
});

test("宿主和 mail 模块解析 From、解实体、HTML 转文字的结果一样", () => {
	for (const from of ["Ann <ann@example.com>", '"Lee, Ann" <ann@example.com>', "evil@bad.test, Ann <ann@example.com>", "x@bad.test@corp.test", "Ann (<evil@bad.test>) <ann@example.com>", "ANN@Example.COM", "friends: a@b.test;"]) {
		assert.deepEqual(hostParseFrom(from), parseFrom(from), from);
	}
	assert.equal(decodeEntities("you&#39;re &amp; &#x4f60;"), moduleMessage.decodeEntities("you&#39;re &amp; &#x4f60;"));
	const html = "<html><head><style>p{}</style></head><body><p>您好&nbsp;Ann</p><br>谢谢</body></html>";
	assert.equal(htmlToText(html), moduleMessage.htmlToText(html));
});
