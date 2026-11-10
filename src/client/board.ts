import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DashboardRow } from "../kernel/types.ts";
import type { MemberCapBoard } from "./protocol.ts";
import { BASIS_LABEL, HOST_SOURCE, STAGE_LABEL, formatElapsed, formatTokens, helperFullName, isLive, modelText, selectRows, shortId, stallMinutes } from "./board-format.mjs";

export { shortId };

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
}

function spread(left: string, right: string, width: number): string {
	const rightFit = fit(right, Math.max(0, Math.floor(width / 2)));
	const leftFit = fit(left, Math.max(0, width - visibleWidth(rightFit) - 1));
	const gap = Math.max(1, width - visibleWidth(leftFit) - visibleWidth(rightFit));
	return fit(leftFit + " ".repeat(gap) + rightFit, width);
}

/** Rows or questions whose id, with or without its tkt_ prefix, starts with key. */
export const ticketsMatching = <T extends { id: string }>(rows: T[], key: string) =>
	key ? rows.filter((r) => r.id.startsWith(key) || r.id.replace(/^tkt_/, "").startsWith(key)) : [];

export const openChoices = (rows: DashboardRow[]) =>
	rows.filter((r) => r.question && r.question.options.length > 0 && !r.question.spoke && (r.question.click === null || r.question.click.state === "dropped"));

const CAP_ID = "cap";
const CAP_TITLE = "成员上限";

/** A question the user can answer with a number. `id` is the asking ticket, or `cap` for the host's own question about the member cap. */
export interface OpenQuestion {
	id: string;
	title: string;
	reportId: string;
	options: string[];
}

export function openQuestions({ rows, memberCap }: Pick<BoardView, "rows" | "memberCap">): OpenQuestion[] {
	const cap = memberCap?.question;
	return [
		...(cap ? [{ id: CAP_ID, title: CAP_TITLE, reportId: cap.reportId, options: cap.options }] : []),
		...openChoices(rows).map((r) => ({ id: r.id, title: r.title, reportId: r.question!.reportId, options: r.question!.options })),
	];
}

const numbered = (options: string[]) => options.map((o, i) => `${i + 1}. ${o}`).join("   ");

export interface BoardView {
	rows: DashboardRow[];
	/** Absent until the first frame, and from a host older than this field. */
	memberCap?: MemberCapBoard;
	receivedAt: number;
	connected: boolean;
}

export function renderBoard(view: BoardView, width: number, now: number): string[] {
	if (width <= 0) return [];
	const { shown, hiddenClosed, active } = selectRows(view.rows);
	const status = view.connected ? "已连接" : "未连接，重试中";
	const lines = [fit(`── Super Agent · ${active} 个任务进行中 · ${status} ──`, width)];
	const cap = view.memberCap?.question;
	if (cap) {
		lines.push(spread(`${CAP_ID} ${CAP_TITLE}`, `${STAGE_LABEL.awaiting_answer} · ${HOST_SOURCE}`, width));
		lines.push(fit(`   问题：${cap.text}`, width));
		lines.push(fit(`   ${numbered(cap.options)}`, width));
	}
	for (const row of shown) {
		const elapsed = row.elapsedMs + (isLive(row) ? now - view.receivedAt : 0);
		const stage = row.stall ? `久无进展 ${stallMinutes(row.stall.since, now)} 分钟` : STAGE_LABEL[row.stage];
		lines.push(spread(`${shortId(row.id)} ${row.title}`, `${stage} · ${BASIS_LABEL[row.basis]}`, width));
		const q = row.question;
		if (q) {
			lines.push(fit(`   问题：${q.text}`, width));
			const c = q.click;
			if (c?.state === "handed_over") lines.push(fit(`   已回答：${q.options[c.option]}`, width));
			else if (c?.state === "sent") lines.push(fit(`   已选「${q.options[c.option]}」，等待幕僚长转交`, width));
			else if (q.options.length) {
				lines.push(fit(`   ${numbered(q.options)}`, width));
				if (q.spoke) lines.push(fit("   你刚发了一句话，等幕僚长处理完再选", width));
				else if (c?.state === "dropped") lines.push(fit("   幕僚长没有转交上次的选择，可以重选", width));
			}
		}
		lines.push(fit(`   最近：${row.latestSummary ?? "（暂无汇报）"}`, width));
		lines.push(fit(`   ${[helperFullName(row.helper), modelText(row)].filter(Boolean).join(" · ")} · 工具 ${row.toolCalls} · ${formatTokens(row.tokensIn + row.tokensOut)} tok · ${formatElapsed(elapsed)}`, width));
	}
	if (hiddenClosed) lines.push(fit(`   另有 ${hiddenClosed} 个已结束的任务`, width));
	if (openQuestions(view).length) lines.push(fit("   回复数字作答；多个问题等回答时用 /answer <编号> <序号>", width));
	if (shown.length) lines.push(fit("   /watch <编号> 只读查看 Worker 过程 · /watch 关闭", width));
	return lines;
}
