import { argsOf, ta } from "../../ta.ts";

export default (input: unknown) => ta("prices", argsOf(input, { symbols: "list" }));
