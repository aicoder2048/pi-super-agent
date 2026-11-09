import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DashboardRow } from "../kernel/types.ts";
import { BASIS_LABEL, STAGE_LABEL, formatElapsed, formatTokens, isLive, modelText, selectRows, shortId } from "./board-format.mjs";

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

/** Questions the user can still answer by number: they have options and no client has clicked one yet. */
export const openChoices = (rows: DashboardRow[]) => rows.filter((r) => r.question && r.question.options.length > 0 && r.question.answered === null);

export interface BoardView {
	rows: DashboardRow[];
	receivedAt: number;
	connected: boolean;
}

export function renderBoard(view: BoardView, width: number, now: number): string[] {
	if (width <= 0) return [];
	const { shown, hiddenClosed, active } = selectRows(view.rows);
	const status = view.connected ? "已连接" : "未连接，重试中";
	const lines = [fit(`── Super Agent · ${active} 个任务进行中 · ${status} ──`, width)];
	for (const row of shown) {
		const elapsed = row.elapsedMs + (isLive(row) ? now - view.receivedAt : 0);
		const stage = row.stall ? `久无进展 ${Math.floor((now - row.stall.since) / 60_000)} 分钟` : STAGE_LABEL[row.stage];
		lines.push(spread(`${shortId(row.id)} ${row.title}`, `${stage} · ${BASIS_LABEL[row.basis]}`, width));
		const q = row.question;
		if (q) {
			lines.push(fit(`   问题：${q.text}`, width));
			if (q.answered !== null) lines.push(fit(`   已回答：${q.options[q.answered]}`, width));
			else if (q.options.length) lines.push(fit(`   ${q.options.map((o, i) => `${i + 1}. ${o}`).join("   ")}`, width));
		}
		lines.push(fit(`   最近：${row.latestSummary ?? "（暂无汇报）"}`, width));
		lines.push(fit(`   ${modelText(row)} · 工具 ${row.toolCalls} · ${formatTokens(row.tokensIn + row.tokensOut)} tok · ${formatElapsed(elapsed)}`, width));
	}
	if (hiddenClosed) lines.push(fit(`   另有 ${hiddenClosed} 个已结束的任务`, width));
	if (openChoices(view.rows).length) lines.push(fit("   回复数字作答；多个问题等回答时用 /answer <编号> <序号>", width));
	if (shown.length) lines.push(fit("   /watch <编号> 只读查看 Worker 过程 · /watch 关闭", width));
	return lines;
}
