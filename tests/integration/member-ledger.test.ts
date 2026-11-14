import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { memberSessionDir } from "../../src/host/dispatch.ts";
import { clearMember, endLeftoverMembers, isRecorded, recordMember } from "../../src/host/member-ledger.ts";
import { FakeSpawner, defaultWorkerModels, fauxRouter, ids, startHost, until } from "../helpers/fakes.ts";
import { Host } from "../../src/host/host.ts";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function leftover(t: TestContext, sessionDir: string, script = "") {
	mkdirSync(sessionDir, { recursive: true });
	const childPid = join(sessionDir, "child.pid");
	const code = `process.title = "pi"; ${script}; const c = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(childPid)}, String(c.pid)); setInterval(() => {}, 1000);`;
	const member = spawn(process.execPath, ["-e", code, "--", "--session-dir", sessionDir], { detached: true, stdio: "ignore" });
	member.unref();
	const pid = member.pid!;
	t.after(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	});
	await until(() => existsSync(childPid) && readFileSync(childPid, "utf8").length > 0, "留下的成员起了子进程", 5000);
	return { pid, child: Number(readFileSync(childPid, "utf8")) };
}

const ledger = (sessionDir: string) => join(sessionDir, "running.json");

test("上一个宿主留下的成员：按宿主自己记下的 pid 结束它和它的进程组，清掉记录", async (t) => {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-ledger-"));
	const sessionDir = memberSessionDir(stateDir, "tkt_1", "news-researcher");
	const { pid, child } = await leftover(t, sessionDir);
	recordMember(sessionDir, pid);
	const recorded = JSON.parse(readFileSync(ledger(sessionDir), "utf8"));
	assert.equal(recorded.pgid, pid);
	assert.match(recorded.startedAt, /\d{2}:\d{2}:\d{2}/, "记下进程的启动时间，用来认出它");
	const logs: string[] = [];
	await endLeftoverMembers(stateDir, (line) => logs.push(line));
	assert.equal(alive(pid), false, "endLeftoverMembers 返回时进程已经没了");
	await until(() => !alive(child), "它起的子进程也随进程组结束", 2000);
	assert.equal(existsSync(ledger(sessionDir)), false);
	assert.deepEqual(logs, [`[host] 结束了上一个宿主留下的成员进程：任务 tkt_1 的 news-researcher（pid ${pid}）`]);
});

test("留下的成员不理会 SIGTERM：补 SIGKILL，仍然等到它没了才返回", async (t) => {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-ledger-"));
	const sessionDir = memberSessionDir(stateDir, "tkt_1", "stubborn");
	const { pid } = await leftover(t, sessionDir, `process.on("SIGTERM", () => {})`);
	recordMember(sessionDir, pid);
	await endLeftoverMembers(stateDir, () => {}, 100);
	assert.equal(alive(pid), false);
});

test("记录里的 pid 现在是别的进程（启动时间对不上）：不发信号，只清记录；进程已经不在的也只清记录", async (t) => {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-ledger-"));
	const reused = memberSessionDir(stateDir, "tkt_1", "reused");
	const gone = memberSessionDir(stateDir, "tkt_2", "gone");
	const other = await leftover(t, join(stateDir, "somewhere-else"));
	mkdirSync(reused, { recursive: true });
	mkdirSync(gone, { recursive: true });
	writeFileSync(ledger(reused), JSON.stringify({ pgid: other.pid, startedAt: "Mon Jan  1 00:00:00 2024" }));
	writeFileSync(ledger(gone), JSON.stringify({ pgid: 2 ** 22 + 12345, startedAt: "Mon Jan  1 00:00:00 2024" }));
	const logs: string[] = [];
	await endLeftoverMembers(stateDir, (line) => logs.push(line));
	assert.equal(alive(other.pid), true, "别人的进程不动");
	assert.equal(existsSync(ledger(reused)), false);
	assert.equal(existsSync(ledger(gone)), false);
	assert.deepEqual(logs, []);
});

