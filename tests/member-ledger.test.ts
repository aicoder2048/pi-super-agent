import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { memberSessionDir } from "../src/host/dispatch.ts";
import { clearMember, endLeftoverMembers, recordMember } from "../src/host/member-ledger.ts";
import { FakeSpawner, defaultWorkerModels, fauxRouter, ids, startHost, until } from "./helpers/fakes.ts";
import { Host } from "../src/host/host.ts";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** A process shaped like a member the host started: its own group, its session dir on the command line, a child in the group. */
async function leftover(t: TestContext, sessionDir: string, script = "") {
	mkdirSync(sessionDir, { recursive: true });
	const childPid = join(sessionDir, "child.pid");
	const code = `${script}; const c = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(childPid)}, String(c.pid)); setInterval(() => {}, 1000);`;
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
	assert.deepEqual(JSON.parse(readFileSync(ledger(sessionDir), "utf8")), { pid });
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

test("记录里的 pid 现在是别的进程（命令行里没有这位成员的会话目录）：不发信号，只清记录；进程已经不在的也只清记录", async (t) => {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-ledger-"));
	const reused = memberSessionDir(stateDir, "tkt_1", "reused");
	const gone = memberSessionDir(stateDir, "tkt_2", "gone");
	const other = await leftover(t, join(stateDir, "somewhere-else"));
	mkdirSync(reused, { recursive: true });
	mkdirSync(gone, { recursive: true });
	recordMember(reused, other.pid);
	writeFileSync(ledger(gone), JSON.stringify({ pid: 2 ** 22 + 12345 }));
	const logs: string[] = [];
	await endLeftoverMembers(stateDir, (line) => logs.push(line));
	assert.equal(alive(other.pid), true, "别人的进程不动");
	assert.equal(existsSync(ledger(reused)), false);
	assert.equal(existsSync(ledger(gone)), false);
	assert.deepEqual(logs, []);
});

test("成员做完后清掉自己的记录；清两次不出错", () => {
	const sessionDir = join(mkdtempSync(join(tmpdir(), "psa-ledger-")), "team", "m");
	recordMember(sessionDir, 4242);
	clearMember(sessionDir);
	clearMember(sessionDir);
	assert.equal(existsSync(ledger(sessionDir)), false);
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
