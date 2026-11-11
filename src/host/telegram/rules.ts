// Pure: who counts as the user on Telegram, what a message or a tap means, and how each outbound message reads.
import { clip, helperFullName } from "../../client/board-format.mjs";
import { isCapAskId } from "../../kernel/cap-ask.ts";
import { OPTIONS_MAX, refusalText } from "../../kernel/question.ts";
import type { DashboardRow, PendingQuestion } from "../../kernel/types.ts";
import { hasVisibleText, type ImChat } from "../server.ts";
import type { Keyboard, TelegramEvent } from "./bot-api.ts";

const MESSAGE_MAX = 4000;
const CLIPPED = "…（全文见网页）";
const HELP_COMMAND = /^\/(start|help)(@\w+)?(\s|$)/;
const CALLBACK_DATA_MAX_BYTES = 64;
const ANSWER_DATA = new RegExp(`^a:([A-Za-z0-9_-]+):([0-${OPTIONS_MAX - 1}])$`);
const REPORT_ID = /^rpt_[A-Za-z0-9_-]+$/;
const TITLE_MAX = 40;
const QUESTION_MIN = 4;
const LEAD_IN = /^[^。！？.!?]{0,7}[：:，,]$/u;
const EDGES = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

export type Note = "help" | "text-only" | "no-forwards" | "no-via-bot";

export const NOTES = {
	help: "这里是白宫。你在这里打的字就是对幕僚长说的话，和网页、终端是同一个对话；幕僚长的回复也发到这里。对一条消息滑动回复，就是引用那句话。助手提问时会发来带按钮的问题，点按钮就是回答；成员上限只能在网页或终端回答。只收文字，转发的消息不会交给幕僚长。",
	"text-only": "目前只收文字消息，这条没有交给幕僚长。",
	"no-forwards": "转发的消息不会交给幕僚长。要问幕僚长，复制文字后用你自己的话发。",
	cap: "成员上限：现在有成员在排队，宿主在问要不要今天放宽上限。这个问题只能在网页或终端的「待你处理」里回答。",
	"no-via-bot": "经别的机器人发出的消息不会交给幕僚长。要问幕僚长，直接在这里打字。",
	missed: "有一条消息可能没送到手机上，网页上有完整对话。",
	setup: (id: number) => `你的 Telegram 数字 id 是 ${id}。把这个数字写进宿主状态目录里 config.json 的 telegram.allowedUserIds，重启宿主后就能在这里和幕僚长对话。`,
} as const;

export type Inbound =
	| { do: "ignore" }
	| { do: "drop" }
	| { do: "tell-id"; chatId: number }
	| { do: "note"; chatId: number; note: Note }
	| { do: "say"; chatId: number; messageId: number; text: string; replyTo: number | null }
	| { do: "answer"; chatId: number; messageId: number; callbackId: string; reportId: string; option: number }
	| { do: "refuse-tap"; callbackId: string; toast: string };

/**
 * `drop` is a stranger or a group: nothing reaches the host. `ignore` is something the user sent that the client does not handle.
 * An empty allowlist is setup mode: a private text only learns its sender's own id, and no tap counts.
 */
export function decide(event: TelegramEvent | null, allowed: ReadonlySet<number>): Inbound {
	if (!event) return { do: "ignore" };
	const { chat, from } = event;
	if (!chat.private || from !== chat.id) return { do: "drop" };
	if (event.kind === "tap") {
		if (!allowed.has(from)) return { do: "drop" };
		const answer = parseAnswerData(event.data);
		if (answer === "cap") return { do: "refuse-tap", callbackId: event.callbackId, toast: refusalText({ kind: "not_here" }) };
		if (!answer) return { do: "refuse-tap", callbackId: event.callbackId, toast: refusalText({ kind: "closed" }) };
		return { do: "answer", chatId: chat.id, messageId: event.messageId, callbackId: event.callbackId, ...answer };
	}
	const { content } = event;
	if (allowed.size === 0) return content.kind === "text" ? { do: "tell-id", chatId: chat.id } : { do: "drop" };
	if (!allowed.has(from)) return { do: "drop" };
	if (content.kind === "forwarded") return { do: "note", chatId: chat.id, note: "no-forwards" };
	if (content.kind === "via-bot") return { do: "note", chatId: chat.id, note: "no-via-bot" };
	if (content.kind === "other") return { do: "note", chatId: chat.id, note: "text-only" };
	if (!hasVisibleText(content.text)) return { do: "ignore" };
	if (HELP_COMMAND.test(content.text)) return { do: "note", chatId: chat.id, note: "help" };
	return { do: "say", chatId: chat.id, messageId: event.messageId, text: content.text, replyTo: event.replyTo };
}

/** The same states and order as the web page's card: a click that stands, then the user's typing, then a click the chief of staff dropped. */
export type CardStatus =
	| { kind: "open" }
	| { kind: "dropped" }
	| { kind: "spoke" }
	| { kind: "sent"; label: string }
	| { kind: "answered"; label: string }
	| { kind: "closed"; label: string | null };

