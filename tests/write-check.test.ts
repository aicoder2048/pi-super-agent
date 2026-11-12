import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { OutputRoot } from "../src/host/output.ts";
import { bashTargets } from "../src/host/write-check.ts";

const REPO = "/psa-not-a-repo";
const TICKET = { id: "tkt_1", workerSessionId: "sid-1" };

const header = (cwd: string) => JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-11-11T00:00:00Z", cwd });
const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ type: "message", id: "m", message: { role: "assistant", content: [{ type: "text", text: "好" }, { type: "toolCall", id: "c", name, arguments: args }] } });
const result = (text: string) => JSON.stringify({ type: "message", id: "r", message: { role: "toolResult", toolCallId: "c", toolName: "write", content: [{ type: "text", text }] } });

function world() {
	const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "psa-writes-")));
	const workdir = join(stateDir, "workers", TICKET.id);
	mkdirSync(workdir, { recursive: true });
	const output = new OutputRoot({ root: join(stateDir, "output"), stateDir, ledger: { claimApp: () => assert.fail("不该开应用") } });
	const session = (file: string, lines: string[]) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
		return file;
	};
	const helper = (...lines: string[]) => session(join(stateDir, "sessions", "workers", `2026-11-11T00-00-00_${TICKET.workerSessionId}.jsonl`), [header(workdir), ...lines]);
	const member = (name: string, ...lines: string[]) => session(join(workdir, "team", name, "2026-11-11T00-00-01_m.jsonl"), [header(workdir), ...lines]);
	return { stateDir, workdir, output, helper, member, check: (since = {}) => output.checkWrites(TICKET, since) };
}

test("write 写到仓库的绝对路径算外面；相对路径、成品目录、/tmp 下算里面", () => {
	const w = world();
	w.helper(
		call("write", { path: `${REPO}/extensions/joke.ts`, content: "x" }),
		result("ok"),
		call("write", { path: "notes.md", content: "x" }),
		call("edit", { path: join(w.output.root, "apps", "app-001-joke", "index.ts"), edits: [] }),
		call("write", { path: "/tmp/scratch.py", content: "x" }),
		call("edit", { path: `${REPO}/README.md`, edits: [] }),
	);
	assert.deepEqual(w.check().outside, [
		{ kind: "wrote", path: `${REPO}/extensions/joke.ts`, tool: "write", by: { role: "helper" } },
		{ kind: "wrote", path: `${REPO}/README.md`, tool: "edit", by: { role: "helper" } },
	]);
});

test("~ 和 @ 开头的路径按 Pi 的规则解析", () => {
	const w = world();
	w.helper(call("write", { path: "~/psa-notes.md", content: "x" }), call("write", { path: `@${REPO}/a.ts`, content: "x" }));
	assert.deepEqual(w.check().outside.map((o) => o.kind === "wrote" && o.path), [join(homedir(), "psa-notes.md"), `${REPO}/a.ts`]);
});

test("成员会话里的写入标的是成员的名字", () => {
	const w = world();
	w.member("coder", call("write", { path: `${REPO}/x.ts`, content: "x" }));
	assert.deepEqual(w.check().outside, [{ kind: "wrote", path: `${REPO}/x.ts`, tool: "write", by: { role: "member", name: "coder" } }]);
});

test("状态目录在临时目录下时，写 config.json、别的任务的目录也算外面；本任务目录和成品目录仍算里面", () => {
	const w = world();
	w.helper(
		call("write", { path: join(w.stateDir, "config.json"), content: "{}" }),
		call("write", { path: "../tkt_other/x.md", content: "x" }),
		call("write", { path: "../../stray.md", content: "x" }),
		call("write", { path: "draft/x.md", content: "x" }),
		call("write", { path: "../../output/docs/analysis/20261111-x.md", content: "x" }),
	);
	assert.deepEqual(w.check().outside.map((o) => o.kind === "wrote" && o.path), [join(w.stateDir, "config.json"), join(w.stateDir, "workers", "tkt_other", "x.md"), join(w.stateDir, "stray.md")]);
});

