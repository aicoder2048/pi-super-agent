import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startLiveModules } from "../../src/host/live-modules.ts";
import { moduleRows, openStore } from "../../src/kernel/store.ts";
import { Modules } from "../../src/modules.ts";
import { judge, type Attempt, type Exam } from "../../src/modules/rehearse.ts";
import { questionOf, scanPackage } from "../../src/modules/validate.ts";
import { MEMBER_TOOLS, memberTools } from "../../src/worker/tools.ts";

const REPO_MODULES = fileURLToPath(new URL("../../modules", import.meta.url));
const BUILDER = join(REPO_MODULES, "module-builder");
const WRITERS = ["scaffolder", "knowledge-curator", "eval-writer", "checker"];

function scanned() {
	const result = scanPackage(BUILDER);
	assert.ok(result.ok, result.ok ? "" : result.problems.map((p) => `${p.where}: ${p.reason}`).join("\n"));
	return result.scan;
}

test("制作模块 module-builder 是新布局包，just module check 的同一段检查通过，带至少两道考题", () => {
	const scan = scanned();
	assert.equal(scan.manifest.name, "module-builder");
	assert.equal(scan.manifest.team, "模块工坊");
	assert.ok(scan.components.filter((c) => c.kind === "evals").length >= 2);
	assert.ok(scan.components.filter((c) => c.kind === "skills").length >= 3);
});

test("五位专家的 tools 都是成员能有的工具；动手写包的四位有 read、write、edit、bash；推断任务里谁都只剩只读工具", () => {
	const agents = scanned().components.flatMap((c) => (c.kind === "agents" ? [c.agent] : []));
	assert.deepEqual(agents.map((a) => a.name).sort(), ["checker", "eval-writer", "interviewer", "knowledge-curator", "scaffolder"]);
	for (const agent of agents) {
		for (const tool of agent.tools) assert.ok(MEMBER_TOOLS.includes(tool), `${agent.name} 的 ${tool} 是成员工具`);
		assert.deepEqual(agent.uses, [], `${agent.name} 不用模块能力，这个包没有知识、数据和工具`);
		for (const tool of ["write", "edit", "bash"]) assert.ok(!memberTools("inference", agent.tools).includes(tool), `${agent.name} 在推断任务里没有 ${tool}`);
	}
	assert.deepEqual(agents.find((a) => a.name === "interviewer")!.tools, ["read", "write", "edit", "ls"], "访谈只写说明书，不跑命令");
	for (const name of WRITERS) {
		const tools = agents.find((a) => a.name === name)!.tools;
		for (const tool of ["read", "write", "edit", "bash"]) assert.ok(tools.includes(tool), `${name} 有 ${tool}`);
	}
});

test("第一次启动：module-builder 随仓库发，默认打开，五位专家在队里，名册说明提到做模块", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-builder-"));
	const db = openStore(join(dir, "state.db"));
	const modules = startLiveModules({ db, stateDir: dir, roots: [REPO_MODULES], discovered: Modules.load([REPO_MODULES]), configSwitches: {}, log: () => {} });
	t.after(() => {
		modules.stop();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(Object.fromEntries(moduleRows(db).map((r) => [r.name, r.switch]))["module-builder"], true);
	assert.equal(modules.kitFor("module-builder", null)?.crew.length, 5);
	const line = modules.live.current().rosterPrompt().split("\n").find((l) => l.startsWith("- module-builder"));
	assert.match(line ?? "", /模块/);
});

const SKILL = (name: string) => readFileSync(join(BUILDER, "skills", name, "SKILL.md"), "utf8");
const QUOTE = "stock-ta/tools/quote";

/** Each fenced block whose info string carries `file=<package>/<path>` is one file of an example package, as the skill shows it. */
function examplePackages(markdown: string): Map<string, Map<string, string>> {
	const packages = new Map<string, Map<string, string>>();
	for (const [, path, body] of markdown.matchAll(/^```\w* file=(\S+)\n([\s\S]*?)^```$/gm)) {
		const [pkg, ...rest] = path!.split("/");
		if (!packages.has(pkg!)) packages.set(pkg!, new Map());
		packages.get(pkg!)!.set(rest.join("/"), body!);
	}
	return packages;
}

function writePackage(t: { after(fn: () => void): void }, name: string, files: Map<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "psa-example-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, body] of files) {
		mkdirSync(dirname(join(root, name, path)), { recursive: true });
		writeFileSync(join(root, name, path), body);
	}
	return join(root, name);
}

