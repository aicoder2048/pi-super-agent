// A local fake model that speaks the OpenAI chat-completions streaming protocol and replays the tool
// calls a test scripted. The Router inside the host and every Worker subprocess reach it through a
// models.json in a throwaway PI_CODING_AGENT_DIR (see fakeAgentEnv in harness.ts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ids, type ToolCallSpec } from "../helpers/fakes.ts";

export const FAKE_PROVIDER = "psa-fake";

export type ToolCall = ToolCallSpec;
/** Tool calls (the turn ends in tool_calls) or plain text (the turn ends). */
export type Answer = ToolCall[] | string;

export interface Step {
	/** Same name as the browser step it feeds, so a failure report and PSA_E2E_SABOTAGE can name it. */
	label: string;
	/** Matched against one message card ("[对话] …", "[Worker 汇报] …", "[任务说明] …"). */
	match: RegExp;
	answer: (card: string) => Answer;
	/** Holds the reply this long, so the page can be seen while the model is still answering. */
	delayMs?: number;
}

/**
 * The Router has one conversation. Workers are told apart by the brief the Router wrote into open_ticket,
 * and a team member by the first task its helper dispatched to it: later dispatches continue that conversation.
 */
export interface Script {
	router: Step[];
	workers?: WorkerScript[];
}
export type WorkerScript = { brief: string; steps: Step[] };

export const on = (label: string, match: RegExp, answer: (card: string) => Answer, delayMs?: number): Step => ({ label, match, answer, ...(delayMs && { delayMs }) });
export const worker = (brief: string, ...steps: Step[]): WorkerScript => ({ brief, steps });

// Tool names and arguments follow src/host/router.ts and src/worker/extension.ts.
export const openTicket = (card: string, title: string, brief = title): ToolCall => ({
	name: "route",
	args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg") ?? "trg_missing", title, brief }] },
});
export const reply = (card: string, text: string): ToolCall => ({ name: "reply", args: { text, cause: card.match(/\b(trg|tkt|act)_[\w-]+/)?.[0] } });
export const dispatch = (agent: string, task: string): ToolCall => ({ name: "dispatch_agent", args: { agent, task } });
export const report = (status: "progress" | "ready" | "blocked" | "failed" | "no_action", summary: string): ToolCall => ({ name: "report", args: { status, summary } });
/** Crashes the current Worker for real: inside the bash tool, $PPID is the Pi process. */
export const crashWorker = (): ToolCall => ({ name: "bash", args: { command: "kill -9 $PPID" } });

export interface Exchange {
	at: number;
	model: string;
	conversation: string;
	cards: string[];
	steps: string[];
	unmatched: string[];
	/** The tools the request offered the model. */
	tools: string[];
	answer: Answer;
}

export interface Leftovers {
	unused: string[];
	unmatched: string[];
	stray: string[];
}

/** "<label>" answers that step wrongly; "<label>:crash" makes its Worker kill its own Pi process. The label may contain colons. */
export function parseSabotage(value: string | undefined): { label: string; crash: boolean } | undefined {
	if (!value) return undefined;
	const crash = value.endsWith(":crash");
	return { label: crash ? value.slice(0, -":crash".length) : value, crash };
}

