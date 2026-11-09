import type { Basis } from "../kernel/types.ts";

const INFERENCE_TOOLS = ["read", "grep", "find", "ls", "report", "hand_back", "read_ticket"] as const;

export function toolAllowlist(basis: Basis): readonly string[] | undefined {
	return basis === "inference" ? INFERENCE_TOOLS : undefined;
}
