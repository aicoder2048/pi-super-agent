/** Level conditions (above, below, change-pct against a basis) alert when a row crosses into them, not on every row inside, so a feed writing every minute does not repeat itself. */
import type { Condition, Json, Watch } from "./protocol.ts";

export type SetCondition = Watch & { collection: string; setAt: string };

/** Oldest first; the last is the row just written. */
export type Point = { value: number; at: string; from: string };

type Kind = Condition["when"];
type Of<K extends Kind> = Extract<Condition, { when: K }>;
type Fields = Record<string, Json | undefined>;
type Spec<K extends Kind> = {
	fields: readonly string[];
	parse(raw: Fields): Of<K> | string;
	/** A streak reads one more row, to tell exactly `times` from more. */
	need(c: Of<K>): number;
	describe(c: Of<K>): string;
	met(c: Of<K>, points: readonly Point[]): string | undefined;
};

// Float rounding can put a move of exactly a threshold a hair below it (5.5 / 5 - 1 < 10%).
const EPSILON = 1e-9;
const round = (n: number) => String(Number(n.toFixed(2)));
/** Restated from src/sources/market/indicators.ts: importing it would pull the market feed into src/modules. */
const sma = (values: readonly number[], n: number) => (values.length < n ? undefined : values.slice(-n).reduce((a, b) => a + b, 0) / n);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const wholeIn = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function streak(points: readonly Point[], rising: boolean): number {
	let count = 0;
	for (let i = points.length - 1; i > 0; i--) {
		const step = points[i]!.value - points[i - 1]!.value;
		if (rising ? step <= 0 : step >= 0) break;
		count++;
	}
	return count;
}

const entered = (points: readonly Point[], inside: (value: number) => boolean) => inside(points.at(-1)!.value) && !(points.length > 1 && inside(points.at(-2)!.value));

const parseTimes = (times: Json | undefined) => (wholeIn(times, 1, 100) ? times : "times 要是 1 到 100 的整数");

type ChangePct = Of<"change-pct">;
const DIRECTIONS = ["up", "down", "either"] as const;

function moveOf(c: ChangePct, value: number, ref: number): number | undefined {
	if (ref === 0) return undefined;
	const move = ((value - ref) / ref) * 100;
	const side = move >= 0 ? "up" : "down";
	return (c.direction === "either" || c.direction === side) && Math.abs(move) >= c.atLeast - EPSILON ? move : undefined;
}
const moved = (move: number) => `${move >= 0 ? "涨" : "跌"}了 ${round(Math.abs(move))}%`;
const directionWord = { up: "涨", down: "跌", either: "涨跌" } as const;

