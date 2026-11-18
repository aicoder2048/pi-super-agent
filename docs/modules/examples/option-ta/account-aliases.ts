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
		// An import replacement whose key the mail feed already owned ends in `:cum<n>:export` (broker-import.ts).
		const m = /^(.*)(:cum\d+(?::export)?)$/.exec(value);
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

/** The registry rows when at least one has an alias. Older installs register none, so every view keeps the stored account. */
export function aliasRegistry(accounts: readonly DbRow[]): DbRow[] {
	const registered = accounts.filter((row) => nonempty(row.account_ref));
	return registered.some((row) => accountAliases(row.aliases).length > 0) ? registered : [];
}

export type AmbiguousAccount = { account_ref: string; candidates: string[] };

/**
 * Read-only grouping view for positions, chains and tax: each row's account, and the account inside its order key and fill id, as
 * the registered name. An unknown account stays as stored. A FILL or EVENT row whose account matches several registered names keeps
 * its stored account, so it is never merged into one of them, and is listed in `ambiguous`. Reversals point at stored ids, so
 * `reversal_of` is never renamed, and a fill id keeps its stored form when it, or its new form, is a reversal target: one
 * reversal never takes out a second row. `renamed` maps each changed fill id from its stored form, for links such as chain legs.
 */
export function alignAccounts(rows: readonly DbRow[], accounts: readonly DbRow[]): { rows: DbRow[]; ambiguous: AmbiguousAccount[]; renamed: Map<string, string> } {
	const registry = aliasRegistry(accounts);
	const renamed = new Map<string, string>();
	if (registry.length === 0) return { rows: [...rows], ambiguous: [], renamed };
	const rekey = (value: unknown) => {
		const m = typeof value === "string" ? /^([^:]+:(?:STO|BTO|BTC|STC):\d{4}-\d{2}-\d{2}:)(.+?)(:cum\d+)?$/.exec(value) : null;
		const resolution = m ? resolveAccount(m[2], registry) : undefined;
		return resolution?.status === "matched" ? m![1] + resolution.account_ref + (m![3] ?? "") : value;
	};
	const reversed = new Set(rows.filter((row) => row.record_type === "REVERSAL").map((row) => row.reversal_of));
	const ambiguous = new Map<string, string[]>();
	const aligned = rows.map((row): DbRow => {
		const resolution = resolveAccount(row.account_ref, registry);
		if (resolution.status === "ambiguous-account" && (row.record_type ?? "FILL") !== "REVERSAL") ambiguous.set(String(row.account_ref), resolution.candidates);
		const out: Record<string, unknown> = { ...row, ...(resolution.status === "matched" && { account_ref: resolution.account_ref }) };
		if ("order_key" in row) out.order_key = rekey(row.order_key);
		const id = rekey(row.fill_id);
		if (typeof id === "string" && id !== row.fill_id && !reversed.has(row.fill_id) && !reversed.has(id)) {
			out.fill_id = id;
			renamed.set(row.fill_id as string, id);
		}
		return out;
	});
	return { rows: aligned, ambiguous: [...ambiguous].sort(([a], [b]) => a.localeCompare(b)).map(([account_ref, candidates]) => ({ account_ref, candidates })), renamed };
}

export const ambiguousNotes = (ambiguous: readonly AmbiguousAccount[]): string[] =>
	ambiguous.map((a) => `待确认账户：${a.account_ref} 对上多个登记账户（${a.candidates.join("、")}），这些行没有合并，按原账户单列，请使用者确认是哪个`);
