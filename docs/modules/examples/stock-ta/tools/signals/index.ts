import { argsOf, ta } from "../../ta.ts";

/** The first scan backfills two years of signals, all unread, so ta's read flag says nothing about what is new. */
export default (input: unknown) => {
	const out = ta("signals", { limit: 20, ...argsOf(input, { symbol: "text", rule_id: "text", timeframe: "timeframe", direction: "text", attention: "list", start: "text", end: "text", limit: "number" }) });
	if (Array.isArray(out["signals"])) out["signals"] = out["signals"].map((row) => (row !== null && typeof row === "object" && !Array.isArray(row) ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== "read")) : row));
	return out;
};
