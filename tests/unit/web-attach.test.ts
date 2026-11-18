import assert from "node:assert/strict";
import test from "node:test";
import { attachmentLine, fileSize, withAttachment } from "../../src/web/view.mjs";

const UP = { id: "up-0123456789ab", name: "AggregateTransactions.csv", size: 8910 };

test("附件那一行写文件名、上传编号和大小，模块工具凭编号取文件", () => {
	assert.equal(attachmentLine(UP), "附件：AggregateTransactions.csv（上传编号 up-0123456789ab，8.7 KB）");
});

test("大小按 B、KB、MB 写，KB 和 MB 留一位小数", () => {
	assert.deepEqual([fileSize(512), fileSize(8910), fileSize(3 * 1024 * 1024 + 200 * 1024)], ["512 B", "8.7 KB", "3.2 MB"]);
});

test("发话时附件那一行接在话的末尾另起一行；没有附件时话不变；只有附件没有话时就是那一行", () => {
	assert.equal(withAttachment("导入这份 JPM 导出  \n", UP), `导入这份 JPM 导出\n${attachmentLine(UP)}`);
	assert.equal(withAttachment("你好", null), "你好");
	assert.equal(withAttachment("  ", UP), attachmentLine(UP));
});
