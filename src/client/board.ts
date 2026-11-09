import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DashboardRow, Stage } from "../kernel/types.ts";

export const STAGE_LABEL: Record<Stage, string> = {
	awaiting_answer: "等你回答",
	awaiting_review: "等你验收",
	blocked_or_failed: "受阻/失败",
	queued: "排队",
	idle: "空闲",
	running: "执行中",
	closed: "已结束",
	stopped: "已叫停",
};

const BASIS_LABEL = { request: "请求", rule: "规则", inference: "推断" } as const;
const TERMINAL: Stage[] = ["closed", "stopped"];
const CLOSED_SHOWN = 2;

export const shortId = (ticketId: string) => ticketId.replace(/^tkt_/, "").slice(0, 4);

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}秒`;
	if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
	return `${Math.floor(s / 3600)}时${Math.floor((s % 3600) / 60)}分`;
}

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

export function selectRows(rows: DashboardRow[]): { shown: DashboardRow[]; hiddenClosed: number } {
	const active = rows.filter((r) => !TERMINAL.includes(r.stage));
	const closed = rows.filter((r) => TERMINAL.includes(r.stage));
	return { shown: [...active, ...closed.slice(0, CLOSED_SHOWN)], hiddenClosed: Math.max(0, closed.length - CLOSED_SHOWN) };
}

export function renderBoard(view: BoardView, width: number, now: number): string[] {
	if (width <= 0) return [];
	const { shown, hiddenClosed } = selectRows(view.rows);
	const active = view.rows.filter((r) => !TERMINAL.includes(r.stage)).length;
	const status = view.connected ? "已连接" : "未连接，重试中";
	const lines = [fit(`── Super Agent · ${active} 个任务进行中 · ${status} ──`, width)];
	for (const row of shown) {
		const live = row.stage === "running" || row.stage === "queued";
		const elapsed = row.elapsedMs + (live ? now - view.receivedAt : 0);
		const model = row.model ? `${row.model.split("/").pop()}${row.fellBack ? "（已回退）" : ""}` : "未启动";
		lines.push(spread(`${shortId(row.id)} ${row.title}`, `${STAGE_LABEL[row.stage]} · ${BASIS_LABEL[row.basis]}`, width));
		lines.push(fit(`   最近：${row.latestSummary ?? "（暂无汇报）"}`, width));
		lines.push(fit(`   ${model} · 工具 ${row.toolCalls} · ${formatTokens(row.tokensIn + row.tokensOut)} tok · ${formatElapsed(elapsed)}`, width));
	}
	if (hiddenClosed) lines.push(fit(`   另有 ${hiddenClosed} 个已结束的任务`, width));
	if (shown.length) lines.push(fit("   /watch <编号> 只读查看 Worker 过程 · /watch 关闭", width));
	return lines;
}
