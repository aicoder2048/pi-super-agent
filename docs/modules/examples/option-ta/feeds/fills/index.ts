import { parseFills, type FillLetter, type FillRow, type StoredRow } from "./parse.ts";

type Input = { items: unknown[]; rows?: { fills?: StoredRow[] } };
type Notice = { id: string; thread: string; fields: { letter: string; count: string; reasons: string } };

/** Only these need the user; working orders, unfilled orders, stock lines and partial fills do not (spec「一行算不算成交」). */
const LOUD = new Set(["unparsed", "duplicate-order-key"]);

const isLetter = (item: unknown): item is FillLetter => typeof item === "object" && item !== null && typeof (item as FillLetter).id === "string" && (item as FillLetter).id !== "";

export default function fills(input: Input): { records: FillRow[]; notices: Notice[] } {
	const recorded = input.rows?.fills ?? [];
	const records: FillRow[] = [];
	const notices: Notice[] = [];
	for (const item of input.items) {
		if (!isLetter(item)) throw new Error("成交邮件的信缺 id，这封信没有入账");
		const { fills: rows, skipped } = parseFills(item, recorded);
		records.push(...rows);
		const loud = skipped.filter((s) => LOUD.has(s.reason));
		if (loud.length === 0) continue;
		const counts = [...new Set(loud.map((s) => s.reason))].sort().map((reason) => `${reason} ${loud.filter((s) => s.reason === reason).length} 行`);
		notices.push({ id: `${item.id}:skipped`, thread: item.threadId || item.id, fields: { letter: item.id, count: String(loud.length), reasons: counts.join("、") } });
	}
	return { records, notices };
}
