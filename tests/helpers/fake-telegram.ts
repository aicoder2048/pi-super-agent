// A fake Bot API on 127.0.0.1: getMe, a long-polling getUpdates and sendMessage, with hooks to inject
// updates and failures. In-process tests point BotApi at it; the e2e preload reroutes the host's fetch to it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_BOT_TOKEN = "123456789:AAH-fake_token_for_tests_only_000000";
export const FAKE_BOT_USERNAME = "psa_test_bot";

export interface SentMessage {
	chatId: number;
	text: string;
	silent: boolean;
	messageId: number;
	at: number;
}

export interface RequestRecord {
	method: string;
	at: number;
	status: number;
}

export interface UserMessage {
	/** Defaults to the sender: a private chat. */
	chatId?: number;
	group?: boolean;
	forwarded?: boolean;
	/** Sent through an inline bot: the text is that bot's, not the user's. */
	viaBot?: boolean;
	photo?: boolean;
	replyTo?: number;
}

type Failure = { status: number; body: object; times: number };
type Waiter = { offset: number; res: ServerResponse; timer: NodeJS.Timeout };

export class FakeTelegram {
	readonly sent: SentMessage[] = [];
	readonly requests: RequestRecord[] = [];
	/** Requests whose path carried another token than the one the fake was started with. */
	wrongToken = 0;
	readonly #token: string;
	readonly #server: Server;
	readonly #updates: { update_id: number }[] = [];
	readonly #redeliver: { update_id: number }[] = [];
	readonly #failures = new Map<string, Failure>();
	readonly #waiters = new Set<Waiter>();
	#confirmed = 0;
	#nextUpdateId = 1000;
	#nextMessageId = 1;
	url = "";

	private constructor(token: string) {
		this.#token = token;
		this.#server = createServer((req, res) => void this.#serve(req, res));
	}

	static async start(token = FAKE_BOT_TOKEN, port = 0): Promise<FakeTelegram> {
		const fake = new FakeTelegram(token);
		await new Promise<void>((listening) => fake.#server.listen(port, "127.0.0.1", listening));
		fake.url = `http://127.0.0.1:${(fake.#server.address() as AddressInfo).port}`;
		return fake;
	}

	/** Queues a message from Telegram user `from`; returns its update_id. */
	userSays(from: number, text: string, options: UserMessage = {}): number {
		const chatId = options.chatId ?? from;
		const message = {
			message_id: this.#nextMessageId++,
			from: { id: from, is_bot: false, first_name: "测试" },
			chat: { id: chatId, type: options.group ? "group" : "private" },
			date: Math.floor(Date.now() / 1000),
			...(options.photo ? { photo: [{ file_id: "photo" }] } : { text }),
			...(options.forwarded && { forward_origin: { type: "hidden_user", sender_user_name: "别人", date: 0 } }),
			...(options.viaBot && { via_bot: { id: 777, is_bot: true, first_name: "gif", username: "gif" } }),
			...(options.replyTo !== undefined && { reply_to_message: { message_id: options.replyTo } }),
		};
		return this.push({ message });
	}

	push(update: object): number {
		const updateId = this.#nextUpdateId++;
		this.#updates.push({ update_id: updateId, ...update });
		this.#wakeWaiters();
		return updateId;
	}

	/** Hands an update out again even though the client confirmed it, as Telegram does after a lost offset. */
	redeliver(updateId: number): void {
		const update = this.#updates.find((u) => u.update_id === updateId);
		if (!update) throw new Error(`没有 update ${updateId}`);
		this.#redeliver.push(update);
		this.#wakeWaiters();
	}

	/** The next `times` calls of `method` answer with `status` (every call until heal() when times is Infinity). */
	fail(method: string, status: number, extra: object = {}, times = Infinity): void {
		this.#failures.set(method, { status, body: { ok: false, error_code: status, description: `fake ${status}`, ...extra }, times });
	}

	heal(method: string): void {
		this.#failures.delete(method);
	}

	calls(method: string): RequestRecord[] {
		return this.requests.filter((r) => r.method === method);
	}

	async close(): Promise<void> {
		for (const waiter of this.#waiters) this.#answerPoll(waiter);
		this.#server.closeAllConnections();
		await new Promise((closed) => this.#server.close(closed));
	}

	async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
		const method = match?.[2] ?? "?";
		const reply = (status: number, body: object) => {
			this.requests.push({ method, at: Date.now(), status });
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
		};
		if (!match || req.method !== "POST") return reply(404, { ok: false, error_code: 404, description: "Not Found" });
		if (match[1] !== this.#token) {
			this.wrongToken++;
			return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
		}
		const failure = this.#failures.get(method);
		if (failure) {
			if (--failure.times <= 0) this.#failures.delete(method);
			return reply(failure.status, failure.body);
		}
		const params = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		switch (method) {
			case "getMe":
				return reply(200, { ok: true, result: { id: Number(this.#token.split(":")[0]), is_bot: true, first_name: "白宫", username: FAKE_BOT_USERNAME } });
			case "sendMessage": {
				const sent = { chatId: params.chat_id, text: params.text, silent: params.disable_notification === true, messageId: this.#nextMessageId++, at: Date.now() };
				this.sent.push(sent);
				return reply(200, { ok: true, result: { message_id: sent.messageId, chat: { id: sent.chatId, type: "private" }, date: Math.floor(sent.at / 1000), text: sent.text } });
			}
			case "getUpdates": {
				const offset = typeof params.offset === "number" ? params.offset : 0;
				this.#confirmed = Math.max(this.#confirmed, offset);
				const waiter: Waiter = { offset, res, timer: setTimeout(() => this.#answerPoll(waiter), (params.timeout ?? 0) * 1000) };
				this.#waiters.add(waiter);
				res.on("close", () => {
					clearTimeout(waiter.timer);
					this.#waiters.delete(waiter);
				});
				if (this.#pending(offset).length) this.#answerPoll(waiter);
				return;
			}
			default:
				return reply(400, { ok: false, error_code: 400, description: `Bad Request: fake has no ${method}` });
		}
	}

	#pending(offset: number): { update_id: number }[] {
		return [...this.#redeliver, ...this.#updates.filter((u) => u.update_id >= Math.max(offset, this.#confirmed))];
	}

	#wakeWaiters(): void {
		for (const waiter of this.#waiters) this.#answerPoll(waiter);
	}

	#answerPoll(waiter: Waiter): void {
		clearTimeout(waiter.timer);
		this.#waiters.delete(waiter);
		const result = this.#pending(waiter.offset);
		this.#redeliver.length = 0;
		this.requests.push({ method: "getUpdates", at: Date.now(), status: 200 });
		if (!waiter.res.writableEnded) waiter.res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
	}
}
