import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantLine } from "../../src/client/protocol.ts";
import { Assistant, type AssistantSessionLike } from "../../src/host/assistant/assistant.ts";
import type { Expert } from "../../src/host/assistant/prompt.ts";
import { openStore } from "../../src/kernel/store.ts";
import { until } from "../helpers/fakes.ts";

const EXPERT: Expert = { key: "option-ta", name: "期权研究组简报官", about: "期权", background: "" };

/** A session whose answers the test releases one at a time, and which, like Pi's, refuses a prompt while it is busy. */
function fakeSession(name: string, log: string[]) {
	const messages: { role: string; content: string }[] = [];
	let busy = false;
	let release: (() => void) | undefined;
	const listeners = new Set<(e: { type: string; message?: { role?: string; content?: unknown } }) => void>();
	const session: AssistantSessionLike & { release(): void; disposed: boolean } = {
		messages,
		disposed: false,
		subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
		async prompt(text: string) {
			if (busy) throw new Error("Agent is already processing");
			busy = true;
			log.push(`${name}:${text.split("\n").at(-1)}`);
			messages.push({ role: "user", content: text });
			await new Promise<void>((done) => (release = done));
			messages.push({ role: "assistant", content: `${name} 答` });
			busy = false;
		},
		release: () => release?.(),
		dispose() {
			this.disposed = true;
		},
	};
	return session;
}

function world(open: (fresh: boolean) => Promise<AssistantSessionLike>) {
	const db = openStore(":memory:");
	const published: unknown[] = [];
	const make = () => new Assistant({ db, open: (_e, fresh) => open(fresh), publish: (m) => published.push(m), log: () => {}, now: () => Date.now() });
	return { db, make, assistant: make(), published };
}
const answers = (a: Assistant) => a.lines().filter((l) => l.role === "assistant");

test("会话打开失败：这一问标失败；下一问重新打开，不一直失败", async () => {
	let opens = 0;
	const log: string[] = [];
	const { assistant } = world(async () => {
		opens++;
		if (opens === 1) throw new Error("模型找不到");
		const s = fakeSession("s", log);
		queueMicrotask(() => setTimeout(() => s.release(), 5));
		return s;
	});
	assistant.ask({ question: "一" }, EXPERT);
	await until(() => answers(assistant).at(-1)?.state === "failed" || undefined, "第一问失败");
	assistant.ask({ question: "二" }, EXPERT);
	await until(() => answers(assistant).at(-1)?.state === "done" || undefined, "第二问答上");
	assert.equal(opens, 2);
});

test("宿主在回答中途重启：那条回答标成中断，不一直显示「正在想」", async () => {
	const log: string[] = [];
	const { make, assistant } = world(async () => fakeSession("s", log));
	assistant.ask({ question: "一" }, EXPERT);
	await until(() => log.length === 1 || undefined, "开始答");
	const restarted = make();
	const last = answers(restarted).at(-1)!;
	assert.equal(last.state, "failed");
	assert.match(last.text, /中断/);
});

test("清空时还排着的问题不再去答，也不会撞进清空后新开的会话；旧会话关掉", async () => {
	const log: string[] = [];
	const sessions: ReturnType<typeof fakeSession>[] = [];
	const { assistant } = world(async (fresh) => {
		const s = fakeSession(fresh ? "新" : "旧", log);
		sessions.push(s);
		return s;
	});
	assistant.ask({ question: "Q1" }, EXPERT);
	assistant.ask({ question: "Q2" }, EXPERT);
	await until(() => log.length === 1 || undefined, "Q1 开始");
	assistant.clear();
	assistant.ask({ question: "Q3" }, EXPERT);
	await until(() => log.length === 2 || undefined, "Q3 开始");
	sessions[0]!.release();
	await new Promise((done) => setTimeout(done, 20));
	sessions[1]!.release();
	await until(() => answers(assistant).at(-1)?.state === "done" || undefined, "Q3 答完");
	assert.deepEqual(log, ["旧:问题：Q1", "新:问题：Q3"]);
	assert.deepEqual(assistant.lines().map((l) => [l.role, l.text]), [["user", "Q3"], ["assistant", "新 答"]]);
	assert.equal(sessions[0]!.disposed, true);
});

test("关掉简报官（宿主停机）：会话都关掉", async () => {
	const log: string[] = [];
	const sessions: ReturnType<typeof fakeSession>[] = [];
	const { assistant } = world(async () => {
		const s = fakeSession("s", log);
		sessions.push(s);
		queueMicrotask(() => setTimeout(() => s.release(), 5));
		return s;
	});
	assistant.ask({ question: "一" }, EXPERT);
	await until(() => answers(assistant).at(-1)?.state === "done" || undefined, "答完");
	await assistant.close();
	assert.equal(sessions[0]!.disposed, true);
});

const _typecheck: AssistantLine | undefined = undefined;
void _typecheck;
