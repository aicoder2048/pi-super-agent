import { argsOf, ta } from "../../ta.ts";

export default (input: unknown) =>
	ta("signals", { limit: 20, ...argsOf(input, { symbol: "text", rule_id: "text", timeframe: "text", direction: "text", attention: "list", start: "text", end: "text", limit: "number" }) });
