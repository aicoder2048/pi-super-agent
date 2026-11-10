import type { Basis } from "../kernel/types.ts";

/** Every tool a member file may list: Pi's built-ins and the ones the worker extension registers. `dispatch_agent` is not listed: only a helper with a crew has it. */
export const WORKER_TOOLS = [
	"read", "bash", "edit", "write", "grep", "find", "ls",
	"report", "hand_back", "read_ticket", "web_get", "lookup", "bg_start", "bg_status", "bg_stop",
] as const;

const READ_TOOLS = ["read", "grep", "find", "ls", "web_get", "lookup"] as const;
const INFERENCE_TOOLS = ["read", "grep", "find", "ls", "report", "hand_back", "read_ticket", "web_get", "lookup"] as const;
/** What a member may use at most: it works and answers, it does not report, hand back, dispatch or outlive its one turn. */
const MEMBER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"] as const;

export function toolAllowlist(basis: Basis, canDispatch = false): readonly string[] | undefined {
	if (basis !== "inference") return undefined;
	return canDispatch ? [...INFERENCE_TOOLS, "dispatch_agent"] : INFERENCE_TOOLS;
}

/** What the ticket's basis allows a member ∩ the member's own `tools` (undefined: no further limit). */
export function memberTools(basis: Basis, own: readonly string[] | undefined): string[] {
	const allowed: readonly string[] = basis === "inference" ? READ_TOOLS : MEMBER_TOOLS;
	return MEMBER_TOOLS.filter((t) => allowed.includes(t) && (!own || own.includes(t)));
}

const CODING_TOOLS: readonly string[] = ["write", "edit", "bash"];

/** A member that can change files or run commands in this ticket does coding work, which gets the long time limit. */
export const canCode = (tools: readonly string[]) => tools.some((t) => CODING_TOOLS.includes(t));
