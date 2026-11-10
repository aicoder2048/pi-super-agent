import { CAP_ASK_NEXT, capAskId, type CapAnswer, type CapAsk, type CapAskStore, type RecordedCapAsk } from "../kernel/cap-ask.ts";
import { newYorkDate } from "../kernel/helper-names.ts";
import type { AnswerRefusal } from "../kernel/question.ts";
import type { CapQuestion, Clock } from "../kernel/types.ts";

export const MEMBER_CAP_DEFAULT = 4;
/** No config key and no answer lets more member processes than this run at once. */
export const MEMBER_CAP_MAX = 10;

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
		return { reportId: capAskId(ask.day), text: `${queue}，同时运行的成员上限是 ${this.#o.configured}。今天放宽到 ${MEMBER_CAP_MAX} 吗？`, options: this.#choices().map((c) => c.label), askedAt: ask.askedAt };
	}

	answer(reportId: string, option: number): CapAnswerOutcome {
		const { clock, store, log } = this.#o;
		const refuse = (refusal: AnswerRefusal) => ({ ok: false as const, refusal });
		const ask = this.#today();
		if (ask.state === "none" || reportId !== capAskId(ask.day)) return refuse({ kind: "closed" });
		const choices = this.#choices();
		const said = (label: string) => `回答成员上限：${label}`;
		if (ask.state !== "asked") {
			const chosen = choices.findIndex((c) => c.state === ask.state);
			if (option !== chosen) return refuse({ kind: "chosen", option: chosen, label: choices[chosen].label });
			return { ok: true, lineId: reportId, text: said(choices[chosen].label), duplicate: true };
		}
		const choice = Number.isInteger(option) ? choices[option] : undefined;
		if (!choice) return refuse({ kind: "out_of_range", count: choices.length });
		const answered = this.#move({ state: choice.state, day: ask.day, askedAt: ask.askedAt, answeredAt: clock.now() });
		store.save(answered, said(choice.label));
		log(`[host] 成员上限：使用者选了「${choice.label}」，纽约 ${ask.day} 这一天${choice.effect}`);
		return { ok: true, lineId: reportId, text: said(choice.label), duplicate: false };
	}

	#choices(): { label: string; state: CapAnswer; effect: string }[] {
		return [
			{ label: `今天放宽到 ${MEMBER_CAP_MAX}`, state: "granted", effect: `上限 ${MEMBER_CAP_MAX}` },
			{ label: `保持 ${this.#o.configured}`, state: "declined", effect: "不再问" },
		];
	}

	#move<A extends RecordedCapAsk>(to: A): A {
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
