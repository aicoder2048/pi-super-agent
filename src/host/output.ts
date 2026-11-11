import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One kind of thing in the output root. `dir` is relative to the root, posix, without a trailing slash. */
export interface OutputKind {
	readonly dir: string;
	readonly label: string;
	readonly holds: string;
	/** app: one numbered `app-NNN-<short>` directory per app, the number from new_app. dated: the model names it `<YYYYMMDD>-<short>[.ext]`. */
	readonly naming: "app" | "dated";
}

/**
 * The only list of kinds: the rule in the prompts and output/README.md are made from it, and no doc copies it.
 * Pi extensions, skills, themes and prompt templates always live inside an app, so a model never picks between a standalone skill and an app's.
 */
export const OUTPUT_KINDS = [
	{
		dir: "apps",
		label: "应用",
		naming: "app",
		holds: "能运行、能装上的东西：Pi 扩展、技能、主题、提示模板、命令行小工具、小网页。一个应用一个目录：扩展放 extensions/，技能放 skills/<名字>/，主题放 themes/，提示模板放 prompts/，测试放 tests/，怎么装、怎么用写在 README.md",
	},
	{ dir: "docs/analysis", label: "分析报告", naming: "dated", holds: "有结论的分析：行情、财报、调研、方案对比、复盘" },
	{ dir: "docs/reports", label: "其他文档", naming: "dated", holds: "说明、教程、草稿、纪要、整理的资料" },
	{ dir: "data", label: "数据", naming: "dated", holds: "导出或抓取的数据文件：CSV、JSON、表格" },
	{ dir: "scripts", label: "一次性脚本", naming: "dated", holds: "为一件事写、用完就算的脚本；要反复用的做成应用" },
	{ dir: "media", label: "图片和渲染件", naming: "dated", holds: "图表、截图、PDF" },
	{ dir: "misc", label: "其他", naming: "dated", holds: "说不清归哪一类的" },
] as const satisfies readonly OutputKind[];

export type OutputRole = "helper" | "member";

const DATED_NAME = "8 位日期-短名，例如 20261111-nvda-drop.md";
const APP_NAME: Record<OutputRole, string> = {
	helper: "用 new_app 要目录，不要自己编号",
	member: "派活里给的目录；没给就在回复里请领队给，不要自己编号",
};

export class OutputRoot {
	/** Absolute; the resolved config value, and the path the prompts name. */
	readonly root: string;
	readonly #stateDir: string;

	constructor(o: { root: string; stateDir: string }) {
		this.root = o.root;
		this.#stateDir = o.stateDir;
	}

	/** Makes the root and every kind's directory and rewrites README.md from the table. Leaves products alone; safe to repeat. */
	prepare(): void {
		for (const kind of OUTPUT_KINDS) mkdirSync(join(this.root, kind.dir), { recursive: true });
		const rows = OUTPUT_KINDS.map((k) => `| ${k.dir}/ | ${k.label}：${k.holds} | ${k.naming === "app" ? "app-<编号>-<短名>/，编号由宿主给，按顺序，删了也不复用" : DATED_NAME} |`);
		writeFileSync(
			join(this.root, "README.md"),
			["# 成品目录", "", "助手和成员做出来、要留给你的东西都放在这里，按下表分类。宿主每次启动按分类表重写这个文件，别手改。", "", "| 目录 | 放什么 | 怎么起名 |", "|---|---|---|", ...rows, ""].join("\n"),
		);
	}

	/** The rule appended to a helper's or member's system prompt when it can write files. */
	prompt(role: OutputRole): string {
		const rows = OUTPUT_KINDS.map((k) => `| ${this.root}/${k.dir}/ | ${k.label}：${k.holds} | ${k.naming === "app" ? APP_NAME[role] : DATED_NAME} |`);
		const lines = [
			"## 成品放在哪里",
			`做出来要留给使用者的东西（代码、文档、数据、图表）都写进成品目录 ${this.root}，按下表放。`,
			"不要写进代码仓库、使用者的其他目录，也不要写进 ~/.pi、.pi/ 这类配置目录；做好的 Pi 扩展、技能不要替使用者安装，在应用的 README.md 里写清怎么加载（例如 pi -e <路径>）。",
			"任务目录（你的工作目录）只放过程文件：草稿、下载的原始材料、中间结果。",
			"| 目录 | 放什么 | 怎么起名 |",
			"|---|---|---|",
			...rows,
			"- 名字用英文小写，单词之间用连字符。写之前先 ls 看一眼，不要覆盖已经有的文件。",
			"- 使用者在对话里明确点名要写到别处时，可以照做。",
			"- 汇报时，宿主会检查有没有写到成品目录、任务目录和临时目录之外，有的话写进汇报，让使用者看到。",
		];
		if (role === "helper") {
			lines.push(
				"- 同一个应用接着做，就用同一个短名调 new_app，会拿回原来的目录。",
				"- 派活给成员时，把成员该写的具体目录（绝对路径）写进任务里。即使你知道代码仓库在哪，也不要让成员写进仓库，也不要写成品目录之外的路径。",
				"- 汇报里写明成品的绝对路径。",
			);
		}
		return lines.join("\n");
	}
}
