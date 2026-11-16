import type { ReportStatus, Stage, WorkerState } from "./types.ts";

export interface StageFacts {
	stopped: boolean;
	closed: boolean;
	workerState: WorkerState;
	latestReport: { status: ReportStatus; hasQuestion: boolean } | null;
	userSpokeAfterLatestReport: boolean;
	inputAfterLatestReport: boolean;
	runAsk: "open" | "approved" | null;
	/** The ticket subscribes at least one thread, so more of the source's messages can still reach it. */
	subscribed: boolean;
}

const STAGE_RULES: readonly (readonly [Stage, (f: StageFacts) => boolean])[] = [
	["stopped", (f) => f.stopped],
	["closed", (f) => f.closed],
	["awaiting_answer", (f) => f.runAsk === "open"],
	["running", (f) => f.runAsk === "approved"],
	["awaiting_answer", (f) => f.latestReport?.hasQuestion === true && !f.userSpokeAfterLatestReport],
	["watching", (f) => f.subscribed && f.latestReport?.status === "ready" && !f.inputAfterLatestReport],
	["awaiting_review", (f) => f.latestReport?.status === "ready" && !f.inputAfterLatestReport],
	[
		"blocked_or_failed",
		(f) => (f.latestReport?.status === "blocked" || f.latestReport?.status === "failed") && !f.userSpokeAfterLatestReport,
	],
	["queued", (f) => f.workerState === "none" || f.workerState === "queued"],
	["watching", (f) => f.subscribed && f.workerState === "idle"],
	["idle", (f) => f.workerState === "idle"],
	["running", () => true],
];

export function deriveStage(facts: StageFacts): Stage {
	return STAGE_RULES.find(([, matches]) => matches(facts))![0];
}
