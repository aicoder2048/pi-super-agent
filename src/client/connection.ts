import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { onJsonLines, writeJsonLine } from "../jsonl.ts";
import { DEFAULT_ACK_TIMEOUT_MS } from "./board-format.mjs";
import { clientTokenBeside } from "./client-token.ts";
import type { ClientToHost, HostToClient } from "./protocol.ts";

export { DEFAULT_ACK_TIMEOUT_MS };

export interface HostConnectionOptions {
	socketPath: string;
	onMessage(message: HostToClient): void;
	onStatus?(connected: boolean): void;
	onAckMissing?(text: string): void;
	onError?(line: string): void;
	retryMs?: number;
	ackTimeoutMs?: number;
}

export class HostConnection {
	readonly #o: HostConnectionOptions;
	#socket: Socket | undefined;
	#connected = false;
	#closed = false;
	#watching: string | undefined;
	#retry: NodeJS.Timeout | undefined;
	#lastReported: string | undefined;
	readonly #awaitingAck = new Map<string, NodeJS.Timeout>();

	constructor(options: HostConnectionOptions) {
		this.#o = options;
	}

	get connected(): boolean {
		return this.#connected;
	}

	open(): void {
		if (this.#closed) return;
		let token: string;
		try {
			token = clientTokenBeside(this.#o.socketPath);
		} catch (error) {
			this.#reportOnce((error as Error).message);
			return this.#retryLater();
		}
		this.#lastReported = undefined;
		const socket = connect(this.#o.socketPath);
		this.#socket = socket;
		socket.on("connect", () => {
			this.#connected = true;
			writeJsonLine(socket, { type: "hello", role: "client", token } satisfies ClientToHost);
			if (this.#watching) writeJsonLine(socket, { type: "watch", ticketId: this.#watching } satisfies ClientToHost);
			this.#o.onStatus?.(true);
		});
		onJsonLines(socket, (record) => {
			const message = record as HostToClient;
			if (message.type === "ack" || message.type === "refused") {
				clearTimeout(this.#awaitingAck.get(message.requestId));
				this.#awaitingAck.delete(message.requestId);
			}
			this.#o.onMessage(message);
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			const was = this.#connected;
			this.#connected = false;
			if (was) this.#o.onStatus?.(false);
			if (this.#closed) return;
			this.#retryLater();
		});
	}

	#retryLater(): void {
		this.#retry = setTimeout(() => this.open(), this.#o.retryMs ?? 1000);
		this.#retry.unref();
	}

	#reportOnce(line: string): void {
		if (line === this.#lastReported) return;
		this.#lastReported = line;
		this.#o.onError?.(line);
	}

	say(text: string): string | undefined {
		const requestId = randomUUID();
		if (!this.#send({ type: "say", text, requestId })) return undefined;
		this.#expectAck(requestId, text);
		return requestId;
	}

	answer(reportId: string, option: number, label = `第 ${option + 1} 个选项`): string | undefined {
		const requestId = randomUUID();
		if (!this.#send({ type: "answer", reportId, option, requestId })) return undefined;
		this.#expectAck(requestId, label);
		return requestId;
	}

	#expectAck(requestId: string, text: string): void {
		const timer = setTimeout(() => {
			this.#awaitingAck.delete(requestId);
			this.#o.onAckMissing?.(text);
		}, this.#o.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
		timer.unref();
		this.#awaitingAck.set(requestId, timer);
	}

	watch(ticketId: string | undefined): void {
		this.#watching = ticketId;
		this.#send({ type: "watch", ticketId });
	}

	#send(message: ClientToHost): boolean {
		if (!this.#socket || !this.#connected) return false;
		writeJsonLine(this.#socket, message);
		return true;
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#retry);
		for (const timer of this.#awaitingAck.values()) clearTimeout(timer);
		this.#awaitingAck.clear();
		this.#socket?.destroy();
	}
}
