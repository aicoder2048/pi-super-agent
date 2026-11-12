import { argsOf, ta } from "../../ta.ts";

export default (input: unknown) => {
	const note = ta("note", argsOf(input, { source: "text" }));
	delete note["path"];
	return note;
};
