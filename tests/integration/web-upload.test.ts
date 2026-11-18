import assert from "node:assert/strict";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { WebGateway, type WebHost } from "../../src/host/web.ts";
import { UPLOAD_MAX_BYTES } from "../../src/host/uploads.ts";

type Got = { status: number; body: string };
type Received = { name: string; type: string; bytes: Buffer };

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<Got> {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method: options.method ?? "POST", headers: options.headers }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode!, body }));
		});
		req.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" || error.code === "EPIPE" ? resolve({ status: 413, body: "" }) : reject(error)));
		req.setTimeout(3000, () => req.destroy(new Error(`请求 3 秒没有响应：${url}`)));
		req.end(options.body);
	});
}

async function gateway(t: TestContext) {
	const received: Received[] = [];
	const host = { upload: (name: string, type: string, bytes: Buffer) => (received.push({ name, type, bytes }), { id: "up-0123456789ab", name, type, size: bytes.length, at: 1 }) } as unknown as WebHost;
	const web = new WebGateway(host, "ab".repeat(32), () => {});
	await web.listen(0);
	t.after(() => web.close());
	const url = new URL(web.url);
	const token = url.searchParams.get("token")!;
	const upload = (query: string, body: Buffer, headers: Record<string, string> = {}) =>
		request(`${url.origin}/upload?${query}`, { headers: { origin: url.origin, "content-type": "application/octet-stream", ...headers }, body });
	return { origin: url.origin, token, received, upload };
}

const CSV = Buffer.from("Trade Date,Type\r\n10/27/2026,Write option\r\n");

test("网页上传：带 token 和本机 Origin 的文件交给宿主，回编号、文件名和大小", async (t) => {
	const g = await gateway(t);
	const got = await g.upload(`token=${g.token}&name=${encodeURIComponent("导出 export.csv")}&type=text%2Fcsv`, CSV);
	assert.equal(got.status, 200, got.body);
	assert.deepEqual(JSON.parse(got.body), { id: "up-0123456789ab", name: "导出 export.csv", size: CSV.length });
	assert.deepEqual(g.received, [{ name: "导出 export.csv", type: "text/csv", bytes: CSV }]);
});

test("网页上传：没有 token 401，外站 Origin 403，正文类型不对 415，没有文件名或空文件 400，GET 405", async (t) => {
	const g = await gateway(t);
	assert.equal((await g.upload("name=a.csv", CSV)).status, 401);
	assert.equal((await g.upload(`token=${g.token}&name=a.csv`, CSV, { origin: "https://evil.example" })).status, 403);
	assert.equal((await g.upload(`token=${g.token}&name=a.csv`, CSV, { "content-type": "text/plain" })).status, 415);
	assert.equal((await g.upload(`token=${g.token}`, CSV)).status, 400);
	assert.equal((await g.upload(`token=${g.token}&name=a.csv`, Buffer.alloc(0))).status, 400);
	assert.equal((await request(`http://${new URL(g.origin).host}/upload?token=${g.token}&name=a.csv`, { method: "GET" })).status, 405);
	assert.deepEqual(g.received, []);
});

test("网页上传：超过 10 MB 的文件 413，宿主收不到", async (t) => {
	const g = await gateway(t);
	const got = await g.upload(`token=${g.token}&name=big.csv`, Buffer.alloc(UPLOAD_MAX_BYTES + 1));
	assert.equal(got.status, 413);
	assert.deepEqual(g.received, []);
});
