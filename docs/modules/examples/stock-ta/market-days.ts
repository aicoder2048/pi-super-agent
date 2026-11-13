/**
 * A copy of src/sources/market/session.ts (module code cannot import the host's). tests/market-hours.test.ts
 * checks the two agree, so a new early close goes into both tables.
 */
export type Phase = "pre" | "regular" | "post" | "closed";

export interface Session {
	nyDate: string;
	phase: Phase;
}

const MINUTE = 60_000;
const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const EARLY_CLOSE = 13 * 60;
// NYSE 1:00 p.m. early closes as published on nyse.com/markets/hours-calendars.
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]);

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

export function nyTime(ms: number): string {
	const { minutes } = nyWall(ms);
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function sessionAt(now: number): Session {
	const w = nyWall(now);
	const openAt = w.midnight + OPEN * MINUTE;
	const closeAt = w.midnight + (EARLY_CLOSES.has(w.nyDate) ? EARLY_CLOSE : CLOSE) * MINUTE;
	const phase: Phase = w.weekend || w.minutes < 4 * 60 || w.minutes >= 20 * 60 ? "closed" : now < openAt ? "pre" : now < closeAt ? "regular" : "post";
	return { nyDate: w.nyDate, phase };
}
