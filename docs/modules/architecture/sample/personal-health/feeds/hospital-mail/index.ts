type Letter = { id: string; from: { address: string }; subject: string; date: string; attachments: { filename: string }[] };

/** The mail connector hands in one letter at a time; only one with an attachment becomes a document. */
export default function hospitalMail(input: { items: Letter[] }) {
	const records = input.items
		.filter((letter) => letter.attachments.length > 0)
		.map((letter) => ({ id: letter.id, kind: "邮件附件", issuedAt: letter.date.slice(0, 10), issuer: letter.from.address, summary: `${letter.subject}（附件：${letter.attachments.map((a) => a.filename).join("、")}）` }));
	return { records, notices: records.map((r) => ({ id: r.id, fields: {} })) };
}
