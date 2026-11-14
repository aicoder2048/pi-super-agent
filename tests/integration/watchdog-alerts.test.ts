import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { FAKE_BOT_TOKEN, FakeTelegram } from "../helpers/fake-telegram.ts";
import { until } from "../helpers/fakes.ts";

const USER = 42;
const PRELOAD = resolve("tests/e2e/telegram-preload.mjs");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const heartbeatPid = (dir: string) => {
	const file = join(dir, "heartbeat.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid : undefined;
};

const goodConfig = (webPort: unknown) => ({ heartbeatSeconds: 0.1, watchdog: { intervalMinutes: 0.005, staleSeconds: 0.5 }, webPort, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } });

async function watchdog(t: TestContext, { webPort = 0 as unknown, graceMs }: { webPort?: unknown; graceMs: number }) {
	const tg = await FakeTelegram.start();
	const dir = mkdtempSync(join(tmpdir(), "psa-wdtg-"));
	writeFileSync(join(dir, "secrets.env"), `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`);
	writeFileSync(join(dir, "config.json"), JSON.stringify(goodConfig(webPort)));
	const wd: ChildProcess = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/watchdog/main.ts"], {
		env: { ...process.env, PSA_STATE_DIR: dir, NODE_OPTIONS: `--import ${PRELOAD}`, PSA_E2E_TELEGRAM_URL: tg.url, PSA_RESTART_GRACE_MS: String(graceMs) },
		stdio: ["ignore", "ignore", openSync(join(dir, "watchdog.log"), "a")],
	});
	t.after(async () => {
		for (const pid of [wd.pid, heartbeatPid(dir)]) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
		await tg.close();
	});
	const about = (mark: string) => tg.sent.filter((m) => m.chatId === USER && m.text.startsWith(`🔔 ${mark} 宿主`));
	return { tg, dir, wd, about };
}

test("真实的 Watchdog 和宿主：宿主被 SIGKILL 后手机收到一条 ⚠️，宿主被拉回来后收到一条不响铃的 ✅", { timeout: 60_000 }, async (t) => {
	const { dir, wd, about } = await watchdog(t, { graceMs: 5000 });
	await until(() => { const pid = heartbeatPid(dir); return !!pid && pid !== wd.pid && alive(pid); }, "宿主写出心跳", 20_000);
	const first = heartbeatPid(dir)!;
	// A host that dies before any check saw it beating counts as a failed start, not an outage.
	await new Promise((r) => setTimeout(r, 1500));
	process.kill(first, "SIGKILL");
	await until(() => about("⚠️").length > 0, "手机收到 ⚠️", 20_000).catch((error) => { throw new Error(`${error.message}\n${readFileSync(join(dir, "watchdog.log"), "utf8")}`); });
	assert.match(about("⚠️")[0].text, /^🔔 ⚠️ 宿主停了（最后一次心跳不到 1 分钟前），看门狗正在重启$/);
	assert.equal(about("⚠️")[0].silent, false);
	await until(() => about("✅").length > 0, "手机收到 ✅", 30_000);
	assert.match(about("✅")[0].text, /^🔔 ✅ 宿主恢复了，停了/);
	assert.equal(about("✅")[0].silent, true);
	assert.notEqual(heartbeatPid(dir), first);
	await new Promise((r) => setTimeout(r, 1000));
	assert.equal(about("⚠️").length, 1);
	assert.equal(about("✅").length, 1);
});

test("真实的 Watchdog：宿主一直起不来（网页端口被占）时只发一条 ⚠️，带上 host.log 里的错误", { timeout: 60_000 }, async (t) => {
	const busy = createServer();
	await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
	t.after(() => busy.close());
	const { about } = await watchdog(t, { webPort: (busy.address() as { port: number }).port, graceMs: 1500 });
	await until(() => about("⚠️").length > 0, "手机收到 ⚠️", 30_000);
	assert.match(about("⚠️")[0].text, /^🔔 ⚠️ 宿主连续 3 次启动失败：网页端口 \d+ 已被占用.*webPort。看门狗会接着重试/);
	assert.ok(!about("⚠️")[0].text.includes(FAKE_BOT_TOKEN.split(":")[1]));
	await new Promise((r) => setTimeout(r, 4000));
	assert.equal(about("⚠️").length, 1, "起不来的这段时间只有一条");
});

test("真实的 Watchdog：Telegram 一直发不出去时照样把被杀的宿主拉回来", { timeout: 60_000 }, async (t) => {
	const { tg, dir, wd } = await watchdog(t, { graceMs: 5000 });
	tg.fail("sendMessage", 502);
	await until(() => { const pid = heartbeatPid(dir); return !!pid && pid !== wd.pid && alive(pid); }, "宿主写出心跳", 20_000);
	const first = heartbeatPid(dir)!;
	await new Promise((r) => setTimeout(r, 1500));
	process.kill(first, "SIGKILL");
	await until(() => tg.calls("sendMessage").length > 0, "Watchdog 试着发 ⚠️", 20_000);
	await until(() => { const pid = heartbeatPid(dir); return !!pid && pid !== first && alive(pid); }, "新宿主写出心跳", 30_000);
	assert.deepEqual(tg.sent.filter((m) => m.text.includes("宿主")), []);
});

test("真实的 Watchdog：config.json 读不了时不退出，手机收到一条 ⚠️；改好后接着拉起宿主", { timeout: 60_000 }, async (t) => {
	const { tg, dir, wd } = await watchdog(t, { webPort: "x", graceMs: 1500 });
	const broken = () => tg.sent.filter((m) => m.chatId === USER && m.text.startsWith("🔔 ⚠️ config.json 读不了"));
	await until(() => broken().length > 0, "手机收到 config.json 的 ⚠️", 20_000).catch((error) => { throw new Error(`${error.message}\n${readFileSync(join(dir, "watchdog.log"), "utf8")}`); });
	assert.match(broken()[0].text, /webPort/);
	assert.equal(wd.exitCode, null, "Watchdog 还在");
	writeFileSync(join(dir, "config.json"), JSON.stringify(goodConfig(0)));
	await until(() => { const pid = heartbeatPid(dir); return !!pid && pid !== wd.pid && alive(pid); }, "改好后宿主写出心跳", 30_000).catch((error) => { throw new Error(`${error.message}\n${readFileSync(join(dir, "watchdog.log"), "utf8")}`); });
	assert.equal(broken().length, 1, "坏着的这段时间只有一条");
});
