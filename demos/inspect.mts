import { join } from "node:path";
import { pathToFileURL } from "node:url";

const wt = process.cwd();
const { Kernel } = await import(pathToFileURL(join(wt, "src/kernel/kernel.ts")).href);
const { openStore } = await import(pathToFileURL(join(wt, "src/kernel/store.ts")).href);
const kernel = new Kernel({ db: openStore(join(process.env.PSA_STATE_DIR!, "state.db")), clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" });
const tickets = kernel.listTickets().map((r: any) => {
	const t = kernel.getTicket(r.id);
	const read = kernel.read(r.id);
	return {
		id: r.id, title: r.title, stage: r.stage, basis: r.basis, ruleId: t?.ruleId ?? null, toolCalls: r.toolCalls,
		latest: r.latestSummary, threads: read?.type === "ticket" ? read.threadIds : [],
		inputs: read?.type === "ticket" ? read.recentInputs.map((i: any) => ({ kind: i.kind, triggerId: i.triggerId, body: i.body.slice(0, 120) })) : [],
	};
});
const triggers = kernel.triggerLog(100).reverse().map((t: any) => ({ id: t.id, source: t.source, disposition: t.disposition, detail: t.dispositionDetail, body: t.body.slice(0, 120), receivedAt: t.receivedAt }));
const conversation = kernel.conversation(50).map((m: any) => ({ who: m.who, text: m.text, at: m.at }));
const decisions = kernel.decisionLog(50).map((d: any) => ({ kind: d.decision.kind, ok: d.ok, reason: d.reason, ticketId: d.ticketId, decision: d.decision }));
console.log(JSON.stringify({ tickets, triggers, conversation, decisions, today: kernel.triggerCountsToday() }));
