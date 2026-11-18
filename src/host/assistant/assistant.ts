/**
 * The web page's AI assistant (ADR-0033). Questions and answers live in state.db, so every page sees the same; each explainer
 * has its own model session, asked one question at a time. An answer streams to the web page as it grows.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AssistantLine } from "../../client/protocol.ts";
import { questionCard, type Asked, type Expert } from "./prompt.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS assistant_lines (
	id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
	at INTEGER NOT NULL,
	expert TEXT NOT NULL,
	text TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('streaming', 'done', 'failed')),
	about TEXT
)`;

/** How many lines the page gets in its snapshot. */
export const ASSISTANT_LINES = 60;
const PUBLISH_EVERY_MS = 150;
const ABOUT_TEXT_CHARS = 120;

type AssistantEvent = { type: string; message?: { role?: string; content?: unknown } };
export type AssistantSessionLike = { prompt(text: string): Promise<void>; subscribe(listener: (event: AssistantEvent) => void): () => void; readonly messages: readonly unknown[]; dispose?(): void };
export type AssistantFrame = { type: "assistant"; line: AssistantLine } | { type: "assistant_cleared" };

export interface AssistantPorts {
	db: DatabaseSync;
	/** `fresh`: start over, as after 清空. */
	open(expert: Expert, fresh: boolean): Promise<AssistantSessionLike>;
	publish(frame: AssistantFrame): void;
	log(line: string): void;
	now(): number;
	/** Deletes the explainers' session files, so a host restarted after 清空 does not continue the old sessions. */
	forget?(): void;
}

type Row = { id: string; role: AssistantLine["role"]; at: number; expert: string; text: string; state: AssistantLine["state"]; about: string | null };

function textOf(message: { content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => String(c.text)).join("") : "";
}

const failedText = (reason: string) => `简报官这次没答上来（${reason.slice(0, 120)}），请稍后再问一次。`;
const INTERRUPTED = "宿主重启了，这个回答中断了，请再问一次。";

export class Assistant {
	readonly #o: AssistantPorts;
	readonly #sessions = new Map<string, Promise<AssistantSessionLike>>();
	readonly #queues = new Map<string, Promise<void>>();
	/** Explainers whose next session starts over: every one after 清空. */
	#fresh = false;
	#epoch = 0;

	constructor(ports: AssistantPorts) {
		this.#o = ports;
		ports.db.exec(SCHEMA);
		// An answer the last host was still writing never finishes: say so instead of 「正在想」 forever.
		ports.db.prepare("UPDATE assistant_lines SET state = 'failed', text = ? WHERE state = 'streaming'").run(INTERRUPTED);
	}

	lines(limit = ASSISTANT_LINES): AssistantLine[] {
		const rows = this.#o.db.prepare("SELECT id, role, at, expert, text, state, about FROM assistant_lines ORDER BY seq DESC LIMIT ?").all(limit) as Row[];
		return rows.reverse().map(({ about, ...row }) => ({ ...row, ...(about !== null && { about: JSON.parse(about) as AssistantLine["about"] }) }));
	}

	/** Returns the id of the answer line. The answer arrives later, as `assistant` frames. */
	ask(asked: Asked, expert: Expert): string {
		const about = asked.line && { ...(asked.picked && { picked: asked.picked }), text: [...asked.line.text].slice(0, ABOUT_TEXT_CHARS).join("") };
		this.#save({ id: randomUUID(), role: "user", at: this.#o.now(), expert: expert.name, text: asked.question, state: "done", ...(about && { about }) });
		const answer: AssistantLine = { id: randomUUID(), role: "assistant", at: this.#o.now(), expert: expert.name, text: "", state: "streaming" };
		this.#save(answer);
		const epoch = this.#epoch;
		const before = this.#queues.get(expert.key) ?? Promise.resolve();
		const run = before.then(() => this.#answer(answer, questionCard(asked), expert, epoch));
		this.#queues.set(expert.key, run);
		return answer.id;
	}

	clear(): void {
		this.#epoch++;
		this.#o.db.exec("DELETE FROM assistant_lines");
		this.#closeSessions();
		this.#queues.clear();
		this.#fresh = true;
		this.#o.forget?.();
		this.#o.publish({ type: "assistant_cleared" });
	}

	/** The host is stopping. */
	async close(): Promise<void> {
		this.#epoch++;
		await Promise.allSettled([...this.#sessions.values()].map((s) => s.then((session) => session.dispose?.())));
		this.#sessions.clear();
	}

	#closeSessions(): void {
		for (const session of this.#sessions.values()) session.then((s) => s.dispose?.(), () => {});
		this.#sessions.clear();
	}

	#session(expert: Expert): Promise<AssistantSessionLike> {
		let session = this.#sessions.get(expert.key);
		if (session === undefined) {
			const opening = this.#o.open(expert, this.#fresh);
			session = opening;
			this.#sessions.set(expert.key, opening);
			// A session that failed to open is not kept, so the next question tries again.
			opening.catch(() => this.#sessions.get(expert.key) === opening && this.#sessions.delete(expert.key));
		}
		return session;
	}

	async #answer(line: AssistantLine, card: string, expert: Expert, epoch: number): Promise<void> {
		const live = () => epoch === this.#epoch;
		// Queued before a 清空: the question is gone, and the session it would run in now belongs to a later question.
		if (!live()) return;
		let lastPublish = 0;
		let unsubscribe = () => {};
		try {
			const session = await this.#session(expert);
			unsubscribe = session.subscribe((event) => {
				if (event.type !== "message_update" || event.message?.role !== "assistant" || !live()) return;
				line.text = textOf(event.message);
				const now = this.#o.now();
				if (now - lastPublish < PUBLISH_EVERY_MS) return;
				lastPublish = now;
				this.#o.publish({ type: "assistant", line: { ...line } });
			});
			await session.prompt(card);
			const last = session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
			if (last?.role === "assistant" && last.stopReason === "error") throw new Error(String(last.errorMessage ?? "模型出错"));
			line.text = textOf(last).trim() || "（没有回答）";
			line.state = "done";
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.#o.log(`[assistant] ${expert.key} 回答失败：${reason}`);
			line.text = failedText(reason);
			line.state = "failed";
		} finally {
			unsubscribe();
		}
		if (live()) this.#save(line);
	}

	#save(line: AssistantLine): void {
		this.#o.db
			.prepare("INSERT INTO assistant_lines (id, seq, role, at, expert, text, state, about) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM assistant_lines), ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET text = excluded.text, state = excluded.state")
			.run(line.id, line.role, line.at, line.expert, line.text, line.state, line.about ? JSON.stringify(line.about) : null);
		this.#o.publish({ type: "assistant", line: { ...line } });
	}
}
