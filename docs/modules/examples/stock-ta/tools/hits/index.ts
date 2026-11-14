import { existsSync, readdirSync } from "node:fs";
import { hitsRoot, readHits } from "../../hits.ts";

const MAX_DAYS = 10;
const MAX_HITS = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default (input: unknown) => {
	const given = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(given["days"] ?? 1)) || 1));
	const symbol = String(given["symbol"] ?? "").trim().toUpperCase().replaceAll(".", "-");
	const minLevel = Number(given["minLevel"] ?? 0) || 0;
	const dataDir = process.env["PSA_MODULE_DATA"] ?? "";
	const root = hitsRoot(dataDir);
	const dates = existsSync(root) ? readdirSync(root).filter((d) => DATE.test(d)).sort().reverse().slice(0, days) : [];
	const hits = dates.flatMap((date) => readHits(dataDir, date))
		.filter((h) => (symbol === "" || h.symbol === symbol) && h.level >= minLevel)
		.sort((a, b) => b.at.localeCompare(a.at));
	return { hits: hits.slice(0, MAX_HITS), dates, truncated: hits.length > MAX_HITS };
};
