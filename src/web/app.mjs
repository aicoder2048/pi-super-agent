// @ts-check

import {
	BAR_HINT, CLEAR_FAILED, SWITCH_FAILED, moduleBody, STAGE_PHRASE, BASIS_PHRASE, answerBody, answerRefusedCopy, applyMessage, applyTranscript, avatarOf, canClear, canSend, choicesInConversation, clearedBar, dutyLine, earlierLines, emptyView, emptyWatch,
	questionOf, choiceOf, helperStrip, isStale, knownLineIds, leftColumn, lifecycleLine, linesNotIn, liveSteps, parseMarkdown, quoteShown, resolveTheme, restartNotice, routeLine, sayBody, sayCopy, sameAsSent, sayOutcome, settleSay, settleSending,
	laneClock, smallPrint, stepGroups, stopSentence, toggleEarlier, toggleTheme, historyKey, historyStep, sentHistory, firstPanel, panelStep, overviewTabs, phoneScreen, panelText, savedPanel,
} from "./view.mjs";
import { DEFAULT_ACK_TIMEOUT_MS, HOST_LINE_LABEL, helperLine } from "../client/board-format.mjs";

const STATUS_TEXT = {
	connecting: "连接中…",
	connected: "",
	disconnected: "连接中断，正在重连",
	expired: "链接已失效，请使用宿主日志中的最新链接",
};

