import { argsOf, ta } from "../../ta.ts";

export default (input: unknown) => ta("screen", { action: "results", limit: 20, ...argsOf(input, { run_id: "number", symbols: "list", limit: "number" }) });
