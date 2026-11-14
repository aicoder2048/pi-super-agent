import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { runFeed, type FeedPorts } from "../src/modules/feed-runner.ts";
import { lockOf, venvDir, VENV_MARK } from "../src/modules/files.ts";
import { createGateway } from "../src/modules/gateway.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { moduleDataDir } from "../src/modules/knowledge.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { ComponentName, ModuleName } from "../src/modules/manifest.ts";
import type { Json, WorkerCaller } from "../src/modules/protocol.ts";
import { runModuleCodeAsync } from "../src/modules/run-code.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { startFakeGoogle } from "./helpers/fake-google.ts";
import { FakeInbox, type Letter } from "./helpers/fake-gmail.ts";
import { brokenImagePdf, formPdf, textPdf } from "./helpers/text-pdf.ts";
import { servedAsHost } from "./helpers/fakes.ts";
import { createOcr } from "../src/ocr/ocr.ts";
import type { Ocr } from "../src/ocr/result.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/mail");
const SCANS = join(import.meta.dirname, "fixtures/ocr");
const TOOL = "tools/read-attachment";
const REFRESH = "1//fake-refresh-mail";
const GMAIL = "/gmail/v1/users/me";
const MB = 1024 * 1024;

type Attachment = NonNullable<Letter["attachments"]>[number];

let realVenv = "";

before(() => {
	realVenv = mkdtempSync(join(tmpdir(), "psa-mail-venv-"));
	const uv = spawnSync("uv", ["sync", "--frozen", "--project", join(PKG, "py")], { env: { ...process.env, UV_PROJECT_ENVIRONMENT: realVenv }, encoding: "utf8" });
	assert.equal(uv.status, 0, `uv sync for the mail py/ project: ${uv.stderr}`);
});

after(() => rmSync(realVenv, { recursive: true, force: true }));

const python = (script: string) => execFileSync(join(realVenv, "bin/python"), ["-c", script]);

type Venv = "real" | "none" | { fake: string };