const problemsOf = (dir: string) => {
	const result = scanPackage(dir);
	return result.ok ? [] : result.problems.map((p) => `${p.where}: ${p.reason}`);
};

function checked(dir: string) {
	const result = scanPackage(dir);
	assert.ok(result.ok, result.ok ? "" : result.problems.map((p) => `${p.where}: ${p.reason}`).join("\n"));
	return result.scan;
}

function examples() {
	const text = SKILL("package-layout");
	const packages = [...examplePackages(text)];
	const marked = text.match(/^```\w* file=/gm)?.length ?? 0;
	assert.equal(packages.reduce((sum, [, files]) => sum + files.size, 0), marked, "每个标了 file= 的代码块都完整取出（代码块要合上）");
	assert.equal(packages.length, 2, "技能 package-layout 给两个示例包");
	const team = packages.find(([, files]) => [...files.keys()].some((path) => path.startsWith("agents/")));
	const solo = packages.find(([, files]) => ![...files.keys()].some((path) => path.startsWith("agents/")));
	assert.ok(team && solo, "一个带专家，一个不带专家");
	return { team, solo };
}

test("技能 package-layout 原文里的两个示例包写进目录，just module check 的同一段检查都通过，都只用 stock-ta/tools/quote", (t) => {
	const { team, solo } = examples();
	const teamScan = checked(writePackage(t, ...team));
	assert.equal(teamScan.manifest.uses, undefined, "带专家的包不写模块级 uses");
	const agents = teamScan.components.flatMap((c) => (c.kind === "agents" ? [c.agent] : []));
	assert.ok(agents.length > 0);
	assert.deepEqual([...new Set(agents.flatMap((a) => a.uses))], [QUOTE], "外部工具写在专家的 uses 里");
	const soloScan = checked(writePackage(t, ...solo));
	assert.deepEqual(soloScan.manifest.uses, [QUOTE], "不带专家的包写在 module.json 的 uses 里");
	const evalUses = [teamScan, soloScan].flatMap((scan) => scan.components.flatMap((c) => (c.kind === "evals" ? c.eval.uses : [])));
	assert.ok(evalUses.every((use) => use === QUOTE), "考题的 uses 也只写 stock-ta/tools/quote 的全名");
	for (const scan of [teamScan, soloScan]) assert.ok(scan.notes.some((n) => n.includes(`uses "${QUOTE}", another module's tool`)), `${scan.manifest.name} 的检查认出外部工具，只给提醒`);
});

test("带专家的示例包把 uses 从专家文件挪到 module.json，检查报错", (t) => {
	const [name, files] = examples().team;
	const moved = new Map(files);
	for (const [path, body] of files) if (path.startsWith("agents/")) moved.set(path, body.replace(/^uses:.*\n/m, ""));
	const manifest = JSON.parse(files.get("module.json")!);
	moved.set("module.json", JSON.stringify({ ...manifest, uses: [QUOTE] }, null, 2));
	assert.ok(problemsOf(writePackage(t, name, moved)).some((line) => line.startsWith(`module.json: has "uses" but agents/ has members`)));
});

test("技能 build-module 原文写了「请对提供方说」的转述规则", () => {
	const text = SKILL("build-module");
	assert.ok(text.includes("请对 <提供方> 说"), "写明转述的句式");
	assert.ok(text.includes("请对 stock-ta 说"), "给出 stock-ta 的例句");
});

const REPO = fileURLToPath(new URL("../..", import.meta.url));

