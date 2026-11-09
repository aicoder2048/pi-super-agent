import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { onJsonLines, writeJsonLine } from "../jsonl.ts";
import type { HostToClient } from "../client/protocol.ts";

export type Broadcast = Extract<HostToClient, { type: "user" | "reply" | "board" }>;

export interface ClientHandlers {
	onSay(text: string): string;
	snapshot(): unknown;
	transcript?(ticketId: string): unknown[];
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

	constructor(clients: ClientHandlers, workers: WorkerRequestHandler) {
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
						writeJsonLine(socket, { type: "snapshot", ...(clients.snapshot() as object) });
					}
					return;
				}
				if (role === "worker") {
					try {
						const result = workers(worker!.ticketId, worker!.token, String(r.method), r.params);
						writeJsonLine(socket, { id: r.id, ok: true, result });
					} catch (error) {
						writeJsonLine(socket, { id: r.id, ok: false, error: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (r.type === "say" && typeof r.text === "string" && r.text.trim()) {
					const triggerId = clients.onSay(r.text);
					if (typeof r.requestId === "string") writeJsonLine(socket, { type: "ack", requestId: r.requestId, triggerId });
				}
				else if (r.type === "watch") {
					client!.watching = typeof r.ticketId === "string" ? r.ticketId : undefined;
					if (client!.watching && clients.transcript) {
						writeJsonLine(socket, { type: "transcript_history", ticketId: client!.watching, messages: clients.transcript(client!.watching) });
					}
				}
			});
			socket.on("close", () => {
				if (client) this.#clients.delete(client);
			});
		});
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
		for (const c of this.#clients) if (c.watching === ticketId) writeJsonLine(c.socket, { type: "transcript", ticketId, message });
	}

	clientCount(): number {
		return this.#clients.size;
	}

	close(): Promise<void> {
		for (const c of this.#clients) c.socket.destroy();
		return new Promise((resolve) => this.#server.close(() => resolve()));
	}
}
