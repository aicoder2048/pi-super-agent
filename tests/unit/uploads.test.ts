import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchUpload, findUpload, saveUpload, UPLOAD_ID } from "../../src/host/uploads.ts";

function state(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-uploads-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("存下的文件拿到 up- 开头的编号，凭编号找回同样的字节、文件名、类型和大小", (t) => {
	const dir = state(t);
	const bytes = Buffer.from("Trade Date,Type\r\n10/27/2026,Write option\r\n");
	const saved = saveUpload(dir, { name: "export.csv", type: "text/csv", bytes, at: 1 });
	assert.match(saved.id, UPLOAD_ID);
	assert.deepEqual({ name: saved.name, type: saved.type, size: saved.size }, { name: "export.csv", type: "text/csv", size: bytes.length });
	const found = findUpload(dir, saved.id)!;
	assert.deepEqual(readFileSync(found.file), bytes);
	assert.deepEqual(found.upload, saved);
});

test("上传的文件只有本机这个用户能读", (t) => {
	const dir = state(t);
	const saved = saveUpload(dir, { name: "a.csv", type: "text/csv", bytes: Buffer.from("x"), at: 1 });
	assert.equal(statSync(findUpload(dir, saved.id)!.file).mode & 0o777, 0o600);
	assert.equal(statSync(join(dir, "uploads")).mode & 0o777, 0o700);
});

test("文件名只留最后一段，去掉控制字符，太长截断；空名字记成「未命名」", (t) => {
	const dir = state(t);
	const name = (n: string) => saveUpload(dir, { name: n, type: "", bytes: Buffer.from("x"), at: 1 }).name;
	assert.equal(name("../../etc/passwd"), "passwd");
	assert.equal(name("C:\\Users\\me\\a.csv"), "a.csv");
	assert.equal(name("a\u0000b\nc.csv"), "abc.csv");
	assert.equal(name("x".repeat(300)).length, 200);
	assert.equal(name("   "), "未命名");
});

test("编号格式不对或不存在时找不到，不会读到上传目录以外的文件", (t) => {
	const dir = state(t);
	for (const id of ["", "up-123", "../state.db", "up-0123456789ab/../../x", "up-0123456789ab"]) assert.equal(findUpload(dir, id), undefined, id);
});

test("工具取上传文件：复制进这次调用的目录，交回 fetched；编号不对时交回一句说明", (t) => {
	const dir = state(t);
	const call = state(t);
	const saved = saveUpload(dir, { name: "export.csv", type: "text/csv", bytes: Buffer.from("a,b\r\n"), at: 1 });
	const got = fetchUpload(dir, { upload_id: saved.id }, call);
	assert.equal(typeof got, "object");
	if (typeof got === "string") return;
	assert.equal(got.file, join(call, "upload"));
	assert.deepEqual(readFileSync(got.file, "utf8"), "a,b\r\n");
	assert.deepEqual({ filename: got.filename, mimeType: got.mimeType, contentType: got.contentType, size: got.size }, { filename: "export.csv", mimeType: "text/csv", contentType: "text/csv", size: 5 });
	assert.match(fetchUpload(dir, { upload_id: "up-000000000000" }, call) as string, /没有上传编号/);
	assert.match(fetchUpload(dir, {}, call) as string, /upload_id/);
});
