// Pure: who counts as the user on Telegram, what a message means, and how each outbound message reads.
import { hasVisibleText, type ImChat } from "../server.ts";
import type { TelegramEvent } from "./bot-api.ts";

const MESSAGE_MAX = 4000;
const CLIPPED = "…（全文见网页）";
const HELP_COMMAND = /^\/(start|help)(@\w+)?(\s|$)/;

export type Note = "help" | "text-only" | "no-forwards" | "no-via-bot";

export const NOTES = {
	help: "这里是白宫。你在这里打的字就是对幕僚长说的话，和网页、终端是同一个对话；幕僚长的回复也发到这里。只收文字，转发的消息不会交给幕僚长。",
	"text-only": "目前只收文字消息，这条没有交给幕僚长。",
	"no-forwards": "转发的消息不会交给幕僚长。要问幕僚长，复制文字后用你自己的话发。",
	"no-via-bot": "经别的机器人发出的消息不会交给幕僚长。要问幕僚长，直接在这里打字。",
	missed: "有一条消息可能没送到手机上，网页上有完整对话。",
	setup: (id: number) => `你的 Telegram 数字 id 是 ${id}。把这个数字写进宿主状态目录里 config.json 的 telegram.allowedUserIds，重启宿主后就能在这里和幕僚长对话。`,
} as const;

export type Inbound =
	| { do: "ignore" }
	| { do: "drop" }
	| { do: "tell-id"; chatId: number }
	| { do: "note"; chatId: number; note: Note }
	| { do: "say"; chatId: number; messageId: number; text: string };

/**
 * `drop` is a stranger or a group: nothing reaches the host. `ignore` is something the user sent that the client does not handle.
 * An empty allowlist is setup mode: a private text only learns its sender's own id.
 */
export function decide(event: TelegramEvent | null, allowed: ReadonlySet<number>): Inbound {
	if (!event) return { do: "ignore" };
	const { chat, from, content } = event;
	if (!chat.private || from !== chat.id) return { do: "drop" };
	if (allowed.size === 0) return content.kind === "text" ? { do: "tell-id", chatId: chat.id } : { do: "drop" };
	if (!allowed.has(from)) return { do: "drop" };
	if (content.kind === "forwarded") return { do: "note", chatId: chat.id, note: "no-forwards" };
	if (content.kind === "via-bot") return { do: "note", chatId: chat.id, note: "no-via-bot" };
	if (content.kind === "other") return { do: "note", chatId: chat.id, note: "text-only" };
	if (!hasVisibleText(content.text)) return { do: "ignore" };
	if (HELP_COMMAND.test(content.text)) return { do: "note", chatId: chat.id, note: "help" };
	return { do: "say", chatId: chat.id, messageId: event.messageId, text: content.text };
}

/** What a row in the outbox asks Telegram to show. `received` is the user's own message: already on the phone, never sent. */
export type OutboundBody =
	| { kind: "line"; text: string; silent: boolean }
	| { kind: "note"; text: string }
	| { kind: "received" };

export function render(body: Exclude<OutboundBody, { kind: "received" }>): { text: string; silent: boolean } {
	return { text: fitMessage(body.text), silent: body.kind === "line" && body.silent };
}

export function mirrorText(text: string, from?: ImChat): string {
	return `${from ? "你在另一个 Telegram 账号说" : "你在网页或终端说"}：${text}`;
}

/** One conversation line is one Telegram message, so a long text is clipped rather than split. */
export function fitMessage(text: string): string {
	if (text.length <= MESSAGE_MAX) return text;
	const kept = text.slice(0, MESSAGE_MAX - CLIPPED.length);
	return (/[\ud800-\udbff]$/.test(kept) ? kept.slice(0, -1) : kept) + CLIPPED;
}