test("bash 和 bg_start 的命令里推测出写到外面的，报成可能写入，只列外面的路径", () => {
	const w = world();
	w.helper(
		call("bash", { command: `cat > ${REPO}/x.ts <<'EOF'\nrm -rf /should-not-count\nEOF` }),
		call("bash", { command: `cat ${REPO}/x.ts > notes.md` }),
		call("bg_start", { command: `cd ${REPO} && npm i` }),
		call("bash", { command: "echo hi > ../../stray-bash.md" }),
	);
	assert.deepEqual(w.check().outside, [
		{ kind: "maybe", paths: [`${REPO}/x.ts`], command: `cat > ${REPO}/x.ts <<'EOF'\nrm -rf /should-not-count\nEOF`, tool: "bash", by: { role: "helper" } },
		{ kind: "maybe", paths: [REPO], command: `cd ${REPO} && npm i`, tool: "bg_start", by: { role: "helper" } },
		{ kind: "maybe", paths: [join(w.stateDir, "stray-bash.md")], command: "echo hi > ../../stray-bash.md", tool: "bash", by: { role: "helper" } },
	]);
});

test("游标：第二次只扫新加的行；没写完的最后一行不算，也不推进游标", () => {
	const w = world();
	const file = w.helper(call("write", { path: `${REPO}/a.ts`, content: "x" }));
	const first = w.check();
	assert.equal(first.outside.length, 1);
	appendFileSync(file, `${call("write", { path: `${REPO}/b.ts`, content: "x" })}\n${call("write", { path: `${REPO}/c.ts`, content: "x" }).slice(0, 30)}`);
	const second = w.check(first.scanned);
	assert.deepEqual(second.outside.map((o) => o.kind === "wrote" && o.path), [`${REPO}/b.ts`]);
	assert.deepEqual(w.check(second.scanned).outside, []);
	appendFileSync(file, `${call("write", { path: `${REPO}/c.ts`, content: "x" }).slice(30)}\n`);
	assert.deepEqual(w.check(second.scanned).outside.map((o) => o.kind === "wrote" && o.path), [`${REPO}/c.ts`]);
});

