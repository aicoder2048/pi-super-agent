import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { webGet } from "../../src/worker/web-get.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(t: test.TestContext, handler: Handler) {
	const seen: { method: string; url: string; userAgent?: string }[] = [];
	const server = createServer((req, res) => {
		seen.push({ method: req.method!, url: req.url!, userAgent: req.headers["user-agent"] });
		handler(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const port = (server.address() as AddressInfo).port;
	return { seen, port, base: `http://127.0.0.1:${port}` };
}

const html = (body: string): Handler => (_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(body);
};

const loopbackOnly = { allow: (ip: string) => ip === "127.0.0.1" };

test("默认规则拒绝本机地址和解析到本机的域名，请求根本没有发出", async (t) => {
	const s = await serve(t, html("<p>秘密</p>"));
	await assert.rejects(webGet(`${s.base}/`), /公网/);
	await assert.rejects(webGet(`http://localhost:${s.port}/`), /公网/);
	assert.equal(s.seen.length, 0);
});

test("域名解析出的地址里只要有一个不是公网就拒绝", async (t) => {
	const s = await serve(t, html("<p>秘密</p>"));
	const resolve = async () => ["93.184.216.34", "127.0.0.1"];
	await assert.rejects(webGet(`http://example.test:${s.port}/`, { resolve }), /公网/);
	assert.equal(s.seen.length, 0);
});

test("只用 GET 取回页面，HTML 去掉脚本、样式和标签", async (t) => {
	const s = await serve(t, html("<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>标题</h1>\n\n<p>正文 &amp;   内容</p></body></html>"));
	const page = await webGet(`${s.base}/doc`, loopbackOnly);
	assert.equal(page.status, 200);
	assert.equal(page.url, `${s.base}/doc`);
	assert.match(page.contentType, /text\/html/);
	assert.equal(page.text, "标题 正文 & 内容");
	assert.equal(page.truncated, false);
	assert.deepEqual(s.seen, [{ method: "GET", url: "/doc", userAgent: "PiSuperAgent/1.0" }]);
});

test("重定向到元数据地址被拒绝", async (t) => {
	const s = await serve(t, (_req, res) => {
		res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
		res.end();
	});
	await assert.rejects(webGet(`${s.base}/`, loopbackOnly), /公网/);
	assert.equal(s.seen.length, 1);
});

test("同一服务器上的重定向会跟随，返回最终网址", async (t) => {
	const s = await serve(t, (req, res) => {
		if (req.url === "/old") {
			res.writeHead(301, { location: "/new" });
			res.end();
		} else html("<p>新页面</p>")(req, res);
	});
	const page = await webGet(`${s.base}/old`, loopbackOnly);
	assert.equal(page.url, `${s.base}/new`);
	assert.equal(page.text, "新页面");
	assert.deepEqual(s.seen.map((r) => r.url), ["/old", "/new"]);
});

test("重定向次数有上限", async (t) => {
	const s = await serve(t, (_req, res) => {
		res.writeHead(302, { location: "/again" });
		res.end();
	});
	await assert.rejects(webGet(`${s.base}/`, { ...loopbackOnly, maxRedirects: 2 }), /重定向/);
	assert.equal(s.seen.length, 3);
});

test("服务器一直不回应时按时限放弃", async (t) => {
	const s = await serve(t, () => {});
	const started = Date.now();
	await assert.rejects(webGet(`${s.base}/`, { ...loopbackOnly, timeoutMs: 200 }), /超时/);
	assert.ok(Date.now() - started < 2000);
});

test("超过大小上限的内容截断并标明", async (t) => {
	const s = await serve(t, (_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("a".repeat(50_000));
	});
	const page = await webGet(`${s.base}/`, { ...loopbackOnly, maxBytes: 1000 });
	assert.equal(page.truncated, true);
	assert.ok(page.text.length <= 1000);
});

test("超过字数上限的文字截断并标明", async (t) => {
	const s = await serve(t, (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ v: "b".repeat(500) }));
	});
	const page = await webGet(`${s.base}/`, { ...loopbackOnly, maxChars: 100 });
	assert.equal(page.truncated, true);
	assert.equal(page.text.length, 100);
});

test("非文本内容被拒绝", async (t) => {
	const s = await serve(t, (_req, res) => {
		res.writeHead(200, { "content-type": "image/png" });
		res.end(Buffer.alloc(10));
	});
	await assert.rejects(webGet(`${s.base}/`, loopbackOnly), /类型/);
});