export class FakeModel {
	readonly exchanges: Exchange[] = [];
	/** Every request that is not POST /v1/chat/completions, including CONNECTs through the proxy tripwire. */
	readonly stray: string[] = [];
	readonly #pending = new Map<string, Step[]>();
	readonly #sabotage: { label: string; crash: boolean } | undefined;
	#server!: Server;
	#drained!: () => void;
	readonly drained = new Promise<void>((done) => (this.#drained = done));
	baseUrl = "";

	private constructor(script: Script, sabotage: string | undefined) {
		this.#pending.set("router", [...script.router]);
		for (const { brief, steps } of script.workers ?? []) {
			if (this.#pending.has(brief)) throw new Error(`两个 Worker 脚本用了同一个 brief：${brief}`);
			this.#pending.set(brief, [...steps]);
		}
		this.#sabotage = parseSabotage(sabotage);
		this.#checkDrained();
	}

	static async start(script: Script, sabotage = process.env.PSA_E2E_SABOTAGE): Promise<FakeModel> {
		const fake = new FakeModel(script, sabotage);
		fake.#server = createServer((req, res) => void fake.#handle(req, res));
		fake.#server.on("connect", (req, socket) => {
			fake.stray.push(`CONNECT ${req.url}`);
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		});
		await new Promise<void>((ready) => fake.#server.listen(0, "127.0.0.1", ready));
		fake.baseUrl = `http://127.0.0.1:${(fake.#server.address() as { port: number }).port}/v1`;
		return fake;
	}

	/** Pi's models.json: one custom provider whose three model ids are the role names. */
	modelsJson(): unknown {
		return {
			providers: {
				[FAKE_PROVIDER]: { baseUrl: this.baseUrl, api: "openai-completions", apiKey: "fake", models: ["router", "worker", "fallback"].map((id) => ({ id })) },
			},
		};
	}

	leftovers(): Leftovers {
		return {
			unused: [...this.#pending.values()].flat().map((s) => s.label),
			unmatched: this.exchanges.flatMap((e) => e.unmatched.map((c) => `${e.conversation}: ${c.slice(0, 120)}`)),
			stray: [...this.stray],
		};
	}

	jsonl(): string {
		return this.exchanges.map((e) => JSON.stringify(e)).join("\n") + "\n";
	}

	close(): Promise<void> {
		this.#server.closeAllConnections();
		return new Promise((done) => this.#server.close(() => done()));
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			this.stray.push(`${req.method} ${req.url}`);
			res.writeHead(404).end();
			return;
		}
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw) as { model: string; messages: Message[]; tools?: { function?: { name?: string } }[] };
		const { delayMs, ...decided } = this.#decide(body.model, body.messages);
		const exchange = { ...decided, tools: (body.tools ?? []).map((t) => t.function?.name ?? "") };
		this.exchanges.push(exchange);
		if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
		stream(res, exchange.answer);
	}

	// Each trailing user card claims the first unused step that matches it, in any order, so the result
	// does not depend on how the Router batches cards or on automatic retries.
	#decide(model: string, messages: Message[]): Omit<Exchange, "tools"> & { delayMs: number } {
		const conversation = model === "router" || model === "fallback" ? "router" : briefOf(messages);
		const cards = trailingCards(messages);
		const base = { at: Date.now(), model, conversation, cards, steps: [] as string[], unmatched: [] as string[], delayMs: 0 };
		if (cards.length === 0) return { ...base, answer: "好。" };
		const pending = this.#pending.get(conversation) ?? [];
		const calls: ToolCall[] = [];
		for (const card of cards) {
			const i = pending.findIndex((s) => s.match.test(card));
			if (i < 0) {
				base.unmatched.push(card);
				continue;
			}
			const [step] = pending.splice(i, 1);
			this.#checkDrained();
			base.steps.push(step.label);
			base.delayMs = Math.max(base.delayMs, step.delayMs ?? 0);
			const answer = this.#sabotaged(step) ?? step.answer(card);
			if (!Array.isArray(answer)) return { ...base, answer };
			calls.push(...answer);
		}
		return { ...base, answer: calls.length ? calls : "好。" };
	}

	#checkDrained(): void {
		if ([...this.#pending.values()].every((steps) => steps.length === 0)) this.#drained();
	}

	#sabotaged(step: Step): Answer | undefined {
		if (this.#sabotage?.label !== step.label) return undefined;
		return this.#sabotage.crash ? [crashWorker()] : "（假模型故意答错，没有调用任何工具）";
	}
}

type Message = { role: string; content?: string | { type: string; text?: string }[] };
const textOf = (m: Message) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));

/**
 * The user cards after the last assistant turn. A member's reply to a dispatch counts as one card, "[成员回复] …",
 * so a helper can be scripted past it; so does a command's output that starts with "[命令输出]".
 */
function trailingCards(messages: Message[]): string[] {
	const out: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") out.unshift(...textOf(m).split(/\n\n(?=\[)/));
		else if (m.role === "tool" && textOf(m).startsWith("成员回复")) out.unshift(`[成员回复] ${textOf(m)}`);
		else if (m.role === "tool" && textOf(m).startsWith("[命令输出]")) out.unshift(textOf(m));
		else break;
	}
	return out;
}

/** A Worker's first user message is "[任务说明] trg_… · …\n<brief>"; a member's is "[派活] <title>\n<task>". */
function briefOf(messages: Message[]): string {
	const first = textOf(messages.find((m) => m.role === "user") ?? { role: "user" });
	return first.slice(first.indexOf("\n") + 1).trim();
}

function stream(res: ServerResponse, answer: Answer): void {
	const send = (body: object) => res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake", ...body })}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream" });
	if (typeof answer === "string") {
		send({ choices: [{ index: 0, delta: { role: "assistant", content: answer } }] });
		send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
	} else {
		answer.forEach((c, i) => send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] }));
		send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	}
	send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	res.end("data: [DONE]\n\n");
}
