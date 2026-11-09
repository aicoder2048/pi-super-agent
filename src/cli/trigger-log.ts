import type { Disposition, Trigger } from "../kernel/types.ts";

const BODY_SHOWN = 40;

const WHERE: Record<Disposition, (detail: string | null) => string> = {
	ignored: () => "被程序过滤",
	delivered: () => "直达订阅的任务",
	to_router: () => "等 Router 处理",
	opened_ticket: (d) => `开了任务 ${d ?? ""}`.trim(),
	handed_over: (d) => `转交给 ${d ?? ""}`.trim(),
	router_ignored: (d) => `Router 忽略：${d ?? ""}`,
};

export function formatTriggerLog(triggers: Trigger[]): string {
	return triggers
		.map((t) => {
			const at = new Date(t.receivedAt).toLocaleString("zh-CN", { hour12: false });
			const chars = [...t.body.replace(/\s+/g, " ")];
			const body = chars.length > BODY_SHOWN ? `${chars.slice(0, BODY_SHOWN).join("")}…` : chars.join("");
			return `${at}  ${t.source}  ${WHERE[t.disposition](t.dispositionDetail)}  ${body}`;
		})
		.join("\n");
}
