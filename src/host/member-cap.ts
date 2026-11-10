import { CAP_ASK_NEXT, capAskId, type CapAnswer, type CapAsk, type CapAskStore, type OpenCapAsk } from "../kernel/cap-ask.ts";
import { newYorkDate } from "../kernel/helper-names.ts";
import type { AnswerRefusal } from "../kernel/question.ts";
import type { CapQuestion, Clock } from "../kernel/types.ts";

export const MEMBER_CAP_DEFAULT = 4;
/** No config key and no answer lets more member processes than this run at once. */
export const MEMBER_CAP_MAX = 10;

/** By option index: the first button grants, the second declines. */
const ANSWERS: readonly CapAnswer[] = ["granted", "declined"];

export type CapAnswerOutcome = { ok: true; lineId: string; text: string; duplicate: boolean } | { ok: false; refusal: AnswerRefusal };

export interface MemberCapOptions {
	/** `maxConcurrentExperts`. */
	configured: number;
	clock: Clock;
	store: CapAskStore;
	log(line: string): void;
}

/** How many member processes may run at once today: the configured cap, or the hard maximum once the user said yes for this New York day. */
export class MemberCap {
	readonly #o: MemberCapOptions;
	#ask: CapAsk;

	constructor(options: MemberCapOptions) {
		this.#o = options;
		this.#ask = options.store.latest();
		this.#today();
	}

	limit(): number {
		return this.#today().state === "granted" ? MEMBER_CAP_MAX : this.#o.configured;
	}

	/** Called when `waiting` dispatches cannot start because every slot is taken. */
	membersWaiting(waiting: number): void {
		const { configured, clock, store, log } = this.#o;
		if (waiting < 1 || configured >= MEMBER_CAP_MAX || this.#today().state !== "none") return;
		const asked = this.#move({ state: "asked", day: newYorkDate(clock.now()), askedAt: clock.now() });
		store.save(asked);
		log(`[host] 成员上限：${waiting} 位成员在排队，上限 ${configured}，已问使用者今天是否放宽到 ${MEMBER_CAP_MAX}`);
	}

	/** The open question as the board shows it; `waiting` is how many dispatches wait for a slot right now. */
	question(waiting: number): CapQuestion | null {
		const ask = this.#today();
		if (ask.state !== "asked") return null;
		const queue = waiting > 0 ? `现在有 ${waiting} 位成员在排队` : "今天有成员排过队";
		return { reportId: capAskId(ask.day), text: `${queue}，同时运行的成员上限是 ${this.#o.configured}。今天放宽到 ${MEMBER_CAP_MAX} 吗？`, options: this.#options(), askedAt: ask.askedAt };
	}

	/** The click of an authenticated user front end; nothing else may call this. */
	answer(reportId: string, option: number): CapAnswerOutcome {
		const { configured, clock, store, log } = this.#o;
		const refuse = (refusal: AnswerRefusal) => ({ ok: false as const, refusal });
		const ask = this.#today();
		if (ask.state === "none" || reportId !== capAskId(ask.day)) return refuse({ kind: "closed" });
		const options = this.#options();
		const said = (o: number) => `回答成员上限：${options[o]}`;
		if (ask.state !== "asked") {
			const chosen = ANSWERS.indexOf(ask.state);
			if (option !== chosen) return refuse({ kind: "chosen", option: chosen, label: options[chosen] });
			return { ok: true, lineId: reportId, text: said(chosen), duplicate: true };
		}
		const state = Number.isInteger(option) ? ANSWERS[option] : undefined;
		if (!state) return refuse({ kind: "out_of_range", count: options.length });
		const answered = this.#move({ state, day: ask.day, askedAt: ask.askedAt, answeredAt: clock.now() });
		store.save(answered, said(option));
		const effect = state === "granted" ? `上限 ${MEMBER_CAP_MAX}` : "不再问";
		log(`[host] 成员上限：使用者选了「${options[option]}」，纽约 ${ask.day} 这一天${effect}`);
		return { ok: true, lineId: reportId, text: said(option), duplicate: false };
	}

	#options(): string[] {
		return [`今天放宽到 ${MEMBER_CAP_MAX}`, `保持 ${this.#o.configured}`];
	}

	#move<A extends OpenCapAsk>(to: A): A {
		if (!CAP_ASK_NEXT[this.#ask.state].includes(to.state)) throw new Error(`成员上限的问题不能从 ${this.#ask.state} 变成 ${to.state}`);
		this.#ask = to;
		return to;
	}

	#today(): CapAsk {
		const { configured, clock, store, log } = this.#o;
		const ask = this.#ask;
		if (ask.state === "none" || ask.day === newYorkDate(clock.now())) return ask;
		if (ask.state === "granted") {
			store.expire(ask.day, clock.now());
			log(`[host] 成员上限：纽约 ${ask.day} 的放宽已到期，上限回到 ${configured}`);
		}
		return (this.#ask = { state: "none" });
	}
}
