const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** feed.json's `every`: a number and one of s, m, h, d. validate.ts checks it with this. */
export const EVERY = /^(\d+)([smhd])$/;

export function everyMs(every: string): number {
	const match = EVERY.exec(every);
	if (match === null) throw new Error(`every「${every}」不是 30s、15m、6h、1d 这样的写法`);
	return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** Calls land on fixed slots of `every` since the epoch, so a restart inside a slot does not call again. */
export function timerDue(every: string, lastRunAt: number | null, now: number): boolean {
	const ms = everyMs(every);
	return lastRunAt === null || Math.floor(now / ms) > Math.floor(lastRunAt / ms);
}

/** The timer's one item per slot. Its id is the slot's start, so a repeated slot is one trigger. */
export function timerItem(every: string, now: number): { id: string; at: string } {
	const ms = everyMs(every);
	const at = new Date(Math.floor(now / ms) * ms).toISOString();
	return { id: at, at };
}
