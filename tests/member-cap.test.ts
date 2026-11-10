import assert from "node:assert/strict";
import { test } from "node:test";
import { MemberCap } from "../src/host/member-cap.ts";
import { CAP_ASK_NEXT, capAskId, isCapAskId, type CapAsk, type CapAskStore } from "../src/kernel/cap-ask.ts";

const NOON = Date.UTC(2026, 10, 9, 17, 0);
const LATE = Date.UTC(2026, 10, 10, 4, 30);
const NEXT_DAY = Date.UTC(2026, 10, 10, 5, 30);
const TODAY = "ask_cap_2026-11-09";

class MemoryStore implements CapAskStore {
	rows = new Map<string, Exclude<CapAsk, { state: "none" }> & { said?: string; expiredAt?: number }>();

	latest(): CapAsk {
		const row = [...this.rows.values()].sort((a, b) => a.day.localeCompare(b.day)).at(-1);
		return row && row.expiredAt === undefined ? row : { state: "none" };
	}

	save(ask: Exclude<CapAsk, { state: "none" }>, said?: string): void {
		this.rows.set(ask.day, { ...ask, ...(said !== undefined && { said }) });
	}

	expire(day: string, at: number): void {
		this.rows.get(day)!.expiredAt = at;
	}
}

function setup(configured = 4, store = new MemoryStore(), at = NOON) {
	const clock = { at, now: () => clock.at };
	const lines: string[] = [];
	const cap = new MemberCap({ configured, clock, store, log: (line) => lines.push(line) });
	return { cap, clock, lines, store };
}

test("问题的状态只有一条路：没问 → 问了 → 放宽或保持；答过之后当天不再变", () => {
	assert.deepEqual(CAP_ASK_NEXT, { none: ["asked"], asked: ["granted", "declined"], granted: [], declined: [] });
});

test("成员因为名额用完开始排队、上限还是配置值时，宿主问一次：写明几位在排队、现在的上限，给两个选项", () => {
	const { cap, lines } = setup();
	assert.equal(cap.question(0), null, "没人排队时不问");
	cap.membersWaiting(2);
	assert.deepEqual(cap.question(2), { reportId: TODAY, text: "现在有 2 位成员在排队，同时运行的成员上限是 4。今天放宽到 10 吗？", options: ["今天放宽到 10", "保持 4"], askedAt: NOON });
	assert.equal(cap.limit(), 4, "问了不等于放宽");
	cap.membersWaiting(3);
	assert.equal(lines.length, 1, "问题还开着时不问第二次");
	assert.match(lines[0], /^\[host\] 成员上限：2 位成员在排队，上限 4，已问使用者今天是否放宽到 10$/);
});

test("排队的成员都轮到了，问题还开着：说法改成今天排过队", () => {
	const { cap } = setup();
	cap.membersWaiting(1);
	assert.equal(cap.question(0)?.text, "今天有成员排过队，同时运行的成员上限是 4。今天放宽到 10 吗？");
});

test("选「今天放宽到 10」：上限马上变成 10，问题收起，记一行日志和使用者的这句话", () => {
	const { cap, lines, store } = setup();
	cap.membersWaiting(2);
	assert.deepEqual(cap.answer(TODAY, 0), { ok: true, lineId: TODAY, text: "回答成员上限：今天放宽到 10", duplicate: false });
	assert.equal(cap.limit(), 10);
	assert.equal(cap.question(2), null);
	assert.equal(store.rows.get("2026-11-09")?.said, "回答成员上限：今天放宽到 10");
	assert.match(lines[1], /^\[host\] 成员上限：使用者选了「今天放宽到 10」，纽约 2026-11-09 这一天上限 10$/);
	assert.equal(lines.length, 2);
});

test("同一项再点一次仍算成功、不重复记；换另一项被拒，回已选的那一项", () => {
	const { cap, lines } = setup();
	cap.membersWaiting(2);
	cap.answer(TODAY, 0);
	assert.deepEqual(cap.answer(TODAY, 0), { ok: true, lineId: TODAY, text: "回答成员上限：今天放宽到 10", duplicate: true });
	assert.deepEqual(cap.answer(TODAY, 1), { ok: false, refusal: { kind: "chosen", option: 0, label: "今天放宽到 10" } });
	assert.equal(lines.length, 2);
	assert.equal(cap.limit(), 10);
});

