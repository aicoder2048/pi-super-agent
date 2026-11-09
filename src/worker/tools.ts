import type { Basis } from "../kernel/types.ts";

/** Every tool a worker can have: Pi's built-ins and the ones the worker extension registers. */
export const WORKER_TOOLS = [
	"read", "bash", "edit", "write", "grep", "find", "ls",
	"report", "hand_back", "read_ticket", "web_get", "lookup", "bg_start", "bg_status", "bg_stop",
] as const;

const REPORTING_TOOLS = ["report", "hand_back", "read_ticket"] as const;
const INFERENCE_TOOLS = ["read", "grep", "find", "ls", ...REPORTING_TOOLS, "web_get", "lookup"] as const;

/** What the basis allows ∩ the role's tools ∪ the reporting tools; undefined means no limit. A role only narrows. */
export function toolAllowlist(basis: Basis, roleTools?: readonly string[]): readonly string[] | undefined {
	const allowed: readonly string[] | undefined = basis === "inference" ? INFERENCE_TOOLS : undefined;
	if (!roleTools) return allowed;
	const narrowed = allowed ? roleTools.filter((t) => allowed.includes(t)) : roleTools;
	return [...new Set([...narrowed, ...REPORTING_TOOLS])];
}