async function attachmentWorld(t: TestContext, letters: readonly Letter[], { venv = "real" as Venv } = {}) {
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	t.after(() => google.close());
	const root = mkdtempSync(join(tmpdir(), "psa-mail-att-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "modules", "mail");
	cpSync(PKG, pkg, { recursive: true });
	const feedJson = join(pkg, "feeds/inbox/feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }));
	const state = join(root, "state");
	const data = instanceData(state);
	const dataDir = moduleDataDir(state, "mail");
	const entry = servedAsHost(Modules.load([join(root, "modules")])).feeds().find((e) => e.source === "mail/inbox");
	assert.ok(entry, "mail 有 inbox feed");
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: REFRESH };
	const ports: FeedPorts = { data, submit: () => {}, alert: () => {}, problem: () => {}, secret: (name) => secrets[name], now: () => Date.now() };
	data.write("mail", entry.components, "senders", [{ address: "ann@example.com" }], "使用者口述", "test");
	box.deliver(...letters);
	assert.deepEqual(await runFeed(entry, [], ports), { ok: true, records: letters.length, notices: letters.length });

	const lock = lockOf(pkg)!;
	const venvAt = venvDir(dataDir, lock);
	mkdirSync(join(dataDir, "files"), { recursive: true });
	if (venv === "real") symlinkSync(realVenv, venvAt);
	if (typeof venv === "object") {
		mkdirSync(join(venvAt, "bin"), { recursive: true });
		writeFileSync(join(venvAt, "bin/python"), venv.fake);
		chmodSync(join(venvAt, "bin/python"), 0o755);
	}
	if (venv !== "none") writeFileSync(join(venvAt, VENV_MARK), lock);

	/** An entry that runs the tool with some limits lowered, so a guard can be crossed in a fraction of a second. */
	const lowered = (limits: Record<string, number>) => {
		const name = `lowered-${Object.keys(limits).join("-")}.ts`;
		writeFileSync(join(pkg, TOOL, name), `import { LIMITS, readAttachment } from "./index.ts";\nexport default (input) => readAttachment(input, { ...LIMITS, ...${JSON.stringify(limits)} });\n`);
		return name;
	};
	const call = (input: Json, entryFile = "index.ts") => runModuleCodeAsync({ packageDir: pkg, component: TOOL, dataDir }, entryFile, input, secrets);
	const downloads = () => google.log.filter((line) => line.includes("/attachments/"));
	return { box, google, pkg, dataDir, secrets, call, lowered, downloads };
}

const ann = (id: string, attachments: readonly Attachment[]): Letter => ({ id, from: "Ann Lee <ann@example.com>", subject: "附件", snippet: "见附件", text: "见附件", attachments });
const file = (filename: string, mimeType: string, data: string | Uint8Array, extra: Partial<Attachment> = {}): Attachment => ({ filename, mimeType, size: Buffer.byteLength(data), data, ...extra });

test("读附件：txt、md、csv、html 和 PDF 各读出文字，回文件名、类型、页数", async (t) => {
	const w = await attachmentWorld(t, [
		ann("m-1", [
			file("note.txt", "text/plain", "对账单已出，余额 1,234.56 元"),
			file("plan.md", "text/markdown", "# 计划\n\n- 第一步"),
			file("rows.csv", "text/csv", "date,amount\n2026-11-01,12.50\n"),
			file("page.html", "text/html", "<html><head><style>p{color:red}</style></head><body><p>你好&amp;再见</p><script>alert('x')</script></body></html>"),
			file("statement.pdf", "application/pdf", textPdf(["Balance 1234.56", "Thank you"])),
		]),
	]);
	assert.deepEqual(await w.call({ messageId: "m-1", partId: "1" }), { ok: true, output: { name: "note.txt", type: "text/plain", pages: null, text: "对账单已出，余额 1,234.56 元", truncated: false } });
	assert.deepEqual(await w.call({ messageId: "m-1", partId: "2" }), { ok: true, output: { name: "plan.md", type: "text/markdown", pages: null, text: "# 计划\n\n- 第一步", truncated: false } });
	assert.deepEqual(await w.call({ messageId: "m-1", partId: "3" }), { ok: true, output: { name: "rows.csv", type: "text/csv", pages: null, text: "date,amount\n2026-11-01,12.50\n", truncated: false } }, "CSV 原样");
	const html = await w.call({ messageId: "m-1", partId: "4" });
	assert.ok(html.ok);
	assert.equal((html.output as { text: string }).text, "你好&再见", "script 和 style 去掉，实体解码");
	const pdf = await w.call({ messageId: "m-1", partId: "5" });
	assert.ok(pdf.ok, JSON.stringify(pdf));
	assert.deepEqual({ ...(pdf.output as object), text: undefined }, { name: "statement.pdf", type: "application/pdf", pages: 2, text: undefined, truncated: false });
	assert.match((pdf.output as { text: string }).text, /Balance 1234\.56[\s\S]*Thank you/);
});

test("读附件：带 BOM 的 txt 去掉 BOM，解不了的字节换成替代字符", async (t) => {
	const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("前"), Buffer.from([0xff, 0xfe]), Buffer.from("后")]);
	const w = await attachmentWorld(t, [ann("m-1", [file("a.txt", "text/plain", bytes)])]);
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.equal((reply.output as { text: string }).text, "前��后");
});

test("读附件：文字附件按 Content-Type 的 charset 解码；认不出的 charset 按 UTF-8 并标明", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [
		file("gbk.txt", "text/plain", Buffer.from("c4e3bac3a3accac0bde7", "hex"), { charset: "gbk" }),
		file("big5.csv", "text/csv", Buffer.from("bb4fc657a741a66e", "hex"), { charset: "big5" }),
		file("odd.txt", "text/plain", "plain words", { charset: "x-made-up" }),
	])]);
	const text = async (partId: string) => {
		const reply = await w.call({ messageId: "m-1", partId });
		assert.ok(reply.ok, JSON.stringify(reply));
		return (reply.output as { text: string }).text;
	};
	assert.equal(await text("1"), "你好，世界");
	assert.equal(await text("2"), "臺灣你好");
	const odd = await text("3");
	assert.match(odd, /^plain words/);
	assert.match(odd, /附件.*x-made-up/, "认不出的 charset 写明");
});

