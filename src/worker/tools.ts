import type { Basis } from "../kernel/types.ts";

// The inference profile has no tool that runs code, writes files or reaches the network, so
// "inference tickets never act externally" holds by construction instead of by a blocklist.
export const INFERENCE_TOOLS = ["read", "grep", "find", "ls", "report", "hand_back", "read_ticket"] as const;

export function toolAllowlist(basis: Basis): readonly string[] | undefined {
	return basis === "inference" ? INFERENCE_TOOLS : undefined;
}
