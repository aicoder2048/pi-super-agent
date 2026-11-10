import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigError } from "../config-error.ts";
import { isCapAskId } from "../kernel/cap-ask.ts";
import { OPTIONS_MAX, refusalText, type AnswerRefusal } from "../kernel/question.ts";
import type { HostToClient, TranscriptHistory, TranscriptMessage } from "../client/protocol.ts";
import { hasVisibleText, HistoryEchoFilter, type AnswerResult, type Broadcast } from "./server.ts";
import { tokenMatches } from "./web-token.ts";

type Snapshot = Omit<Extract<HostToClient, { type: "snapshot" }>, "type">;

export interface WebHost {
	snapshot(): Snapshot;
	transcript(ticketId: string): TranscriptHistory;
	say(text: string): string;
	answer(reportId: string, option: number): AnswerResult;
}

const SAY_MAX_BYTES = 32 * 1024;
const TICKET_ID = /^tkt_[A-Za-z0-9_-]{1,64}$/;
const REPORT_ID = /^rpt_[A-Za-z0-9_-]{1,64}$/;

const INDEX_HTML = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const SCRIPT = "text/javascript; charset=utf-8";
// No user data in these, so they need only the Host check. A relative module import or a favicon request would drop the token anyway.
const STATIC = new Map([
	["/app.mjs", { type: SCRIPT, body: readFileSync(new URL("../web/app.mjs", import.meta.url)) }],
	["/view.mjs", { type: SCRIPT, body: readFileSync(new URL("../web/view.mjs", import.meta.url)) }],
	["/client/board-format.mjs", { type: SCRIPT, body: readFileSync(new URL("../client/board-format.mjs", import.meta.url)) }],
	["/icon.svg", { type: "image/svg+xml", body: readFileSync(new URL("../web/icon.svg", import.meta.url)) }],
]);

const NO_LEAK_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } as const;
// img-src exists only for the tab icon: browsers apply default-src to the favicon request.
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const KEEPALIVE_MS = 15_000;
const INTERNAL_ERROR = "宿主内部出错，详情见宿主日志。";

const DENIED = {
	400: "请求无法解析：地址不对，或正文不是 {\"text\": \"…\"} 或 {\"answer\": {\"reportId\": \"rpt_…\", \"option\": 0}}，或这句话是空的。",
	401: "token 缺失或已失效，请用宿主日志里最新的网址打开。",
	403: "只接受本机这个页面（127.0.0.1 或 localhost）发来的请求。",
	404: "没有这个页面。",
	405: "这个地址不接受这种请求；发话用 POST /say，其余只接受 GET。",
	413: "这句话太长了，请分几次说。",
	415: "发话的正文要用 application/json。",
} as const;

export class WebGateway {
	readonly #server: Server;
	readonly #token: string;
	readonly #streams = new Set<ServerResponse>();
	readonly #watchers = new Map<string, Set<ServerResponse>>();
	readonly #echoes = new HistoryEchoFilter<ServerResponse>();
	readonly #host: WebHost;
	readonly #log: (line: string) => void;
	#port = 0;