const SPECS: { [K in Kind]: Spec<K> } = {
	above: {
		fields: ["value"],
		parse: ({ value }) => (isNumber(value) ? { when: "above", value } : "value 要是数字"),
		need: () => 2,
		describe: (c) => `高于 ${c.value}`,
		met: (c, points) => (entered(points, (v) => v > c.value) ? `高于 ${c.value}` : undefined),
	},
	below: {
		fields: ["value"],
		parse: ({ value }) => (isNumber(value) ? { when: "below", value } : "value 要是数字"),
		need: () => 2,
		describe: (c) => `低于 ${c.value}`,
		met: (c, points) => (entered(points, (v) => v < c.value) ? `低于 ${c.value}` : undefined),
	},
	"rising-streak": {
		fields: ["times"],
		parse: ({ times }) => {
			const parsed = parseTimes(times);
			return typeof parsed === "string" ? parsed : { when: "rising-streak", times: parsed };
		},
		need: (c) => c.times + 2,
		describe: (c) => `连续 ${c.times} 次上涨`,
		met: (c, points) => (streak(points, true) === c.times ? `连续 ${c.times} 次上涨` : undefined),
	},
	"falling-streak": {
		fields: ["times"],
		parse: ({ times }) => {
			const parsed = parseTimes(times);
			return typeof parsed === "string" ? parsed : { when: "falling-streak", times: parsed };
		},
		need: (c) => c.times + 2,
		describe: (c) => `连续 ${c.times} 次下跌`,
		met: (c, points) => (streak(points, false) === c.times ? `连续 ${c.times} 次下跌` : undefined),
	},
	"change-pct": {
		fields: ["atLeast", "direction", "basis"],
		parse: ({ atLeast, direction = "either", basis }) => {
			if (!isNumber(atLeast) || atLeast <= 0 || atLeast > 1000) return "atLeast 要是 0 到 1000 之间的百分数";
			if (!DIRECTIONS.includes(direction as never)) return `direction 只能是 ${DIRECTIONS.join("、")}`;
			if (basis !== undefined && (!isNumber(basis) || basis === 0)) return "basis 要是不为 0 的数字";
			return { when: "change-pct", atLeast, direction: direction as ChangePct["direction"], ...(basis !== undefined && { basis }) };
		},
		need: () => 2,
		describe: (c) => `${c.basis === undefined ? "比上一次" : `相对 ${c.basis} `}${directionWord[c.direction]} ${c.atLeast}% 以上`,
		met: (c, points) => {
			const [prev, now] = [points.at(-2), points.at(-1)!];
			const basis = c.basis;
			if (basis !== undefined) {
				const move = moveOf(c, now.value, basis);
				return move !== undefined && entered(points, (v) => moveOf(c, v, basis) !== undefined) ? `相对 ${basis} ${moved(move)}` : undefined;
			}
			const move = prev && moveOf(c, now.value, prev.value);
			return move === undefined ? undefined : `比上一次（${prev!.value}，${prev!.at}）${moved(move)}`;
		},
	},
	"crosses-average": {
		fields: ["points", "direction"],
		parse: ({ points, direction }) => {
			if (!wholeIn(points, 2, 200)) return "points 要是 2 到 200 的整数";
			if (direction !== "up" && direction !== "down") return "direction 只能是 up、down";
			return { when: "crosses-average", points, direction };
		},
		need: (c) => c.points + 1,
		describe: (c) => `${c.direction === "up" ? "上穿" : "下穿"}最近 ${c.points} 次的均值`,
		met: (c, points) => {
			const values = points.map((p) => p.value);
			const before = sma(values.slice(0, -1), c.points);
			const after = sma(values, c.points);
			if (before === undefined || after === undefined) return undefined;
			const [prev, now] = values.slice(-2) as [number, number];
			const crossed = c.direction === "up" ? prev <= before && now > after : prev >= before && now < after;
			return crossed ? `${c.direction === "up" ? "上穿" : "下穿"}最近 ${c.points} 次的均值 ${round(after)}` : undefined;
		},
	},
};

const specOf = <K extends Kind>(c: Of<K>) => SPECS[c.when] as unknown as Spec<K>;

const isFields = (raw: unknown): raw is Fields => typeof raw === "object" && raw !== null && !Array.isArray(raw);

/** The `watch` of a `set` request, checked. A string is what is wrong with it. */
export function parseWatch(raw: unknown): (Omit<Watch, "id"> & { id?: string }) | string {
	if (!isFields(raw)) return "watch 要是一个对象：key、condition，可选 note、id";
	const { key, condition, note, id } = raw;
	if (typeof key !== "string" || key.trim() === "" || key.length > 200) return "key 要是这类数据 watch key 字段的一个值，例如「空腹血糖」";
	if (note !== undefined && (typeof note !== "string" || note.length > 500)) return "note 要是 500 字以内的文字";
	if (id !== undefined && typeof id !== "string") return "id 要是已有条件的编号";
	if (!isFields(condition) || !Object.hasOwn(SPECS, condition.when as string)) return `condition.when 只能是 ${Object.keys(SPECS).join("、")}`;
	const spec = SPECS[condition.when as Kind];
	const extra = Object.keys(condition).find((f) => f !== "when" && !spec.fields.includes(f));
	if (extra !== undefined) return `${condition.when} 不认 ${extra}，只认 ${spec.fields.join("、")}`;
	const parsed = spec.parse(condition);
	if (typeof parsed === "string") return `${condition.when}：${parsed}`;
	return { key, condition: parsed, ...(note !== undefined && note !== "" && { note }), ...(id !== undefined && { id }) };
}

export const need = (c: Condition) => specOf(c).need(c);

export const describe = (c: Condition) => specOf(c).describe(c);

export const met = (c: Condition, points: readonly Point[]) => specOf(c).met(c, points);

// 1000: the kernel's host_lines length check.
const oneLine = (text: string) => [...text.replace(/\s+/g, " ").trim()].slice(0, 1000).join("");

export function alertText(title: string, condition: SetCondition, point: Point, happened: string): string {
	return oneLine(`${title} ${condition.key} ${point.value}，${happened}（${point.at}，来自 ${point.from}）${condition.note ? `。备注：${condition.note}` : ""}`);
}

export function receiptText(done: "已设" | "已改" | "已去掉", title: string, condition: SetCondition): string {
	return oneLine(`${done}提醒条件 ${condition.id}：${title} ${condition.key} ${describe(condition.condition)}${condition.note ? `（${condition.note}）` : ""}`);
}
