// POLYGON_API_KEY=… node docs/modules/evidence/p2-measure-fetch.ts <dir> <from> <to>
// Fetches unadjusted minute aggregates for the eight stocks, SPY, QQQ and VIXY, and VIXY's daily aggregates, into <dir>/min/.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STOCKS } from "./p2-measure-data.ts";

const [dir = "/tmp/p2m", from = "2025-10-01", to = "2026-11-13"] = process.argv.slice(2);
const key = process.env["POLYGON_API_KEY"] ?? "";
if (key === "") throw new Error("set POLYGON_API_KEY");
mkdirSync(join(dir, "min"), { recursive: true });

async function fetchAll(symbol: string, span: "minute" | "day", start: string): Promise<void> {
	const out = join(dir, "min", `${symbol}-${span}-${start}-${to}.json`);
	if (existsSync(out)) return;
	let url: string | null = `https://api.massive.com/v2/aggs/ticker/${symbol}/range/1/${span}/${start}/${to}?adjusted=false&sort=asc&limit=50000`;
	const rows: number[][] = [];
	while (url !== null) {
		const reply = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
		if (!reply.ok) throw new Error(`${symbol} HTTP ${reply.status}`);
		const body = (await reply.json()) as { results?: { t: number; o: number; h: number; l: number; c: number; v: number }[]; next_url?: string };
		for (const b of body.results ?? []) rows.push([b.t, b.o, b.h, b.l, b.c, b.v]);
		url = body.next_url ?? null;
	}
	writeFileSync(out, JSON.stringify(rows));
	console.log(symbol, span, rows.length);
}

await Promise.all([...STOCKS, "SPY", "QQQ", "VIXY"].map((s) => fetchAll(s, "minute", from)));
await fetchAll("VIXY", "day", "2024-11-01");
