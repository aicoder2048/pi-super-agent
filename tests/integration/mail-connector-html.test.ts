import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../../src/modules.ts";
import { gmailAccount } from "../../src/modules/connectors/gmail.ts";
import { letterOf, type GmailMessage } from "../../src/modules/connectors/letter.ts";
import { MailConnector } from "../../src/modules/connectors/mail.ts";
import type { FeedPorts } from "../../src/modules/feed-runner.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import { startFakeGoogle } from "../helpers/fake-google.ts";
import { FakeInbox, type Letter } from "../helpers/fake-gmail.ts";
import { servedAsHost } from "../helpers/fakes.ts";

const REFRESH = "1//fake-refresh-mail";
const DESK = "Desk <desk@broker.example.com>";

/** A module that keeps what its handler sees of each letter's html; a subject with 坏 makes the handler throw. */
function fillsPackage(dir: string): void {
	mkdirSync(join(dir, "feeds/fills"), { recursive: true });
	mkdirSync(join(dir, "data/fills"), { recursive: true });
	writeFileSync(join(dir, "module.json"), JSON.stringify({ schema: 1, name: "fills", version: "0.1.0", title: "成交" }));
	const text = (title: string) => ({ type: "text", title });
	writeFileSync(join(dir, "data/fills/collection.json"), JSON.stringify({ title: "成交", kind: "record", class: "private", fields: { gmailId: text("Gmail 编号"), body: text("正文"), html: text("HTML"), hasHtml: text("有没有 html 键") } }));
	writeFileSync(join(dir, "feeds/fills/feed.json"), JSON.stringify({ title: "成交确认", connector: "mail", handler: "index.ts", every: "5m", settings: { senders: ["@broker.example.com"] }, into: "fills" }));
	writeFileSync(
		join(dir, "feeds/fills/index.ts"),
		`export default ({ items: [letter] }) => {
	if (letter.subject.includes("坏")) throw new Error("读不懂这封确认信");
	return { records: [{ id: letter.id, gmailId: letter.id, body: letter.body, html: letter.html ?? "", hasHtml: String("html" in letter) }] };
};\n`,
	);
}

