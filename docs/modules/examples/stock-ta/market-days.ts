/** The session clock is a copy of src/sources/market/session.ts (module code cannot import the host's); tests/market-hours.test.ts keeps the two equal. */
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

// NYSE full-day closures as published on nyse.com/markets/hours-calendars, the same horizon as the early closes above.
const HOLIDAYS = new Set([
	"2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
	"2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
	"2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
	"2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);

const DAY_MS = 86_400_000;
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const weekday = (date: string) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
export const isTradingDay = (date: string) => weekday(date) && !HOLIDAYS.has(date);

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

/** The regular session's closing moment on the New York date that holds `ms`: 16:00, or 13:00 on an early-close day. */
export function regularCloseAt(ms: number): number {
	const w = nyWall(ms);
	return w.midnight + (EARLY_CLOSES.has(w.nyDate) ? EARLY_CLOSE : CLOSE) * MINUTE;
}

/** The regular session's opening moment, 9:30, on the New York date that holds `ms`. */
export const regularOpenAt = (ms: number): number => nyWall(ms).midnight + OPEN * MINUTE;

export function sessionAt(now: number): Session {
	const w = nyWall(now);
	const openAt = w.midnight + OPEN * MINUTE;
	const closeAt = regularCloseAt(now);
	const phase: Phase = w.weekend || w.minutes < 4 * 60 || w.minutes >= 20 * 60 ? "closed" : now < openAt ? "pre" : now < closeAt ? "regular" : "post";
	return { nyDate: w.nyDate, phase };
}
