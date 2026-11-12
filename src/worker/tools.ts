import type { Basis } from "../kernel/types.ts";

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

export function toolAllowlist(basis: Basis, canDispatch = false): readonly string[] | undefined {
	if (basis !== "inference") return undefined;
	return canDispatch ? [...INFERENCE_TOOLS, "dispatch_agent"] : INFERENCE_TOOLS;
}

/** What the ticket's basis allows a member ∩ the member's own `tools` (undefined: no further limit). */
export function memberTools(basis: Basis, own: readonly string[] | undefined): string[] {
	const allowed: readonly string[] = basis === "inference" ? READ_TOOLS : MEMBER_TOOLS;
	return MEMBER_TOOLS.filter((t) => allowed.includes(t) && (!own || own.includes(t)));
}

export const DOMAIN_GATED_TOOLS = ["lookup", "tripwire"] as const;
export type DomainGatedTool = (typeof DOMAIN_GATED_TOOLS)[number];

const CODING_TOOLS: readonly string[] = ["write", "edit", "bash"];

export const canCode = (tools: readonly string[]) => tools.some((t) => CODING_TOOLS.includes(t));

/** The custom entry a member's session gets at the start of each dispatch; its data is `{ callId }`, the helper's tool call. */
export const DISPATCH_MARK = "psa-dispatch";
