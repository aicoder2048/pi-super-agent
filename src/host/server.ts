import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { onJsonLines, writeJsonLine } from "../jsonl.ts";
import type { HostToClient } from "../client/protocol.ts";
import { refusalText, type AnswerRefusal } from "../kernel/question.ts";

export type Broadcast = Extract<HostToClient, { type: "user" | "reply" | "board" }>;

export type AnswerResult = { ok: true; triggerId: string } | { ok: false; refusal: AnswerRefusal };

export interface ClientHandlers {
	onSay(text: string): string;
	onAnswer(reportId: string, option: number): AnswerResult;
	snapshot(): unknown;
	transcript?(ticketId: string): unknown[];
}

// Zero-width and other format characters (Unicode Cf) render as nothing, so a line of only those is blank.
export function hasVisibleText(text: string): boolean {
	return text.replace(/[\s\p{Cf}]/gu, "") !== "";
}

export class HistoryEchoFilter<K extends object> {
	readonly #last = new WeakMap<K, string>();

	opened(watcher: K, history: unknown[]): void {
		if (history.length) this.#last.set(watcher, JSON.stringify(history.at(-1)));
		else this.#last.delete(watcher);
	}

	isEcho(watcher: K, json: string): boolean {
		const last = this.#last.get(watcher);
		this.#last.delete(watcher);
		return last === json;
	}
}

export interface WorkerRequestHandler {
	(ticketId: string, token: string, method: string, params: unknown): unknown;
}

interface ClientConn {
	socket: Socket;
	watching: string | undefined;
}

export class HostServer {
	readonly #server: Server;
	readonly #clients = new Set<ClientConn>();
	readonly #echoes = new HistoryEchoFilter<ClientConn>();
	readonly #log: (line: string) => void;

	constructor(clients: ClientHandlers, workers: WorkerRequestHandler, log: (line: string) => void) {
		this.#log = log;
		this.#server = createServer((socket) => {
			socket.on("error", () => {});
			let role: "client" | "worker" | undefined;
			let client: ClientConn | undefined;
			let worker: { ticketId: string; token: string } | undefined;
			onJsonLines(socket, (record) => {
				const r = record as Record<string, any>;
				if (!role) {
					if (r.type !== "hello") return socket.destroy();
					role = r.role === "worker" ? "worker" : "client";
					if (role === "worker") worker = { ticketId: String(r.ticketId), token: String(r.token) };
					else {
						client = { socket, watching: undefined };
						this.#clients.add(client);
						this.#guard("hello", () => writeJsonLine(socket, { type: "snapshot", ...(clients.snapshot() as object) }), () => socket.destroy());
					}
					return;
				}
				if (role === "worker") {
					new Promise((resolve) => resolve(workers(worker!.ticketId, worker!.token, String(r.method), r.params))).then(
						(result) => writeJsonLine(socket, { id: r.id, ok: true, result }),
						(error) => writeJsonLine(socket, { id: r.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
					);
					return;
				}
				const c = client!;
				if (r.type === "say" && typeof r.text === "string" && hasVisibleText(r.text)) {
					// No ack on failure: the client already warns that an unacked line may not have arrived.
					this.#guard("say", () => {
						const triggerId = clients.onSay(r.text);
						if (typeof r.requestId === "string") writeJsonLine(socket, { type: "ack", requestId: r.requestId, triggerId });
					}, () => {});
				}
				else if (r.type === "answer" && typeof r.reportId === "string" && Number.isInteger(r.option) && typeof r.requestId === "string") {
					const result = clients.onAnswer(r.reportId, r.option);
					writeJsonLine(socket, result.ok ? { type: "ack", requestId: r.requestId, triggerId: result.triggerId } : { type: "refused", requestId: r.requestId, reason: refusalText(result.refusal) });
				}
				else if (r.type === "watch") {
					c.watching = typeof r.ticketId === "string" ? r.ticketId : undefined;
					if (c.watching && clients.transcript) {
						const ticketId = c.watching;
						this.#guard("watch", () => {
							const messages = clients.transcript!(ticketId);
							this.#echoes.opened(c, messages);
							writeJsonLine(socket, { type: "transcript_history", ticketId, messages });
						}, () => writeJsonLine(socket, { type: "transcript_history", ticketId, messages: [] }));
					}
				}
			});
			socket.on("close", () => {
				if (client) this.#clients.delete(client);
			});
		});
	}

	// One client's failed request must not reach the socket's data handler, where it would kill the host.
	#guard(what: string, work: () => void, answerFailure: () => void): void {
		try {
			work();
		} catch (error) {
			this.#log(`[socket] 客户端 ${what} 出错：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			answerFailure();
		}
	}

	listen(path: string): Promise<void> {
		rmSync(path, { force: true });
		return new Promise((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen(path, () => resolve());
		});
	}

	broadcast(message: Broadcast): void {
		for (const c of this.#clients) writeJsonLine(c.socket, message);
	}

	sendTranscript(ticketId: string, message: unknown): void {
		const json = JSON.stringify(message);
		for (const c of this.#clients) {
			if (c.watching === ticketId && !this.#echoes.isEcho(c, json)) writeJsonLine(c.socket, { type: "transcript", ticketId, message });
		}
	}

	clientCount(): number {
		return this.#clients.size;
	}

	close(): Promise<void> {
		for (const c of this.#clients) c.socket.destroy();
		return new Promise((resolve) => this.#server.close(() => resolve()));
	}
}
