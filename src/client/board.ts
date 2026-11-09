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
		lines.push(spread(`${shortId(row.id)} ${row.title}`, `${STAGE_LABEL[row.stage]} · ${BASIS_LABEL[row.basis]}`, width));
		lines.push(fit(`   最近：${row.latestSummary ?? "（暂无汇报）"}`, width));
		lines.push(fit(`   ${modelText(row)} · 工具 ${row.toolCalls} · ${formatTokens(row.tokensIn + row.tokensOut)} tok · ${formatElapsed(elapsed)}`, width));
	}
	if (hiddenClosed) lines.push(fit(`   另有 ${hiddenClosed} 个已结束的任务`, width));
	if (shown.length) lines.push(fit("   /watch <编号> 只读查看 Worker 过程 · /watch 关闭", width));
	return lines;
}