test("技能 build-module 原文里提供方不在时的三句原因，和网关 gateway.ts 回的一字不差", () => {
	const source = readFileSync(join(REPO, "src/modules/gateway.ts"), "utf8");
	const reasons = [...source.matchAll(/code: "provider-absent", note: `([^`]+)`/g)].map(([, note]) =>
		note!.replaceAll("${provider}", "stock-ta").replaceAll("${copy.module}", "stock-ta").replaceAll("${name}", "quote"),
	);
	assert.equal(new Set(reasons).size, 3, `网关有三句 provider-absent 原因，多了或少了要同步改技能：${reasons.join(" / ")}`);
	const text = SKILL("build-module");
	for (const reason of reasons) assert.ok(text.includes(`「${reason}」`), `技能写着「${reason}」`);
});

test("技能 data-and-feeds 写的 html 截断尾串，和 letter.ts 截断时加的一字不差", () => {
	const source = readFileSync(join(REPO, "src/modules/connectors/letter.ts"), "utf8");
	const tail = /const HTML = \{ bytes: [^,]+, cut: "\\n\\n([^"]+)" \}/.exec(source)?.[1];
	assert.ok(tail, "letter.ts 里找到 HTML 的截断尾串");
	assert.ok(SKILL("data-and-feeds").includes(`「${tail}」`), `技能写着「${tail}」`);
});

test("技能 build-module 找提供方的包也看仓库的示例包，三处都没有时汇报找不到，不当成没开放", () => {
	const text = SKILL("build-module");
	assert.ok(text.includes("$PSA_REPO/docs/modules/examples/<提供方>/module.json"), "写明示例包的路径");
	assert.ok(text.includes("「找不到提供方的包」"), "写明找不到时怎么汇报");
});

test("写专家的人拿得到转述三条：package-layout 的外部 uses 一节指过去，搭结构的专家读那一节", () => {
	const layout = SKILL("package-layout");
	const external = layout.slice(layout.indexOf("## 用别的模块的工具"), layout.indexOf("## 两个示例包"));
	assert.ok(external.includes("build-module「和别的模块连起来」的三条"), "外部 uses 一节指向三条");
	const scaffolder = readFileSync(join(BUILDER, "agents", "scaffolder.md"), "utf8");
	assert.ok(scaffolder.includes("「和别的模块连起来」"), "搭结构读 build-module 的那一节");
	assert.ok(scaffolder.includes("data-and-feeds"), "搭结构写数据和 feed 时读技能 data-and-feeds");
});

test("package-layout 不再叫人照 full 模板写数据和 feed，full 模板的 README 指向真正的样例", () => {
	assert.ok(!SKILL("package-layout").includes("数据、工具和 feed 照 `full` 模板写"));
	const readme = readFileSync(join(REPO, "src/modules/templates/full/README.md"), "utf8");
	assert.ok(!readme.includes("框架还没做"), "README 不再说框架没做数据和 feed");
	assert.ok(readme.includes("docs/modules/examples/mail/"), "README 指向 mail 示例包");
});

function mailExample() {
	const packages = [...examplePackages(SKILL("data-and-feeds"))];
	assert.equal(packages.length, 1, "技能 data-and-feeds 给一个示例包");
	return packages[0]!;
}

test("技能 data-and-feeds 的示例包写进目录，just module check 的同一段检查通过（连 feed 的样例一起跑），mail feed 写进私密集合", (t) => {
	const [name, files] = mailExample();
	const scan = checked(writePackage(t, name, files));
	const feeds = scan.components.flatMap((c) => (c.kind === "feeds" ? [c] : []));
	const mail = feeds.find((c) => c.feed.connector === "mail");
	assert.ok(mail, "有一个 mail 连接器的 feed");
	assert.ok(mail.fixtures.length > 0, "feed 带样例，检查会跑它");
	const collections = new Map(scan.components.flatMap((c) => (c.kind === "data" ? [[c.name as string, c.collection] as const] : [])));
	assert.equal(collections.get(mail.feed.into!)?.class, "private");
	const senders = (mail.feed.settings as { senders?: unknown } | undefined)?.senders;
	assert.equal(typeof senders, "string", "settings.senders 写集合名，不在包里写地址");
	assert.equal(collections.get(senders as string)?.fields["address"]?.type, "text");
});

test("示例包的 mail feed 改写进非私密集合，检查报错", (t) => {
	const [name, files] = mailExample();
	const feedPath = [...files.keys()].find((path) => path.endsWith("feed.json"))!;
	const into = JSON.parse(files.get(feedPath)!).into as string;
	const changed = new Map(files);
	const collectionPath = `data/${into}/collection.json`;
	changed.set(collectionPath, files.get(collectionPath)!.replace(`"class": "private"`, `"class": "shareable"`));
	assert.ok(problemsOf(writePackage(t, name, changed)).some((line) => line.includes("must write into a private collection")));
});

const AGENT = (name: string) => readFileSync(join(BUILDER, "agents", `${name}.md`), "utf8");

test("考题题面是使用者的原话：write-evals 和出考题都叫人先用说明书的典型问题，不在题面里教答法；工坊自己的考题照做", () => {
	const text = SKILL("write-evals");
	assert.ok(text.includes("说明书有「典型问题」"), "先用说明书的典型问题");
	assert.ok(text.includes("使用者的口吻"), "题面用使用者的口吻");
	assert.ok(text.includes("不在题面里教答法"), "题面不写调哪个工具、怎么排版");
	assert.ok(AGENT("eval-writer").includes("典型问题"), "出考题先读典型问题");
	for (const c of scanned().components) {
		if (c.kind !== "evals") continue;
		const body = questionOf(readFileSync(join(BUILDER, "evals", `${c.name}.md`), "utf8"));
		assert.ok(body.length <= 150, `${c.name} 的题面 ${body.length} 字，超过 150`);
	}
});

test("expect 的判法写进技能，和 judge 一致：空格算字，所以「QCC 待确认」和「QCC待确认」是两个短语；预演失败不放宽、不拆开 expect", () => {
	const text = SKILL("write-evals");
	assert.ok(text.includes("区分大小写，空格算字"), "写明判法");
	assert.ok(text.includes("「QCC 待确认」和「QCC待确认」是两个短语"), "给出空格的例子");
	const exam: Exam = { name: "tax", uses: [], expect: ["QCC 待确认"], question: "q" };
	const attempt: Attempt = { opened: true, ticket: "T1", domain: "m", report: { status: "done", summary: "QCC待确认" }, gateway: [] };
	const said = (summary: string, phrase: string) => judge("m", { ...exam, expect: [phrase] }, { ...attempt, report: { status: "done", summary } }).pass;
	assert.equal(said("QCC待确认", "QCC 待确认"), false, "judge 真的把少一个空格判成没有");
	assert.equal(said("qcc 待确认", "QCC 待确认"), false, "区分大小写");
	assert.equal(said("ＱＣＣ 待确认", "QCC 待确认"), false, "全角半角不同");
	assert.equal(said("结论：QCC 待确认。", "QCC 待确认"), true, "一字不差就算找到");
	assert.ok(text.includes("不为了过预演放宽 expect"), "不放宽");
	assert.ok(text.includes("不拆开"), "不拆开");
	assert.ok(text.includes("汇报里单列"), "改了的 expect 在汇报里单列");
	assert.ok(SKILL("build-module").includes("write-evals 的「预演失败时」"), "领队预演失败时照 write-evals 判断");
});

test("description 照说明书那一句写，不写施工进度；说明书外的集合、feed、工具不加", () => {
	const layout = SKILL("package-layout");
	assert.ok(layout.includes("照说明书那一句原样写"), "description 照抄说明书");
	assert.ok(layout.includes("不写施工进度"), "不写施工进度");
	assert.ok(SKILL("build-module").includes("说明书里没有的集合、feed、工具不加"), "不擅自加组成");
});

test("包里不写本机绝对路径：package-layout 写明，检查专家查 module check 的提醒；工坊自己的包没有这类提醒", () => {
	assert.ok(SKILL("package-layout").includes("包里的文件不写本机绝对路径"));
	assert.ok(AGENT("checker").includes("本机绝对路径"));
	assert.ok(!scanned().notes.some((note) => note.includes("local absolute path")), "module-builder 自己干净");
});

test("使用者给了说明书就原样采用：领队原样复制，访谈只在末尾补「假设和缺项」，不写这次怎么做", () => {
	assert.ok(SKILL("build-module").includes("原样复制"), "领队复制说明书文件");
	const interviewer = AGENT("interviewer");
	assert.ok(interviewer.includes("一字不改"), "访谈不重写");
	assert.ok(interviewer.includes("「假设和缺项」"), "只在末尾补假设和缺项");
	assert.ok(interviewer.includes("不写这次怎么做"), "不掺过程信息");
});

test("专家的 uses 按最小需要列，私密集合只给要用的专家；包里不放测试文件；知识不引用宿主源码路径", () => {
	const layout = SKILL("package-layout");
	assert.ok(layout.includes("按最小需要列"));
	assert.ok(layout.includes("领队本来就调得到本模块的"), "不为领队把能力塞进专家的 uses");
	assert.ok(AGENT("scaffolder").includes("uses"), "搭结构对 uses 也只给要的");
	assert.ok(layout.includes("包里不放测试文件"), "测试写成 cases.json 和样例");
	assert.ok(layout.includes("不引用宿主源码路径"), "包里所有文件都不引用宿主源码");
	assert.ok(AGENT("knowledge-curator").includes("不引用宿主源码路径"));
});

test("module check 不跑包里的测试文件：一个必然失败的 tests/*.test.ts 不挡检查，所以技能叫人把验证写进 cases.json", (t) => {
	const [name, files] = examples().solo;
	const withTest = new Map(files);
	const skill = [...files.keys()].find((path) => path.startsWith("skills/"))!;
	withTest.set(join(dirname(skill), "tests", "always-fails.test.ts"), 'import test from "node:test";\ntest("x", () => { throw new Error("ran"); });\n');
	assert.deepEqual(problemsOf(writePackage(t, name, withTest)), []);
});
