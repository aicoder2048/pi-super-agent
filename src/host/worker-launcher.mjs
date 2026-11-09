// RpcClient spawns this in place of Pi's CLI. Pi runs in its own process group, so a terminal Ctrl+C
// reaches only the host, which stops Workers itself; RpcClient's spawn has no option for that.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";

// Below RpcClient.stop's 1 s SIGKILL of this launcher, which would leave Pi running without it.
const KILL_AFTER_MS = 800;
// Pi prints this whenever the session file is missing. That is normal for a new Worker; for a
// resumed one it means Pi silently started an empty session and the task lost its context.
const NEW_SESSION_WARNING = /No project session found with id /;
const LOST_SESSION = `[worker ${process.env.PSA_TICKET}] 恢复任务时找不到原来的 Pi 会话，Pi 新建了空会话，这个任务之前的上下文丢了`;

const pi = spawn(process.execPath, [process.env.PSA_PI_CLI, ...process.argv.slice(2)], {
	detached: true,
	stdio: ["inherit", "inherit", "pipe"],
});
const signalGroup = (signal) => {
	try {
		process.kill(-pi.pid, signal);
	} catch {}
};

process.on("SIGINT", () => {});
for (const signal of ["SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		signalGroup(signal);
		setTimeout(() => signalGroup("SIGKILL"), KILL_AFTER_MS).unref();
	});
}
createInterface({ input: pi.stderr }).on("line", (line) => {
	if (!NEW_SESSION_WARNING.test(line)) process.stderr.write(`${line}\n`);
	else if (process.env.PSA_WORKER_RESUME) process.stderr.write(`${new Date().toISOString()} ${LOST_SESSION}\n`);
});
pi.on("exit", () => signalGroup("SIGKILL"));
pi.on("close", (code, signal) => process.stderr.write("", () => process.exit(code ?? 128 + constants.signals[signal])));
