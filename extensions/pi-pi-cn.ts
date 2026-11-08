/**
 * Pi Pi 中文版 — 构建 Pi 智能体的元智能体（TUI 与对话均为中文）
 *
 * 与 pi-pi.ts 功能相同：一组领域专家（扩展、主题、技能、配置、TUI 等）
 * 并行调研 Pi 文档，主智能体汇总调研结果并亲自写文件。
 *
 * 与原版的区别：
 *   - TUI 全部中文：专家卡片、状态、通知、页脚、命令说明
 *   - 提示词不翻译：主智能体和专家都用原版英文提示词，末尾追加同一段
 *     中文语言规则（.pi/agents/pi-pi-cn/lang-cn.md），对话与调研结果均为中文
 *   - 卡片宽度按终端列宽计算（visibleWidth），中文双宽字符不会挤歪边框
 *
 * 依赖的文件（相对启动目录，须在项目根目录启动 pi）：
 *   .pi/agents/pi-pi/*.md               专家定义（与原版共用）
 *   .pi/agents/pi-pi/pi-orchestrator.md 主智能体提示词（与原版共用）
 *   .pi/agents/pi-pi-cn/lang-cn.md      中文语言规则
 *
 * 命令：
 *   /experts          — 列出专家及状态
 *   /experts-grid N   — 设置看板列数（默认 3）
 *
 * 用法：pi -e extensions/pi-pi-cn.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── 类型 ─────────────────────────────────────────

type ExpertStatus = "idle" | "researching" | "done" | "error";

interface ExpertDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface ExpertState {
	def: ExpertDef;
	status: ExpertStatus;
	question: string;
	elapsed: number;
	lastLine: string;
	queryCount: number;
	timer?: ReturnType<typeof setInterval>;
}

// ── 中文显示名与简介 ──────────────────────────────
// key 仍是英文专家名（工具参数里用它），这里只管显示。

const EXPERT_CN: Record<string, { name: string; desc: string }> = {
	"agent-expert":      { name: "智能体专家",   desc: "智能体定义：.md 人设、工具、teams.yaml、编排" },
	"cli-expert":        { name: "命令行专家",   desc: "CLI 参数、环境变量、子命令、输出模式、非交互用法" },
	"config-expert":     { name: "配置专家",     desc: "settings.json、provider、模型、包、快捷键配置" },
	"ext-expert":        { name: "扩展专家",     desc: "扩展：工具、事件、命令、渲染、状态管理" },
	"keybinding-expert": { name: "快捷键专家",   desc: "registerShortcut()、Key ID、保留键、终端兼容性" },
	"prompt-expert":     { name: "提示词专家",   desc: "提示词模板：单文件 .md 命令、参数 $1 / $@" },
	"skill-expert":      { name: "技能专家",     desc: "技能：SKILL.md 多文件包、脚本、引用、frontmatter" },
	"theme-expert":      { name: "主题专家",     desc: "主题：JSON 格式、51 个颜色 token、vars、色值" },
	"tui-expert":        { name: "界面专家",     desc: "TUI：组件、键盘输入、浮层、widget、页脚、编辑器" },
};

const STATUS_CN: Record<ExpertStatus, string> = {
	idle: "空闲",
	researching: "调研中",
	done: "完成",
	error: "出错",
};

function displayName(name: string): string {
	const cn = EXPERT_CN[name.toLowerCase()];
	if (cn) return cn.name;
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function displayDesc(def: ExpertDef): string {
	return EXPERT_CN[def.name.toLowerCase()]?.desc ?? def.description;
}

function parseAgentFile(filePath: string): ExpertDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

// ── 提示词文件 ────────────────────────────────────
// 提示词是内容，不写在代码里。中文版不翻译原版提示词，
// 而是在原版英文提示词末尾追加一段中文语言规则（主智能体和专家共用）。

const ORCHESTRATOR_FILE = join(".pi", "agents", "pi-pi", "pi-orchestrator.md");
const LANG_RULE_FILE = join(".pi", "agents", "pi-pi-cn", "lang-cn.md");

/** 读取 .md 正文（去掉 frontmatter）。文件不存在返回 null。 */
function readPromptBody(filePath: string): string | null {
	if (!existsSync(filePath)) return null;
	const raw = readFileSync(filePath, "utf-8");
	const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return (match ? match[1] : raw).trim();
}

