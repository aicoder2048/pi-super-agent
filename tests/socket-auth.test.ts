import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient } from "../src/client/protocol.ts";
import { busyPort, fakeFeed, ofType, startHost, tempStateDir, until, within } from "./helpers/fakes.ts";

const tokenFile = (stateDir: string) => join(stateDir, "client-token");
const readToken = (stateDir: string) => readFileSync(tokenFile(stateDir), "utf8").trim();
const mode = (path: string) => statSync(path).mode & 0o777;

async function runHostOnce(stateDir: string): Promise<void> {
	const { host } = await startHost(() => [], () => {}, { stateDir });
	await host.stop();
}

test("凭据文件：宿主启动后状态目录里有 client-token，64 位十六进制，权限 0600，和 web-token 不是同一个", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir, webPort: 0 });
	t.after(() => host.stop());
	assert.match(readToken(stateDir), /^[0-9a-f]{64}$/);
	assert.equal(mode(tokenFile(stateDir)), 0o600);
	assert.notEqual(readToken(stateDir), readFileSync(join(stateDir, "web-token"), "utf8").trim());
});

test("凭据文件：同一状态目录重启后 client-token 不变", async () => {
	const stateDir = tempStateDir();
	await runHostOnce(stateDir);
	const token = readToken(stateDir);
	await runHostOnce(stateDir);
	assert.equal(readToken(stateDir), token);
});

test("凭据文件：client-token 权限比 0600 宽时收紧到 0600，内容照用，日志说一次且不含凭据", async (t) => {
	const stateDir = tempStateDir();
	const kept = "cd".repeat(32);
	writeFileSync(tokenFile(stateDir), `${kept}\n`);
	chmodSync(tokenFile(stateDir), 0o644);
	const lines: string[] = [];
	const { host } = await startHost(() => [], () => {}, { stateDir, log: (line) => lines.push(line) });
	t.after(() => host.stop());
	assert.equal(readToken(stateDir), kept);
	assert.equal(mode(tokenFile(stateDir)), 0o600);
	assert.equal(lines.filter((l) => l.includes("client-token")).length, 1, lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes(kept)), "日志里不该有凭据");
});

test("凭据文件：网页端口被占用、宿主起不来时，不创建 client-token", async (t) => {
	const port = await busyPort(t);
	const stateDir = tempStateDir();
	await assert.rejects(startHost(() => [], () => {}, { stateDir, webPort: port }));
	assert.equal(existsSync(tokenFile(stateDir)), false);
});

test("just client-token-rotate 删掉 client-token，宿主下次启动生成新的", async () => {
	const stateDir = tempStateDir();
	await runHostOnce(stateDir);
	const old = readToken(stateDir);
	const rotate = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/client-token-rotate.ts"], {
		env: { ...process.env, PSA_STATE_DIR: stateDir },
		encoding: "utf8",
	});
	assert.equal(rotate.status, 0, rotate.stderr);
	assert.equal(existsSync(tokenFile(stateDir)), false);
	assert.ok(!rotate.stdout.includes(old), "不打印凭据");
	await runHostOnce(stateDir);
	assert.notEqual(readToken(stateDir), old);
});

function rawSession(socketPath: string, lines: object[]): Promise<Record<string, any>[]> {
	return new Promise((resolve) => {
		const got: Record<string, any>[] = [];
		const socket = connect(socketPath);
		let buffer = "";
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			buffer += chunk;
			const parts = buffer.split("\n");
			buffer = parts.pop()!;
			got.push(...parts.map((p) => JSON.parse(p)));
			if (got.some((m) => m.type === "ack")) socket.destroy();
		});
		socket.on("close", () => resolve(got));
		socket.on("connect", () => socket.write(lines.map((l) => JSON.stringify(l) + "\n").join("")));
	});
}

const SAY = { type: "say", text: "冒充使用者说的话", requestId: "r1" };

