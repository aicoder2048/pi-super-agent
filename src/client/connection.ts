import { connect, type Socket } from "node:net";
import { onJsonLines, writeJsonLine } from "../jsonl.ts";
import type { ClientToHost, HostToClient } from "./protocol.ts";

export interface HostConnectionOptions {
	socketPath: string;
	onMessage(message: HostToClient): void;
	onStatus?(connected: boolean): void;
	retryMs?: number;
}

export class HostConnection {
	readonly #o: HostConnectionOptions;
	#socket: Socket | undefined;
	#connected = false;
	#closed = false;
	#watching: string | undefined;
	#retry: NodeJS.Timeout | undefined;

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
		onJsonLines(socket, (record) => this.#o.onMessage(record as HostToClient));
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

	say(text: string): boolean {
		return this.#send({ type: "say", text });
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
		this.#socket?.destroy();
	}
}