/** 返回缺失的提示词文件路径（相对 cwd），全部存在则为空数组。 */
function missingPromptFiles(cwd: string): string[] {
	return [ORCHESTRATOR_FILE, LANG_RULE_FILE].filter(f => !existsSync(join(cwd, f)));
}

// ── 专家卡片配色 ──────────────────────────────────
// 每位专家一个色相：bg 填充卡片内部，br 是同色相更亮的边框色。
const EXPERT_COLORS: Record<string, { bg: string; br: string }> = {
	"agent-expert":      { bg: "\x1b[48;2;20;30;75m",  br: "\x1b[38;2;70;110;210m"  }, // 藏青
	"config-expert":     { bg: "\x1b[48;2;18;65;30m",  br: "\x1b[38;2;55;175;90m"   }, // 森林绿
	"ext-expert":        { bg: "\x1b[48;2;80;18;28m",  br: "\x1b[38;2;210;65;85m"   }, // 深红
	"keybinding-expert": { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m"  }, // 紫罗兰
	"prompt-expert":     { bg: "\x1b[48;2;80;55;12m",  br: "\x1b[38;2;215;150;40m"  }, // 琥珀
	"skill-expert":      { bg: "\x1b[48;2;12;65;75m",  br: "\x1b[38;2;40;175;195m"  }, // 青绿
	"theme-expert":      { bg: "\x1b[48;2;80;18;62m",  br: "\x1b[38;2;210;55;160m"  }, // 玫红
	"tui-expert":        { bg: "\x1b[48;2;28;42;80m",  br: "\x1b[38;2;85;120;210m"  }, // 石板蓝
	"cli-expert":        { bg: "\x1b[48;2;60;80;20m",  br: "\x1b[38;2;160;210;55m"  }, // 橄榄绿
};
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

// ── 扩展 ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const experts: Map<string, ExpertState> = new Map();
	let gridCols = 3;
	let widgetCtx: any;

	function loadExperts(cwd: string) {
		// 与原版 pi-pi 共用专家目录
		const piPiDir = join(cwd, ".pi", "agents", "pi-pi");

		experts.clear();

		if (!existsSync(piPiDir)) return;
		try {
			for (const file of readdirSync(piPiDir)) {
				if (!file.endsWith(".md")) continue;
				if (file === "pi-orchestrator.md") continue;
				const fullPath = resolve(piPiDir, file);
				const def = parseAgentFile(fullPath);
				if (def) {
					const key = def.name.toLowerCase();
					if (!experts.has(key)) {
						experts.set(key, {
							def,
							status: "idle",
							question: "",
							elapsed: 0,
							lastLine: "",
							queryCount: 0,
						});
					}
				}
			}
		} catch {}
	}

	// ── 看板渲染 ─────────────────────────────────
	// 所有宽度都按终端列宽算：中文字符占 2 列，不能用 string.length。

	function renderCard(state: ExpertState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const fit = (s: string, max: number) => truncateToWidth(s, Math.max(0, max), "...");

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "researching" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "researching" ? "◉"
			: state.status === "done" ? "✓" : "✗";

		const nameText = fit(displayName(state.def.name), w - 1);
		const nameStr = theme.fg("accent", theme.bold(nameText));

		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}秒` : "";
		const queriesStr = state.queryCount > 0 ? ` (第${state.queryCount}次)` : "";
		const statusText = fit(`${statusIcon} ${STATUS_CN[state.status]}${timeStr}${queriesStr}`, w - 1);
		const statusLine = theme.fg(statusColor, statusText);

		const workText = fit(state.question || displayDesc(state.def), Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);

		const lastText = fit(state.lastLine || "", Math.min(50, w - 1)) || "—";
		const lastLineRendered = theme.fg("dim", lastText);

		const colors = EXPERT_COLORS[state.def.name];
		const bg  = colors?.bg ?? "";
		const br  = colors?.br ?? "";
		const bgr = bg ? BG_RESET : "";
		const fgr = br ? FG_RESET : "";

		// br 给边框字符上色，bg 填在后面，让整张卡片（上下边、两侧竖线）成为一整块。
		const bord = (s: string) => bg + br + s + bgr + fgr;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";

		// 填充前再补一次 bg，防止 theme.fg 内部用了全量 ANSI reset 导致行尾没底色。
		const border = (content: string, visLen: number) => {
			const pad = " ".repeat(Math.max(0, w - visLen));
			return bord("│") + bg + content + bg + pad + bgr + bord("│");
		};

		return [
			bord(top),
			border(" " + nameStr, 1 + visibleWidth(nameText)),
			border(" " + statusLine, 1 + visibleWidth(statusText)),
			border(" " + workLine, 1 + visibleWidth(workText)),
			border(" " + lastLineRendered, 1 + visibleWidth(lastText)),
			bord(bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("pi-pi-cn-grid", (_tui: any, theme: any) => {

			return {
				render(width: number): string[] {
					if (experts.size === 0) {
						return ["", theme.fg("dim", "  没有找到专家。请把智能体 .md 文件放进 .pi/agents/pi-pi/")];
					}

					const cols = Math.min(gridCols, experts.size);
					const gap = 1;
					// 直接返回原始行，避免 Text 组件误算 ANSI 宽度
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols) - 1;
					const allExperts = Array.from(experts.values());

					const lines: string[] = [""]; // 顶部留白

					for (let i = 0; i < allExperts.length; i += cols) {
						const rowExperts = allExperts.slice(i, i + cols);
						const cards = rowExperts.map(e => renderCard(e, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(6).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							lines.push(cards.map(card => card[line] || "").join(" ".repeat(gap)));
						}
					}

					return lines;
				},
				invalidate() {},
			};
		});
	}

	// ── 询问单个专家 ─────────────────────────────

	function queryExpert(
		expertName: string,
		question: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = expertName.toLowerCase();
		const state = experts.get(key);
		if (!state) {
			return Promise.resolve({
				output: `找不到专家 "${expertName}"。可用专家：${Array.from(experts.values()).map(s => s.def.name).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "researching") {
			return Promise.resolve({
				output: `${displayName(state.def.name)}（${state.def.name}）正在调研中，请等它完成。`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "researching";
		state.question = question;
		state.elapsed = 0;
		state.lastLine = "";
		state.queryCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const model = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";

		const langRule = readPromptBody(join(ctx.cwd, LANG_RULE_FILE)) ?? "";

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt + "\n\n" + langRule,
			question,
		];

		const textChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastLine = last;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";

				const full = textChunks.join("");
				state.lastLine = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				ctx.ui.notify(
					`${displayName(state.def.name)} ${STATUS_CN[state.status]}，用时 ${Math.round(state.elapsed / 1000)} 秒`,
					state.status === "done" ? "success" : "error"
				);

				resolve({
					output: full,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.status = "error";
				state.lastLine = `错误：${err.message}`;
				updateWidget();
				resolve({
					output: `启动专家子进程失败：${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── query_experts 工具（并行） ───────────────

	pi.registerTool({
		name: "query_experts",
		label: "询问专家",
		description: `**并行**询问一位或多位 Pi 领域专家。所有专家作为并发子进程同时运行。

传入一个查询数组 —— 每项包含专家名和一个具体问题。所有专家同时开始，结果一起返回。

可用专家（参数里用英文名）：
- ext-expert（扩展专家）：扩展 —— 工具、事件、命令、渲染、状态管理
- theme-expert（主题专家）：主题 —— JSON 格式、51 个颜色 token、vars、色值
- skill-expert（技能专家）：技能 —— SKILL.md 多文件包、脚本、引用、frontmatter
- config-expert（配置专家）：配置 —— settings.json、provider、模型、包、快捷键
- tui-expert（界面专家）：TUI —— 组件、键盘输入、浮层、widget、页脚、编辑器
- prompt-expert（提示词专家）：提示词模板 —— 单文件 .md 命令、参数（$1、$@）
- agent-expert（智能体专家）：智能体定义 —— .md 人设、工具、teams.yaml、编排
- keybinding-expert（快捷键专家）：快捷键 —— registerShortcut()、Key ID、保留键、macOS 终端兼容性
- cli-expert（命令行专家）：CLI —— 参数、环境变量、子命令、输出模式

围绕你要**构建**的东西提具体问题。每位专家会返回文档摘录、代码模式和实现指导（中文）。`,

		parameters: Type.Object({
			queries: Type.Array(
				Type.Object({
					expert: Type.String({
						description: "专家英文名：ext-expert、theme-expert、skill-expert、config-expert、tui-expert、prompt-expert、agent-expert、keybinding-expert、cli-expert",
					}),
					question: Type.String({
						description: "关于你要构建的东西的具体问题，附上目标组件的上下文。",
					}),
				}),
				{ description: "要并行执行的专家查询数组" },
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { queries } = params as { queries: { expert: string; question: string }[] };

			if (!queries || queries.length === 0) {
				return {
					content: [{ type: "text", text: "没有提供任何查询。" }],
					details: { results: [], status: "error" },
				};
			}

			const names = queries.map(q => displayName(q.expert)).join("、");
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `正在并行询问 ${queries.length} 位专家：${names}` }],
					details: { queries, status: "researching", results: [] },
				});
			}

			// 所有专家并发启动 —— 用 allSettled，一位失败不会丢掉其他人的结果
			const settled = await Promise.allSettled(
				queries.map(async ({ expert, question }) => {
					const result = await queryExpert(expert, question, ctx);
					const truncated = result.output.length > 12000
						? result.output.slice(0, 12000) + "\n\n... [已截断 —— 如需更多请追问]"
						: result.output;
					const status = result.exitCode === 0 ? "done" : "error";
					return {
						expert,
						question,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						output: truncated,
						fullOutput: result.output,
					};
				}),
			);

			const results = settled.map((s, i) =>
				s.status === "fulfilled"
					? s.value
					: {
						expert: queries[i].expert,
						question: queries[i].question,
						status: "error" as const,
						elapsed: 0,
						exitCode: 1,
						output: `错误：${(s.reason as any)?.message || s.reason}`,
						fullOutput: "",
					},
			);

			// 拼合返回内容
			const sections = results.map(r => {
				const icon = r.status === "done" ? "✓" : "✗";
				return `## [${icon}] ${displayName(r.expert)}（${r.expert}，${Math.round(r.elapsed / 1000)} 秒）\n\n${r.output}`;
			});

			return {
				content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
				details: {
					results,
					status: results.every(r => r.status === "done") ? "done" : "partial",
				},
			};
		},

		renderCall(args, theme) {
			const queries = (args as any).queries || [];
			const names = queries.map((q: any) => displayName(q.expert || "?")).join("、");
			return new Text(
				theme.fg("toolTitle", theme.bold("询问专家 ")) +
				theme.fg("accent", `${queries.length} 位并行`) +
				theme.fg("dim", " — ") +
				theme.fg("muted", names),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details?.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "researching") {
				const count = details.queries?.length || "?";
				return new Text(
					theme.fg("accent", `◉ ${count} 位专家`) +
					theme.fg("dim", " 正在并行调研……"),
					0, 0,
				);
			}

			const lines = (details.results as any[]).map((r: any) => {
				const icon = r.status === "done" ? "✓" : "✗";
				const color = r.status === "done" ? "success" : "error";
				const elapsed = typeof r.elapsed === "number" ? Math.round(r.elapsed / 1000) : 0;
				return theme.fg(color, `${icon} ${displayName(r.expert)}`) +
					theme.fg("dim", ` ${elapsed}秒`);
			});

			const header = lines.join(theme.fg("dim", " · "));

			if (options.expanded && details.results) {
				const expanded = (details.results as any[]).map((r: any) => {
					const output = r.fullOutput
						? (r.fullOutput.length > 4000 ? r.fullOutput.slice(0, 4000) + "\n... [已截断]" : r.fullOutput)
						: r.output || "";
					return theme.fg("accent", `── ${displayName(r.expert)} ──`) + "\n" + theme.fg("muted", output);
				});
				return new Text(header + "\n\n" + expanded.join("\n\n"), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── 命令 ─────────────────────────────────────

	pi.registerCommand("experts", {
		description: "列出 Pi Pi 专家及其状态",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const lines = Array.from(experts.values())
				.map(s => `${displayName(s.def.name)}（${s.def.name}，${STATUS_CN[s.status]}，已询问 ${s.queryCount} 次）：${displayDesc(s.def)}`)
				.join("\n");
			_ctx.ui.notify(lines || "尚未加载任何专家", "info");
		},
	});

	pi.registerCommand("experts-grid", {
		description: "设置专家看板列数：/experts-grid <1-5>",
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 5) {
				gridCols = n;
				_ctx.ui.notify(`看板已设为 ${gridCols} 列`, "info");
				updateWidget();
			} else {
				_ctx.ui.notify("用法：/experts-grid <1-5>", "error");
			}
		},
	});

	// ── System Prompt ────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		const expertCatalog = Array.from(experts.values())
			.map(s => `### ${displayName(s.def.name)}\n**调用名：** \`${s.def.name}\`\n${displayDesc(s.def)}\n（原文：${s.def.description}）`)
			.join("\n\n");

		const expertNames = Array.from(experts.values())
			.map(s => `${displayName(s.def.name)}（${s.def.name}）`)
			.join("、");

		const template = readPromptBody(join(_ctx.cwd, ORCHESTRATOR_FILE));
		const langRule = readPromptBody(join(_ctx.cwd, LANG_RULE_FILE));
		if (template === null || langRule === null) {
			// session_start 已经报过错；这里不覆盖 system prompt，避免把错误文案当提示词喂给模型
			return;
		}

		const systemPrompt = template
			.replace("{{EXPERT_COUNT}}", experts.size.toString())
			.replace("{{EXPERT_NAMES}}", expertNames)
			.replace("{{EXPERT_CATALOG}}", expertCatalog)
			+ "\n\n" + langRule;

		return { systemPrompt };
	});

	// ── 会话启动 ─────────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		applyExtensionDefaults(import.meta.url, _ctx);
		if (widgetCtx) {
			widgetCtx.ui.setWidget("pi-pi-cn-grid", undefined);
		}
		widgetCtx = _ctx;

		loadExperts(_ctx.cwd);
		updateWidget();

		const missing = missingPromptFiles(_ctx.cwd);
		if (missing.length > 0) {
			_ctx.ui.setStatus("pi-pi-cn", "Pi Pi 中文版：缺少提示词文件");
			_ctx.ui.notify(
				`Pi Pi 中文版无法工作，缺少提示词文件（相对当前目录 ${_ctx.cwd}）：\n` +
				missing.map(f => `  - ${f}`).join("\n") +
				`\n\n请在项目根目录启动 pi，或补齐这些文件。`,
				"error",
			);
			return;
		}

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join("、");
		_ctx.ui.setStatus("pi-pi-cn", `Pi Pi 中文版（${experts.size} 位专家）`);
		_ctx.ui.notify(
			`Pi Pi 中文版已加载 —— ${experts.size} 位专家：${expertNames}\n\n` +
			`/experts          查看专家及状态\n` +
			`/experts-grid N   设置看板列数（1-5）\n\n` +
			`告诉我你想构建什么 Pi 组件吧！`,
			"info",
		);

		// 自定义页脚
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "未选模型";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const active = Array.from(experts.values()).filter(e => e.status === "researching").length;
				const done = Array.from(experts.values()).filter(e => e.status === "done").length;

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", "Pi Pi 中文版");
				const mid = active > 0
					? theme.fg("accent", ` ◉ ${active} 位调研中`)
					: done > 0
					? theme.fg("success", ` ✓ ${done} 位已完成`)
					: "";
				const right = theme.fg("dim", `上下文 [${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

				return [truncateToWidth(left + mid + pad + right, width)];
			},
		}));
	});
}
