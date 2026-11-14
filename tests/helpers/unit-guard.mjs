import childProcess from "node:child_process";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

if (process.env.NODE_TEST_CONTEXT) {
	const refuse = (what) => {
		throw new Error(`unit tests may not ${what}; move this file to tests/integration/ (see tests/README.md)`);
	};
	const piLoaderLookup = (file, args) => file === "npm" && args?.join(" ") === "root -g";
	const { execFileSync } = childProcess;
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "fork"]) {
		childProcess[name] = () => refuse(`start a child process (child_process.${name})`);
	}
	// src/pi-runtime.mjs asks npm where the global Pi install lives the first time a test imports Pi.
	childProcess.execFileSync = (file, args, ...rest) =>
		piLoaderLookup(file, args) ? execFileSync(file, args, ...rest) : refuse("start a child process (child_process.execFileSync)");
	net.Server.prototype.listen = () => refuse("listen on a port or socket (net.Server.listen)");
	syncBuiltinESMExports();
}
