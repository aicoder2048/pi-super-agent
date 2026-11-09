// @ts-check

import {
	STAGE_PHRASE, BASIS_PHRASE, applyMessage, applyTranscript, canSend, dutyLine, emptyView, emptyWatch,
	isStale, leftColumn, resolveTheme, restartNotice, sayCopy, sayOutcome, smallPrint, stopSentence, toggleTheme,
} from "./view.mjs";
import { DEFAULT_ACK_TIMEOUT_MS, isLive } from "../client/board-format.mjs";

const STATUS_TEXT = {
	connecting: "连接中…",
	connected: "",
	disconnected: "连接中断，正在重连",
	expired: "链接已失效，请使用宿主日志中的最新链接",
};

const THEME_KEY = "psa-theme";
const MARK = { ok: "✓", error: "!", pending: "…" };

/** @param {Document} doc */
function mount(doc) {
	const token = new URL(import.meta.url).searchParams.get("token") ?? "";
	const query = `token=${encodeURIComponent(token)}`;
	const view = emptyView();
	/** @param {string} id */
	const $ = (id) => /** @type {HTMLElement} */ (doc.getElementById(id));
	const status = $("status");
	const thread = /** @type {HTMLElement} */ ($("conversation").firstElementChild);
	const composer = /** @type {HTMLTextAreaElement} */ ($("composer"));
	const send = /** @type {HTMLButtonElement} */ ($("send"));
	const sayStatus = $("say-status");
	const mark = /** @type {Element} */ (doc.querySelector(".logo svg"));
	let rendered = 0;
	/** @type {{ watch: ReturnType<typeof emptyWatch>, source: EventSource } | undefined} */
	let watching;

	/** @param {string} tag @param {string} className @param {string} [text] */
	const el = (tag, className, text = "") => {
		const node = doc.createElement(tag);
		node.className = className;
		node.textContent = text;
		return node;
	};

	/** @param {keyof typeof STATUS_TEXT} s */
	const setStatus = (s) => {
		status.dataset.status = s;
		status.textContent = STATUS_TEXT[s];
	};

	/** @param {import("./view.mjs").SayState} state @param {number} [status] */
	const setSay = (state, status) => {
		sayStatus.dataset.state = state;
		sayStatus.textContent = sayCopy(state, status);
	};

	const store = {
		get: () => {
			try {
				return localStorage.getItem(THEME_KEY);
			} catch {
				return null;
			}
		},
		/** @param {string} value */
		set: (value) => {
			try {
				localStorage.setItem(THEME_KEY, value);
			} catch {}
		},
	};
	const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
	const stored = store.get();
	if (stored === "light" || stored === "dark") doc.documentElement.dataset.theme = stored;
	$("theme").addEventListener("click", () => {
		const next = toggleTheme(resolveTheme(doc.documentElement.dataset.theme ?? null, systemDark()));
		doc.documentElement.dataset.theme = next;
		store.set(next);
	});

	const renderHeader = () => {
		$("duty").textContent = dutyLine(view.duty, Date.now());
		$("restart").textContent = restartNotice(view.duty, Date.now());
	};

	/** @param {import("./view.mjs").TaskCard} card @param {string} tone */
	const taskCard = (card, tone) => {
		const node = el("div", `card ${tone}`);
		node.tabIndex = 0;
		node.setAttribute("role", "button");
		node.setAttribute("aria-current", String(watching?.watch.ticketId === card.id));
		node.append(el("div", "title", card.title), el("div", "why", `${card.why} · ${card.stage}`), el("div", "latest", card.latest));
		if (card.canStop) {
			const row = el("div", "row");
			const stop = el("button", "stop", "停止");
			stop.type = "button";
			stop.addEventListener("click", (e) => {
				e.stopPropagation();
				composer.value = stopSentence(card.title);
				composer.focus();
			});
			row.append(el("span", "spacer"), stop);
			node.append(row);
		}
		node.addEventListener("click", () => watch(card.id));
		node.addEventListener("keydown", (e) => {
			if (e.target === node && (e.key === "Enter" || e.key === " ")) {
				e.preventDefault();
				watch(card.id);
			}
		});
		return node;
	};

	/** @param {string} heading @param {HTMLElement[]} items @param {string} emptyText @param {string} [headingClass] */
	const section = (heading, items, emptyText, headingClass = "") => {
		const node = el("section", "");
		node.append(el("h2", headingClass, heading), ...(items.length ? items : [el("p", "empty", emptyText)]));
		return node;
	};

	const renderLeft = () => {
		const left = leftColumn(view);
		const today = el("section", "");
		today.id = "today";
		today.append(el("div", "headline", left.today.headline), el("div", "detail", left.today.detail));
		const done = el("details", "");
		done.id = "done";
		done.open = /** @type {HTMLDetailsElement | null} */ (doc.getElementById("done"))?.open ?? false;
		const list = el("div", "list");
		list.append(...left.done.map((c) => taskCard(c, "done")));
		done.append(el("summary", "", left.doneLine), list);
		$("left").replaceChildren(
			section(`待你处理 · ${left.needsYou.length}`, left.needsYou.map((c) => taskCard(c, "ask")), "暂无待处理事项。", "warn"),
			section(`进行中 · ${left.doing.length}`, left.doing.map((c) => taskCard(c, "doing")), "暂无进行中的任务。"),
			section(`关注的来源 · ${left.watching.length}`, left.watching.map((w) => {
				const node = el("div", "watch");
				const body = el("div", "");
				body.append(el("div", "name", w.name), el("div", "rule", [w.rule, w.hits].filter(Boolean).join(" · ")));
				node.append(body);
				return node;
			}), "暂无关注的来源。"),
			today,
			done,
		);
	};

	const renderConversation = () => {
		const box = $("conversation");
		const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
		for (const line of [...view.lines.values()].slice(rendered)) {
			const item = el("div", `line ${line.who}`);
			const bubble = el("div", "bubble");
			bubble.append(el("span", "sr", line.who === "user" ? "你：" : "Super Agent："), doc.createTextNode(line.text));
			if (line.who === "router") {
				const avatar = el("div", "avatar");
				avatar.append(mark.cloneNode(true));
				item.append(avatar);
			}
			item.append(bubble);
			thread.append(item);
		}
		rendered = view.lines.size;
		if (atBottom) box.scrollTop = box.scrollHeight;
	};

	const renderHow = () => {
		const row = view.rows.find((r) => r.id === watching?.watch.ticketId);
		$("how-title").textContent = row?.title ?? "";
		$("how-meta").textContent = row ? `${BASIS_PHRASE[row.basis]} · ${STAGE_PHRASE[row.stage]}` : "";
		$("small-print").textContent = smallPrint(row, Date.now(), view.receivedAt);
	};

	const renderSteps = () => {
		const steps = watching?.watch.steps ?? [];
		if (!watching) return void $("steps").replaceChildren(el("li", "empty", "选择左侧的任务，查看助手的执行过程。"));
		if (!steps.length) return void $("steps").replaceChildren(el("li", "empty", "暂无步骤。"));
		const open = new Set([...$("steps").querySelectorAll("details[open]")].map((d) => d.getAttribute("data-i")));
		$("steps").replaceChildren(...steps.map((step, i) => {
			const li = el("li", `step ${step.state}`);
			const rail = el("span", "rail");
			rail.append(el("span", "mark", MARK[step.state]));
			const body = el("div", "step-body");
			const raw = el("details", "");
			raw.setAttribute("data-i", String(i));
			raw.open = open.has(String(i));
			raw.append(el("summary", "", "原始记录"), el("pre", "", step.raw));
			body.append(el("div", "step-title", step.title), el("div", "step-detail", step.detail), raw);
			li.append(rail, body);
			return li;
		}));
	};

	const render = { conversation: renderConversation, left: renderLeft, header: renderHeader };

	/** @param {string} ticketId */
	const watch = (ticketId) => {
		watching?.source.close();
		const w = emptyWatch(ticketId);
		const source = new EventSource(`/transcript?${query}&ticket=${encodeURIComponent(ticketId)}`);
		source.onmessage = (e) => {
			if (applyTranscript(w, JSON.parse(e.data))) renderSteps();
		};
		watching = { watch: w, source };
		renderLeft();
		renderHow();
		renderSteps();
	};

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
			const panes = applyMessage(view, JSON.parse(e.data), Date.now());
			for (const pane of panes) render[pane]();
			if (panes.includes("left")) renderHow();
		};
		events.onerror = () => {
			setStatus("disconnected");
			if (events.readyState === EventSource.CONNECTING) return;
			// CLOSED means a non-200 answer, which EventSource never retries.
			reconnect();
		};
	};

	const say = async () => {
		const text = composer.value;
		if (!canSend(text) || send.disabled) return;
		send.disabled = true;
		setSay("sending");
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), DEFAULT_ACK_TIMEOUT_MS);
		try {
			const res = await fetch(`/say?${query}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
				signal: abort.signal,
				cache: "no-store",
			});
			const state = sayOutcome({ status: res.status });
			if (state === "delivered" && composer.value === text) composer.value = "";
			if (state === "expired") setStatus("expired");
			setSay(state, res.status);
		} catch {
			setSay(sayOutcome(abort.signal.aborted ? "timeout" : "network"));
		} finally {
			clearTimeout(timer);
			send.disabled = false;
		}
	};

	$("say").addEventListener("submit", (e) => {
		e.preventDefault();
		void say();
	});
	composer.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		void say();
	});

	renderLeft();
	renderSteps();
	setInterval(() => {
		if (watching && view.rows.some((r) => r.id === watching?.watch.ticketId && isLive(r))) renderHow();
	}, 1000);
	setInterval(renderHeader, 30_000);
	connect();
}

mount(document);
