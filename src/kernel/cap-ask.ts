export type CapAnswer = "granted" | "declined";

/**
 * Whether the host asked the user to raise the member cap on one New York day, and what the user said.
 * `CAP_ASK_NEXT` is the only way a state changes within a day; a record of an earlier day counts as "none".
 */
export type CapAsk =
	| { state: "none" }
	| { state: "asked"; day: string; askedAt: number }
	| { state: CapAnswer; day: string; askedAt: number; answeredAt: number };

export type RecordedCapAsk = Exclude<CapAsk, { state: "none" }>;

export const CAP_ASK_NEXT: Record<CapAsk["state"], readonly CapAsk["state"][]> = {
	none: ["asked"],
	asked: ["granted", "declined"],
	granted: [],
	declined: [],
};

export const CAP_ASK_PREFIX = "ask_cap_";
const CAP_ASK_ID = new RegExp(`^${CAP_ASK_PREFIX}\\d{4}-\\d{2}-\\d{2}$`);

export const capAskId = (day: string) => `${CAP_ASK_PREFIX}${day}`;
export const isCapAskId = (id: string) => CAP_ASK_ID.test(id);

export interface CapAskStore {
	/** The most recent ask, or none when there is no ask or it is a grant already recorded as expired. */
	latest(): CapAsk;
	/** `said` is the user's sentence for an answer. */
	save(ask: RecordedCapAsk, said?: string): void;
	expire(day: string, at: number): void;
}
