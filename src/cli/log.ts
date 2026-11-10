import { join } from "node:path";
import { defaultStateDir } from "../host/config.ts";
import { Kernel } from "../kernel/kernel.ts";
import { openStore } from "../kernel/store.ts";
import { formatTriggerLog } from "./trigger-log.ts";

const limit = Number(process.argv[2] ?? 30);
const kernel = new Kernel({ db: openStore(join(defaultStateDir(), "state.db")), clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" });
console.log(formatTriggerLog(kernel.triggerLog(limit).reverse()) || `还没有触发（状态目录 ${defaultStateDir()}）。`);
