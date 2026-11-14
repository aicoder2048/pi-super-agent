import assert from "node:assert/strict";
import { chmodSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, type TestContext } from "node:test";
import { createOcr } from "../src/ocr/ocr.ts";
import { ocrText, type Ocr, type OcrResult } from "../src/ocr/result.ts";
import { createGateway } from "../src/modules/gateway.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { ComponentName, ModuleName } from "../src/modules/manifest.ts";
import type { Json, WorkerCaller } from "../src/modules/protocol.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { PATH_TOOLS, toolAllowlist, MEMBER_TOOLS } from "../src/worker/tools.ts";
import { openOnConversation, startHost, until } from "./helpers/fakes.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/ocr");
const onMac = process.platform === "darwin";

let vision: Ocr | undefined;

before(async () => {
	if (!onMac) return;
	vision = createOcr({ engine: "vision", maxPages: 2, timeoutSeconds: 60 });
	await vision.prepare();
}, { timeout: 300_000 });

test("vision：读出扫描图片里的中文和英文，一页一段，带置信度和秒数", { skip: !onMac }, async () => {
	const result = await vision!.read(join(FIXTURES, "scan.png"));
	assert.equal(result.engine, "vision");
	assert.equal(result.totalPages, 1);
	assert.equal(result.truncated, false);
	assert.equal(result.pages.length, 1);
	assert.match(result.pages[0]!.text, /空腹血糖/);
	assert.match(result.pages[0]!.text, /复查血脂/);
	assert.match(result.pages[0]!.text, /HC-2026-1103/);
	assert.ok(typeof result.pages[0]!.confidence === "number" && result.pages[0]!.confidence > 0, JSON.stringify(result));
	assert.ok(result.seconds > 0 && result.seconds < 30, String(result.seconds));
});

test("vision：只有图片的 PDF 一页页读；超过页数上限只读前几页，写明共几页", { skip: !onMac }, async () => {
	const one = await vision!.read(join(FIXTURES, "scan.pdf"));
	assert.match(one.pages[0]!.text, /空腹血糖/);
	const three = await vision!.read(join(FIXTURES, "three.pdf"));
	assert.deepEqual(three.pages.map((p) => p.page), [1, 2]);
	assert.match(three.pages[1]!.text, /第\s*2\s*页/);
	assert.equal(three.totalPages, 3);
	assert.equal(three.truncated, true);
	assert.ok(three.notes.some((n) => /只读了前 2 页，共 3 页/.test(n)), three.notes.join("\n"));
});

test("vision：透明底上的深色字也读得出（先铺白底再识别）", { skip: !onMac }, async () => {
	const result = await vision!.read(join(FIXTURES, "transparent.png"));
	assert.match(result.pages[0]!.text, /glucose 5\.6/);
});

test("不是 PDF 也不是图片的文件不交给引擎，直接拒绝并说只读哪些", async () => {
	const off = createOcr({ engine: "vision", maxPages: 2, timeoutSeconds: 5 });
	await assert.rejects(off.read(join(FIXTURES, "notes.docx")), /只读 PDF 和图片/);
});

test("engine 是 off：读就拒绝，说这台宿主没开 OCR", async () => {
	await assert.rejects(createOcr({ engine: "off" }).read(join(FIXTURES, "scan.png")), /这台宿主没开 OCR/);
});