const THEME_KEY = "psa-theme";
const PANEL_KEY = "psa-panel-open";
const TAB_KEY = "psa-right-panel";
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
	const clearButton = /** @type {HTMLButtonElement} */ ($("clear"));
	/** @param {string} id */
	const template = (id) => /** @type {Element} */ (/** @type {HTMLTemplateElement} */ ($(id)).content.firstElementChild);
	const avatarMark = template("router-avatar");
	const youMark = template("user-avatar");
	const wrench = template("helper-icon");
	const crown = template("crown-mark");
	const icons = new Map([.../** @type {HTMLTemplateElement} */ ($("step-icons")).content.querySelectorAll("svg[data-icon]")].map((svg) => [svg.getAttribute("data-icon"), svg]));
	let rendered = 0;
	/** @type {number | null} */
	let renderedClearAt = null;
	let earlierShown = false;
	/** @type {import("./view.mjs").SayState} */
	let sayState = "idle";
	/** @type {(import("./view.mjs").Said & { idsAtSay: Set<string> }) | undefined} */
	let unconfirmed;
	/** @type {import("./view.mjs").ConversationLine | null} */
	let quoting = null;
	/** @type {import("./view.mjs").Browsing} */
	let browsing = { index: null, draft: "" };
	const quoteStrip = $("quote-strip");
	const touch = matchMedia("(hover: none)");
	/** @type {{ watch: ReturnType<typeof emptyWatch>, source: EventSource } | undefined} */
	let watching;
	/** @type {import("./view.mjs").Sending} */
	const sending = new Map();
	const switching = new Set();
	let panel = firstPanel();
	let restored = false;
	let moduleDetails = false;

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
			if (block.kind === "table") {
				const table = el("table", "");
				const row = (/** @type {string} */ tag, /** @type {import("./view.mjs").Span[][]} */ cells) => {
					const tr = el("tr", "");
					for (const cell of cells) {
						const box = el(tag, "");
						inline(box, cell);
						tr.append(box);
					}
					return tr;
				};
				const head = el("thead", "");
				head.append(row("th", block.head));
				const body = el("tbody", "");
				body.append(...block.rows.map((cells) => row("td", cells)));
				table.append(head, body);
				const scroll = el("div", "md-table");
				scroll.append(table);
				node.append(scroll);
			} else if (block.kind === "ul" || block.kind === "ol") {
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
		/** @param {string} key */
		get: (key) => {
			try {
				return localStorage.getItem(key);
			} catch {
				return null;
			}
		},
		/** @param {string} key @param {string} value */
		set: (key, value) => {
			try {
				localStorage.setItem(key, value);
			} catch {}
		},
	};
	const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
	const stored = store.get(THEME_KEY);
	if (stored === "light" || stored === "dark") doc.documentElement.dataset.theme = stored;
	$("theme").addEventListener("click", () => {
		const next = toggleTheme(resolveTheme(doc.documentElement.dataset.theme ?? null, systemDark()));
		doc.documentElement.dataset.theme = next;
		store.set(THEME_KEY, next);
	});

	/** @type {Record<string, boolean>} */
	const panelOpen = (() => {
		try {
			return JSON.parse(store.get(PANEL_KEY) ?? "{}") ?? {};
		} catch {
			return {};
		}
	})();

	const renderHeader = () => {
		$("duty").textContent = dutyLine(view.duty, Date.now(), status.dataset.status === "connected");
		$("restart").textContent = restartNotice(view.duty, Date.now());
	};

	/** @param {import("./view.mjs").Avatar} avatar */
	const avatarNode = (avatar) => {
		const face = el("span", `face tint-${avatar.tint}`, avatar.text);
		face.dataset.kind = avatar.kind;
		face.setAttribute("aria-hidden", "true");
		if (avatar.kind === "unassigned") face.append(wrench.cloneNode(true));
		if (avatar.kind === "leader") face.append(crown.cloneNode(true));
		return face;
	};

	/** @param {import("./view.mjs").Crew} crew */
	const crewNode = (crew) => {
		const node = el("div", "crew");
		const stack = el("span", "stack");
		stack.append(...crew.avatars.map(avatarNode));
		node.append(stack, el("span", "crew-text", crew.text));
		return node;
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
		head.append(avatarNode(card.avatar), el("div", "title", card.title));
		node.append(head, el("div", "by", card.helper), el("div", "why", `${card.why} · ${card.stage}`), md("latest", card.latest));
		if (card.outside) node.append(el("div", "outside", card.outside));
		if (card.crew) node.append(crewNode(card.crew));
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

	/** @param {import("./view.mjs").CapCard} card */
	const capCard = (card) => {
		const node = el("div", "card ask cap");
		const box = el("div", "choices");
		fillChoices(box, card.choice);
		node.append(el("div", "title", card.title), el("div", "by", card.source), el("div", "why", card.stage), el("div", "latest", card.latest), box);
		return node;
	};

	/** @param {string} heading @param {HTMLElement[]} items @param {string} emptyText @param {string} [headingClass] */
	const section = (heading, items, emptyText, headingClass = "") => {
		const node = el("section", "");
		node.append(el("h2", headingClass, heading), ...(items.length ? items : [el("p", "empty", emptyText)]));
		return node;
	};

	/** @param {string} source @param {import("./view.mjs").PanelList} list */
	const panelList = (source, list) => {
		const id = `${source}/${list.key}`;
		const node = el("details", `panel ${list.key}`);
		node.open = panelOpen[id] ?? list.open;
		const items = el("ul", "");
		items.append(...list.items.map((item) => el("li", "", item)));
		node.append(el("summary", "", list.summary), items);
		node.addEventListener("toggle", () => {
			// Setting open above queues a toggle too; only the viewer's own click is worth remembering.
			if (node.open === (panelOpen[id] ?? list.open)) return;
			panelOpen[id] = node.open;
			store.set(PANEL_KEY, JSON.stringify(panelOpen));
		});
		return node;
	};

	/** @param {string} name @param {boolean} on */
	const switchModule = async (name, on) => {
		switching.add(name);
		renderOverview();
		try {
			const res = await fetch(`/module?${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: moduleBody(name, on), cache: "no-store", signal: AbortSignal.timeout(DEFAULT_ACK_TIMEOUT_MS) });
			if (res.status === 401) setStatus("expired");
			else if (!res.ok) setSay("rejected", res.status, SWITCH_FAILED);
		} catch {
			setSay("rejected", undefined, SWITCH_FAILED);
		} finally {
			switching.delete(name);
			renderOverview();
		}
	};

	/** @param {import("./view.mjs").ModuleView} m */
	const moduleCard = (m) => {
		const node = el("div", `card module ${m.tone}`);
		node.dataset.module = m.name;
		const button = el("button", "switch", m.button);
		button.type = "button";
		button.setAttribute("aria-pressed", String(m.on));
		button.setAttribute("aria-label", `${m.button} ${m.name}`);
		button.disabled = switching.has(m.name);
		button.addEventListener("click", () => void switchModule(m.name, !m.on));
		const head = el("div", "head");
		head.append(el("span", "dot"), el("div", "title", m.heading), button);
		node.append(head, el("div", "state", m.state), ...[m.version, ...m.lines].map((line) => el("div", "meta", line)));
		if (m.problems.length) {
			const list = el("ul", "problems");
			list.append(...m.problems.map((p) => el("li", "", p)));
			node.append(list);
		}
		if (m.imports.length) {
			const box = el("details", "imports");
			const list = el("ul", "");
			list.append(...m.imports.map((i) => {
				const item = el("li", "", i.name);
				item.append(el("code", "", i.command));
				return item;
			}));
			box.append(el("summary", "", m.importsHeading), list);
			node.append(box);
		}
		return node;
	};

	const renderLeft = (left = leftColumn(view, Date.now(), sending)) => {
		/** @type {HTMLElement} */ ($("bottom").querySelector(".badge")).textContent = left.needsYouCount ? String(left.needsYouCount) : "";
		$("left").replaceChildren(
			section(left.needsYouLine, [...(left.capCard ? [capCard(left.capCard)] : []), ...left.needsYou.map((c) => taskCard(c, "ask"))], "暂无待处理事项。", "warn"),
			section(`进行中 · ${left.doing.length}`, left.doing.map((c) => taskCard(c, "doing")), "暂无进行中的任务。"),
		);
	};

	/** @param {import("./view.mjs").ModuleView} m */
	const moduleRow = (m) => {
		const node = el("div", `module-row ${m.tone}`);
		node.dataset.module = m.name;
		const toggle = el("button", "toggle");
		toggle.type = "button";
		toggle.setAttribute("role", "switch");
		toggle.setAttribute("aria-checked", String(m.on));
		toggle.setAttribute("aria-label", m.name);
		toggle.disabled = switching.has(m.name);
		toggle.addEventListener("click", () => void switchModule(m.name, !m.on));
		node.append(el("span", "dot"), el("span", "name", m.name), el("span", "note", m.note), toggle);
		return node;
	};

	const renderOverview = (left = leftColumn(view, Date.now(), sending)) => {
		const today = el("div", "box");
		today.append(el("div", "headline", left.today.headline || "今日暂无来源消息"), el("div", "detail", left.today.detail));
		const alerts = el("div", "box");
		const list = el("ul", "alerts");
		list.append(...left.alerts.map((a) => {
			const item = el("li", a.id === panel.flash ? "flash" : "", a.text);
			item.dataset.line = a.id;
			return item;
		}));
		alerts.append(el("div", "headline", left.alertsLine), list);
		$("today").replaceChildren(today, alerts, el("p", "empty", "来源和盯盘条件在「来源」，模块开关在「模块」。"));
		const watches = left.watching.map((w) => {
			const node = el("div", w.problem ? "watch problem" : "watch");
			node.dataset.source = w.source;
			const body = el("div", "");
			body.append(el("div", "name", w.name), el("div", "rule", [w.rule, w.hits, w.alerts].filter(Boolean).join(" · ")), ...w.lists.map((l) => panelList(w.source, l)));
			node.append(body);
			return node;
		});
		$("sources").replaceChildren(...(watches.length ? watches : [el("p", "empty", "暂无关注的来源。")]));
		const head = el("div", "pane-head");
		const more = el("button", "more", moduleDetails ? "‹ 收起" : "详情 ›");
		more.type = "button";
		more.setAttribute("aria-expanded", String(moduleDetails));
		more.addEventListener("click", () => {
			moduleDetails = !moduleDetails;
			renderOverview();
		});
		head.append(el("h2", "", left.modulesLine), ...(left.modules.length ? [more] : []));
		const rows = el("div", moduleDetails ? "module-cards" : "box module-rows");
		rows.append(...left.modules.map(moduleDetails ? moduleCard : moduleRow));
		$("modules").replaceChildren(head, left.modules.length ? rows : el("p", "empty", "没有发现模块。"));
		const done = left.done.map((c) => taskCard(c, "done"));
		$("done").replaceChildren(...(done.length ? done : [el("p", "empty", "暂无已完成的任务。")]));
	};

	/** @param {import("./view.mjs").PanelTab} tab */
	const tabNode = (tab) => {
		const node = el("button", "tab", tab.label);
		node.type = "button";
		node.id = `tab-${tab.key}`;
		node.dataset.tab = tab.key;
		node.setAttribute("role", "tab");
		node.setAttribute("aria-selected", String(tab.selected));
		node.setAttribute("aria-controls", tab.key === "task" ? "how" : tab.key);
		node.tabIndex = tab.selected ? 0 : -1;
		if (tab.count !== null) node.append(el("span", "count", String(tab.count)));
		node.addEventListener("click", () => showPanel(panelStep(panel, { kind: "pick", tab: tab.key })));
		if (tab.key !== "task") return node;
		const close = el("button", "tab-close", "×");
		close.type = "button";
		close.setAttribute("aria-label", `关闭${tab.label}`);
		close.addEventListener("click", () => showPanel(panelStep(panel, { kind: "close" })));
		const wrap = el("span", "task-tab");
		wrap.append(node, close);
		return wrap;
	};

	// Counts change with every board push; the bar is rebuilt only when what it shows changed, so a focused tab keeps focus.
	let tabsShown = "";
	const renderTabs = () => {
		const tabs = overviewTabs(view, panel);
		const key = JSON.stringify(tabs);
		if (key !== tabsShown) {
			tabsShown = key;
			const focused = /** @type {HTMLElement | null} */ (doc.activeElement)?.closest?.(".tab")?.getAttribute("data-tab");
			$("tabs").replaceChildren(...tabs.map(tabNode));
			if (focused) /** @type {HTMLElement | null} */ ($("tabs").querySelector(`.tab[data-tab="${focused}"]`))?.focus();
		}
		for (const pane of ["how", "today", "sources", "modules", "done"]) $(pane).hidden = pane !== (panel.showing === "task" ? "how" : panel.showing);
	};

	const PLACE_NAME = { todo: "待办", chat: "对话", overview: "概况" };
	const renderScreen = () => {
		const screen = phoneScreen(panel);
		const entered = doc.body.dataset.screen !== screen;
		doc.body.dataset.screen = screen;
		for (const button of $("bottom").querySelectorAll("button")) button.setAttribute("aria-current", String(/** @type {HTMLElement} */ (button).dataset.place === screen));
		/** @type {HTMLElement} */ ($("bottom").querySelector(".dot")).hidden = !panel.dot;
		$("back").textContent = `‹ ${PLACE_NAME[panel.place]}`;
		// A hidden conversation keeps scrollTop at 0, so coming back to it would show the oldest lines.
		if (entered && screen === "chat") $("conversation").scrollTop = $("conversation").scrollHeight;
	};

	/** @param {string | null} ticketId */
	const follow = (ticketId) => {
		watching?.source.close();
		watching = undefined;
		if (!ticketId) return;
		const w = emptyWatch(ticketId);
		const source = new EventSource(`/transcript?${query}&ticket=${encodeURIComponent(ticketId)}`);
		source.onmessage = (e) => {
			if (applyTranscript(w, JSON.parse(e.data))) renderSteps();
		};
		watching = { watch: w, source };
	};

	const renderPanel = () => {
		const left = leftColumn(view, Date.now(), sending);
		renderTabs();
		renderLeft(left);
		renderOverview(left);
		renderHelpers();
		renderHow();
		renderAsk();
		renderSteps();
	};

	/** @param {import("./view.mjs").Panel} next */
	const showPanel = (next) => {
		const reopen = next.task !== (watching?.watch.ticketId ?? null);
		panel = next;
		store.set(TAB_KEY, panelText(panel));
		renderScreen();
		if (!reopen) {
			renderTabs();
			renderOverview();
			return;
		}
		follow(panel.task);
		renderPanel();
	};

	/** @param {import("./view.mjs").HelperChip} chip */
	const helperChip = (chip) => {
		const node = el("button", "helper-chip");
		node.type = "button";
		node.dataset.id = chip.id;
		node.append(el("span", "dot"), avatarNode(chip.avatar), el("span", "name", chip.name), el("span", "role", chip.role), el("span", "meta"));
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

	/** @returns {import("./view.mjs").Said} */
	const composed = () => ({ text: composer.value, quoteOf: quoting?.id ?? null });

	const renderQuoteStrip = () => {
		const box = $("conversation");
		const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
		quoteStrip.hidden = !quoting;
		if (quoting) {
			const shown = quoteShown(quoting);
			/** @type {HTMLElement} */ (quoteStrip.querySelector(".quote-who")).textContent = `引用 ${shown.who}：`;
			/** @type {HTMLElement} */ (quoteStrip.querySelector(".quote-text")).textContent = shown.text;
		}
		if (atBottom) box.scrollTop = box.scrollHeight;
	};

	/** @param {import("./view.mjs").Said} sent */
	const clearIfUnchanged = (sent) => {
		if (!sameAsSent(sent, composed())) return;
		composer.value = "";
		quoting = null;
		renderQuoteStrip();
	};

	const unpick = () => {
		for (const picked of thread.querySelectorAll(".line.picked")) picked.classList.remove("picked");
	};

	/** @param {import("./view.mjs").ConversationLine | null} line */
	const setQuote = (line) => {
		quoting = line;
		unpick();
		renderQuoteStrip();
		composer.focus();
	};

	/** @param {import("../kernel/types.ts").Quote} quote */
	const quotedNode = (quote) => {
		const shown = quoteShown(quote);
		const node = el("div", "quoted");
		node.append(el("span", "sr", "引用 "), el("span", "quote-text", `${shown.who}：${shown.text}`));
		return node;
	};

	/** @param {import("./view.mjs").ConversationLine} line */
	const quoteButton = (line) => {
		const button = el("button", "quote-btn", "引用");
		button.type = "button";
		button.addEventListener("click", (e) => {
			e.stopPropagation();
			setQuote(line);
		});
		return button;
	};

	/** @param {import("./view.mjs").ConversationLine} line @param {boolean} withChoices */
	const lineNode = (line, withChoices) => {
		const item = el("div", `line ${line.who}`);
		if (line.who === "alert" || line.who === "receipt") {
			const said = el("div", "said");
			said.append(el("div", "who", HOST_LINE_LABEL[line.who]), el("div", "bubble", line.text));
			item.append(said);
			return item;
		}
		const bubble = line.who === "router" ? md("bubble", line.text) : el("div", "bubble", line.text);
		if (line.who === "router") {
			const avatar = avatarMark.cloneNode(true);
			const said = el("div", "said");
			said.append(el("div", "who", "幕僚长"), bubble, quoteButton(line));
			if (withChoices) {
				const choices = el("div", "choices");
				choices.dataset.line = line.id;
				said.append(choices);
			}
			item.append(avatar, said);
		} else {
			bubble.prepend(el("span", "sr", "你："));
			const said = el("div", "said");
			const slot = el("div", "route-slot");
			slot.dataset.line = line.id;
			said.append(bubble, ...(line.quote ? [quotedNode(line.quote)] : []), slot, quoteButton(line));
			item.append(said, youMark.cloneNode(true));
		}
		return item;
	};

	const clearedBarNode = () => {
		const node = el("button", "cleared-bar");
		node.type = "button";
		node.addEventListener("click", () => {
			toggleEarlier(view);
			renderConversation();
		});
		return node;
	};

	const renderConversation = () => {
		const box = $("conversation");
		const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
		const clearAt = view.cleared?.at ?? null;
		if (clearAt !== renderedClearAt) {
			for (const node of thread.querySelectorAll(":scope > .line, :scope > .cleared-bar, :scope > .earlier")) node.remove();
			rendered = 0;
			renderedClearAt = clearAt;
			earlierShown = false;
			if (view.cleared) thread.append(clearedBarNode(), el("div", "earlier"));
		}
		const top = clearedBar(view, Date.now());
		const barNode = thread.querySelector(".cleared-bar");
		if (top && barNode) {
			barNode.textContent = top.text;
			barNode.setAttribute("aria-expanded", String(top.expanded));
		}
		if (view.showEarlier !== earlierShown) {
			thread.querySelector(".earlier")?.replaceChildren(...earlierLines(view).map((line) => lineNode(line, false)));
			earlierShown = view.showEarlier;
		}
		for (const line of [...view.lines.values()].slice(rendered)) thread.append(lineNode(line, true));
		rendered = view.lines.size;
		clearButton.disabled = !canClear(view);
		renderRoutes();
		renderChoices();
		if (atBottom) box.scrollTop = box.scrollHeight;
		settleUnconfirmed();
	};

	const settleUnconfirmed = () => {
		if (!unconfirmed) return;
		const next = settleSay({ state: sayState, ...unconfirmed }, linesNotIn(view, unconfirmed.idsAtSay));
		if (next === sayState) return;
		clearIfUnchanged(unconfirmed);
		unconfirmed = undefined;
		setSay(next);
	};

	const renderHow = () => {
		const row = view.rows.find((r) => r.id === watching?.watch.ticketId);
		$("how-badge").replaceChildren(...(row ? [avatarNode(avatarOf(row))] : []));
		$("how-title").textContent = row?.title ?? "";
		$("how-helper").textContent = row ? helperLine(row) : "";
		$("how-meta").textContent = row ? `${BASIS_PHRASE[row.basis]} · ${STAGE_PHRASE[row.stage]}` : "";
		$("how-life").textContent = lifecycleLine(row, Date.now(), view.receivedAt);
		$("small-print").textContent = smallPrint(row);
	};

	// Built on board pushes only, not by the 1 s tick, so a focused option button survives.
	const renderAsk = () => {
		const row = view.rows.find((r) => r.id === watching?.watch.ticketId);
		const box = $("how-ask");
		box.hidden = !row?.question;
		if (!row?.question) return void box.replaceChildren();
		const choices = el("div", "choices");
		fillChoices(choices, choiceOf(row.question, sending));
		box.replaceChildren(md("latest", row.question.text), choices);
	};

	let stepsShown = "";
	/** runningSince moves a little with every frame, so only the phase and the fixed numbers decide a rebuild. @param {import("./view.mjs").DispatchClock} clock */
	const clockKey = (clock) => clock && [clock.phase, clock.limitMs, clock.phase === "ended" ? clock.ranMs : null];
	/** @param {import("./view.mjs").Step[]} steps */
	const stepsKey = (steps) => JSON.stringify(steps.map((s) => [s.state, s.detail, s.dispatch && [s.dispatch.tokens, s.dispatch.note, s.dispatch.steps.map((m) => [m.state, m.title, m.detail]), clockKey(s.dispatch.clock)]]));
	const renderStepsIfMoved = () => {
		if (watching && stepsShown !== stepsKey(liveSteps(watching.watch, view))) renderSteps();
	};

	/** @param {import("./view.mjs").StepIcon} icon @param {import("./view.mjs").Step["state"]} state */
	const markNode = (icon, state) => {
		const mark = el("span", "mark");
		mark.append(/** @type {Element} */ (icons.get(icon) ?? icons.get("tool")).cloneNode(true), el("span", "mark-state", MARK[state]));
		return mark;
	};

	/** @param {import("./view.mjs").Step} step @param {number} i @param {Set<string | null>} open */
	const detailNodes = (step, i, open) => {
		const nodes = [];
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
			nodes.push(box);
		}
		const raw = el("details", "");
		raw.setAttribute("data-i", String(i));
		raw.open = open.has(String(i));
		raw.append(el("summary", "", "原始记录"), el("pre", "", step.raw));
		nodes.push(raw);
		return nodes;
	};

	/** @param {import("./view.mjs").Step} step @param {number} i @param {Set<string | null>} open */
	const stepItem = (step, i, open) => {
		const li = el("li", `step ${step.state}`);
		const rail = el("span", "rail");
		rail.append(markNode(step.icon, step.state));
		const body = el("div", "step-body");
		body.append(el("div", "step-title", step.title), step.markdown ? md("step-detail", step.detail) : el("div", "step-detail", step.detail), ...detailNodes(step, i, open));
		li.append(rail, body);
		return li;
	};

	/** Running lanes, patched by the 1 s tick instead of rebuilding the panel. @type {{ entry: import("./view.mjs").DispatchEntry, time: HTMLElement, bar: HTMLElement | null }[]} */
	let ticking = [];

	/** @param {HTMLElement} bar @param {{ text: string, ratio: number | null }} clock */
	const setBar = (bar, clock) => {
		const percent = Math.round((clock.ratio ?? 0) * 100);
		bar.setAttribute("aria-valuenow", String(percent));
		bar.setAttribute("aria-valuetext", clock.text);
		/** @type {HTMLElement} */ (bar.firstElementChild).style.width = `${percent}%`;
	};

	/** @param {import("./view.mjs").Lane} lane @param {Set<string | null>} open */
	const laneNode = (lane, open) => {
		const { step, i } = lane;
		const node = el("div", `step lane ${step.state}`);
		const head = el("div", "lane-head");
		head.append(avatarNode(lane.avatar), el("div", "step-detail", step.detail));
		const clock = laneClock(step.dispatch, Date.now());
		const time = el("div", "lane-time", clock.text);
		node.append(head, time);
		let bar = null;
		if (clock.ratio !== null) {
			bar = el("div", "lane-bar");
			bar.setAttribute("role", "progressbar");
			bar.setAttribute("aria-valuemin", "0");
			bar.setAttribute("aria-valuemax", "100");
			bar.setAttribute("aria-label", BAR_HINT);
			bar.title = BAR_HINT;
			bar.append(el("span", "lane-fill"));
			setBar(bar, clock);
			node.append(bar);
		}
		if (step.dispatch.clock?.phase === "running") ticking.push({ entry: step.dispatch, time, bar });
		node.append(...detailNodes(step, i, open));
		return node;
	};

	/** Not a .step itself, so `.step` still counts one per dispatch. @param {Extract<import("./view.mjs").StepGroup, { kind: "lanes" }>} group @param {Set<string | null>} open */
	const lanesItem = (group, open) => {
		const li = el("li", "lanes");
		li.dataset.state = group.state;
		const rail = el("span", "rail");
		rail.append(markNode("dispatch", group.state));
		const row = el("div", "lane-row");
		row.append(...group.lanes.map((lane) => laneNode(lane, open)));
		const body = el("div", "step-body");
		body.append(el("div", "step-title", "派活"), row);
		li.append(rail, body);
		return li;
	};

	const tickLanes = () => {
		const now = Date.now();
		for (const { entry, time, bar } of ticking) {
			const clock = laneClock(entry, now);
			time.textContent = clock.text;
			if (bar) setBar(bar, clock);
		}
	};

	const renderSteps = () => {
		const steps = watching ? liveSteps(watching.watch, view) : [];
		stepsShown = stepsKey(steps);
		ticking = [];
		if (!watching) return void $("steps").replaceChildren();
		if (!steps.length) return void $("steps").replaceChildren(el("li", "empty", "暂无步骤。"));
		const open = new Set([...$("steps").querySelectorAll("details[open]")].map((d) => d.getAttribute("data-i")));
		const row = view.rows.find((r) => r.id === watching?.watch.ticketId);
		$("steps").replaceChildren(...stepGroups(steps, row).map((group) => (group.kind === "step" ? stepItem(group.step, group.i, open) : lanesItem(group, open))));
	};

	const render = {
		conversation: renderConversation,
		left: () => {
			const left = leftColumn(view, Date.now(), sending);
			renderLeft(left);
			renderOverview(left);
			renderTabs();
			renderAsk();
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
				const options = questionOf(view, reportId)?.options ?? [];
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

	/** Clicking the task already open reopens its stream, which recovers after a host restart. @param {string} ticketId */
	const watch = (ticketId) => {
		panel = panelStep(panel, { kind: "open", ticketId });
		store.set(TAB_KEY, panelText(panel));
		renderScreen();
		follow(ticketId);
		renderPanel();
	};

	/** @param {import("./view.mjs").PanelTab["key"]} key @param {1 | -1} by */
	const nextTab = (key, by) => {
		const keys = overviewTabs(view, panel).map((t) => t.key);
		return keys[(keys.indexOf(key) + by + keys.length) % keys.length];
	};
	for (const button of $("bottom").querySelectorAll("button")) {
		const place = /** @type {import("./view.mjs").Place} */ (/** @type {HTMLElement} */ (button).dataset.place);
		const icon = /** @type {HTMLElement} */ (button.querySelector(".icon"));
		icon.replaceWith(/** @type {Element} */ (icons.get(icon.dataset.icon ?? "")).cloneNode(true));
		button.addEventListener("click", () => showPanel(panelStep(panel, { kind: "place", place })));
	}
	renderScreen();
	$("back").addEventListener("click", () => showPanel(panelStep(panel, { kind: "pick", tab: panel.last })));
	$("tabs").addEventListener("keydown", (e) => {
		const key = /** @type {HTMLElement} */ (e.target).closest(".tab")?.getAttribute("data-tab");
		if (!key || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
		e.preventDefault();
		const tab = nextTab(/** @type {import("./view.mjs").PanelTab["key"]} */ (key), e.key === "ArrowRight" ? 1 : -1);
		showPanel(panelStep(panel, { kind: "pick", tab }));
		/** @type {HTMLElement | null} */ ($("tabs").querySelector(`.tab[data-tab="${tab}"]`))?.focus();
	});

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
			const message = JSON.parse(e.data);
			const panes = applyMessage(view, message, Date.now());
			if (panes.includes("left")) settleSending(view, sending);
			for (const pane of panes) render[pane]();
			if (panes.includes("left")) renderHow();
			if (message.type === "snapshot" && !restored) {
				restored = true;
				showPanel(savedPanel(store.get(TAB_KEY), new Set(view.rows.map((r) => r.id))));
			}
			if (message.type === "host_line" && message.who === "alert") showPanel(panelStep(panel, { kind: "alert", lineId: message.id, phone: getComputedStyle($("bottom")).display !== "none" }));
		};
		events.onerror = () => {
			setStatus("disconnected");
			if (events.readyState === EventSource.CONNECTING) return;
			// CLOSED means a non-200 answer, which EventSource never retries.
			reconnect();
		};
	};

	const say = async () => {
		const sent = composed();
		if (!canSend(sent.text) || send.disabled) return;
		send.disabled = true;
		unconfirmed = undefined;
		const idsAtSay = knownLineIds(view);
		setSay("sending");
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), DEFAULT_ACK_TIMEOUT_MS);
		try {
			const res = await fetch(`/say?${query}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: sayBody(sent),
				signal: abort.signal,
				cache: "no-store",
			});
			const state = sayOutcome({ status: res.status });
			if (state === "delivered") clearIfUnchanged(sent);
			if (state === "expired") setStatus("expired");
			setSay(state, res.status);
		} catch {
			setSay(sayOutcome(abort.signal.aborted ? "timeout" : "network"));
			unconfirmed = { ...sent, idsAtSay };
			settleUnconfirmed();
		} finally {
			clearTimeout(timer);
			send.disabled = false;
		}
	};

	clearButton.addEventListener("click", async () => {
		clearButton.disabled = true;
		try {
			const res = await fetch(`/clear?${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store", signal: AbortSignal.timeout(DEFAULT_ACK_TIMEOUT_MS) });
			if (res.status === 401) setStatus("expired");
			else if (!res.ok) setSay("rejected", res.status, CLEAR_FAILED);
		} catch {
			setSay("rejected", undefined, CLEAR_FAILED);
		} finally {
			clearButton.disabled = !canClear(view);
		}
	});

	$("say").addEventListener("submit", (e) => {
		e.preventDefault();
		void say();
	});
	$("quote-cancel").addEventListener("click", () => setQuote(null));
	thread.addEventListener("click", (e) => {
		const target = /** @type {Element} */ (e.target);
		if (!touch.matches || target.closest(".choices, .route, a, button")) return;
		const line = target.closest(".bubble")?.closest(".line");
		if (!line) return;
		const wasPicked = line.classList.contains("picked");
		unpick();
		line.classList.toggle("picked", !wasPicked);
	});
	composer.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && quoting && !e.isComposing && e.keyCode !== 229) {
			e.preventDefault();
			setQuote(null);
			return;
		}
		const arrow = historyKey(e, composer.value, composer.selectionStart, composer.selectionEnd);
		const step = arrow && historyStep(browsing, arrow, sentHistory(view), composer.value);
		if (step) {
			e.preventDefault();
			browsing = step.state;
			composer.value = step.text;
			composer.setSelectionRange(step.text.length, step.text.length);
			return;
		}
		if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		void say();
	});

	renderPanel();
	setInterval(() => {
		renderHelpers();
		if (watching) {
			renderHow();
			tickLanes();
		}
	}, 1000);
	setInterval(() => {
		renderHeader();
		if (view.rows.some((r) => r.stall)) renderLeft();
	}, 30_000);
	connect();
}

mount(document);
