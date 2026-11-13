import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listed, senderList, type SenderRow } from "../../feeds/inbox/index.ts";
import { clean, parseFrom } from "../../feeds/inbox/message.ts";

type Original = { threadId: string; messageIdHeader: string; fromAddress: string; replyTo: string; subject: string };

const MAX_CHARS = 20_000;
// 39 bytes of UTF-8 make 52 of base64, so `Subject: ` and the first encoded word still fit a 78-character line.
const WORD_BYTES = 39;

function parseInput(input: unknown): { messageId: string; body: string } {
	const fields = (input ?? {}) as Record<string, unknown>;
	const extra = Object.keys(fields).filter((key) => key !== "messageId" && key !== "body");
	if (extra.length > 0) throw new Error(`只收 messageId 和 body，收件人、抄送、主题由原信定，不能给 ${extra.join("、")}`);
	const { messageId, body } = fields;
	if (typeof messageId !== "string" || messageId === "") throw new Error("要给 messageId：messages 里那一行的 gmailId");
	if (typeof body !== "string" || body.trim() === "") throw new Error("要给 body：回信正文，纯文字");
	if ([...body].length > MAX_CHARS) throw new Error(`body 最多 ${MAX_CHARS} 字`);
	return { messageId, body };
}

const FEED = "mail/inbox";

/**
 * Only a row the feed stored and nothing edited since: the host refuses a task write whose `from` is the feed's source, so
 * `_from` names the feed and an empty `_sources` means no later write touched it. A task's own or edited row could name anyone.
 */
function storedLetter(messageId: string): { letter: Original; senders: SenderRow[] } {
	const db = join(process.env["PSA_MODULE_DATA"] ?? "", "data.db");
	const notFound = new Error(`messages 里没有 gmailId 为 ${messageId} 的信（只认 feed 收下、之后没被改过的那一行）`);
	if (!existsSync(db)) throw notFound;
	const reader = new DatabaseSync(db, { readOnly: true });
	try {
		const columns = ["threadId", "messageIdHeader", "fromAddress", "replyTo", "subject"].map((c) => `COALESCE(${c}, '') AS ${c}`).join(", ");
		const letter = reader.prepare(`SELECT ${columns} FROM messages WHERE gmailId = ? AND "_from" = ? AND "_sources" IS NULL LIMIT 1`).get(messageId, FEED) as Original | undefined;
		if (letter === undefined) throw notFound;
		const hasSenders = reader.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'senders'`).get() !== undefined;
		const rows = hasSenders ? (reader.prepare(`SELECT "_id" AS id, address, addedAt, removedAt FROM senders`).all() as Record<string, unknown>[]) : [];
		return { letter, senders: rows.map(({ id, ...fields }) => ({ id: String(id), fields })) };
	} finally {
		reader.close();
	}
}

function encodedWords(text: string): string {
	if (/^[\x20-\x7e]*$/.test(text)) return text;
	const words: string[] = [];
	let word = "";
	for (const char of text) {
		if (Buffer.byteLength(word + char) > WORD_BYTES) {
			words.push(word);
			word = "";
		}
		word += char;
	}
	words.push(word);
	return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

const replySubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);

function replyToNote({ replyTo, fromAddress }: Original): string | undefined {
	const written = clean(replyTo);
	const address = parseFrom(written)?.address;
	if (written === "" || address === fromAddress) return undefined;
	return `原信的 Reply-To 是 ${address ?? written.slice(0, 120)}，和发件人地址不一样。草稿回给了发件人，要回 Reply-To 请在 Gmail 里改收件人`;
}

export default function draftReply(input: unknown) {
	const { messageId, body } = parseInput(input);
	const { letter, senders } = storedLetter(messageId);
	if (letter.fromAddress === "") throw new Error("这封信的发件人地址是空的，没法回");
	if (parseFrom(letter.fromAddress)?.address !== letter.fromAddress) throw new Error(`这封信存着的发件人地址不是单个地址：${JSON.stringify(letter.fromAddress.slice(0, 120))}，没法回`);
	if (!listed(senderList(senders, Date.now()), letter.fromAddress)) throw new Error(`${letter.fromAddress} 现在不在邮件名单上（可能划掉了），不写草稿`);
	const reference = clean(letter.messageIdHeader);
	const text = body.replace(/\r?\n/g, "\r\n");
	const raw = [
		`To: ${letter.fromAddress}`,
		`Subject: ${encodedWords(replySubject(clean(letter.subject)))}`,
		...(reference === "" ? [] : [`In-Reply-To: ${reference}`, `References: ${reference}`]),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"",
		...(Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? []),
	].join("\r\n");
	const note = replyToNote(letter);
	return { draft: { raw, threadId: letter.threadId }, ...(note && { note }) };
}
