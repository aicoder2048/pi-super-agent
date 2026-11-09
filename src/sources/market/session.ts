export type Phase = "pre" | "regular" | "post" | "closed";

export interface Session {
	nyDate: string;
	phase: Phase;
	openAt: number;
	closeAt: number;
}

const MINUTE = 60_000;
// Delayed plans lag about 15 minutes, so the last regular-session quotes arrive after the bell.
export const DELAY_GRACE_MS = 20 * MINUTE;
const MAX_SLEEP_MS = 15 * MINUTE;

const NY = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/New_York",
	hourCycle: "h23",
	weekday: "short",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
});

function nyWall(ms: number) {
	const p = Object.fromEntries(NY.formatToParts(ms).map((x) => [x.type, x.value]));
	const [y, m, d, h, mi, s] = [p.year, p.month, p.day, p.hour, p.minute, p.second].map(Number);
	const offset = Date.UTC(y, m - 1, d, h, mi, s) - Math.floor(ms / 1000) * 1000;
	return { nyDate: `${p.year}-${p.month}-${p.day}`, weekend: p.weekday === "Sat" || p.weekday === "Sun", minutes: h * 60 + mi, midnight: Date.UTC(y, m - 1, d) - offset };
}

export function nyDateOf(ms: number): string {
	return nyWall(ms).nyDate;
}

export function sessionAt(now: number): Session {
	const w = nyWall(now);
	const openAt = w.midnight + (9 * 60 + 30) * MINUTE;
	const closeAt = w.midnight + 16 * 60 * MINUTE;
	const phase: Phase = w.weekend || w.minutes < 4 * 60 || w.minutes >= 20 * 60 ? "closed" : now < openAt ? "pre" : now < closeAt ? "regular" : "post";
	return { nyDate: w.nyDate, phase, openAt, closeAt };
}

export function inPollWindow(now: number): boolean {
	const s = sessionAt(now);
	return !nyWall(now).weekend && now >= s.openAt && now <= s.closeAt + DELAY_GRACE_MS;
}

export function nextPollDelay(now: number, everySeconds: number): number {
	if (inPollWindow(now)) return everySeconds * 1000;
	const s = sessionAt(now);
	return s.phase === "pre" ? Math.min(s.openAt - now, MAX_SLEEP_MS) : MAX_SLEEP_MS;
}