test("读附件：messageId 不在 messages 里、partId 不属于这封信，都拒绝，不下载", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("a.txt", "text/plain", "x")])]);
	const stranger = await w.call({ messageId: "m-404", partId: "1" });
	assert.ok(!stranger.ok);
	assert.match(stranger.note, /messages 里没有 gmailId 为 m-404 的信/);
	const wrongPart = await w.call({ messageId: "m-1", partId: "0.0" });
	assert.ok(!wrongPart.ok);
	assert.match(wrongPart.note, /这封信没有 partId 为 0\.0 的附件.*1/);
	const missing = await w.call({ messageId: "m-1" } as Json);
	assert.ok(!missing.ok);
	assert.match(missing.note, /messageId 和 partId/);
	assert.deepEqual(w.downloads(), []);
});

test("读附件：超过 10 MB 拒绝，不下载", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("big.txt", "text/plain", "x", { size: 11 * MB })])]);
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(!reply.ok);
	assert.match(reply.note, /附件有 11\.0 MB，超过 10 MB/);
	assert.deepEqual(w.downloads(), []);
});

test("读附件：不认的类型拒绝并写明类型，类型和扩展名对不上也拒绝，都不下载", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("photo.png", "image/jpeg", "png"), file("run.exe", "text/plain", "MZ"), file("a.zip", "application/zip", "PK")])]);
	for (const [partId, shown] of [["1", "image/jpeg（photo.png）"], ["2", "text/plain（run.exe）"], ["3", "application/zip（a.zip）"]] as const) {
		const reply = await w.call({ messageId: "m-1", partId });
		assert.ok(!reply.ok, partId);
		assert.ok(reply.note.includes(`这个附件是 ${shown}，只读 txt、md、csv、html、pdf 和图片（png、jpg、heic、tiff、webp、bmp）`), reply.note);
	}
	assert.deepEqual(w.downloads(), []);
});

test("读附件：通用类型（QQ 邮箱发的 octet-stream 等）按扩展名选读法", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [
		file("note.txt", "application/octet-stream", "对账单已出"),
		file("rows.csv", "binary/octet-stream", "a,b\n1,2\n"),
		file("statement.pdf", "application/octet-stream", textPdf(["Balance 1234.56"])),
		file("plan.md", "application/x-download", "# 计划"),
		file("page.html", "", "<p>你好</p>"),
	])]);
	const read = async (partId: string) => {
		const reply = await w.call({ messageId: "m-1", partId });
		assert.ok(reply.ok, `${partId} ${JSON.stringify(reply)}`);
		return reply.output as { type: string; text: string; pages: number | null };
	};
	assert.deepEqual(await read("1"), { name: "note.txt", type: "application/octet-stream", pages: null, text: "对账单已出", truncated: false });
	assert.equal((await read("2")).text, "a,b\n1,2\n");
	const pdf = await read("3");
	assert.equal(pdf.pages, 1);
	assert.match(pdf.text, /Balance 1234\.56/);
	assert.equal((await read("4")).text, "# 计划");
	assert.equal((await read("5")).text, "你好");
});

test("读附件：通用类型的 .pdf 开头不是 %PDF- 就拒绝；不认的扩展名不下载就拒绝", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("fake.pdf", "application/octet-stream", "MZ not a pdf"), file("run.exe", "application/octet-stream", "MZ")])]);
	const fake = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(!fake.ok);
	assert.match(fake.note, /fake\.pdf.*不是 PDF/);
	const before = w.downloads().length;
	const exe = await w.call({ messageId: "m-1", partId: "2" });
	assert.ok(!exe.ok);
	assert.ok(exe.note.includes("这个附件是 application/octet-stream（run.exe），只读 txt、md、csv、html、pdf"), exe.note);
	assert.equal(w.downloads().length, before, "exe 不下载");
});

test("读附件：下载超过上限就拒绝，写「附件下载超时」", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("slow.txt", "text/plain", "x".repeat(4000), { trickleMs: 3000 })])]);
	const started = Date.now();
	const reply = await w.call({ messageId: "m-1", partId: "1" }, w.lowered({ downloadMs: 400 }));
	assert.ok(!reply.ok);
	assert.match(reply.note, /附件下载超时/);
	assert.ok(Date.now() - started < 2500, "不等下载传完");
});

