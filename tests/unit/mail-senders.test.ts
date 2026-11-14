import assert from "node:assert/strict";
import test from "node:test";
import { listed, senderList, type SenderRow } from "../../docs/modules/examples/mail/feeds/inbox/index.ts";

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
