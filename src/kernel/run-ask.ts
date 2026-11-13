/** On 同意 the host runs `command` itself, once, so nothing can change it between approval and run (ADR-0021). */

export const RUN_ASK_PREFIX = "ask_run_";
const RUN_ASK_ID = new RegExp(`^${RUN_ASK_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
export const isRunAskId = (id: string) => RUN_ASK_ID.test(id);

export const RUN_ASK_TTL_MS = 24 * 60 * 60_000;
export const RUN_TIMEOUT_MS = 10 * 60_000;
export const RUN_COMMAND_MAX = 2000;
export const RUN_WHY_MAX = 200;
export const RUN_TAIL_MAX = 4000;
export { RUN_OPTIONS } from "../client/board-format.mjs";

export type DeclineReason = "user" | "expired" | "ticket-ended";

export type RunAskState =
	| { state: "open" }
	| { state: "approved"; answeredAt: number }
	/** `exitCode` null: killed at the time limit, or the host stopped while it ran. `outputFile` is absolute. */
	| { state: "ran"; answeredAt: number; ranAt: number; exitCode: number | null; outputFile: string | null }
	| { state: "declined"; reason: DeclineReason; answeredAt: number };

/** Copied by the host from the trigger that opened the task, never from the model. Null on a task no trigger opened. */
export interface RunOrigin {
	source: string | null;
	sender: string | null;
}

export type RunAsk = {
	id: string;
	ticketId: string;
	command: string;
	why: string;
	origin: RunOrigin;
	askedAt: number;
	expiresAt: number;
} & RunAskState;

export const RUN_ASK_NEXT: Record<RunAskState["state"], readonly RunAskState["state"][]> = {
	open: ["approved", "declined"],
	approved: ["ran"],
	ran: [],
	declined: [],
};

export function parseRunRequest(raw: unknown): { command: string; why: string } {
	const { command, why } = (raw ?? {}) as { command?: unknown; why?: unknown };
	if (typeof command !== "string" || command.trim() === "") throw new Error("command 要写出一条完整的命令");
	if (/[^\x20-\x7E\n\t]/.test(command)) throw new Error("command 只能用 ASCII 可打印字符、换行和 Tab；中文等别的文字请先写进文件，命令里只引用文件名");
	const length = [...command].length;
	if (length > RUN_COMMAND_MAX) throw new Error(`command 不超过 ${RUN_COMMAND_MAX} 个字，现在有 ${length} 个字`);
	if (typeof why !== "string" || why.trim() === "") throw new Error("why 要用一句话说明为什么要运行这条命令");
	if ([...why].length > RUN_WHY_MAX) throw new Error(`why 不超过 ${RUN_WHY_MAX} 个字`);
	if (why.includes("\0")) throw new Error("why 里不能有 NUL 字符");
	return { command, why: why.trim() };
}

const fence = (command: string) => `命令：\n${command}`;

/** Nothing here comes from mail or the web except the command and its output. */
export const RUN_NOTE = {
	ran: (command: string, { exitCode, timedOut, outputFile, tail }: { exitCode: number | null; timedOut: boolean; outputFile: string; tail: string }) =>
		[
			timedOut
				? `使用者同意了，宿主运行了这条命令，到了 ${RUN_TIMEOUT_MS / 60_000} 分钟的时限还没结束，宿主结束了它，没有退出码。`
				: `使用者同意了，宿主运行了这条命令，${exitCode === null ? "它被信号结束，没有退出码" : `退出码 ${exitCode}`}。`,
			fence(command),
			`完整输出在 ${outputFile}`,
			`输出的最后 ${RUN_TAIL_MAX} 字：`,
			tail,
		].join("\n"),
	declined: (command: string) => `使用者没有同意，宿主没有运行这条命令。\n${fence(command)}`,
	expired: (command: string) => `这张批准卡片 24 小时没有人回答，按不要处理，宿主没有运行这条命令。\n${fence(command)}`,
	restarted: (command: string, outputFile: string | null) =>
		`宿主在运行这条批准过的命令时重启了，没有重跑，结果不明。先看工作目录里它留下了什么${outputFile ? `，已有的输出在 ${outputFile}` : ""}。\n${fence(command)}`,
};
