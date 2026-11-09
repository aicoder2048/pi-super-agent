import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tempStateDir } from "./helpers/fakes.ts";

function badConfigDir() {
	const dir = tempStateDir();
	writeFileSync(join(dir, "config.json"), JSON.stringify({ heartbeatSeconds: 10, watchdog: { staleSeconds: 1 } }));
	return dir;
}

const cases = [
	{
		name: "状态目录路径太长时，just host",
		entry: "src/host/main.ts",
		stateDir: () => join(tempStateDir(), "a-really-long-directory-name-to-push-the-socket-path-over-the-unix-limit-xxxxxxxxxxxx"),
		message: /状态目录路径太长.*PSA_STATE_DIR/,
	},
	{ name: "config.json 的 Watchdog 间隔不合理时，just host", entry: "src/host/main.ts", stateDir: badConfigDir, message: /watchdog\.staleSeconds.*heartbeatSeconds/ },
	{ name: "config.json 的 Watchdog 间隔不合理时，just watchdog", entry: "src/watchdog/main.ts", stateDir: badConfigDir, message: /watchdog\.staleSeconds.*heartbeatSeconds/ },
];

for (const c of cases) {
	test(`${c.name} 只打印一句说明并以 1 退出，不打印堆栈`, () => {
		const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", c.entry], {
			env: { ...process.env, PSA_STATE_DIR: c.stateDir() },
			encoding: "utf8",
			timeout: 20_000,
		});
		assert.equal(run.status, 1);
		assert.match(run.stderr, c.message);
		assert.doesNotMatch(run.stderr, /^\s+at /m);
		assert.doesNotMatch(run.stderr, /^file:\/\//m);
	});
}
