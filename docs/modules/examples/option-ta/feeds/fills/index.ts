import { aliasRegistry, resolveAccount } from "../../account-aliases.ts";
import { parseFills, type FillLetter, type FillRow, type StoredRow } from "./parse.ts";

type Input = { items: unknown[]; rows?: { fills?: StoredRow[]; accounts?: StoredRow[] } };
type Notice = { id: string; thread: string; fields: { letter: string; count: string; reasons: string } };

/** Only these need the user; working orders, unfilled orders, stock lines and partial fills do not (spec「一行算不算成交」). */
const LOUD = new Set(["unparsed", "duplicate-order-key", "ambiguous-account"]);

const isLetter = (item: unknown): item is FillLetter => typeof item === "object" && item !== null && typeof (item as FillLetter).id === "string" && (item as FillLetter).id !== "";

export default function fills(input: Input): { records: FillRow[]; notices: Notice[] } {
	const recorded = [...(input.rows?.fills ?? [])];
	const records: FillRow[] = [];
	const notices: Notice[] = [];
	const accounts = (input.rows?.accounts ?? []).map((row) => row.fields);
	const registry = aliasRegistry(accounts);
	for (const item of input.items) {
		if (!isLetter(item)) throw new Error("成交邮件的信缺 id，这封信没有入账");
		const { fills: rows, skipped } = parseFills(item, recorded, accounts);
		const unknown = registry.length === 0 ? [] : rows.filter((row) => resolveAccount(row.account_ref, registry).status === "unknown-account");
		records.push(...rows);
		recorded.push(...rows.map(({ id, ...fields }) => ({ id, from: "this-batch", fields })));
		const loud = skipped.filter((s) => LOUD.has(s.reason));
		if (loud.length === 0 && unknown.length === 0) continue;
		const counts = [...new Set(loud.map((s) => s.reason))].sort().map((reason) => `${reason} ${loud.filter((s) => s.reason === reason).length} 行`);
		const reasons = [
			...(counts.length > 0 ? [`${counts.join("、")}没有入账`] : []),
			...(unknown.length > 0 ? [`unknown-account ${unknown.length} 行按邮件短码入账了，问是新账户还是别名漏登记`] : []),
		];
		notices.push({ id: `${item.id}:skipped`, thread: item.threadId || item.id, fields: { letter: item.id, count: String(loud.length + unknown.length), reasons: reasons.join("；") } });
	}
	return { records, notices };
}