test("读不出来的记录（空的、写了一半、不是记录）认不出任何进程：日志记一行写明是哪个文件，清掉它，照常继续", async () => {
	for (const content of ["", '{"pgid":12', "null", "[]"]) {
		const stateDir = mkdtempSync(join(tmpdir(), "psa-ledger-"));
		const sessionDir = memberSessionDir(stateDir, "tkt_1", "news-researcher");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(ledger(sessionDir), content);
		const logs: string[] = [];
		await endLeftoverMembers(stateDir, (line) => logs.push(line));
		assert.equal(existsSync(ledger(sessionDir)), false, JSON.stringify(content));
		assert.equal(logs.length, 1, JSON.stringify(content));
		assert.ok(logs[0].includes(ledger(sessionDir)), logs[0]);
	}
});

test("成员记录是空文件时宿主照常启动", async (t) => {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-ledger-"));
	const sessionDir = memberSessionDir(stateDir, "tkt_1", "news-researcher");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(ledger(sessionDir), "");
	const host = await Host.start({ stateDir, createRouter: fauxRouter(() => []).createRouter, createSpawner: () => new FakeSpawner(() => {}), log: () => {}, workerModels: defaultWorkerModels() });
	t.after(() => host.stop());
	assert.equal(existsSync(ledger(sessionDir)), false);
});

test("成员做完后清掉自己的记录；清两次不出错", () => {
	const sessionDir = join(mkdtempSync(join(tmpdir(), "psa-ledger-")), "team", "m");
	recordMember(sessionDir, process.pid);
	assert.equal(isRecorded(sessionDir), true);
	clearMember(sessionDir);
	clearMember(sessionDir);
	assert.equal(isRecorded(sessionDir), false);
});

test("宿主重启：先结束上一个宿主留下的成员，再恢复任务、起助手", async (t) => {
	const brain = (cards: string[]) => cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "t", brief: "b" }] } }] : []));
	const first = await startHost(brain, () => {});
	first.host.say("看一下");
	await until(() => first.spawner.spawned.length === 1, "助手在运行");
	const ticketId = first.host.kernel.listTickets()[0].id;
	const stateDir = first.spawner.workers.get(ticketId)!.spec.workdir.split("/workers/")[0];
	await first.host.stop();
	const sessionDir = memberSessionDir(stateDir, ticketId, "news-researcher");
	const { pid } = await leftover(t, sessionDir);
	recordMember(sessionDir, pid);
	const aliveAtSpawn: boolean[] = [];
	const spawner = new FakeSpawner(() => {});
	const spawn = spawner.spawn.bind(spawner);
	spawner.spawn = (spec, events) => (aliveAtSpawn.push(alive(pid)), spawn(spec, events));
	const second = await Host.start({ stateDir, createRouter: fauxRouter(brain).createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels() });
	t.after(() => second.stop());
	assert.equal(alive(pid), false, "宿主启动完成时留下的成员已经没了");
	await until(() => aliveAtSpawn.length === 1, "恢复的任务重新起了助手");
	assert.deepEqual(aliveAtSpawn, [false]);
});

test("同一个状态目录上再起一个宿主：它启动失败并说明已有宿主在运行，不动在跑的宿主的成员、记录和 socket", async (t) => {
	const first = await startHost(() => [], () => {});
	t.after(() => first.host.stop());
	const stateDir = first.host.socketPath.replace(/\/host\.sock$/, "");
	const sessionDir = memberSessionDir(stateDir, "tkt_1", "news-researcher");
	const { pid } = await leftover(t, sessionDir);
	recordMember(sessionDir, pid);
	const second = Host.start({ stateDir, createRouter: fauxRouter(() => []).createRouter, createSpawner: () => new FakeSpawner(() => {}), log: () => {}, workerModels: defaultWorkerModels() });
	second.then((host) => host.stop(), () => {});
	await assert.rejects(second, (e: Error) => e.name === "ConfigError" && /已经有一个宿主在运行/.test(e.message) && e.message.includes(stateDir));
	assert.equal(alive(pid), true, "在跑的宿主的成员没有被结束");
	assert.equal(isRecorded(sessionDir), true);
	await new Promise<void>((done, fail) => connect(first.host.socketPath).once("connect", function (this: import("node:net").Socket) {
		this.destroy();
		done();
	}).once("error", fail));
});
