import { join } from "node:path";
import { defaultStateDir } from "../host/config.ts";
import { dropTrigger } from "../sources/generic.ts";

const [source, thread, ...body] = process.argv.slice(2);
if (!source || !thread || body.length === 0) throw new Error("用法：just drop <来源> <线程> <正文>");
const inbox = join(defaultStateDir(), "inbox");
const file = dropTrigger(inbox, { source, thread, body: body.join(" "), sender: source });
console.log(`已投递 ${join(inbox, file)}`);