test("读附件：文字超过上限截断，标 truncated", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("long.txt", "text/plain", `${"字".repeat(100_000)}尾巴`)])]);
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(reply.ok, JSON.stringify(reply));
	const output = reply.output as { text: string; truncated: boolean };
	assert.equal([...output.text].length, 100_000);
	assert.ok(!output.text.includes("尾巴"));
	assert.equal(output.truncated, true);
});

test("读附件：PDF 超过 50 页只读前 50 页，pages 是总页数，标 truncated", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("long.pdf", "application/pdf", textPdf(Array.from({ length: 60 }, (_, i) => `Page ${i + 1} end`)))])]);
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(reply.ok, JSON.stringify(reply));
	const output = reply.output as { pages: number; text: string; truncated: boolean };
	assert.equal(output.pages, 60);
	assert.match(output.text, /Page 50 end/);
	assert.doesNotMatch(output.text, /Page 51 end/);
	assert.equal(output.truncated, true);
});

test("读附件：有密码的 PDF 拒绝，读不出的 PDF 也说明", async (t) => {
	const locked = python("import io, sys; from pypdf import PdfWriter; w = PdfWriter(); w.add_blank_page(200, 200); w.encrypt('pw', algorithm='RC4-128'); b = io.BytesIO(); w.write(b); sys.stdout.buffer.write(b.getvalue())");
	const w = await attachmentWorld(t, [ann("m-1", [file("locked.pdf", "application/pdf", locked), file("broken.pdf", "application/pdf", "not a pdf at all")])]);
	const encrypted = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(!encrypted.ok);
	assert.match(encrypted.note, /PDF 有密码，读不了/);
	const broken = await w.call({ messageId: "m-1", partId: "2" });
	assert.ok(!broken.ok);
	assert.match(broken.note, /PDF 读不出来/);
});

test("读附件：解压后超过 pypdf 上限的 PDF 写「PDF 太大，读不了」", async (t) => {
	const bomb = textPdf([deflateSync(Buffer.alloc(100 * MB, 0x20), { level: 9 })]);
	const w = await attachmentWorld(t, [ann("m-1", [file("bomb.pdf", "application/pdf", bomb)])]);
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(!reply.ok);
	assert.match(reply.note, /PDF 太大，读不了/);
});

test("读附件：PDF 子进程超过时限被杀，写明原因，进程不在了", async (t) => {
	const pidFile = join(tmpdir(), `psa-mail-pid-${process.pid}-${Date.now()}`);
	t.after(() => rmSync(pidFile, { force: true }));
	const w = await attachmentWorld(t, [ann("m-1", [file("a.pdf", "application/pdf", textPdf(["x"]))])], { venv: { fake: `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n` } });
	const started = Date.now();
	const reply = await w.call({ messageId: "m-1", partId: "1" }, w.lowered({ pdfMs: 500 }));
	assert.ok(!reply.ok);
	assert.match(reply.note, /PDF 太复杂，0\.5 秒内读不完/);
	assert.ok(Date.now() - started < 5000);
	assert.equal(spawnSync("kill", ["-0", readFileSync(pidFile, "utf8").trim()]).status, 1, "子进程已经不在了");
});

test("读附件：PDF 子进程内存超过上限被杀，写「PDF 太大，读不了」", async (t) => {
	const hog = `#!/bin/sh\nexec python3 -c "import time; b = b'x' * (300 * 1024 * 1024); time.sleep(30)"\n`;
	const w = await attachmentWorld(t, [ann("m-1", [file("a.pdf", "application/pdf", textPdf(["x"]))])], { venv: { fake: hog } });
	const reply = await w.call({ messageId: "m-1", partId: "1" }, w.lowered({ rssBytes: 100 * MB }));
	assert.ok(!reply.ok);
	assert.match(reply.note, /PDF 太大，读不了/);
});

