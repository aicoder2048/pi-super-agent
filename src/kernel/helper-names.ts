import type { Basis, HelperRole } from "./types.ts";

export const HELPER_NAMES = [
	"边牧", "弈境", "青檀", "观澜", "知微", "拾遗", "远山", "听松", "墨衡", "照夜",
	"栖云", "砚秋", "闻溪", "疏影", "归帆", "长庚", "星槎", "渡鸦", "白隼", "灵犀",
	"松烟", "竹笺", "枕流", "漱石", "望舒", "羲和", "扶摇", "清商", "素笺", "青萍",
	"寒山", "石渠", "兰台", "北辰", "析木", "玄枵", "惊蛰", "白露", "霜降", "谷雨",
	"小满", "芒种", "守拙", "抱朴", "观复", "见微", "明夷", "既济", "格物", "云岫",
	"苍梧", "鹤汀", "鸣泉", "澄怀", "雪泥鸿爪", "高山流水", "空谷足音", "春山可望", "星河欲转",
] as const;

const ROLE_BY_BASIS: Record<Basis, HelperRole> = { request: "conversation", rule: "rule", inference: "watch" };

export function helperRole(basis: Basis, originSource: string | null, isMarketSource: (source: string) => boolean): HelperRole {
	const role = ROLE_BY_BASIS[basis];
	return role === "rule" && originSource !== null && isMarketSource(originSource) ? "market" : role;
}

const ROUND_MARK = ["", "", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** Walks the pool from the ticket's ordinal and takes the first name no helper on duty holds; when all are held, the next round adds ·二, then ·三. */
export function helperName(ordinal: number, onDuty: ReadonlySet<string>): string {
	for (let round = 1; ; round++) {
		for (let i = 0; i < HELPER_NAMES.length; i++) {
			const base = HELPER_NAMES[(ordinal + i) % HELPER_NAMES.length];
			const name = round === 1 ? base : `${base}·${ROUND_MARK[round] ?? round}`;
			if (!onDuty.has(name)) return name;
		}
	}
}

const NEW_YORK_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** The New York calendar date (YYYY-MM-DD) a helper number counts in. */
export const newYorkDate = (ms: number) => NEW_YORK_DATE.format(ms);