export interface CardView {
	reportId: string;
	title: string;
	/** Empty for a ticket from before helpers had names. */
	helper: string;
	question: string;
	options: readonly string[];
	status: CardStatus;
}

export function cardView(row: DashboardRow): CardView | null {
	const q = row.question;
	if (!q) return null;
	const click = q.click;
	const status: CardStatus =
		click?.state === "handed_over"
			? { kind: "answered", label: q.options[click.option] }
			: click?.state === "sent"
				? { kind: "sent", label: q.options[click.option] }
				: q.spoke
					? { kind: "spoke" }
					: click?.state === "dropped"
						? { kind: "dropped" }
						: { kind: "open" };
	return { reportId: q.reportId, title: row.title, helper: helperFullName(row.helper), question: q.text, options: q.options, status };
}

/**
 * The chief of staff relaying a helper's question the card already shows: the question itself, give or take edge
 * punctuation and a lead-in such as 「请问：」, with nothing after it. Anything more might be news the phone would lose,
 * so it goes out. Once the user typed or the answer reached the task, a re-ask is news too.
 */
export function repeatsQuestion(reply: { text: string; at: number }, question: PendingQuestion | null): boolean {
	if (!question || question.askedAt > reply.at || question.spoke || question.click?.state === "handed_over") return false;
	const asked = question.text.replace(EDGES, "");
	const said = reply.text.replace(EDGES, "");
	if ([...asked].length < QUESTION_MIN || !said.endsWith(asked)) return false;
	const leadIn = said.slice(0, said.length - asked.length).trimEnd();
	return leadIn === "" || LEAD_IN.test(leadIn);
}

/** A question that left the board: buttons go, and the option the user picked stays readable. */
export function closedView(view: CardView): CardView {
	const label = view.status.kind === "sent" || view.status.kind === "answered" ? view.status.label : null;
	return { ...view, status: { kind: "closed", label } };
}

function statusLine({ status, options }: CardView): string {
	switch (status.kind) {
		case "open":
			return options.length ? "" : "直接打字回答。";
		case "dropped":
			return "幕僚长没有转交这次选择，请重选或直接回复";
		case "spoke":
			return options.length ? "已插话：你刚发了一句话，等幕僚长处理完再点" : "已插话：你刚发了一句话，等幕僚长处理";
		case "sent":
			return `已选「${status.label}」，已发送，等待幕僚长转交`;
		case "answered":
			return `已选「${status.label}」，已回答`;
		case "closed":
			return status.label === null ? `已结束：${refusalText({ kind: "closed" })}` : `已结束：你选了「${status.label}」`;
	}
}

function cardText(view: CardView): string {
	const head = `${view.helper ? `${view.helper} ` : "助手"}问你（任务「${clip(view.title, TITLE_MAX)}」）：\n${view.question}`;
	const line = statusLine(view);
	return line ? `${head}\n\n${line}` : head;
}

function cardKeyboard(view: CardView): Keyboard | null {
	if (!view.options.length || (view.status.kind !== "open" && view.status.kind !== "dropped")) return null;
	return view.options.map((label, option) => [{ label, data: answerData(view.reportId, option) }]);
}

/** What a row in the outbox asks Telegram to show. `received` is the user's own message: already on the phone, never sent. */
export type OutboundBody =
	| { kind: "line"; text: string; silent: boolean }
	| { kind: "note"; text: string }
	| { kind: "card"; view: CardView }
	| { kind: "received" };

/** `note`: the chat owes the may-be-missing note, and it goes first so a clipped text keeps it. A card never carries it. */
export function render(body: Exclude<OutboundBody, { kind: "received" }>, note = false): { text: string; keyboard: Keyboard | null; silent: boolean } {
	if (body.kind === "card") return { text: fitMessage(cardText(body.view)), keyboard: cardKeyboard(body.view), silent: false };
	const text = note ? (body.text ? `${NOTES.missed}\n${body.text}` : NOTES.missed) : body.text;
	return { text: fitMessage(text), keyboard: null, silent: body.kind === "line" && body.silent };
}

/** Telegram drops a keyboard whose callback_data is longer than 64 bytes, so building one fails loudly instead. */
export function answerData(reportId: string, option: number): string {
	const data = `a:${reportId}:${option}`;
	if (Buffer.byteLength(data) > CALLBACK_DATA_MAX_BYTES) throw new Error(`按钮数据超过 Telegram 的 ${CALLBACK_DATA_MAX_BYTES} 字节上限：${reportId}`);
	return data;
}

/** "cap" for the member-cap question, which no Telegram button may answer; null for anything this client never builds. */
export function parseAnswerData(data: string): { reportId: string; option: number } | "cap" | null {
	const match = ANSWER_DATA.exec(data);
	if (!match) return null;
	if (isCapAskId(match[1])) return "cap";
	return REPORT_ID.test(match[1]) ? { reportId: match[1], option: Number(match[2]) } : null;
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
