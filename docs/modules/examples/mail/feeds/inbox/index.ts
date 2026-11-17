import { released, type Attachment, type MessageRow } from "./message.ts";

/** A letter as the host's mail connector hands it in (src/modules/connectors/letter.ts): only senders on the list reach here. */
type Letter = { id: string; threadId: string; messageIdHeader: string; from: { name: string; address: string }; replyTo: string; subject: string; date: string; snippet: string; body: string; attachments: Attachment[] };

type Reply = { records: MessageRow[]; notices: { id: string; thread: string; fields: Record<string, string> }[] };

const rowOf = (letter: Letter): MessageRow => ({
	id: letter.id,
	gmailId: letter.id,
	threadId: letter.threadId,
	messageIdHeader: letter.messageIdHeader,
	fromName: letter.from.name,
	fromAddress: letter.from.address,
	replyTo: letter.replyTo,
	subject: letter.subject,
	date: letter.date,
	snippet: letter.snippet,
	body: letter.body,
	attachments: JSON.stringify(letter.attachments),
});

/** One notice per letter, on its Gmail thread, so a task opened from a letter hears the replies in that thread. */
export default function inbox(input: { items: Letter[] }): Reply {
	const records = input.items.map(rowOf);
	return { records, notices: records.map((row) => ({ id: row.id, thread: row.threadId || row.id, fields: released(row) })) };
}
