/** One model session per explainer (ADR-0033): no tools, its own system prompt, its own session files. */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, type ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { emptyResources } from "../router.ts";
import type { AssistantSessionLike } from "./assistant.ts";
import { assistantSystemPrompt, type Expert } from "./prompt.ts";

export type AssistantSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Model = NonNullable<Parameters<typeof createAgentSession>[0]>["model"];

export type SessionOptions = { modelRuntime: ModelRuntime; model: () => Model; stateDir: string; retry?: { maxRetries?: number; baseDelayMs?: number } };

/** `fresh`: start over, as after 清空简报官; otherwise continue the explainer's last session. */
/**
 * Follows the Router's model selector: before each question the session moves to the model the selector picks now, so a fallback
 * (or the way back) reaches the briefer too.
 */
export async function openAssistantSession(options: SessionOptions, expert: Expert, fresh: boolean): Promise<AssistantSessionLike> {
	const session = await openSession(options, expert, fresh);
	return {
		get messages() {
			return session.messages;
		},
		subscribe: (listener) => session.subscribe(listener as never),
		async prompt(text) {
			const want = options.model();
			if (session.model?.provider !== want.provider || session.model?.id !== want.id) await session.setModel(want);
			await session.prompt(text);
		},
		dispose: () => session.dispose(),
	};
}

/** Deletes every briefer's session files (after 清空). */
export const forgetAssistantSessions = (stateDir: string) => rmSync(join(stateDir, "sessions", "assistant"), { recursive: true, force: true });

async function openSession({ modelRuntime, model, stateDir, retry }: SessionOptions, expert: Expert, fresh: boolean): Promise<AssistantSession> {
	const dir = join(stateDir, "sessions", "assistant", expert.key);
	const cwd = join(stateDir, "assistant");
	const { session } = await createAgentSession({
		cwd,
		model: model(),
		modelRuntime,
		resourceLoader: emptyResources(assistantSystemPrompt(expert)),
		tools: [],
		customTools: [],
		sessionManager: fresh ? SessionManager.create(cwd, dir) : SessionManager.continueRecent(cwd, dir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2, ...retry } }),
	});
	return session;
}
