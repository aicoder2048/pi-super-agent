// RpcClient spawns this in place of Pi's CLI. Pi runs in its own process group, so a terminal Ctrl+C
// reaches only the host, which stops Workers itself; RpcClient's spawn has no option for that.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";

// Below RpcClient.stop's 1 s SIGKILL of this launcher, which would leave Pi running without it.
const KILL_AFTER_MS = 800;
// Pi prints this for every new Worker session, which is the normal case here.
const NEW_SESSION_WARNING = /No project session found with id /;

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
});
pi.on("exit", () => signalGroup("SIGKILL"));
pi.on("close", (code, signal) => process.exit(code ?? 128 + constants.signals[signal]));
