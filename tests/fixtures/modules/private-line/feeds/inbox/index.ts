interface Letter {
	id: string;
	from: string;
	subject: string;
	snippet: string;
	body: string;
	problem?: string;
	/** Reports the problem as a one-shot notice instead of something broken. */
	once?: true;
	fail?: string;
}

export default function collect(input: { items: Letter[] }) {
	const failure = input.items.find((item) => item.fail !== undefined)?.fail;
	if (failure !== undefined) throw new Error(failure);
	const letters = input.items.filter((item) => item.id !== undefined);
	const reported = input.items.find((item) => item.problem !== undefined);
	const problem = reported?.problem;
	return {
		records: letters.map(({ id, from, subject, snippet, body }) => ({ id, from, subject, snippet, body })),
		notices: letters.map(({ id, from, subject, snippet }) => ({ id, fields: { from, subject, snippet } })),
		...(problem !== undefined && { problem: reported?.once ? { id: problem, text: "有 30 小时没查，请在信箱里看一下", once: true } : { id: problem, text: "收件箱的授权过期了，请重新授权" } }),
	};
}
