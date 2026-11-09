import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigError } from "../config-error.ts";
import type { HostToClient } from "../client/protocol.ts";
import type { Broadcast } from "./server.ts";

type Snapshot = Omit<Extract<HostToClient, { type: "snapshot" }>, "type">;

export interface WebHost {
	snapshot(): Snapshot;
	/** Returns the triggerId. Callers pass text that is non-empty after trim. */
	say(text: string): string;
}

const SAY_MAX_BYTES = 32 * 1024;

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
	400: "请求无法解析：地址不对，或正文不是 {\"text\": \"…\"}，或这句话是空的。",
	401: "token 缺失或已失效，请用宿主日志里最新的网址打开。",
	403: "只接受本机这个页面（127.0.0.1 或 localhost）发来的请求。",
	404: "没有这个页面。",
	405: "这个地址不接受这种请求；发话用 POST /say，其余只接受 GET。",
	413: "这句话太长了，请分几次说。",
	415: "发话的正文要用 application/json。",
} as const;

export class WebGateway {
	readonly #server: Server;
	readonly #token = randomBytes(32).toString("hex");
	readonly #streams = new Set<ServerResponse>();
	readonly #host: WebHost;
	#port = 0;

	constructor(host: WebHost) {
		this.#host = host;
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
		if (url.pathname === "/say") return req.method === "POST" ? this.#say(req, res) : deny(res, 405);
		if (req.method !== "GET") return deny(res, 405);
		if (script) return void res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "text/javascript; charset=utf-8" }).end(script);
		if (url.pathname === "/") {
			res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": CSP });
			return void res.end(INDEX_HTML.replace("{{token}}", this.#token));
		}
		if (url.pathname === "/events") return this.#openStream(res);
		deny(res, 404);
	}

	// The token stops other local pages; Origin and the JSON content type each stop cross-site form posts,
	// since a cross-origin JSON POST needs a CORS preflight that this server never answers.
	#say(req: IncomingMessage, res: ServerResponse): void {
		const origin = req.headers.origin?.toLowerCase();
		if (origin !== `http://127.0.0.1:${this.#port}` && origin !== `http://localhost:${this.#port}`) return deny(res, 403);
		if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return deny(res, 415);
		if (Number(req.headers["content-length"] ?? 0) > SAY_MAX_BYTES) return tooLarge(req, res);
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > SAY_MAX_BYTES) return tooLarge(req, res);
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (res.headersSent) return;
			const text = parseSay(Buffer.concat(chunks).toString("utf8"));
			if (text === undefined) return deny(res, 400);
			const triggerId = this.#host.say(text);
			res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ triggerId }));
		});
	}

	#openStream(res: ServerResponse): void {
		res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
		res.write("retry: 1000\n\n");
		res.write(sseFrame({ type: "snapshot", ...this.#host.snapshot() }));
		this.#streams.add(res);
		const keepalive = setInterval(() => res.write("event: ping\ndata: \n\n"), KEEPALIVE_MS);
		keepalive.unref();
		res.on("close", () => {
			clearInterval(keepalive);
			this.#streams.delete(res);
		});
	}
}

function parseSay(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		const text = (parsed as { text?: unknown } | null)?.text;
		return typeof text === "string" && text.trim() !== "" ? text : undefined;
	} catch {
		return undefined;
	}
}

function tooLarge(req: IncomingMessage, res: ServerResponse): void {
	if (res.headersSent) return void req.destroy();
	res.writeHead(413, { ...NO_LEAK_HEADERS, "content-type": "text/plain; charset=utf-8", connection: "close" }).end(DENIED[413], () => req.destroy());
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
