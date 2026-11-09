import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { onJsonLines, writeJsonLine } from "../jsonl.ts";
import type { ClientToHost, HostToClient } from "./protocol.ts";

export const DEFAULT_ACK_TIMEOUT_MS = 5000;

export interface HostConnectionOptions {
	socketPath: string;
	onMessage(message: HostToClient): void;
	onStatus?(connected: boolean): void;
	onAckMissing?(text: string): void;
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
	readonly #awaitingAck = new Map<string, NodeJS.Timeout>();

	constructor(options: HostConnectionOptions) {
		this.#o = options;
	}

	get connected(): boolean {
		return this.#connected;
	}

	open(): void {
		if (this.#closed) return;
		const socket = connect(this.#o.socketPath);
		this.#socket = socket;
		socket.on("connect", () => {
			this.#connected = true;
			writeJsonLine(socket, { type: "hello", role: "client" } satisfies ClientToHost);
			if (this.#watching) writeJsonLine(socket, { type: "watch", ticketId: this.#watching } satisfies ClientToHost);
			this.#o.onStatus?.(true);
		});
		onJsonLines(socket, (record) => {
			const message = record as HostToClient;
			if (message.type === "ack") {
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
			this.#retry = setTimeout(() => this.open(), this.#o.retryMs ?? 1000);
			this.#retry.unref();
		});
	}

	say(text: string): string | undefined {
		const requestId = randomUUID();
		if (!this.#send({ type: "say", text, requestId })) return undefined;
		const timer = setTimeout(() => {
			this.#awaitingAck.delete(requestId);
			this.#o.onAckMissing?.(text);
		}, this.#o.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
		timer.unref();
		this.#awaitingAck.set(requestId, timer);
		return requestId;
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
