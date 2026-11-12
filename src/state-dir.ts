import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultStateDir(): string {
	return resolve(process.env.PSA_STATE_DIR ?? join(homedir(), ".pi-super-agent"));
}
