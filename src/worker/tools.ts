import type { Basis } from "../kernel/types.ts";

/** Every tool a worker can have: Pi's built-ins and the ones the worker extension registers. */
export const WORKER_TOOLS = [
	"read", "bash", "edit", "write", "grep", "find", "ls",
	"report", "hand_back", "read_ticket", "web_get", "lookup", "bg_start", "bg_status", "bg_stop",
] as const;

const INFERENCE_TOOLS = ["read", "grep", "find", "ls", "report", "hand_back", "read_ticket", "web_get", "lookup"] as const;

export function toolAllowlist(basis: Basis): readonly string[] | undefined {
	return basis === "inference" ? INFERENCE_TOOLS : undefined;
}
