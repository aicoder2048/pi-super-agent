// @ts-check

import { applyMessage, boardModel, emptyView, isStale } from "./view.mjs";
import { isLive } from "../client/board-format.mjs";

const STATUS_TEXT = {
	connecting: "连接中…",
	connected: "已连接",
	disconnected: "未连接，重试中",
	expired: "token 已失效，请用宿主日志里最新的网址打开",
};

/** @param {Document} doc */
function mount(doc) {
	const token = new URL(import.meta.url).searchParams.get("token") ?? "";
	const query = `token=${encodeURIComponent(token)}`;
	const view = emptyView();
	const status = /** @type {HTMLElement} */ (doc.getElementById("status"));
	const conversation = /** @type {HTMLElement} */ (doc.getElementById("conversation"));
	const board = /** @type {HTMLElement} */ (doc.getElementById("board"));
	let rendered = 0;

	/** @param {keyof typeof STATUS_TEXT} s */
	const setStatus = (s) => {
		status.dataset.status = s;
		status.textContent = STATUS_TEXT[s];
	};

	/** @param {string} tag @param {string} className @param {string} text */
	const el = (tag, className, text) => {
		const node = doc.createElement(tag);
		node.className = className;
		node.textContent = text;
		return node;
	};

	const renderConversation = () => {
		const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
		for (const line of [...view.lines.values()].slice(rendered)) {
			const item = el("div", `line ${line.who}`, "");
			item.append(el("span", "who", line.who === "user" ? "你" : "Router"), el("span", "text", line.text));
			conversation.append(item);
		}
		rendered = view.lines.size;
		if (atBottom) conversation.scrollTop = conversation.scrollHeight;
	};

	const renderBoard = () => {
		const model = boardModel(view, Date.now());
		const nodes = [el("h2", "", `看板 · ${model.active} 个任务进行中`)];
		for (const card of model.cards) {
			const node = el("article", `card ${card.stage}`, "");
			const head = el("div", "head", "");
			head.append(el("span", "id", card.shortId), el("span", "title", card.title), el("span", "stage", `${card.stageLabel} · ${card.basisLabel}`));
			node.append(head, el("div", "summary", `最近：${card.summary}`), el("div", "meta", `${card.model} · 工具 ${card.toolCalls} · ${card.tokens} · ${card.elapsed}`));
			nodes.push(node);
		}
		if (model.hiddenClosed) nodes.push(el("p", "hidden", `另有 ${model.hiddenClosed} 个已结束的任务`));
		if (!model.cards.length) nodes.push(el("p", "empty", "暂无任务"));
		board.replaceChildren(...nodes);
	};

	const render = { conversation: renderConversation, board: renderBoard };

	const connect = () => {
		setStatus("connecting");
		const events = new EventSource(`/events?${query}`);
		let lastFrameAt = Date.now();
		const alive = () => (lastFrameAt = Date.now());
		const reconnect = () => {
			clearInterval(watchdog);
			events.close();
			setStatus("disconnected");
			fetch(`/?${query}`, { cache: "no-store" })
				.then((res) => (res.status === 401 ? setStatus("expired") : setTimeout(connect, 1000)))
				.catch(() => setTimeout(connect, 1000));
		};
		// A hung host can keep the TCP connection open, so EventSource alone would stay "connected" forever.
		const watchdog = setInterval(() => {
			if (isStale(lastFrameAt, Date.now())) reconnect();
		}, 1000);
		events.onopen = () => {
			alive();
			setStatus("connected");
		};
		events.addEventListener("ping", alive);
		events.onmessage = (e) => {
			alive();
			for (const pane of applyMessage(view, JSON.parse(e.data), Date.now())) render[pane]();
		};
		events.onerror = () => {
			setStatus("disconnected");
			if (events.readyState === EventSource.CONNECTING) return;
			// CLOSED means a non-200 answer, which EventSource never retries.
			reconnect();
		};
	};

	renderBoard();
	setInterval(() => {
		if (view.rows.some(isLive)) renderBoard();
	}, 1000);
	connect();
}

mount(document);
