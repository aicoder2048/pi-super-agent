/** Exact, source-scoped private account aliases. No fuzzy matching, suffix matching or account creation. */
import type { DbRow } from "./data-db.ts";

export type AccountAlias =
	| { kind: "email"; code: string }
	| { kind: "jpm-export"; account_name: string; account_type: string; account_number: string }
	| { kind: "etrade-export"; account_label: string };
export type AccountResolution = { status: "matched"; account_ref: string } | { status: "ambiguous-account" | "unknown-account"; candidates: string[] };
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim().length > 0;

/** Invalid JSON/entries grant no matches. Numbers must stay strings (including leading zeros). */
export function accountAliases(value: unknown): AccountAlias[] {
	if (typeof value !== "string") return [];
	try {
		const entries: unknown = JSON.parse(value);
		return Array.isArray(entries) ? entries.filter(validAlias) : [];
	} catch { return []; }
}
function validAlias(value: unknown): value is AccountAlias {
	if (value === null || typeof value !== "object") return false;
	const a = value as Record<string, unknown>;
	return (a.kind === "email" && nonempty(a.code)) ||
		(a.kind === "jpm-export" && nonempty(a.account_name) && nonempty(a.account_type) && nonempty(a.account_number)) ||
		(a.kind === "etrade-export" && nonempty(a.account_label));
}
function sameAlias(a: AccountAlias, b: AccountAlias): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "email" && b.kind === "email") return a.code === b.code;
	if (a.kind === "etrade-export" && b.kind === "etrade-export") return a.account_label === b.account_label;
	return a.kind === "jpm-export" && b.kind === "jpm-export" && a.account_name === b.account_name && a.account_type === b.account_type && a.account_number === b.account_number;
}

/** A plain string matches a registered name or email code; structured input never falls back to a partial/name match. */
export function resolveAccount(value: unknown, accounts: readonly DbRow[]): AccountResolution {
	let query = value;
	if (typeof query === "string" && query.trim().startsWith("{")) {
		try { query = JSON.parse(query); } catch { return { status: "unknown-account", candidates: [] }; }
	}
	const candidates = [...new Set(accounts.filter((row) => {
		if (!nonempty(row.account_ref)) return false;
		const aliases = accountAliases(row.aliases);
		return typeof query === "string"
			? row.account_ref === query || aliases.some((a) => a.kind === "email" && a.code === query)
			: validAlias(query) && aliases.some((a) => sameAlias(a, query as AccountAlias));
	}).map((row) => row.account_ref as string))].sort();
	return candidates.length === 1 ? { status: "matched", account_ref: candidates[0]! } : { status: candidates.length > 1 ? "ambiguous-account" : "unknown-account", candidates };
}

/** Read-only compatibility view: never rewrites stored mail short codes or identifiers. */
export function alignHistoricalAccounts(fills: readonly DbRow[], accounts: readonly DbRow[], targetKey: string): { rows: DbRow[]; ambiguous: boolean; reversed: boolean } {
	const keyPattern = /^([^:]+:(?:STO|BTO|BTC|STC):\d{4}-\d{2}-\d{2}:)(.+)$/;
	const targetPrefix = targetKey.match(keyPattern)?.[1];
	const targetAccount = targetKey.match(keyPattern)?.[2];
	let ambiguous = false;
	const keyView = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const m = keyPattern.exec(value);
		if (!m) return undefined;
		const resolution = resolveAccount(m[2], accounts);
		if (resolution.status === "matched") return m[1] + resolution.account_ref;
		if (m[1] === targetPrefix && resolution.candidates.includes(targetAccount!)) ambiguous = true;
		return undefined;
	};
	const idView = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const m = /^(.*)(:cum\d+)$/.exec(value);
		const key = keyView(m ? m[1] : value);
		return key === undefined ? undefined : key + (m ? m[2] : "");
	};
	let reversed = false;
	const rows = fills.map((row): DbRow => {
		const key = keyView(row.order_key);
		const id = idView(row.fill_id);
		const reversal = idView(row.reversal_of);
		// A reversal can omit order_key: its target alone is sufficient to stop automatic recording.
		if (row.record_type === "REVERSAL" && (key === targetKey || reversal === targetKey || reversal?.startsWith(targetKey + ":cum"))) reversed = true;
		if (key === undefined) {
			const rawKey = typeof row.order_key === "string" ? keyPattern.exec(row.order_key) : null;
			const ref = resolveAccount(row.account_ref, accounts);
			const factPrefix = `${row.option_symbol}:${row.side}:${row.trade_date}:`;
			if (id?.startsWith(targetKey + ":cum") ||
				((rawKey?.[1] === targetPrefix || factPrefix === targetPrefix) &&
					(ref.status === "matched" ? ref.account_ref === targetAccount : ref.candidates.includes(targetAccount!)))) ambiguous = true;
			return row;
		}
		const ref = resolveAccount(row.account_ref, accounts);
		const account = key.match(keyPattern)![2]!;
		if (ref.status !== "matched" || ref.account_ref !== account || (row.fill_id != null && row.fill_id !== "" && (id === undefined || !id.startsWith(key + ":cum")))) {
			if (key === targetKey || (ref.status === "matched" && ref.account_ref === targetAccount && key.startsWith(targetPrefix!))) ambiguous = true;
			return row;
		}
		return { ...row, account_ref: account, order_key: key, ...(id === undefined ? {} : { fill_id: id }), ...(reversal === undefined ? {} : { reversal_of: reversal }) };
	});
	// Also respect explicit links to a stored fact ID/row ID, not only synthesized :cum IDs.
	const targetIds = new Set(fills.flatMap((row, index) => rows[index]?.order_key === targetKey ? [row.fill_id, row._id].filter((id) => id != null && id !== "").map(String) : []));
	if (fills.some((row) => row.record_type === "REVERSAL" && row.reversal_of != null && targetIds.has(String(row.reversal_of)))) reversed = true;
	return { rows, ambiguous, reversed };
}
