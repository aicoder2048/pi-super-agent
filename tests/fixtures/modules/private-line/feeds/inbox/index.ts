interface Letter {
	id: string;
	from: string;
	subject: string;
	snippet: string;
	body: string;
	problem?: string;
	fail?: string;
}

export default function collect(input: { items: Letter[] }) {
	const failure = input.items.find((item) => item.fail !== undefined)?.fail;
	if (failure !== undefined) throw new Error(failure);
	const letters = input.items.filter((item) => item.id !== undefined);
	const problem = input.items.find((item) => item.problem !== undefined)?.problem;
	return {
		records: letters.map(({ id, from, subject, snippet, body }) => ({ id, from, subject, snippet, body })),
		notices: letters.map(({ id, from, subject, snippet }) => ({ id, fields: { from, subject, snippet } })),
		...(problem !== undefined && { problem: { id: problem, text: "收件箱的授权过期了，请重新授权" } }),
	};
}
