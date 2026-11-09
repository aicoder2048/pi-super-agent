import { clip } from "../client/board-format.mjs";

export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
export const OPTION_MAX_CHARS = 20;

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

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
		if (!option) throw new Error("选项不能为空");
		if (INVISIBLE.test(option)) throw new Error("选项里不能有换行、制表、方向控制等看不见的字符");
		const length = [...option].length;
		if (length > OPTION_MAX_CHARS) throw new Error(`每个选项不超过 ${OPTION_MAX_CHARS} 个字，「${option}」有 ${length} 个字`);
		return option;
	});
	if (new Set(options).size !== options.length) throw new Error("选项不能重复");
	return options;
}

export type AnswerRefusal =
	| { kind: "no_question" }
	| { kind: "no_options" }
	| { kind: "out_of_range"; count: number }
	| { kind: "chosen"; option: number; label: string }
	| { kind: "spoke" }
	| { kind: "closed" };

export function refusalText(r: AnswerRefusal): string {
	switch (r.kind) {
		case "no_question":
			return "这个问题不存在";
		case "no_options":
			return "这个问题没有选项，请直接回复";
		case "out_of_range":
			return `这个问题只有 ${r.count} 个选项`;
		case "chosen":
			return `已选「${r.label}」`;
		case "spoke":
			return "你刚发了一句话，幕僚长处理完之前不能点选项";
		case "closed":
			return "这个问题已经回答过，或已不在等待回答";
	}
}

const TITLE_IN_ANSWER_MAX = 40;

export const answerSentence = (title: string, option: string) => `回答任务「${clip(title, TITLE_IN_ANSWER_MAX)}」：${option}`;

const ANSWER_PREFIX = "answer:";

export const answerExternalId = (reportId: string, attempt: number) => `${ANSWER_PREFIX}${reportId}:${attempt}`;
