export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
export const OPTION_MAX_CHARS = 20;

/** Boundary parse of a Worker's report options. Throws, so the Worker sees a tool error and can resend. */
export function parseOptions(raw: unknown, question: string | undefined): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error(`options 要写成 ${OPTIONS_MIN} 到 ${OPTIONS_MAX} 个短选项的列表`);
	if (!question) throw new Error("options 只能和 question 一起提交：先写出要使用者回答的问题");
	if (raw.length < OPTIONS_MIN || raw.length > OPTIONS_MAX) {
		throw new Error(`options 要有 ${OPTIONS_MIN} 到 ${OPTIONS_MAX} 个选项，现在有 ${raw.length} 个`);
	}
	const options = raw.map((o) => {
		if (typeof o !== "string") throw new Error("每个选项都要是一段文字");
		const option = o.trim();
		if (!option || option.includes("\n")) throw new Error("选项不能为空，也不能换行");
		const length = [...option].length;
		if (length > OPTION_MAX_CHARS) throw new Error(`每个选项不超过 ${OPTION_MAX_CHARS} 个字，「${option}」有 ${length} 个字`);
		return option;
	});
	if (new Set(options).size !== options.length) throw new Error("选项不能重复");
	return options;
}

/** The words a click sends as the user's own message, in the same shape as the page's 停止任务「标题」. */
export const answerSentence = (title: string, option: string) => `回答任务「${title}」：${option}`;

/** (source, externalId) is UNIQUE, so this key makes every repeat of a click the same trigger. */
export const answerExternalId = (reportId: string) => `answer:${reportId}`;

export const reportIdOfAnswer = (externalId: string): string | null =>
	externalId.startsWith("answer:") ? externalId.slice("answer:".length) : null;
