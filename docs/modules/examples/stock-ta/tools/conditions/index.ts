import { argsOf, ta } from "../../ta.ts";

export default (input: unknown) => ta("conditions", argsOf(input, { symbol: "text" }));
