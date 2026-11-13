import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { helperSessionDir } from "./dispatch.ts";
import { within } from "../worker/read-roots.ts";
import type { ScanCursor, WriteCheck } from "../kernel/types.ts";
import { scanSessions, type Placement, type SessionToScan } from "./write-check.ts";

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

const DATED_NAME = "8 位日期-短名，扩展名按内容，例如 20261111-nvda-drop";
const APP_NAME: Record<OutputRole, string> = {
	helper: "用 new_app 要目录，不要自己编号",
	member: "派活里给的目录；没给就在回复里请领队给，不要自己编号",
};

declare const appShortBrand: unique symbol;
/** An app's short name, as parseAppShort accepts it. */
export type AppShort = string & { readonly [appShortBrand]: true };

const APP_SHORT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const APP_SHORT_MAX = 24;
const APP_DIR = /^app-(\d{3,})-/;

/** Checks the short name a model sent; the error goes back to the model as is. */
export function parseAppShort(raw: unknown): AppShort {
	if (typeof raw !== "string" || raw.length > APP_SHORT_MAX || !APP_SHORT.test(raw)) {
		throw new Error(`应用短名（${JSON.stringify(raw)}）要用英文小写字母开头，只含小写字母、数字和单个连字符，不以连字符结尾，最长 ${APP_SHORT_MAX} 个字符，例如 joke、stock-alert`);
	}
	return raw as AppShort;
}

/** The kernel owns app numbers; see Kernel.claimApp. */
export interface AppLedger {
	claimApp(ticketId: string, short: string, floor: number): { number: number; isNew: boolean };
}

export interface App {
	/** app-007-joke */
	app: string;
	/** Absolute, and already made. */
	dir: string;
	isNew: boolean;
}

/** The real path of `path`, through its nearest existing ancestor when it does not exist yet (/tmp is /private/tmp on macOS). */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(real(parent), basename(path));
	}
}

export class OutputRoot {
	/** Absolute; the resolved config value, and the path the prompts name. */
	readonly root: string;
	readonly #stateDir: string;
	readonly #ledger: AppLedger;

	constructor(o: { root: string; stateDir: string; ledger: AppLedger }) {
		this.root = o.root;
		this.#stateDir = o.stateDir;
		this.#ledger = o.ledger;
	}

	/** worker.new_app. The floor keeps a new number above the app directories on disk, even with a fresh state.db. */
	newApp(ticketId: string, rawShort: unknown): App {
		const short = parseAppShort(rawShort);
		const apps = join(this.root, "apps");
		mkdirSync(apps, { recursive: true });
		const highest = Math.max(0, ...readdirSync(apps).map((name) => Number(APP_DIR.exec(name)?.[1] ?? 0)));
		const { number, isNew } = this.#ledger.claimApp(ticketId, short, highest + 1);
		const app = `app-${String(number).padStart(3, "0")}-${short}`;
		const dir = join(apps, app);
		mkdirSync(dir, { recursive: true });
		return { app, dir, isNew };
	}

	/** What the ticket's helper and members wrote outside since `since`, read from their session files. */
	checkWrites(ticket: { id: string; workerSessionId: string }, since: ScanCursor): WriteCheck {
		try {
			return scanSessions(this.#sessions(ticket), since, this.#placement(ticket.id), homedir());
		} catch (error) {
			// A failed check must not lose the report it rides on; the problem shows on the card instead.
			return { outside: [], omitted: 0, scanned: since, problem: `没能检查：${error instanceof Error ? error.message : String(error)}` };
		}
	}

	#sessions(ticket: { id: string; workerSessionId: string }): SessionToScan[] {
		const jsonl = (dir: string) => (statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : []);
		const entry = (file: string, by: SessionToScan["by"]) => ({ file, key: relative(this.#stateDir, file), by });
		const helpers = helperSessionDir(this.#stateDir);
		const team = join(this.#stateDir, "workers", ticket.id, "team");
		return [
			...jsonl(helpers).filter((f) => f.endsWith(`_${ticket.workerSessionId}.jsonl`)).map((f) => entry(join(helpers, f), { role: "helper" })),
			...(existsSync(team) ? readdirSync(team) : []).flatMap((name) => jsonl(join(team, name)).map((f) => entry(join(team, name, f), { role: "member", name }))),
		];
	}

	/**
	 * Inside: the output root, this ticket's workdir, the module packages, and the temp directories. Elsewhere in the state directory is outside,
	 * even when the state directory itself sits in a temp directory, so config.json and the tokens are never inside.
	 */
	#placement(ticketId: string): Placement {
		const state = real(this.#stateDir);
		const own = [real(this.root), real(join(this.#stateDir, "workers", ticketId)), real(join(this.#stateDir, "modules"))];
		const temp = [real(tmpdir()), real("/tmp")];
		return (path) => {
			const p = real(path);
			if (within(state, p)) return own.some((dir) => within(dir, p)) ? "inside" : "outside";
			return [...own, ...temp].some((dir) => within(dir, p)) ? "inside" : "outside";
		};
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
			`- 模块包写进 ${join(this.#stateDir, "modules")}/<名字>/（模块目录），宿主只在那里发现模块，不放成品目录。`,
			"- 使用者在对话里明确点名要写到别处时，可以照做。",
			"- 汇报时，宿主会检查有没有写到成品目录、模块目录、任务目录和临时目录之外，有的话写进汇报，让使用者看到。",
		];
		if (role === "helper") {
			lines.push(
				"- 同一个应用接着做，就用同一个短名调 new_app，会拿回原来的目录。",
				"- 派活给成员时，把成员该写的具体目录（绝对路径）写进任务里。即使你知道代码仓库在哪，也不要让成员写进仓库，路径只用成品目录或模块目录里的。",
				"- 汇报里写明成品的绝对路径。",
			);
		}
		return lines.join("\n");
	}
}