for (const [what, hello] of Object.entries({
	"不带凭据": { type: "hello", role: "client" },
	"带错的凭据": { type: "hello", role: "client", token: "ef".repeat(32) },
	"凭据不是字符串": { type: "hello", role: "client", token: { length: 64 } },
	"用别的角色名、不带凭据": { type: "hello", role: "admin" },
})) {
	test(`socket：client hello ${what}时被断开，拿不到快照，说的话不进对话，日志记一行且不含凭据`, async (t) => {
		const stateDir = tempStateDir();
		const lines: string[] = [];
		const { host } = await startHost(() => [], () => {}, { stateDir, log: (line) => lines.push(line) });
		t.after(() => host.stop());
		const got = await within(rawSession(host.socketPath, [hello, SAY]), 3000, "宿主断开这个连接");
		assert.deepEqual(got, []);
		assert.deepEqual(host.kernel.conversation(), []);
		assert.equal(host.server.clientCount(), 0);
		const refused = lines.filter((l) => l.startsWith("[socket]"));
		assert.equal(refused.length, 1, lines.join("\n"));
		assert.ok(!refused[0].includes(readToken(stateDir)) && !refused[0].includes("ef".repeat(32)), "日志里不该有凭据");
	});
}

test("socket：client hello 带对的凭据时拿到快照，说的话进对话", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	const got = await within(rawSession(host.socketPath, [{ type: "hello", role: "client", token: readToken(stateDir) }, SAY]), 3000, "收到确认");
	assert.deepEqual(got.map((m) => m.type).slice(0, 1), ["snapshot"]);
	assert.deepEqual(host.kernel.conversation().map((m) => m.text), [SAY.text]);
});

function client(socketPath: string) {
	const got: HostToClient[] = [];
	const errors: string[] = [];
	const conn = new HostConnection({ socketPath, onMessage: (m) => got.push(m), onError: (line) => errors.push(line), retryMs: 30 });
	conn.open();
	return { conn, got, errors };
}

test("客户端：宿主换了凭据重启后，HostConnection 重连时重新读文件，自己连上", async (t) => {
	const stateDir = tempStateDir();
	const first = await startHost(() => [], () => {}, { stateDir });
	const c = client(first.host.socketPath);
	t.after(() => c.conn.close());
	await until(() => ofType(c.got, "snapshot").length === 1, "第一次快照");
	await first.host.stop();
	rmSync(tokenFile(stateDir));
	const second = await startHost(() => [], () => {}, { stateDir });
	t.after(() => second.host.stop());
	await until(() => ofType(c.got, "snapshot").length === 2, "换凭据后的快照");
});

test("客户端：socket 旁边没有 client-token 时 HostConnection 不发 hello，报一行让人先启动宿主的错，文件出现后自己连上", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	const token = readToken(stateDir);
	rmSync(tokenFile(stateDir));
	const c = client(host.socketPath);
	t.after(() => c.conn.close());
	await until(() => c.errors.length > 0, "报错");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(c.errors.length, 1, "重试期间同一个错只报一次");
	assert.match(c.errors[0], /client-token.*just host/);
	assert.ok(!c.errors[0].includes("\n"));
	assert.equal(c.conn.connected, false);
	writeFileSync(tokenFile(stateDir), `${token}\n`, { mode: 0o600 });
	await until(() => ofType(c.got, "snapshot").length === 1, "文件出现后连上");
});

function runSay(stateDir: string, args: string[]) {
	const child = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/say.ts", ...args], {
		env: { ...process.env, PSA_STATE_DIR: stateDir, PSA_SAY_WAIT_MS: "300" },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stderr += d));
	const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
	return within(exited, 20_000, "just say 退出").finally(() => child.kill());
}

function tailSay(stateDir: string) {
	const child = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/say.ts", "tail"], { env: { ...process.env, PSA_STATE_DIR: stateDir } });
	let stdout = "";
	child.stdout.on("data", (d) => (stdout += d));
	return {
		output: () => stdout,
		lines: () => stdout.trim().split("\n").map((l) => l.replace(/^\d\d:\d\d:\d\d /, "TIME ")),
		stop: () => child.kill(),
	};
}

test("just say：对着真实宿主说一句话，这句话进了对话，退出码 0", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	const run = await runSay(stateDir, ["say", "经", "say", "说的"]);
	assert.equal(run.code, 0, run.stderr);
	assert.deepEqual(host.kernel.conversation().map((m) => m.text), ["经 say 说的"]);
});

