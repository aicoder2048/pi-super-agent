// The only module that knows the bot token, the Bot API's URLs and its JSON.
import { inspect } from "node:util";
import { ConfigError } from "../../config-error.ts";

export const TELEGRAM_API = "https://api.telegram.org";
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const TOKEN_SHAPE = /^(\d{5,}):[A-Za-z0-9_-]{30,}$/;
const REQUEST_DEADLINE_MS = 30_000;
const POLL_DEADLINE_EXTRA_MS = 15_000;
const DESCRIPTION_MAX = 120;

export type Http = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

// A WeakMap instead of a field: nothing outside this module can read the token, whatever prints or serializes the object.
const secrets = new WeakMap<BotToken, string>();

export class BotToken {
	/** The number before ":". Not secret: Telegram shows it as the bot's user id. */
	readonly botId: number;

	constructor(raw: string, origin: string) {
		const shape = TOKEN_SHAPE.exec(raw);
		if (!shape) throw new ConfigError(`TELEGRAM_BOT_TOKEN（${origin}）格式不对：应是 @BotFather 给的「数字:字母数字串」，请重新复制`);
		this.botId = Number(shape[1]);
		secrets.set(this, raw);
	}

	toString(): string {
		return "[BotToken]";
	}

	toJSON(): string {
		return "[BotToken]";
	}

	[inspect.custom](): string {
		return "[BotToken]";
	}
}

export interface Chat {
	id: number;
	private: boolean;
}

export type MessageContent =
	| { kind: "text"; text: string }
	| { kind: "forwarded" }
	| { kind: "other" };

export type TelegramEvent = { kind: "message"; chat: Chat; from: number; messageId: number; content: MessageContent; replyTo: number | null };

/** `event` is null for anything the client does not handle; the offset still moves past it. */
export interface Update {
	updateId: number;
	event: TelegramEvent | null;
}

export type TelegramErrorKind =
	| "stopped"
	| "network"
	| "unauthorized"
	| "forbidden"
	| "conflict"
	| "rate_limited"
	| "bad_request"
	| "server"
	| "bad_response";

const KIND_BY_STATUS: Record<number, TelegramErrorKind> = { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 409: "conflict", 429: "rate_limited" };

/** Built only from fixed parts and Telegram's own description, never from a URL or a caught error. */
export class TelegramError extends Error {
	override name = "TelegramError";
	readonly method: string;
	readonly kind: TelegramErrorKind;
	readonly retryAfterMs: number | undefined;

	constructor(method: string, kind: TelegramErrorKind, retryAfterMs?: number, description?: string) {
		super(`Telegram ${method}：${kind}${description ? `：${description.slice(0, DESCRIPTION_MAX)}` : ""}`);
		this.method = method;
		this.kind = kind;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface BotApiOptions {
	token: BotToken;
	baseUrl?: string;
	/** Defaults to the global fetch, looked up at call time so an e2e preload can reroute it. */
	http?: Http;
}

export class BotApi {
	readonly botId: number;
	readonly #token: BotToken;
	readonly #base: string;
	readonly #http: Http;

	constructor({ token, baseUrl = TELEGRAM_API, http = (url, init) => fetch(url, init) }: BotApiOptions) {
		if (baseUrl !== TELEGRAM_API && !LOOPBACK.test(baseUrl)) throw new Error(`Telegram baseUrl 只能是 ${TELEGRAM_API} 或 http://127.0.0.1:<端口>`);
		this.botId = token.botId;
		this.#token = token;
		this.#base = baseUrl;
		this.#http = http;
	}

	async getMe(signal: AbortSignal): Promise<{ username: string }> {
		const me = await this.#call("getMe", {}, signal);
		if (typeof me?.username !== "string") throw new TelegramError("getMe", "bad_response");
		return { username: me.username };
	}

	async getUpdates(offset: number | undefined, timeoutSec: number, signal: AbortSignal): Promise<Update[]> {
		const params = { ...(offset !== undefined && { offset }), timeout: timeoutSec, allowed_updates: ["message"] };
		const result = await this.#call("getUpdates", params, signal, timeoutSec * 1000 + POLL_DEADLINE_EXTRA_MS);
		if (!Array.isArray(result) || !result.every((u) => Number.isSafeInteger(u?.update_id))) throw new TelegramError("getUpdates", "bad_response");
		return result.map((u) => ({ updateId: u.update_id, event: parseMessage(u.message) }));
	}

	async send(chatId: number, text: string, silent: boolean, signal: AbortSignal): Promise<number> {
		const sent = await this.#call("sendMessage", { chat_id: chatId, text, ...(silent && { disable_notification: true }) }, signal);
		if (!Number.isSafeInteger(sent?.message_id)) throw new TelegramError("sendMessage", "bad_response");
		return sent.message_id;
	}

	async #call(method: string, params: object, signal: AbortSignal, deadlineMs = REQUEST_DEADLINE_MS): Promise<any> {
		const raw = secrets.get(this.#token)!;
		let status: number;
		let text: string;
		try {
			const response = await this.#http(`${this.#base}/bot${raw}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(params),
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]),
			});
			status = response.status;
			text = await response.text();
		} catch {
			throw new TelegramError(method, signal.aborted ? "stopped" : "network");
		}
		let reply: any;
		try {
			reply = JSON.parse(text);
		} catch {
			throw new TelegramError(method, status >= 500 ? "server" : "bad_response");
		}
		if (reply?.ok === true && status < 300 && "result" in reply) return reply.result;
		const kind = KIND_BY_STATUS[status] ?? (status >= 500 ? "server" : "bad_response");
		const retryAfter = reply?.parameters?.retry_after;
		const description = typeof reply?.description === "string" ? reply.description.replaceAll(raw, "[BotToken]").replaceAll(raw.split(":")[1], "[BotToken]") : undefined;
		throw new TelegramError(method, kind, typeof retryAfter === "number" ? retryAfter * 1000 : undefined, description);
	}
}

function parseMessage(m: any): TelegramEvent | null {
	if (typeof m !== "object" || m === null) return null;
	const { chat, from, message_id: messageId } = m;
	if (!Number.isSafeInteger(chat?.id) || typeof chat.type !== "string" || !Number.isSafeInteger(from?.id) || !Number.isSafeInteger(messageId)) return null;
	const content: MessageContent = m.forward_origin ? { kind: "forwarded" } : typeof m.text === "string" ? { kind: "text", text: m.text } : { kind: "other" };
	const replyTo = m.reply_to_message?.message_id;
	return { kind: "message", chat: { id: chat.id, private: chat.type === "private" }, from: from.id, messageId, content, replyTo: Number.isSafeInteger(replyTo) ? replyTo : null };
}