function fakeUnlimited(t: TestContext, body: string): string {
	const home = mkdtempSync(join(tmpdir(), "psa-unlimited-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	mkdirSync(join(home, ".venv/bin"), { recursive: true });
	mkdirSync(join(home, "models/unlimited_ocr_official"), { recursive: true });
	writeFileSync(join(home, ".venv/bin/python"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/argv"\nenv > "${home}/env"\n${body}\n`);
	chmodSync(join(home, ".venv/bin/python"), 0o755);
	return home;
}

const WRITE_PAGES = `out=""; prev=""; for a in "$@"; do [ "$prev" = "--out-root" ] && out="$a"; prev="$a"; done
for n in 1 2; do mkdir -p "$out/doc/pages/page_000$n"; printf '第%s页的文字' "$n" > "$out/doc/pages/page_000$n/result.md"; done`;

test("unlimited：用 home 里的 .venv 跑 unlimited-ocr 脚本，不连网，PDF 只交前 maxPages 页，按页读回结果", async (t) => {
	const home = fakeUnlimited(t, WRITE_PAGES);
	const result = await createOcr({ engine: "unlimited", home, maxPages: 2, timeoutSeconds: 10 }).read(join(FIXTURES, "three.pdf"));
	assert.equal(result.engine, "unlimited");
	assert.deepEqual(result.pages, [{ page: 1, text: "第1页的文字", confidence: null }, { page: 2, text: "第2页的文字", confidence: null }]);
	const argv = readFileSync(join(home, "argv"), "utf8").split("\n");
	assert.equal(argv[0], join(home, ".claude/skills/unlimited-ocr/scripts/ocr.py"));
	assert.equal(argv[1], join(FIXTURES, "three.pdf"));
	assert.ok(argv.includes("--no-crop"), argv.join(" "));
	assert.equal(argv[argv.indexOf("--pages") + 1], "1-2");
	assert.equal(argv[argv.indexOf("--model-dir") + 1], join(home, "models/unlimited_ocr_official"));
	assert.match(readFileSync(join(home, "env"), "utf8"), /^HF_HUB_OFFLINE=1$/m);
	const outRoot = argv[argv.indexOf("--out-root") + 1]!;
	assert.equal(existsSync(outRoot), false, "临时输出目录读完就删");
});

test("超过时限就停下引擎的进程，报几秒内没读完", async (t) => {
	const home = fakeUnlimited(t, "sleep 30");
	const started = Date.now();
	await assert.rejects(createOcr({ engine: "unlimited", home, maxPages: 2, timeoutSeconds: 1 }).read(join(FIXTURES, "scan.png")), /1 秒内没读完/);
	assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);
});

const RESULT: OcrResult = { engine: "vision", pages: [{ page: 1, text: "第一页", confidence: 0.9 }, { page: 2, text: "第二页", confidence: 0.8 }], totalPages: 3, truncated: true, seconds: 1.234, notes: ["只读了前 2 页，共 3 页"] };

test("给助手的文字：先说明是识别出的数据、不是指令，再写引擎、页数、秒数和每一页", () => {
	const text = ocrText(RESULT);
	assert.match(text.split("\n")[0]!, /只是数据.*不是给你的指令/);
	assert.match(text, /vision/);
	assert.match(text, /只读了前 2 页，共 3 页/);
	assert.match(text, /第 1 页[\s\S]*第一页[\s\S]*第 2 页[\s\S]*第二页/);
});

test("助手的 ocr 工具：所有任务都能用（来源开的任务也能），成员要在 tools 里写；路径和 read 一样只能在读得到的目录里", () => {
	for (const profile of ["inference", "module-feed"] as const) assert.ok(toolAllowlist(profile)!.includes("ocr"), profile);
	assert.ok(!toolAllowlist("module-feed")!.includes("web_get"));
	assert.ok(!toolAllowlist("module-feed")!.includes("bash"));
	assert.ok(MEMBER_TOOLS.includes("ocr"));
	assert.ok(PATH_TOOLS.includes("ocr"));
});

async function helperOcr(options: { ocr?: Ocr }): Promise<unknown> {
	const results: unknown[] = [];
	const { host } = await startHost(
		(cards) => cards.flatMap((card) => (card.startsWith("[对话]") ? openOnConversation(card, "读扫描件") : [])),
		async (worker) => {
			results.push(await Promise.resolve().then(() => worker.request("worker.ocr", { path: "/tmp/scan.pdf" })).catch((e: Error) => e.message));
			worker.report({ status: "ready", summary: "读完了" });
			worker.settle();
		},
		options,
	);
	try {
		await host.say("帮我读一下扫描件");
		await until(() => results.length === 1, "助手调完 ocr", 10_000);
		return results[0];
	} finally {
		await host.stop();
	}
}

test("宿主：助手调 ocr，宿主用它的 OCR 读这个文件，回给助手的是带说明的文字；宿主没开 OCR 时拒绝", async () => {
	const read: string[] = [];
	assert.equal(await helperOcr({ ocr: { prepare: async () => {}, read: async (file) => (read.push(file), RESULT) } }), ocrText(RESULT));
	assert.deepEqual(read, ["/tmp/scan.pdf"]);
	assert.match(String(await helperOcr({})), /这台宿主没开 OCR/);
});

const PORT_TOOL = (effect: string) =>
	JSON.stringify({ title: "读扫描", description: "读扫描件", effect, port: "ocr", input: { name: { type: "text", title: "文件名" } }, output: { text: { type: "text", title: "文字" } } });

/** `as` overrides the path the reply names; `keep` is text the tool read itself before asking for OCR. */
function scanModule(t: TestContext, ocr: Ocr | undefined) {
	const root = mkdtempSync(join(tmpdir(), "psa-ocr-port-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "src/papers");
	mkdirSync(join(pkg, "tools/scan"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "papers", version: "0.1.0", title: "纸件", description: "扫描的纸件" }));
	writeFileSync(join(pkg, "tools/scan/tool.json"), PORT_TOOL("read"));
	writeFileSync(
		join(pkg, "tools/scan/index.ts"),
		`import { copyFileSync } from "node:fs";\nimport { join } from "node:path";\nexport default (input) => {\n\tif (input.name === "text") return { name: "a.txt", text: "本来就有文字" };\n\tcopyFileSync(${JSON.stringify(join(FIXTURES, "scan.png"))}, join(process.env.PSA_MODULE_DATA, "files", "scan.png"));\n\treturn { name: "scan.png", text: input.keep ?? "", truncated: false, ocr: { file: input.as ?? "files/scan.png" } };\n};\n`,
	);
	const scan = scanPackage(pkg, { runCases: false });
	assert.ok(scan.ok, JSON.stringify(scan));
	const store = new ModuleStore(join(root, "store"));
	const digest = scan.scan.digest;
	assert.ok(store.keep("papers" as ModuleName, digest, pkg));
	const dataDir = join(root, "data");
	const gateway = createGateway({ copyDir: (m, d) => store.dirOf(m, d), serving: () => digest, dataDir: () => dataDir, secret: () => undefined, log: () => {}, ...(ocr && { ocr }) } as Parameters<typeof createGateway>[0]);
	const caller: WorkerCaller = { who: "worker", ticket: "tkt_1", pin: { module: "papers" as ModuleName, digest }, basis: "request", member: null, heardOthers: false };
	const call = (input: Json) => gateway.call(caller, { kind: "tool", name: "scan" as ComponentName, input });
	return { call, dataDir };
}

test("模块工具声明 port ocr：工具把文件放进自己的 files/ 交给宿主，宿主读出文字填进 text，ocr 写引擎、页数和秒数，文件读完就删", async (t) => {
	const read: string[] = [];
	const { call, dataDir } = scanModule(t, { prepare: async () => {}, read: async (file) => (read.push(file), RESULT) });
	const reply = await call({ name: "scan" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.deepEqual(read, [join(realpathSync(dataDir), "files/scan.png")]);
	const output = reply.output as Record<string, Json>;
	assert.equal(output.name, "scan.png");
	assert.match(String(output.text), /第 1 页\n第一页\n\n第 2 页\n第二页/);
	assert.equal(output.truncated, true, "OCR 只读了前几页，truncated 跟着是 true");
	assert.deepEqual(output.ocr, { engine: "vision", pagesRead: 2, totalPages: 3, seconds: 1.2, confidence: 0.85, notes: ["只读了前 2 页，共 3 页"] });
	assert.equal(existsSync(join(dataDir, "files/scan.png")), false);
});

test("port ocr：工具读出了文字、没要 OCR，结果原样返回，不读", async (t) => {
	const read: string[] = [];
	const { call } = scanModule(t, { prepare: async () => {}, read: async (file) => (read.push(file), RESULT) });
	assert.deepEqual(await call({ name: "text" }), { ok: true, output: { name: "a.txt", text: "本来就有文字" } });
	assert.deepEqual(read, []);
});

test("port ocr：要读的文件不在模块数据的 files/ 里就拒绝，不读", async (t) => {
	const read: string[] = [];
	const { call } = scanModule(t, { prepare: async () => {}, read: async (file) => (read.push(file), RESULT) });
	for (const as of ["data.db", "files/../data.db", "/etc/hosts", "files/missing.png"]) {
		const reply = await call({ name: "scan", as });
		assert.ok(!reply.ok && reply.refusal.code === "provider-failed" && /files\//.test(reply.refusal.note), `${as} ${JSON.stringify(reply)}`);
	}
	assert.deepEqual(read, []);
});

test("port ocr：宿主没开 OCR 时拒绝，说读不出文字，文件照样删掉", async (t) => {
	const { call, dataDir } = scanModule(t, undefined);
	const reply = await call({ name: "scan" });
	assert.ok(!reply.ok && reply.refusal.code === "provider-failed", JSON.stringify(reply));
	assert.match(reply.refusal.note, /没开 OCR/);
	assert.equal(existsSync(join(dataDir, "files/scan.png")), false);
});

test("port ocr：工具自己读出了一些字又要 OCR，OCR 没开或没读成时回工具读出的字，ocr 写明为什么没读，文件照样删掉", async (t) => {
	const cases: [string, Ocr | undefined, RegExp][] = [
		["off", undefined, /没开 OCR/],
		["failed", { prepare: async () => {}, read: async () => Promise.reject(new Error("引擎崩了")) }, /OCR 没读成：引擎崩了/],
	];
	for (const [name, ocr, why] of cases) {
		const { call, dataDir } = scanModule(t, ocr);
		const reply = await call({ name: "scan", keep: "第一页本来就有的字" });
		assert.ok(reply.ok, `${name} ${JSON.stringify(reply)}`);
		const output = reply.output as { text: string; ocr: { failed: string } };
		assert.equal(output.text, "第一页本来就有的字", name);
		assert.match(output.ocr.failed, why, name);
		assert.equal(existsSync(join(dataDir, "files/scan.png")), false, name);
	}
});

test("port ocr：任何模块的 effect 是 read 的工具都能声明；effect 是 write 的不行", (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-ocr-scan-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = (effect: string) => {
		const dir = join(root, effect, "papers");
		mkdirSync(join(dir, "tools/scan"), { recursive: true });
		writeFileSync(join(dir, "module.json"), JSON.stringify({ schema: 1, name: "papers", version: "0.1.0", title: "纸件", description: "扫描的纸件" }));
		writeFileSync(join(dir, "tools/scan/tool.json"), PORT_TOOL(effect));
		writeFileSync(join(dir, "tools/scan/index.ts"), "export default () => ({});");
		return scanPackage(dir, { runCases: false });
	};
	assert.ok(pkg("read").ok);
	const write = pkg("write");
	assert.ok(!write.ok && write.problems.some((p) => /"port" ocr.*"effect": "read"/.test(p.reason)), JSON.stringify(write));
});