test("just say：状态目录里没有 client-token 时只打印一行让人先启动宿主的话，退出码 1，什么都没说出去", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	rmSync(tokenFile(stateDir));
	const run = await runSay(stateDir, ["say", "不该送达"]);
	assert.equal(run.code, 1);
	assert.match(run.stderr.trim(), /^.*client-token.*just host.*$/);
	assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
	assert.deepEqual(host.kernel.conversation(), []);
});

test("just say：client-token 和宿主的不一致时打印一行说明，退出码 1，什么都没说出去", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	writeFileSync(tokenFile(stateDir), `${"ef".repeat(32)}\n`, { mode: 0o600 });
	const run = await runSay(stateDir, ["say", "不该送达"]);
	assert.equal(run.code, 1);
	assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
	assert.match(run.stderr, /重启/);
	assert.deepEqual(host.kernel.conversation(), []);
});

test("just notify：对着真实宿主发一条通知，对话里多一行「通知」，tail 打成「通知>」；Router 没被叫，没开任务，退出码 0", async (t) => {
	const stateDir = tempStateDir();
	let routerTurns = 0;
	const { host } = await startHost(() => (routerTurns++, []), () => {}, { stateDir });
	t.after(() => host.stop());
	const tail = tailSay(stateDir);
	t.after(tail.stop);
	const run = await runSay(stateDir, ["notify", "G3", "合并了"]);
	assert.equal(run.code, 0, run.stderr);
	await until(() => tail.output().includes("G3 合并了"), "tail 打出通知", 15_000);
	assert.deepEqual(tail.lines(), ["TIME 通知> G3 合并了"]);
	assert.deepEqual(host.kernel.conversation().map((l) => [l.who, l.text]), [["notice", "G3 合并了"]]);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(routerTurns, 0);
	assert.deepEqual(host.kernel.listTickets(), []);
});

test("just notify：空的通知不连宿主，打一行用法，退出码 1", async () => {
	const run = await runSay(tempStateDir(), ["notify", " "]);
	assert.equal(run.code, 1);
	assert.match(run.stderr.trim(), /^用法：just notify/);
	assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
});

test("just notify：没有宿主在运行时打一行话，退出码 1", async () => {
	const stateDir = tempStateDir();
	writeFileSync(tokenFile(stateDir), `${"ab".repeat(32)}\n`, { mode: 0o600 });
	const run = await runSay(stateDir, ["notify", "没人收"]);
	assert.equal(run.code, 1);
	assert.match(run.stderr.trim(), /连不上宿主.*just host/);
	assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
});

test("just notify：超过 2000 字时宿主拒收，打出原因，退出码 1，什么都没记", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	const run = await runSay(stateDir, ["notify", "长".repeat(2001)]);
	assert.equal(run.code, 1);
	assert.match(run.stderr.trim(), /2000/);
	assert.deepEqual(host.kernel.conversation(), []);
});

test("socket：升级前就开着的旧客户端每秒重连一次，宿主一分钟内只记一行拒绝日志，每次都照样断开", async (t) => {
	const lines: string[] = [];
	const { host } = await startHost(() => [], () => {}, { log: (line) => lines.push(line) });
	t.after(() => host.stop());
	for (let i = 0; i < 5; i++) assert.deepEqual(await within(rawSession(host.socketPath, [{ type: "hello", role: "client" }, SAY]), 3000, "断开"), []);
	assert.equal(lines.filter((l) => l.startsWith("[socket]")).length, 1, lines.join("\n"));
	assert.deepEqual(host.kernel.conversation(), []);
});

test("凭据比较：空凭据永远不算对，哪怕要比的那一方也是空的", async () => {
	const { tokenMatches } = await import("../src/host/web-token.ts");
	assert.equal(tokenMatches("", ""), false);
	assert.equal(tokenMatches("a", "a"), true);
});