test("会话头里的工作目录和现在的不一样时，相对路径按会话头的工作目录解析", () => {
	const w = world();
	const file = join(w.stateDir, "sessions", "workers", `x_${TICKET.workerSessionId}.jsonl`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${header("/psa-elsewhere/old")}\n${call("write", { path: "x.md", content: "x" })}\n`);
	assert.deepEqual(w.check().outside.map((o) => o.kind === "wrote" && o.path), ["/psa-elsewhere/old/x.md"]);
});

test("读不了会话文件时返回原因，游标不动", { skip: process.getuid?.() === 0 && "root 能读任何文件" }, () => {
	const w = world();
	const file = w.helper(call("write", { path: `${REPO}/a.ts`, content: "x" }));
	chmodSync(file, 0o000);
	const check = w.check({ "x.jsonl": 3 });
	assert.match(check.problem ?? "", /会话/);
	assert.deepEqual(check.scanned, { "x.jsonl": 3 });
	chmodSync(file, 0o600);
});

test("同一路径写了多次只报一次；超过 50 处时多出来的只计数", () => {
	const w = world();
	w.helper(...Array.from({ length: 60 }, (_, i) => call("write", { path: `${REPO}/f${i}.ts`, content: "x" })), call("write", { path: `${REPO}/f0.ts`, content: "y" }));
	const check = w.check();
	assert.equal(check.outside.length, 50);
	assert.equal(check.omitted, 10);
});

test("bash 的写入推测：重定向、tee、cp/mv 的目标、git -C、cd 之后装包都算；读、2>&1、/dev/null 不算", () => {
	const cwd = "/work";
	const cases: [string, string[]][] = [
		["echo a > /r/x", ["/r/x"]],
		["echo a>>/r/x 2>&1", ["/r/x"]],
		["ls /r > /dev/null 2>/dev/null", []],
		["cat /r/a | tee /r/b /r/c", ["/r/b", "/r/c"]],
		["cp -r /r/a /r/b", ["/r/b"]],
		["mkdir -p /r/a /r/b && touch /r/c", ["/r/a", "/r/b", "/r/c"]],
		["sed -i '' 's/a/b/' /r/x", ["/r/x"]],
		["git -C /r commit -m 'a b'", ["/r"]],
		["git status", []],
		["cd /r && git add .", ["/r"]],
		["cd /r; npm install", ["/r"]],
		["curl -o /r/x https://e.com", ["/r/x"]],
		["tar -xzf a.tgz -C /r", ["/r"]],
		["python3 -c 'open(\"/r/x\",\"w\")'", ["/r/x"]],
		["echo '> /r/not-a-redirect'", []],
		["echo \"a\" > ~/x", [join(homedir(), "x")]],
	];
	for (const [command, expected] of cases) assert.deepEqual(bashTargets(command, cwd, homedir()), expected, command);
});

test("bash 的误报：解释器的脚本路径和参数、cd 之后跑测试或脚本、-c 里只读文件、tee 到 /dev/ 都不算写入", () => {
	const cases = [
		"node /r/scripts/check.mjs",
		"python3 /r/tools/x.py --in /etc/hosts --out /r/out.json",
		"cd /r && python3 -m pytest",
		"cd /r && node scripts/build.mjs",
		"python3 -c \"print(open('/etc/hosts').read())\"",
		"bash /r/run.sh /r/x",
		"echo x | tee /dev/stderr",
		"echo x | tee -a /dev/null",
	];
	for (const command of cases) assert.deepEqual(bashTargets(command, "/work", homedir()), [], command);
});

test("bash 的写入推测：-c/-e 里的代码有写操作时算它写的路径，bash -c 里的命令按命令推测", () => {
	const cases: [string, string[]][] = [
		["python3 -c \"open('/r/x','w').write('x')\"", ["/r/x"]],
		["node -e \"require('fs').writeFileSync('/r/n.txt','x')\"", ["/r/n.txt"]],
		["bash -c \"echo x > /r/bc\"", ["/r/bc"]],
		["sh -c 'cd /r && npm install'", ["/r"]],
	];
	for (const [command, expected] of cases) assert.deepEqual(bashTargets(command, "/work", homedir()), expected, command);
});

test("pi install、remove 算写到 Pi 的配置目录：默认 ~/.pi/agent，带 -l 时是当前目录的 .pi", () => {
	const home = "/home/u";
	const cases: [string, string[]][] = [
		["pi install ./myext", ["/home/u/.pi/agent"]],
		["pi install npm:@scope/pkg", ["/home/u/.pi/agent"]],
		["cd /r && pi install -l ./myext", ["/r/.pi"]],
		["pi remove --local npm:x", ["/work/.pi"]],
		["pi uninstall git:github.com/a/b", ["/home/u/.pi/agent"]],
		["pi --version", []],
		["pi list", []],
	];
	for (const [command, expected] of cases) assert.deepEqual(bashTargets(command, "/work", home), expected, command);
});

test("bash 命令里的 $HOME 和 ${HOME} 和 ~ 一样展开成家目录；单引号里的不展开", () => {
	const home = "/home/u";
	const cases: [string, string[]][] = [
		["echo x > $HOME/a.txt", ["/home/u/a.txt"]],
		["cp ext.ts \"${HOME}/.pi/agent/extensions/ext.ts\"", ["/home/u/.pi/agent/extensions/ext.ts"]],
		["mkdir -p $HOME", ["/home/u"]],
		["echo x > $HOMEDIR/a", ["/work/$HOMEDIR/a"]],
		["echo x > '$HOME/a'", ["/work/$HOME/a"]],
	];
	for (const [command, expected] of cases) assert.deepEqual(bashTargets(command, "/work", home), expected, command);
});

test("成品目录里名字以 .. 开头的文件仍算里面", () => {
	const w = world();
	w.helper(call("write", { path: join(w.output.root, "..notes.md"), content: "x" }), call("write", { path: join(w.workdir, "..draft.md"), content: "x" }));
	assert.deepEqual(w.check().outside, []);
});