async function world(t: TestContext) {
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	t.after(() => google.close());
	const root = mkdtempSync(join(tmpdir(), "psa-mail-html-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	fillsPackage(join(root, "modules", "fills"));
	const fills = servedAsHost(Modules.load([join(root, "modules")])).feeds().find((e) => e.source === "fills/fills")!;
	const data = instanceData(join(root, "state"));
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: REFRESH };
	const ports: FeedPorts = { data, submit: () => {}, alert: () => true, badge: () => {}, problem: () => {}, connectorProblem: () => {}, secret: () => undefined, now: () => Date.now() };
	const rejectedDir = join(root, "rejected");
	const mail = new MailConnector({ account: gmailAccount({ secret: (name) => secrets[name], oauthUrl: google.url }), rejectedDir: () => rejectedDir, rejected: () => {} });
	await mail.beat(fills, ports);
	const seen = async (...letters: Letter[]) => {
		box.deliver(...letters);
		assert.equal((await mail.beat(fills, ports)).ok, true);
		return Object.fromEntries(data.query("fills", fills.components, "fills", {}, "test").rows.map((r) => [r.fields["gmailId"], r.fields]));
	};
	return { box, mail, fills, ports, seen, rejectedDir };
}

const b64 = (bytes: string | Uint8Array) => Buffer.from(bytes).toString("base64url");
const ct = (value: string) => ({ name: "Content-Type", value });
const QP = { name: "Content-Transfer-Encoding", value: "quoted-printable" };

const PLAIN = "合约 成交数量 挂单数量\nSPY 2026-12-18 600C 3\n";
const TABLE = '<html><body><table><tr><th>合约</th><th>成交数量</th><th>挂单数量</th></tr><tr><td>SPY 2026-12-18 600C</td><td></td><td>3</td></tr></table><img src="cid:logo@example.com"></body></html>';

/** A desk's reply the way Gmail serves it: related(alternative(text/plain, text/html), inline image). Gmail has already undone the transfer encoding. */
function related(html: { headers: { name: string; value: string }[]; bytes: Uint8Array }): Record<string, unknown> {
	return {
		partId: "",
		mimeType: "multipart/related",
		filename: "",
		body: { size: 0 },
		parts: [
			{
				partId: "0",
				mimeType: "multipart/alternative",
				filename: "",
				headers: [ct('multipart/alternative; boundary="b2"')],
				body: { size: 0 },
				parts: [
					{ partId: "0.0", mimeType: "text/plain", filename: "", headers: [ct('text/plain; charset="UTF-8"')], body: { size: Buffer.byteLength(PLAIN), data: b64(PLAIN) } },
					{ partId: "0.1", mimeType: "text/html", filename: "", headers: html.headers, body: { size: html.bytes.length, data: b64(html.bytes) } },
				],
			},
			{ partId: "1", mimeType: "image/png", filename: "logo.png", headers: [ct("image/png"), { name: "Content-ID", value: "<logo@example.com>" }], body: { size: 2048, attachmentId: "att-logo" } },
		],
	};
}

test("related(alternative(纯文本, HTML), 图) 的信：handler 拿到 html，原样是那张表；body 照旧是纯文本", async (t) => {
	const w = await world(t);
	const rows = await w.seen({ id: "m-fill", from: DESK, subject: "成交回报", payload: related({ headers: [ct('text/html; charset="UTF-8"'), QP], bytes: Buffer.from(TABLE) }) });
	assert.equal(rows["m-fill"]?.["html"], TABLE);
	assert.equal(rows["m-fill"]?.["body"], PLAIN);
});

test("HTML 按它那一段的 charset 解码：windows-1252 和 GBK 都对，Gmail 已解开的 quoted-printable 不再解第二次", async (t) => {
	const w = await world(t);
	const cp1252 = Buffer.concat([Buffer.from("<td>Avg "), Buffer.from([0x80]), Buffer.from("2.15 caf"), Buffer.from([0xe9]), Buffer.from(" x=41 =20</td>")]);
	const gbk = Buffer.concat([Buffer.from("<td>"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from("</td>")]);
	const rows = await w.seen(
		{ id: "m-1252", from: DESK, payload: related({ headers: [ct("text/html; charset=windows-1252"), QP], bytes: cp1252 }) },
		{ id: "m-gbk", from: DESK, payload: related({ headers: [ct('text/html; charset="GBK"')], bytes: gbk }) },
	);
	assert.equal(rows["m-1252"]?.["html"], "<td>Avg €2.15 café x=41 =20</td>");
	assert.equal(rows["m-gbk"]?.["html"], "<td>你好</td>");
});

test("只有纯文本的信：handler 拿到的信没有 html 这个键", async (t) => {
	const w = await world(t);
	const rows = await w.seen({ id: "m-plain", from: DESK, text: "Filled 1 @ 2.15" });
	assert.equal(rows["m-plain"]?.["hasHtml"], "false");
	assert.equal(rows["m-plain"]?.["body"], "Filled 1 @ 2.15");
});

test("handler 读不懂、信被拒收：拒收记录里没有 HTML", async (t) => {
	const w = await world(t);
	const letter: Letter = { id: "m-bad", from: DESK, subject: "成交回报 坏", payload: related({ headers: [ct('text/html; charset="UTF-8"')], bytes: Buffer.from(TABLE) }) };
	w.box.deliver(letter);
	for (const beat of [1, 2, 3]) assert.equal((await w.mail.beat(w.fills, w.ports)).ok, beat === 3, `第 ${beat} 拍`);
	const [file] = readdirSync(w.rejectedDir);
	const record = readFileSync(join(w.rejectedDir, file!), "utf8");
	assert.ok(!record.includes("挂单数量") && !record.includes("<table"), record);
});

const DESK_BOX = { name: "", address: "desk@broker.example.com" };
const part = (mimeType: string, text: string) => ({ mimeType, filename: "", headers: [ct(`${mimeType}; charset=utf-8`)], body: { data: b64(text) } });
const forwarded = { mimeType: "message/rfc822", filename: "", body: {}, parts: [{ mimeType: "multipart/alternative", parts: [part("text/plain", "ORDER 10"), part("text/html", "<td>ORDER 10</td>")] }] };

test("转发进来的原信的 HTML 不算这封信的 html；这封信自己的 HTML 太大、只给附件号的，也不拿后面的顶替", () => {
	const plainReply: GmailMessage = { id: "m-fwd", payload: { mimeType: "multipart/mixed", parts: [part("text/plain", "Filled 3"), forwarded] } };
	assert.equal("html" in letterOf(plainReply, DESK_BOX), false, "只有纯文本的回信带着原单");
	const bigHtml: GmailMessage = { id: "m-big-fwd", payload: { mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: [part("text/plain", "Filled 3"), { mimeType: "text/html", filename: "", body: { attachmentId: "att-html", size: 900_000 } }] }, forwarded] } };
	assert.equal("html" in letterOf(bigHtml, DESK_BOX), false, "外层 HTML 只有附件号");
	const own: GmailMessage = { id: "m-own", payload: { mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: [part("text/plain", "Filled 3"), part("text/html", "<td>FILLED 3</td>")] }, forwarded] } };
	assert.equal(letterOf(own, DESK_BOX).html, "<td>FILLED 3</td>");
});

test("HTML 最多 256 KB，比正文的 64 KB 宽：超出的按字截断，末尾写明，整串不超过 256 KB", () => {
	const big = `<p>${"成交".repeat(60_000)}</p>`;
	const message: GmailMessage = { id: "m-big", payload: { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", headers: [ct("text/html; charset=utf-8")], body: { data: b64(big) } }] } };
	const html = letterOf(message, DESK_BOX).html!;
	assert.ok(Buffer.byteLength(html) <= 256 * 1024 && Buffer.byteLength(html) > 255 * 1024, String(Buffer.byteLength(html)));
	assert.ok(html.startsWith("<p>成交成交") && !html.includes("\uFFFD"));
	assert.ok(html.endsWith("\n\n[HTML 超过 256 KB，后面截掉了，全文在 Gmail 里看]"), html.slice(-80));
	const rows = `<table>${'<tr><td class="q">1</td><td class="w">2</td></tr>'.repeat(9_000)}</table>`;
	const cut = letterOf({ id: "m-rows", payload: { mimeType: "text/html", body: { data: b64(rows) } } }, DESK_BOX).html!;
	assert.match(cut, /<\/tr>\n\n\[HTML 超过 256 KB/, "截在一行表格的后面，不留半行");
	const wide = `<table>${"<tr><td>1</td><td></td></tr>".repeat(4_000)}</table>`;
	const under: GmailMessage = { id: "m-wide", payload: { mimeType: "text/html", body: { data: b64(wide) } } };
	assert.equal(letterOf(under, DESK_BOX).html, wide, "比正文的 64 KB 大、不到 256 KB 的 HTML 不截");
});
