import type { Basis } from "../kernel/types.ts";

/** Every tool a role file may list: Pi's built-ins and the ones the worker extension registers. `consult` is not listed: leads always get it. */
export const WORKER_TOOLS = [
	"read", "bash", "edit", "write", "grep", "find", "ls",
	"report", "hand_back", "read_ticket", "web_get", "lookup", "bg_start", "bg_status", "bg_stop",
] as const;

const REPORTING_TOOLS = ["report", "hand_back", "read_ticket"] as const;
/** What a consulted expert may use: it answers a question, it does not act. */
export const EXPERT_TOOLS = ["read", "grep", "find", "ls", "web_get", "lookup"] as const;
const INFERENCE_TOOLS = [...EXPERT_TOOLS, ...REPORTING_TOOLS] as const;

/** What the basis allows ∩ the role's tools ∪ the reporting tools (∪ consult for a lead); undefined means no limit. A role only narrows. */
export function toolAllowlist(basis: Basis, roleTools?: readonly string[], lead = false): readonly string[] | undefined {
	const allowed: readonly string[] | undefined = basis === "inference" ? INFERENCE_TOOLS : undefined;
	const list = roleTools ? [...new Set([...(allowed ? roleTools.filter((t) => allowed.includes(t)) : roleTools), ...REPORTING_TOOLS])] : allowed;
	return list && lead ? [...list, "consult"] : list;
}

/** The read-only tools ∩ the expert role's tools. Never consult, never a reporting tool. */
export function expertTools(roleTools?: readonly string[]): string[] {
	return EXPERT_TOOLS.filter((t) => !roleTools || roleTools.includes(t));
}
