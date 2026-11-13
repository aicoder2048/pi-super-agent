import { argsOf, ta } from "../../ta.ts";

export default (input: unknown) => ta("structure", argsOf(input, { symbol: "text", timeframe: "timeframe" }));
