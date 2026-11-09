export type Phase = "pre" | "regular" | "post" | "closed";

export interface Session {
	nyDate: string;
	weekend: boolean;
	phase: Phase;
	openAt: number;
	closeAt: number;
	previousSessionMinutes: number;
}

export const MINUTE = 60_000;
// Delayed plans lag about 15 minutes, so the last regular-session quotes arrive after the bell.
const DELAY_GRACE_MS = 20 * MINUTE;
const MAX_SLEEP_MS = 15 * MINUTE;
const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const EARLY_CLOSE = 13 * 60;
// NYSE 1:00 p.m. early closes as published on nyse.com/markets/hours-calendars, each mapped to
// the next trading day, whose prevDay volume then covers 210 minutes instead of 390.
const EARLY_CLOSES = new Map([
	["2026-11-27", "2026-11-30"],
	["2026-12-24", "2026-12-28"],
	["2027-11-26", "2027-11-29"],
	["2028-07-03", "2028-07-05"],
	["2028-11-24", "2028-11-27"],
]);
const AFTER_EARLY_CLOSE = new Set(EARLY_CLOSES.values());

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

export function nyTime(ms: number): string {
	const { minutes } = nyWall(ms);
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function sessionAt(now: number): Session {
	const w = nyWall(now);
	const openAt = w.midnight + OPEN * MINUTE;
	const closeAt = w.midnight + (EARLY_CLOSES.has(w.nyDate) ? EARLY_CLOSE : CLOSE) * MINUTE;
	const phase: Phase = w.weekend || w.minutes < 4 * 60 || w.minutes >= 20 * 60 ? "closed" : now < openAt ? "pre" : now < closeAt ? "regular" : "post";
	const previousSessionMinutes = (AFTER_EARLY_CLOSE.has(w.nyDate) ? EARLY_CLOSE : CLOSE) - OPEN;
	return { nyDate: w.nyDate, weekend: w.weekend, phase, openAt, closeAt, previousSessionMinutes };
}

export function inPollWindow(now: number): boolean {
	const s = sessionAt(now);
	return !s.weekend && now >= s.openAt && now <= s.closeAt + DELAY_GRACE_MS;
}

export function nextPollDelay(now: number, everySeconds: number): number {
	if (inPollWindow(now)) return everySeconds * 1000;
	const s = sessionAt(now);
	return s.phase === "pre" ? Math.min(s.openAt - now, MAX_SLEEP_MS) : MAX_SLEEP_MS;
}
