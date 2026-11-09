import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigError } from "../config-error.ts";
import type { HostToClient } from "../client/protocol.ts";
import type { Broadcast } from "./server.ts";

type Snapshot = Omit<Extract<HostToClient, { type: "snapshot" }>, "type">;

const INDEX_HTML = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
// No user data in these, so they need only the Host check. A relative module import would drop the token anyway.
const SCRIPTS = new Map([
	["/app.mjs", readFileSync(new URL("../web/app.mjs", import.meta.url))],
	["/view.mjs", readFileSync(new URL("../web/view.mjs", import.meta.url))],
	["/client/board-format.mjs", readFileSync(new URL("../client/board-format.mjs", import.meta.url))],
]);

const NO_LEAK_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } as const;
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const KEEPALIVE_MS = 15_000;

const DENIED = {
	400: "请求地址无法解析。",
	401: "token 缺失或已失效，请用宿主日志里最新的网址打开。",
	403: "只接受 127.0.0.1 或 localhost 访问。",
	404: "没有这个页面。",
	405: "只读页面，只接受 GET。",
} as const;

export class WebGateway {
	readonly #server: Server;
	readonly #token = randomBytes(32).toString("hex");
	readonly #streams = new Set<ServerResponse>();
	readonly #snapshot: () => Snapshot;
	#port = 0;

	constructor(snapshot: () => Snapshot) {
		this.#snapshot = snapshot;
		this.#server = createServer((req, res) => this.#handle(req, res));
	}

	listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#server.once("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE") reject(new ConfigError(`网页端口 ${port} 已被占用，可能另一个宿主还在运行。停掉它，或在 config.json 里改 webPort。`));
				else if (error.code === "EACCES") reject(new ConfigError(`没有权限监听网页端口 ${port}，请在 config.json 里改 webPort。`));
				else reject(error);
			});
			this.#server.listen({ host: "127.0.0.1", port }, () => {
				this.#port = (this.#server.address() as AddressInfo).port;
				resolve();
			});
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.#port}/?token=${this.#token}`;
	}

	broadcast(message: Broadcast): void {
		const frame = sseFrame(message);
		for (const res of this.#streams) res.write(frame);
	}

	close(): Promise<void> {
		if (!this.#server.listening) return Promise.resolve();
		const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
		// server.close() alone waits on every open SSE stream forever.
		this.#server.closeAllConnections();
		return closed;
	}

	#handle(req: IncomingMessage, res: ServerResponse): void {
		const url = URL.parse(req.url ?? "/", "http://x");
		if (!url) return deny(res, 400);
		if (!isLocalHost(req.headers.host, this.#port)) return deny(res, 403);
		const script = SCRIPTS.get(url.pathname);
		if (!script && !tokenMatches(url.searchParams.get("token") ?? "", this.#token)) return deny(res, 401);
		if (req.method !== "GET") return deny(res, 405);
		if (script) return void res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "text/javascript; charset=utf-8" }).end(script);
		if (url.pathname === "/") {
			res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": CSP });
			return void res.end(INDEX_HTML.replace("{{token}}", this.#token));
		}
		if (url.pathname === "/events") return this.#openStream(res);
		deny(res, 404);
	}

	#openStream(res: ServerResponse): void {
		res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
		res.write("retry: 1000\n\n");
		res.write(sseFrame({ type: "snapshot", ...this.#snapshot() }));
		this.#streams.add(res);
		const keepalive = setInterval(() => res.write("event: ping\ndata: \n\n"), KEEPALIVE_MS);
		keepalive.unref();
		res.on("close", () => {
			clearInterval(keepalive);
			this.#streams.delete(res);
		});
	}
}

function sseFrame(message: HostToClient): string {
	return `data: ${JSON.stringify(message)}\n\n`;
}

function isLocalHost(host: string | undefined, port: number): boolean {
	const h = host?.toLowerCase();
	return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function tokenMatches(given: string, token: string): boolean {
	const got = Buffer.from(given);
	const want = Buffer.from(token);
	return got.length === want.length && timingSafeEqual(got, want);
}

function deny(res: ServerResponse, status: keyof typeof DENIED): void {
	res.writeHead(status, { ...NO_LEAK_HEADERS, "content-type": "text/plain; charset=utf-8" }).end(DENIED[status]);
}