test("socket 客户端也收到 cleared 帧；清屏后新 hello 的快照和网页快照相同", async (t) => {
	const { host } = await startHost(() => [], () => {}, { webPort: 0 });
	t.after(() => host.stop());
	const c = client(host.socketPath);
	t.after(() => c.conn.close());
	await until(() => ofType(c.got, "snapshot").length === 1, "快照");
	host.say("早");
	await until(() => ofType(c.got, "user").length === 1, "user");
	host.clearConversation();
	await until(() => ofType(c.got, "cleared").length === 1, "cleared 帧");
	const late = client(host.socketPath);
	t.after(() => late.conn.close());
	await until(() => ofType(late.got, "snapshot").length === 1, "新连接的快照");
	const [snap] = ofType(late.got, "snapshot");
	const web = host.snapshot();
	assert.deepEqual(snap.conversation, web.conversation);
	assert.deepEqual(snap.cleared, web.cleared);
	assert.deepEqual(snap.cleared?.lines.map((l) => l.text), ["早"]);
	assert.equal(ofType(c.got, "cleared").length, 1);
});

test("just tail：带引用的话前面先打一行「↪ 引用 …」", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	const first = host.say("方案 A 先停掉旧任务");
	host.sayQuoting("改成 B", first);
	const tail = tailSay(stateDir);
	t.after(tail.stop);
	await until(() => tail.output().includes("你> 改成 B"), "tail 打出引用的那句", 15_000);
	host.sayQuoting("再想想", first);
	await until(() => tail.output().includes("你> 再想想"), "实时的那句", 5000);
	assert.deepEqual(tail.lines(), ["TIME 你> 方案 A 先停掉旧任务", "TIME ↪ 引用 你：方案 A 先停掉旧任务", "TIME 你> 改成 B", "TIME ↪ 引用 你：方案 A 先停掉旧任务", "TIME 你> 再想想"]);
});

test("just tail：提醒和收据打成「盯盘提醒>」「盯盘条件（只在本机）>」，历史里的和实时的都一样", async (t) => {
	const stateDir = tempStateDir();
	const feed = fakeFeed("us-market");
	const { host } = await startHost(() => [], () => {}, { stateDir, feeds: [feed.spec] });
	t.after(() => host.stop());
	feed.ctx!.post({ kind: "receipt", text: "已记下：NVDA" });
	const tail = tailSay(stateDir);
	t.after(tail.stop);
	await until(() => tail.output().includes("已记下"), "tail 打出历史里的收据", 15_000);
	feed.ctx!.post({ kind: "alert", externalId: "NVDA:x", text: "NVDA 涨了 5.3%", occurredAt: 1 });
	await until(() => tail.output().includes("NVDA 涨了"), "实时的提醒", 5000);
	assert.deepEqual(tail.lines(), ["TIME 盯盘条件（只在本机）> 已记下：NVDA", "TIME 盯盘提醒> NVDA 涨了 5.3%"]);
});

test("just say：socket 的 say 多带一个 quote 键时照常当一句话说，不带引用", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	const first = host.say("方案 A");
	await within(rawSession(host.socketPath, [{ type: "hello", role: "client", token: readToken(stateDir) }, { ...SAY, quote: first, quoteOf: first }]), 3000, "收到确认");
	const said = host.kernel.conversation().at(-1);
	assert.equal(said?.text, SAY.text);
	assert.equal(said && "quote" in said, false);
});

test("just tail：旧版宿主发来不带 who 的 user 帧，照样打成「你>」", async (t) => {
	const stateDir = tempStateDir();
	writeFileSync(tokenFile(stateDir), "tok\n");
	const server = createServer((socket) => {
		socket.once("data", () => {
			socket.write(`${JSON.stringify({ type: "snapshot", conversation: [{ id: "trg_1", who: "user", text: "早", at: 1 }], cleared: null, board: [], today: {}, duty: {}, helpers: {}, routes: {}, dispatching: {}, memberCap: null, watching: [] })}\n`);
			socket.write(`${JSON.stringify({ type: "user", id: "trg_2", text: "旧宿主的一句", at: 2 })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(join(stateDir, "host.sock"), resolve));
	t.after(() => server.close());
	const tail = tailSay(stateDir);
	t.after(tail.stop);
	await until(() => tail.output().includes("旧宿主的一句"), "tail 打出旧宿主的那句", 15_000);
	assert.deepEqual(tail.lines(), ["TIME 你> 早", "TIME 你> 旧宿主的一句"]);
});