	constructor(host: WebHost, token: string, log: (line: string) => void) {
		this.#host = host;
		this.#token = token;
		this.#log = log;
		this.#server = createServer((req, res) => this.#guard(req, res, () => this.#handle(req, res)));
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

	sendTranscript(ticketId: string, message: TranscriptMessage, member?: { callId: string; index: number }): void {
		const watchers = this.#watchers.get(ticketId);
		if (!watchers) return;
		const frame = sseFrame({ type: "transcript", ticketId, message, ...(member && { member }) });
		const json = JSON.stringify(message);
		const alreadyInHistory = (res: ServerResponse) => !member && this.#echoes.isEcho(res, json);
		for (const res of watchers) if (!alreadyInHistory(res)) res.write(frame);
	}

	close(): Promise<void> {
		if (!this.#server.listening) return Promise.resolve();
		const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
		// server.close() alone waits on every open SSE stream forever.
		this.#server.closeAllConnections();
		return closed;
	}

	// A throw here would escape into the http server's emit and take the whole host down.
	#guard(req: IncomingMessage, res: ServerResponse, work: () => void): void {
		try {
			work();
		} catch (error) {
			this.#log(`[web] ${req.method} ${URL.parse(req.url ?? "/", "http://x")?.pathname} 出错：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			if (res.headersSent) res.destroy();
			else res.writeHead(500, { ...NO_LEAK_HEADERS, "content-type": "text/plain; charset=utf-8" }).end(INTERNAL_ERROR);
		}
	}

	#handle(req: IncomingMessage, res: ServerResponse): void {
		const url = URL.parse(req.url ?? "/", "http://x");
		if (!url) return deny(res, 400);
		if (!isLocalHost(req.headers.host, this.#port)) return deny(res, 403);
		const file = STATIC.get(url.pathname);
		if (!file && !tokenMatches(url.searchParams.get("token") ?? "", this.#token)) return deny(res, 401);
		if (url.pathname === "/say") return req.method === "POST" ? this.#say(req, res) : deny(res, 405);
		if (req.method !== "GET") return deny(res, 405);
		if (file) return void res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": file.type }).end(file.body);
		if (url.pathname === "/") {
			res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": CSP });
			return void res.end(INDEX_HTML.replace("{{token}}", this.#token));
		}
		if (url.pathname === "/events") return this.#openStream(res, { type: "snapshot", ...this.#host.snapshot() }, this.#streams);
		if (url.pathname === "/transcript") {
			const ticketId = url.searchParams.get("ticket") ?? "";
			if (!TICKET_ID.test(ticketId)) return deny(res, 400);
			const history = this.#host.transcript(ticketId);
			const watchers = this.#watchers.get(ticketId) ?? new Set();
			this.#watchers.set(ticketId, watchers);
			this.#echoes.opened(res, history.messages);
			return this.#openStream(res, { type: "transcript_history", ticketId, ...history }, watchers, () => this.#watchers.delete(ticketId));
		}
		deny(res, 404);
	}

	// The token stops other local pages; Origin and the JSON content type each stop cross-site form posts,
	// since a cross-origin JSON POST needs a CORS preflight that this server never answers.
	#say(req: IncomingMessage, res: ServerResponse): void {
		const origin = req.headers.origin?.toLowerCase();
		if (!origin?.startsWith("http://") || !isLocalHost(origin.slice("http://".length), this.#port)) return deny(res, 403);
		if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return deny(res, 415);
		if (Number(req.headers["content-length"] ?? 0) > SAY_MAX_BYTES) return tooLarge(req, res);
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > SAY_MAX_BYTES) return tooLarge(req, res);
			chunks.push(chunk);
		});
		req.on("end", () =>
			this.#guard(req, res, () => {
				if (res.headersSent) return;
				const body = parseSayBody(Buffer.concat(chunks).toString("utf8"));
				if (body === undefined) return deny(res, 400);
				const result = body.kind === "text" ? { ok: true as const, triggerId: this.#host.say(body.text) } : this.#host.answer(body.reportId, body.option);
				if (!result.ok) return refuse(res, result.refusal);
				const { triggerId } = result;
				res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ triggerId }));
			}),
		);
	}

	#openStream(res: ServerResponse, first: HostToClient, set: Set<ServerResponse>, onEmpty?: () => void): void {
		res.writeHead(200, { ...NO_LEAK_HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
		res.write("retry: 1000\n\n");
		res.write(sseFrame(first));
		set.add(res);
		const keepalive = setInterval(() => res.write("event: ping\ndata: \n\n"), KEEPALIVE_MS);
		keepalive.unref();
		res.on("close", () => {
			clearInterval(keepalive);
			set.delete(res);
			if (set.size === 0) onEmpty?.();
		});
	}
}

type SayBody = { kind: "text"; text: string } | { kind: "answer"; reportId: string; option: number };

function parseSayBody(body: string): SayBody | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const keys = Object.keys(parsed);
	if (keys.length !== 1) return undefined;
	const { text, answer } = parsed as { text?: unknown; answer?: unknown };
	if (keys[0] === "text") return typeof text === "string" && hasVisibleText(text) ? { kind: "text", text } : undefined;
	if (keys[0] !== "answer" || typeof answer !== "object" || answer === null || Object.keys(answer).length !== 2) return undefined;
	const { reportId, option } = answer as { reportId?: unknown; option?: unknown };
	if (typeof reportId !== "string" || !(REPORT_ID.test(reportId) || isCapAskId(reportId))) return undefined;
	if (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= OPTIONS_MAX) return undefined;
	return { kind: "answer", reportId, option };
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

const REFUSED_STATUS: Record<AnswerRefusal["kind"], number> = { no_question: 404, no_options: 409, out_of_range: 409, chosen: 409, spoke: 409, closed: 409 };

// The body is JSON so the page can pick its own copy by `refused`; `reason` is for curl users.
function refuse(res: ServerResponse, refusal: AnswerRefusal): void {
	const body = { refused: refusal.kind, ...(refusal.kind === "chosen" ? { option: refusal.option } : {}), reason: refusalText(refusal) };
	res.writeHead(REFUSED_STATUS[refusal.kind], { ...NO_LEAK_HEADERS, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

function deny(res: ServerResponse, status: keyof typeof DENIED): void {
	res.writeHead(status, { ...NO_LEAK_HEADERS, "content-type": "text/plain; charset=utf-8" }).end(DENIED[status]);
}
