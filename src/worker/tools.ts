import type { Basis, Opener } from "../kernel/types.ts";

/** Every tool a helper can have: Pi's built-ins and the ones the worker extension registers for it. */
export const WORKER_TOOLS = [
	"read", "bash", "edit", "write", "grep", "find", "ls",
	"report", "hand_back", "read_ticket", "web_get", "lookup", "tripwire", "new_app", "bg_start", "bg_status", "bg_stop", "dispatch_agent", "domain_tool", "knowledge", "data", "watch",
] as const;

const READ_TOOLS = ["read", "grep", "find", "ls", "web_get", "lookup"] as const;
const INFERENCE_TOOLS = ["read", "grep", "find", "ls", "report", "hand_back", "read_ticket", "web_get", "lookup", "domain_tool", "knowledge", "data", "watch"] as const;
/**
 * Every tool a member file may list, and so the most a member can use: it works and answers, it does
 * not report, hand back, read the ticket, dispatch or outlive its one turn. A member file that lists
 * any other tool is rejected at load.
 */
export const MEMBER_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"];

/** What a ticket's helper and members may use: its basis, except that a ticket a module feed opened gets the tightest one (ADR-0018). */
export type Profile = Basis | "module-feed";

export const profileOf = (basis: Basis, opener: Opener): Profile => (opener === "module-feed" ? "module-feed" : basis);

const FEED_TOOLS = INFERENCE_TOOLS.filter((t) => t !== "web_get");
const FEED_MEMBER_TOOLS = READ_TOOLS.filter((t) => t !== "web_get");

/**
 * Per profile: the helper's tools and why one off the list is refused (no list: no limit, and reads go anywhere),
 * and what a member may have. A profile with a list also keeps reads inside the ticket's read roots.
 */
const PROFILES: Record<Profile, { helper?: { tools: readonly string[]; refusal: (tool: string) => string }; member: readonly string[] }> = {
	request: { member: MEMBER_TOOLS },
	rule: { member: MEMBER_TOOLS },
	inference: { helper: { tools: INFERENCE_TOOLS, refusal: (tool) => `依据为推断的任务只能读文件、读网页、查数据和汇报，不能用 ${tool}。需要对外动作时写成草稿，用 report 的 drafts 提交。` }, member: READ_TOOLS },
	"module-feed": { helper: { tools: FEED_TOOLS, refusal: (tool) => `来源开的任务不能用 ${tool}。要运行命令，在汇报里请使用者在对话里提出。` }, member: FEED_MEMBER_TOOLS },
};

/** The Pi tools whose `path` a rooted profile checks against the read roots. */
export const PATH_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export const isRooted = (profile: Profile) => PROFILES[profile].helper !== undefined;

/** Why the helper of a rooted profile may not use `tool`. */
export const helperRefusal = (profile: Profile, tool: string) => PROFILES[profile].helper!.refusal(tool);

/** For a rooted helper's prompt: Pi answers a call to a tool off the list with only "Tool X not found", so the reason goes up front. */
export function helperLimits(profile: Profile): string | undefined {
	const helper = PROFILES[profile].helper;
	return helper?.refusal(WORKER_TOOLS.filter((t) => t !== "dispatch_agent" && !helper.tools.includes(t)).join("、"));
}

export function toolAllowlist(profile: Profile, canDispatch = false): readonly string[] | undefined {
	const tools = PROFILES[profile].helper?.tools;
	return tools && canDispatch ? [...tools, "dispatch_agent"] : tools;
}

/** What the ticket's profile allows a member ∩ the member's own `tools` (undefined: no further limit). */
export function memberTools(profile: Profile, own: readonly string[] | undefined): string[] {
	const allowed = PROFILES[profile].member;
	return MEMBER_TOOLS.filter((t) => allowed.includes(t) && (!own || own.includes(t)));
}

export const DOMAIN_GATED_TOOLS = ["lookup", "tripwire"] as const;
export type DomainGatedTool = (typeof DOMAIN_GATED_TOOLS)[number];

const CODING_TOOLS: readonly string[] = ["write", "edit", "bash"];

export const canCode = (tools: readonly string[]) => tools.some((t) => CODING_TOOLS.includes(t));

/** The custom entry a member's session gets at the start of each dispatch; its data is `{ callId }`, the helper's tool call. */
export const DISPATCH_MARK = "psa-dispatch";