test("读附件：PDF 子进程的环境只有 PATH 和 PSA_MODULE_VENV，没有密钥", async (t) => {
	const printEnv = `#!/bin/sh\ncat > /dev/null\nnames=$(env | cut -d= -f1 | grep -v '^PWD$' | grep -v '^SHLVL$' | grep -v '^_$' | sort | tr '\\n' ' ')\nprintf '{"pages": 1, "text": "%s", "truncated": false}\\n' "$names"\n`;
	const w = await attachmentWorld(t, [ann("m-1", [file("a.pdf", "application/pdf", textPdf(["x"]))])], { venv: { fake: printEnv } });
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.equal((reply.output as { text: string }).text.trim(), "PATH PSA_MODULE_VENV");
});

test("读附件：没装 Python 环境时说明先跑 just module setup mail", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("a.pdf", "application/pdf", textPdf(["x"]))])], { venv: "none" });
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(!reply.ok);
	assert.match(reply.note, /just module setup mail/);
});

test("读附件：调用前后 files/ 里没有多出东西，附件不落盘", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("a.txt", "text/plain", "x"), file("b.pdf", "application/pdf", textPdf(["secret page"]))])]);
	const listing = () => readdirSync(join(w.dataDir, "files"), { recursive: true }).sort();
	const before = listing();
	assert.ok((await w.call({ messageId: "m-1", partId: "1" })).ok);
	assert.ok((await w.call({ messageId: "m-1", partId: "2" })).ok);
	assert.deepEqual(listing(), before);
});

function gatewayOver(t: TestContext, w: Awaited<ReturnType<typeof attachmentWorld>>, ocr?: Ocr) {
	const scan = scanPackage(w.pkg, { runCases: false });
	assert.ok(scan.ok, JSON.stringify(scan));
	const store = new ModuleStore(join(w.dataDir, "..", "..", "store"));
	const digest = scan.scan.digest;
	assert.ok(store.keep("mail" as ModuleName, digest, w.pkg));
	const gateway = createGateway({ copyDir: (module, pin) => store.dirOf(module, pin), serving: () => digest, dataDir: () => w.dataDir, rows: {} as never, secret: (name) => w.secrets[name], log: () => {}, ...(ocr && { ocr }) });
	const caller: WorkerCaller = { who: "worker", ticket: "tkt_1", pin: { module: "mail" as ModuleName, digest }, basis: "inference", member: null, heardOthers: false };
	return { gateway, caller };
}

test("读附件：一页页只有一张图、几乎没字的 PDF 当扫描件，附件原样放进 files/ 交给宿主 OCR，回的 text 是空的；只有几个字的文字 PDF 照常读", async (t) => {
	const scanned = readFileSync(join(SCANS, "three.pdf"));
	const w = await attachmentWorld(t, [ann("m-1", [file("scan.pdf", "application/pdf", scanned), file("short.pdf", "application/pdf", textPdf(["Paid"]))])]);
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(reply.ok, JSON.stringify(reply));
	const output = reply.output as { name: string; pages: number; text: string; ocr: { file: string } };
	assert.deepEqual({ ...output, ocr: undefined }, { name: "scan.pdf", type: "application/pdf", pages: 3, text: "", truncated: false, ocr: undefined });
	assert.match(output.ocr.file, /^files\/ocr-[0-9a-f]{16}\.pdf$/);
	assert.ok(readFileSync(join(w.dataDir, output.ocr.file)).equals(scanned), "交给宿主的就是附件原样");
	assert.deepEqual(await w.call({ messageId: "m-1", partId: "2" }), { ok: true, output: { name: "short.pdf", type: "application/pdf", pages: 1, text: "Paid", truncated: false } });
});

test("读附件：扫描图包在 Form XObject 里的 PDF（合并、另存、打印成 PDF 常见）也当扫描件交给宿主 OCR；Form 引用自己不会卡住", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("merged.pdf", "application/pdf", formPdf("image")), file("loop.pdf", "application/pdf", formPdf("loop"))])]);
	const reply = await w.call({ messageId: "m-1", partId: "1" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.match((reply.output as { ocr?: { file: string } }).ocr?.file ?? "", /^files\/ocr-[0-9a-f]{16}\.pdf$/, JSON.stringify(reply.output));
	assert.deepEqual(await w.call({ messageId: "m-1", partId: "2" }), { ok: true, output: { name: "loop.pdf", type: "application/pdf", pages: 1, text: "", truncated: false } });
});