test("选「保持 4」：上限不变，这个纽约日里再排队也不再问", () => {
	const { cap, clock, lines } = setup();
	cap.membersWaiting(2);
	assert.equal(cap.answer(TODAY, 1).ok, true);
	assert.equal(cap.limit(), 4);
	clock.at = LATE;
	cap.membersWaiting(5);
	assert.equal(cap.question(5), null);
	assert.match(lines[1], /^\[host\] 成员上限：使用者选了「保持 4」，纽约 2026-11-09 这一天不再问$/);
	assert.equal(lines.length, 2);
	assert.deepEqual(cap.answer(TODAY, 0), { ok: false, refusal: { kind: "chosen", option: 1, label: "保持 4" } }, "说了保持之后不能再点放宽");
});

test("放宽只到纽约当天结束：过了零点上限回到配置值，记一行日志；之后再排队重新问", () => {
	const { cap, clock, lines } = setup();
	cap.membersWaiting(2);
	cap.answer(TODAY, 0);
	clock.at = LATE;
	assert.equal(cap.limit(), 10, "纽约 23:30 还是同一天");
	clock.at = NEXT_DAY;
	assert.equal(cap.limit(), 4);
	assert.equal(cap.limit(), 4);
	assert.deepEqual(lines.slice(2), ["[host] 成员上限：纽约 2026-11-09 的放宽已到期，上限回到 4"]);
	cap.membersWaiting(1);
	assert.equal(cap.question(1)?.reportId, "ask_cap_2026-11-10");
	assert.deepEqual(cap.answer(TODAY, 0), { ok: false, refusal: { kind: "closed" } }, "昨天的按钮今天不算数");
});

test("没回答的问题过了纽约当天自己收起，不记到期；保持也只管当天", () => {
	const { cap, clock, lines } = setup();
	cap.membersWaiting(2);
	clock.at = NEXT_DAY;
	assert.equal(cap.question(0), null);
	assert.equal(lines.length, 1);
	cap.membersWaiting(1);
	cap.answer("ask_cap_2026-11-10", 1);
	clock.at = NEXT_DAY + 86_400_000;
	cap.membersWaiting(1);
	assert.equal(cap.question(1)?.reportId, "ask_cap_2026-11-11");
});

test("宿主重启后同一个纽约日里放宽还在、开着的问题还在；隔天启动时到期只记一次", () => {
	const first = setup();
	first.cap.membersWaiting(2);
	assert.deepEqual(setup(4, first.store).cap.question(0)?.reportId, TODAY, "问了没答就重启，问题还在");
	first.cap.answer(TODAY, 0);
	const sameDay = setup(4, first.store, LATE);
	assert.equal(sameDay.cap.limit(), 10);
	assert.deepEqual(sameDay.lines, []);
	const nextDay = setup(4, first.store, NEXT_DAY);
	assert.equal(nextDay.cap.limit(), 4);
	assert.deepEqual(nextDay.lines, ["[host] 成员上限：纽约 2026-11-09 的放宽已到期，上限回到 4"]);
	const again = setup(4, first.store, NEXT_DAY);
	assert.equal(again.cap.limit(), 4);
	assert.deepEqual(again.lines, []);
});

test("配置的上限已经是 10：从不问，也没有可答的问题", () => {
	const { cap, lines } = setup(10);
	cap.membersWaiting(3);
	assert.equal(cap.question(3), null);
	assert.equal(cap.limit(), 10);
	assert.deepEqual(lines, []);
	assert.deepEqual(cap.answer(TODAY, 0), { ok: false, refusal: { kind: "closed" } });
});

test("没有问过就来回答、选项序号不对：都被拒，上限不变", () => {
	const { cap } = setup();
	assert.deepEqual(cap.answer(TODAY, 0), { ok: false, refusal: { kind: "closed" } });
	cap.membersWaiting(1);
	for (const option of [2, -1, 0.5]) assert.deepEqual(cap.answer(TODAY, option), { ok: false, refusal: { kind: "out_of_range", count: 2 } });
	assert.equal(cap.limit(), 4);
});

test("问题的编号带着纽约日期，和助手汇报的编号分得开", () => {
	assert.equal(capAskId("2026-11-09"), TODAY);
	assert.equal(isCapAskId(TODAY), true);
	for (const id of ["rpt_abc", "ask_cap_", "ask_cap_2026-11-09x", "xask_cap_2026-11-09"]) assert.equal(isCapAskId(id), false, id);
});
