/**
 * Super Agent 客户端：Pi TUI 只当人机界面，输入转发给宿主，本地模型不参与。
 * 启动：just client（宿主需先用 just host 启动）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { openChoices, renderBoard, shortId, type BoardView } from "../src/client/board.ts";
import { DEFAULT_ACK_TIMEOUT_MS, HostConnection } from "../src/client/connection.ts";
import type { ConversationLine, HostToClient } from "../src/client/protocol.ts";
import type { DashboardRow } from "../src/kernel/types.ts";
import { formatTranscriptMessage } from "../src/client/transcript.ts";
import { defaultStateDir } from "../src/host/config.ts";

const LINE = "psa-line";
type Who = "user" | "router" | "worker" | "system";
const PREFIX: Record<Who, string> = { user: "你", router: "Router", worker: "Worker", system: "·" };
const HISTORY_SHOWN = 10;

export default function superAgentClient(pi: ExtensionAPI): void {
	const view: BoardView = { rows: [], receivedAt: Date.now(), connected: false };
	let ctx: ExtensionContext | undefined;
	let conn: HostConnection | undefined;
	const seenIds = new Set<string>();
	let primed = false;
	let watching: string | undefined;
	let ticker: NodeJS.Timeout | undefined;

	const show = (who: Who, text: string) =>
		pi.sendMessage({ customType: LINE, content: `${PREFIX[who]}> ${text}`, display: true, details: { who } });

	const drawBoard = () =>
		ctx?.ui.setWidget("psa-board", () => ({ render: (width: number) => renderBoard(view, width, Date.now()), invalidate() {} }));

	const isNew = (l: ConversationLine) => !seenIds.has(l.id);
	const markSeen = (l: ConversationLine) => seenIds.add(l.id);

	const showConversation = (lines: ConversationLine[]) => {
		const fresh = lines.filter(isNew);
		for (const l of primed ? fresh : fresh.slice(-HISTORY_SHOWN)) show(l.who, l.text);
		lines.forEach(markSeen);
		primed = true;
	};

	const onMessage = (m: HostToClient) => {
		switch (m.type) {
			case "snapshot":
				showConversation(m.conversation);
				view.rows = m.board;
				view.receivedAt = Date.now();
				break;
			case "user":
			case "reply": {
				const line: ConversationLine = { id: m.type === "user" ? m.id : m.replyId, who: m.type === "user" ? "user" : "router", text: m.text, at: m.at };
				if (!isNew(line)) return;
				markSeen(line);
				show(line.who, line.text);
				return;
			}
			case "ack":
				return;
			case "refused":
				ctx?.ui.notify(m.reason, "warning");
				return;
			case "board":
				view.rows = m.rows;
				view.receivedAt = Date.now();
				break;
			case "transcript_history":
				show("system", `开始只读查看 ${shortId(m.ticketId)} 的 Worker 过程（共 ${m.messages.length} 条消息）`);
				for (const message of m.messages) for (const line of formatTranscriptMessage(message)) show("worker", line);
				return;
			case "transcript":
				if (m.ticketId !== watching) return;
				for (const line of formatTranscriptMessage(m.message)) show("worker", line);
				return;
		}
		drawBoard();
	};

	pi.registerMessageRenderer(LINE, (message, _options, theme) => {
		const who = ((message.details as { who?: Who } | undefined)?.who ?? "system") as Who;
		const color = who === "router" ? "accent" : who === "user" ? "text" : "muted";
		return new Text(theme.fg(color, String(message.content)), 0, 0);
	});

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		const ackTimeoutMs = Number(process.env.PSA_ACK_TIMEOUT_MS) || DEFAULT_ACK_TIMEOUT_MS;
		conn = new HostConnection({
			socketPath: process.env.PSA_SOCKET ?? join(defaultStateDir(), "host.sock"),
			onMessage,
			ackTimeoutMs,
			onAckMissing: (text) =>
				ctx?.ui.notify(`宿主 ${ackTimeoutMs / 1000} 秒内没有确认收到「${text}」，这句话可能没送达。宿主可能卡住了，稍后看对话里有没有它，没有就再说一次。`, "warning"),
			onStatus: (connected) => {
				view.connected = connected;
				drawBoard();
			},
		});
		conn.open();
		drawBoard();
		ticker = setInterval(drawBoard, 5000);
		ticker.unref();
	});

	pi.on("session_shutdown", async () => {
		clearInterval(ticker);
		conn?.close();
	});

	const answer = (row: DashboardRow, pick: number, ui: ExtensionContext["ui"]) => {
		const q = row.question!;
		if (pick < 1 || pick > q.options.length) return ui.notify(`「${row.title}」只有 ${q.options.length} 个选项`, "warning");
		if (!conn?.answer(q.reportId, pick - 1, q.options[pick - 1])) ui.notify("宿主未连接，回答没有发出。先运行 just host。", "warning");
	};

	pi.on("input", async (event, context) => {
		if (event.source === "extension") return { action: "continue" };
		const text = event.text.trim();
		if (!text) return { action: "handled" };
		const open = /^[1-9]$/.test(text) ? openChoices(view.rows) : [];
		if (open.length === 1) {
			answer(open[0], Number(text), context.ui);
			return { action: "handled" };
		}
		if (open.length > 1) {
			context.ui.notify(`有 ${open.length} 个问题在等回答，请用 /answer <编号> <序号>，例如 /answer ${shortId(open[0].id)} ${text}`, "warning");
			return { action: "handled" };
		}
		if (!conn?.say(text)) context.ui.notify("宿主未连接，这句话没有发出。先运行 just host。", "warning");
		return { action: "handled" };
	});

	pi.registerCommand("answer", {
		description: "选一个问题的选项作答：/answer <编号> <序号>",
		handler: async (args, context) => {
			const [key = "", pick = ""] = args.trim().split(/\s+/);
			const matches = openChoices(view.rows).filter((r) => shortId(r.id).startsWith(key) || r.id === key);
			if (!key || matches.length !== 1 || !/^\d+$/.test(pick)) {
				context.ui.notify(matches.length > 1 ? `编号 ${key} 对应多个问题，请多写几位` : "用法：/answer <编号> <序号>，编号是看板上等回答的任务", "warning");
				return;
			}
			answer(matches[0], Number(pick), context.ui);
		},
	});

	pi.registerCommand("watch", {
		description: "只读查看某个 Worker 的完整过程：/watch <编号>；不带编号时关闭",
		handler: async (args, context) => {
			const key = args.trim();
			if (!key) {
				if (watching) show("system", `已停止查看 ${shortId(watching)}`);
				watching = undefined;
				conn?.watch(undefined);
				return;
			}
			const matches = view.rows.filter((r) => shortId(r.id).startsWith(key) || r.id === key);
			if (matches.length !== 1) {
				context.ui.notify(matches.length ? `编号 ${key} 对应多个任务，请多写几位` : `看板上没有编号 ${key}`, "warning");
				return;
			}
			watching = matches[0].id;
			conn?.watch(watching);
		},
	});
}