test("读附件：某页的图片表坏了（指向不存在的对象、条目是 null、整个是数组），那页只是不算扫描件，别的页的字照常读出来", async (t) => {
	const broken = { dangling: "<< /Im9 99 0 R >>", "null-entry": "<< /Im9 null >>", array: "[1 2]" };
	const w = await attachmentWorld(t, [ann("m-1", Object.entries(broken).map(([name, xobject]) => file(`${name}.pdf`, "application/pdf", brokenImagePdf("Fasting glucose 5.6 mmol/L", xobject))))]);
	for (const [i, name] of Object.keys(broken).entries()) {
		assert.deepEqual(await w.call({ messageId: "m-1", partId: String(i + 1) }), { ok: true, output: { name: `${name}.pdf`, type: "application/pdf", pages: 2, text: "Fasting glucose 5.6 mmol/L", truncated: false } }, name);
	}
});

test("读附件：png、jpg、heic、tiff、webp、bmp 图片附件交给宿主 OCR；通用类型按扩展名认", async (t) => {
	const png = readFileSync(join(SCANS, "scan.png"));
	const w = await attachmentWorld(t, [ann("m-1", [
		file("scan.png", "image/png", png),
		file("photo.JPG", "image/jpeg", "jpg"),
		file("IMG_1.heic", "image/heic", "heic"),
		file("fax.tif", "application/octet-stream", "tif"),
		file("shot.jpg", "image/jpg", "jpg"),
		file("web.webp", "image/webp", "webp"),
		file("old.bmp", "image/bmp", "bmp"),
	])]);
	for (const [partId, extension] of [["1", "png"], ["2", "jpg"], ["3", "heic"], ["4", "tif"], ["5", "jpg"], ["6", "webp"], ["7", "bmp"]] as const) {
		const reply = await w.call({ messageId: "m-1", partId });
		assert.ok(reply.ok, JSON.stringify(reply));
		const output = reply.output as { pages: number | null; text: string; ocr: { file: string } };
		assert.equal(output.pages, null);
		assert.equal(output.text, "");
		assert.match(output.ocr.file, new RegExp(`^files/ocr-[0-9a-f]{16}\\.${extension}$`));
	}
});

test("读附件经过宿主：扫描的 PDF 由宿主的 Vision 读出中文，files/ 里不留东西", { skip: process.platform !== "darwin" }, async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("scan.pdf", "application/pdf", readFileSync(join(SCANS, "scan.pdf")))])]);
	const ocr = createOcr({ engine: "vision", maxPages: 20, timeoutSeconds: 60 });
	await ocr.prepare();
	const { gateway, caller } = gatewayOver(t, w, ocr);
	const listing = () => readdirSync(join(w.dataDir, "files")).sort();
	const before = listing();
	const reply = await gateway.call(caller, { kind: "tool", name: "read-attachment" as ComponentName, input: { messageId: "m-1", partId: "1" } });
	assert.ok(reply.ok, JSON.stringify(reply));
	const output = reply.output as { text: string; ocr: { engine: string } };
	assert.match(output.text, /空腹血糖/);
	assert.equal(output.ocr.engine, "vision");
	assert.deepEqual(listing(), before);
});

test("读附件：推断任务也能调", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("a.txt", "text/plain", "推断任务读到的附件")])]);
	const { gateway, caller } = gatewayOver(t, w);
	const reply = await gateway.call(caller, { kind: "tool", name: "read-attachment" as ComponentName, input: { messageId: "m-1", partId: "1" } });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.equal((reply.output as { text: string }).text, "推断任务读到的附件");
});

test("读附件：只请求 messages.get 和 attachments.get，不碰别的接口", async (t) => {
	const w = await attachmentWorld(t, [ann("m-1", [file("a.txt", "text/plain", "x")])]);
	w.google.log.length = 0;
	assert.ok((await w.call({ messageId: "m-1", partId: "1" })).ok);
	assert.deepEqual(
		w.google.log.map((line) => line.replace(/\?.*/, "")),
		["POST /token", `GET ${GMAIL}/messages/m-1`, `GET ${GMAIL}/messages/m-1/attachments/att-m-1-1`],
	);
});
