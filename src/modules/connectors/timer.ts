const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const EVERY = /^(\d+)([smhd])$/;

export function everyMs(every: string): number {
	const match = EVERY.exec(every);
	if (match === null) throw new Error(`every「${every}」不是 30s、15m、6h、1d 这样的写法`);
	return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

export function timerDue(every: string, lastRunAt: number | null, now: number): boolean {
	const ms = everyMs(every);
	return lastRunAt === null || Math.floor(now / ms) > Math.floor(lastRunAt / ms);
}

/** Its id is the slot's start, so the kernel's (source, external id) dedupe makes a repeated slot one trigger. */
export function timerItem(every: string, now: number): { id: string; at: string } {
	const ms = everyMs(every);
	const at = new Date(Math.floor(now / ms) * ms).toISOString();
	return { id: at, at };
}
