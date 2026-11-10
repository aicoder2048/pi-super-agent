import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Read from the socket's own directory on every connect: a client follows a rotated credential by itself,
// and one state directory's credential is never sent to another's socket.
export function readClientToken(socketPath: string): string {
	const path = join(dirname(socketPath), "client-token");
	try {
		return readFileSync(path, "utf8").trim();
	} catch (error) {
		throw new Error(`读不了客户端凭据 ${path}（${(error as NodeJS.ErrnoException).code}）。先运行 just host；宿主已经在运行就重启它一次。`);
	}
}
