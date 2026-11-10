// @ts-check

import {
	STAGE_PHRASE, BASIS_PHRASE, answerBody, answerRefusedCopy, applyMessage, applyTranscript, canSend, choicesInConversation, dutyLine, emptyView, emptyWatch,
	helperStrip, helperTint, isStale, leftColumn, lifecycleLine, liveSteps, parseMarkdown, resolveTheme, restartNotice, routeLine, sayCopy, sayOutcome, settleSay, settleSending, smallPrint, stopSentence,
	toggleTheme,
} from "./view.mjs";
import { DEFAULT_ACK_TIMEOUT_MS, helperFullName } from "../client/board-format.mjs";

const STATUS_TEXT = {
	connecting: "连接中…",
	connected: "",
	disconnected: "连接中断，正在重连",
	expired: "链接已失效，请使用宿主日志中的最新链接",
};

const THEME_KEY = "psa-theme";
const MARK = { ok: "✓", error: "!", pending: "…", stopped: "■" };

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
	/** @param {string} id */
	const template = (id) => /** @type {Element} */ (/** @type {HTMLTemplateElement} */ ($(id)).content.firstElementChild);
	const avatarMark = template("router-avatar");
	const wrench = template("helper-icon");
	let rendered = 0;
	/** @type {import("./view.mjs").SayState} */
	let sayState = "idle";
	/** @type {{ text: string, from: number } | undefined} */
	let unconfirmed;
	/** @type {{ watch: ReturnType<typeof emptyWatch>, source: EventSource } | undefined} */
	let watching;
	/** @type {import("./view.mjs").Sending} */
	const sending = new Map();

	/** @param {string} tag @param {string} className @param {string} [text] */
	const el = (tag, className, text = "") => {
		const node = doc.createElement(tag);
		node.className = className;
		node.textContent = text;
		return node;
	};

	/** The safe Markdown subset as DOM nodes; every piece of text goes in through textContent. @param {string} className @param {string} text */
	const md = (className, text) => {
		const node = el("div", `${className} md`);
		const inline = (/** @type {HTMLElement} */ box, /** @type {import("./view.mjs").Span[]} */ spans) =>
			box.append(...spans.map((s) => (s.code ? el("code", "", s.text) : s.bold ? el("strong", "", s.text) : s.italic ? el("em", "", s.text) : doc.createTextNode(s.text))));
		for (const block of parseMarkdown(text)) {
			if (block.kind === "ul" || block.kind === "ol") {
				const list = el(block.kind, "");
				for (const item of block.items) {
					const li = el("li", "");
					inline(li, item);
					list.append(li);
				}
				node.append(list);
			} else {
				const box = el("div", block.kind === "h" ? "md-h" : "md-p");
				inline(box, block.spans);
				node.append(box);
			}
		}
		return node;
	};

	/** @param {keyof typeof STATUS_TEXT} s */
	const setStatus = (s) => {
		status.dataset.status = s;
		status.textContent = STATUS_TEXT[s];
		renderHeader();
	};

	/** @param {import("./view.mjs").SayState} state @param {number} [status] @param {string} [text] */
	const setSay = (state, status, text = sayCopy(state, status)) => {
		sayState = state;
		sayStatus.dataset.state = state;
		sayStatus.textContent = text;
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
		$("duty").textContent = dutyLine(view.duty, Date.now(), status.dataset.status === "connected");
		$("restart").textContent = restartNotice(view.duty, Date.now());
	};

	/** @param {string} ticketId */
	const helperBadge = (ticketId) => {
		const badge = el("span", `helper tint-${helperTint(ticketId)}`);
		badge.setAttribute("aria-hidden", "true");
		badge.append(wrench.cloneNode(true));
		return badge;
	};

	/** @param {HTMLElement} box @param {import("./view.mjs").Choice | null | undefined} choice */
	const fillChoices = (box, choice) => {
		box.replaceChildren();
		if (!choice) return;
		for (const b of choice.buttons) {
			const button = el("button", "", b.label);
			button.type = "button";
			button.disabled = choice.locked;
			button.setAttribute("aria-pressed", String(b.picked));
			button.addEventListener("click", (e) => {
				e.stopPropagation();
				void answer(choice.reportId, b.option);
			});
			box.append(button);
		}
		if (choice.note) box.append(el("span", "note", choice.note));
	};

	// A message's route changes after it is drawn; an unchanged one is left alone so a focused line keeps focus.
	const renderRoutes = () => {
		for (const slot of /** @type {NodeListOf<HTMLElement>} */ (thread.querySelectorAll(".route-slot[data-line]"))) {
			const route = routeLine(view, slot.dataset.line ?? "");
			const shown = route ? `${route.ticketId ?? ""}|${route.text}` : "";
			if (slot.dataset.shown === shown) continue;
			slot.dataset.shown = shown;
			if (!route) {
				slot.replaceChildren();
				continue;
			}
			const node = el(route.ticketId ? "button" : "span", "route", route.text);
			if (route.ticketId) {
				const { ticketId } = route;
				/** @type {HTMLButtonElement} */ (node).type = "button";
				node.addEventListener("click", () => watch(ticketId));
			}
			slot.replaceChildren(node);
		}
	};

	const renderChoices = () => {
		const placed = choicesInConversation(view, sending);
		for (const box of thread.querySelectorAll(".choices[data-line]")) fillChoices(/** @type {HTMLElement} */ (box), placed.get(box.getAttribute("data-line") ?? ""));
	};

	/** @param {import("./view.mjs").TaskCard} card @param {string} tone */
	const taskCard = (card, tone) => {
		const node = el("div", `card ${tone}`);
		node.tabIndex = 0;
		node.setAttribute("role", "button");
		node.setAttribute("aria-current", String(watching?.watch.ticketId === card.id));
		const head = el("div", "head");
		head.append(helperBadge(card.id), el("div", "title", card.title));
		node.append(head, el("div", "by", card.helper), el("div", "why", `${card.why} · ${card.stage}`), el("div", "latest", card.latest));
		if (card.choice) {
			const box = el("div", "choices");
			fillChoices(box, card.choice);
			node.append(box);
		}
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
		const left = leftColumn(view, Date.now(), sending);
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
				const node = el("div", w.problem ? "watch problem" : "watch");
				const body = el("div", "");
				body.append(el("div", "name", w.name), el("div", "rule", [w.rule, w.hits].filter(Boolean).join(" · ")));
				node.append(body);
				return node;
			}), "暂无关注的来源。"),
			today,
			done,
		);
	};

	/** @param {import("./view.mjs").HelperChip} chip */
	const helperChip = (chip) => {
		const node = el("button", "helper-chip");
		node.type = "button";
		node.dataset.id = chip.id;
		node.append(el("span", "dot"), el("span", "name", chip.name), el("span", "role", chip.role), el("span", "meta"));
		node.addEventListener("click", () => watch(chip.id));
		const slot = el("div", "helper-slot");
		slot.append(node, el("div", "members"));
		return slot;
	};

	// Chips tick every second; they are updated in place so a focused or half-clicked chip survives.
	const renderHelpers = () => {
		const strip = helperStrip(view, Date.now());
		const box = $("helpers");
		box.hidden = !strip.total && !strip.chips.length;
		const shown = [...box.querySelectorAll(".helper-chip")].map((n) => /** @type {HTMLElement} */ (n).dataset.id).join();
		if (shown !== strip.chips.map((c) => c.id).join() || !box.querySelector(".total")) {
			box.replaceChildren(...strip.chips.map(helperChip), el("span", "total"));
		}
		for (const chip of strip.chips) {
			const node = /** @type {HTMLElement} */ (box.querySelector(`.helper-chip[data-id="${chip.id}"]`));
			const dot = /** @type {HTMLElement} */ (node.querySelector(".dot"));
			dot.textContent = chip.mark;
			dot.dataset.duty = chip.duty;
			/** @type {HTMLElement} */ (node.querySelector(".meta")).textContent = `${chip.elapsed} · ${chip.tokens}`;
			node.setAttribute("aria-current", String(watching?.watch.ticketId === chip.id));
			const members = /** @type {HTMLElement} */ (node.nextElementSibling);
			const labels = chip.members.map((m) => m.label);
			if (members.dataset.shown !== labels.join()) {
				members.dataset.shown = labels.join();
				members.replaceChildren(...chip.members.map((m) => el("span", `member-chip ${m.state}`, m.label)));
			}
			node.setAttribute("aria-label", `${chip.name} · ${chip.role}，${chip.state}，用时 ${chip.elapsed}，${chip.tokens}${labels.length ? `，成员：${labels.join("、")}` : ""}`);
		}
		/** @type {HTMLElement} */ (box.querySelector(".total")).textContent = strip.total;
	};

	const renderConversation = () => {
		const box = $("conversation");
		const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
		for (const line of [...view.lines.values()].slice(rendered)) {
			const item = el("div", `line ${line.who}`);
			const bubble = el("div", "bubble", line.text);
			if (line.who === "router") {
				const avatar = avatarMark.cloneNode(true);
				const said = el("div", "said");
				const choices = el("div", "choices");
				choices.dataset.line = line.id;
				said.append(el("div", "who", "幕僚长"), bubble, choices);
				item.append(avatar, said);
			} else {
				bubble.prepend(el("span", "sr", "你："));
				const said = el("div", "said");
				const slot = el("div", "route-slot");
				slot.dataset.line = line.id;
				said.append(bubble, slot);
				item.append(said);
			}
			thread.append(item);
		}
		rendered = view.lines.size;
		renderRoutes();
		renderChoices();
		if (atBottom) box.scrollTop = box.scrollHeight;
		settleUnconfirmed();
	};

	const settleUnconfirmed = () => {
		if (!unconfirmed) return;
		const next = settleSay({ state: sayState, text: unconfirmed.text }, composer.value, [...view.lines.values()].slice(unconfirmed.from));
		if (next.state === sayState) return;
		unconfirmed = undefined;
		composer.value = next.composer;
		setSay(next.state);
	};

	const renderHow = () => {
		const row = view.rows.find((r) => r.id === watching?.watch.ticketId);
		$("how-badge").replaceChildren(...(row ? [helperBadge(row.id)] : []));
		$("how-title").textContent = row?.title ?? "";
		$("how-helper").textContent = helperFullName(row?.helper ?? null);
		$("how-meta").textContent = row ? `${BASIS_PHRASE[row.basis]} · ${STAGE_PHRASE[row.stage]}` : "";
		$("how-life").textContent = lifecycleLine(row, Date.now(), view.receivedAt);
		$("small-print").textContent = smallPrint(row);
	};

	let stepsShown = "";
	/** @param {import("./view.mjs").Step[]} steps */
	const stepsKey = (steps) => JSON.stringify(steps.map((s) => [s.state, s.detail, s.dispatch && [s.dispatch.tokens, s.dispatch.note, s.dispatch.steps.map((m) => [m.state, m.title, m.detail])]]));
	// A board frame can move a dispatch, or a step whose helper stopped, without any new transcript message.
	const renderStepsIfMoved = () => {
		if (watching && stepsShown !== stepsKey(liveSteps(watching.watch, view))) renderSteps();
	};

	const renderSteps = () => {
		const steps = watching ? liveSteps(watching.watch, view) : [];
		stepsShown = stepsKey(steps);
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
			body.append(el("div", "step-title", step.title), el("div", "step-detail", step.detail));
			if (step.dispatch) {
				const d = step.dispatch;
				const box = el("details", "dispatch");
				box.setAttribute("data-i", `d${i}`);
				box.open = open.has(`d${i}`);
				box.append(el("summary", "", "派活明细"), el("div", "dispatch-head", [d.title, d.stateText, d.tokens].filter(Boolean).join(" · ")), el("div", "dispatch-task", `任务：${d.task}`));
				if (d.note) box.append(el("div", "dispatch-note", d.note));
				if (d.steps.length) {
					const list = el("ol", "member-steps");
					list.append(...d.steps.map((m) => {
						const item = el("li", `member-step ${m.state}`);
						item.append(el("span", "member-step-mark", MARK[m.state]), el("span", "member-step-title", m.title), el("span", "member-step-detail", m.detail));
						return item;
					}));
					box.append(list);
				}
				if (d.reply) box.append(md("dispatch-reply", d.reply));
				body.append(box);
			}
			body.append(raw);
			li.append(rail, body);
			return li;
		}));
	};

	const render = {
		conversation: renderConversation,
		left: () => {
			renderLeft();
			renderChoices();
			renderHelpers();
			renderStepsIfMoved();
		},
		header: renderHeader,
	};

	/** @param {string} reportId @param {number} option */
	const answer = async (reportId, option) => {
		if (sending.has(reportId)) return;
		sending.set(reportId, { option });
		render.left();
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), DEFAULT_ACK_TIMEOUT_MS);
		try {
			const res = await fetch(`/say?${query}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: answerBody(reportId, option),
				signal: abort.signal,
				cache: "no-store",
			});
			const state = sayOutcome({ status: res.status });
			if (state === "expired") setStatus("expired");
			if (state === "delivered") {
				sending.set(reportId, { option, triggerId: (await res.json()).triggerId });
				settleSending(view, sending);
				setSay(state);
			} else {
				sending.delete(reportId);
				const options = view.rows.find((r) => r.question?.reportId === reportId)?.question?.options ?? [];
				setSay(state, res.status, state === "rejected" ? answerRefusedCopy(res.status, await res.json().catch(() => null), options) : undefined);
			}
		} catch {
			sending.delete(reportId);
			setSay(sayOutcome(abort.signal.aborted ? "timeout" : "network"));
		} finally {
			clearTimeout(timer);
			render.left();
		}
	};

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
		renderHelpers();
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
			if (panes.includes("left")) settleSending(view, sending);
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
		unconfirmed = undefined;
		const from = view.lines.size;
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
			unconfirmed = { text, from };
			settleUnconfirmed();
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
		renderHelpers();
		if (watching) renderHow();
	}, 1000);
	setInterval(() => {
		renderHeader();
		if (view.rows.some((r) => r.stall)) renderLeft();
	}, 30_000);
	connect();
}

mount(document);
