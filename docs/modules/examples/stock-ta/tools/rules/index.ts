import { argsOf, ta } from "../../ta.ts";

export default (input: unknown) => ta("rules", argsOf(input, { rule_id: "text" }));
