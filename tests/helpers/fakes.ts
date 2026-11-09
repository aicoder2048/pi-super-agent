import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../../src/host/router.ts";
import { ModelSelector } from "../../src/model-selector.ts";
import { formatModelRef } from "../../src/models.ts";
import type { WorkerModels } from "../../src/host/workers.ts";

export function defaultWorkerModels(): WorkerModels {
	return {
		selector: new ModelSelector({
			primary: { provider: "openai-codex", id: "gpt-6.1-sol" },
			fallback: { provider: "deepseek", id: "deepseek-flash" },
			probeEveryMs: 15 * 60_000,
			clock: { now: () => Date.now() },
		}),
		fallbackDailyTokens: Number.POSITIVE_INFINITY,
	};
}
import { Host, type HostDeps, type HostOptions, type RouterLike } from "../../src/host/host.ts";
import type { WorkerEvents, WorkerHandle, WorkerSpawner, WorkerSpec } from "../../src/host/workers.ts";

export type ToolCallSpec = { name: string; args: Record<string, unknown> };
export type Brain = (cards: string[], call: number, toolResults: string[]) => ToolCallSpec[] | Promise<ToolCallSpec[]>;

function messageText(m: any): string {
	if (typeof m.content === "string") return m.content;
	return (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

export interface FauxRouterHandle {
	createRouter: (deps: HostDeps) => Promise<RouterLike>;
	batches: string[][];
	calls: () => number;
}

export interface FauxRouterOptions {
	models?: string[];
	failOn?: (modelId: string) => string | undefined;
	persist?: boolean;
	errorRetryMs?: number[];
}

export function fauxRouter(brain: Brain, options: FauxRouterOptions = {}): FauxRouterHandle {
	const batches: string[][] = [];
	const modelIds = options.models ?? ["router"];
	const faux = fauxProvider({ models: modelIds.map((id) => ({ id })) });
	let callCount = 0;
	const respond = async (context: any, model: any) => {
		callCount++;
		const failure = options.failOn?.(model.id);
		if (failure) return fauxAssistantMessage("", { stopReason: "error", errorMessage: failure });
		const messages = context.messages as any[];
		const trailing: string[] = [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) continue;
			if (m.role !== "user") break;
			trailing.unshift(...messageText(m).split(/\n\n(?=\[)/));
		}
		const toolResults: string[] = [];
		for (let i = messages.length - 1; i >= 0 && messages[i].role === "toolResult"; i--) toolResults.unshift(messageText(messages[i]));
		if (trailing.length) batches.push(trailing);
		const calls = trailing.length || toolResults.length ? await brain(trailing, callCount, toolResults) : [];
		if (calls.length === 0) return fauxAssistantMessage(fauxText("ok"));
		return fauxAssistantMessage(calls.map((c) => fauxToolCall(c.name, c.args as any)), { stopReason: "toolUse" });
	};
	const step = (context: any, _o: unknown, _s: unknown, model: any) => respond(context, model);
	faux.setResponses(Array.from({ length: 500 }, () => step));
	return {
		batches,
		calls: () => callCount,
		async createRouter(deps) {
			const modelRuntime = await ModelRuntime.create({
				authPath: join(mkdtempSync(join(tmpdir(), "psa-auth-")), "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerNativeProvider(faux.provider);
			const ref = (id: string) => ({ provider: faux.getModel().provider, id });
			const models = {
				selector: new ModelSelector({ primary: ref(modelIds[0]), fallback: ref(modelIds.at(1) ?? modelIds[0]), probeEveryMs: 15 * 60_000, clock: { now: () => Date.now() } }),
				resolve: (r: { id: string }) => faux.getModel(r.id)!,
			};
			return Router.create({
				kernel: deps.kernel,
				modelRuntime,
				models,
				retry: { maxRetries: 3, baseDelayMs: 1 },
				sessionDir: options.persist ? join(deps.stateDir, "sessions", "router") : undefined,
				errorRetryMs: options.errorRetryMs ?? [10, 10, 10],
				cwd: deps.stateDir,
				rules: "",
				afterCommand: deps.afterCommand,
			});
		},
	};
}

export const ids = (card: string, prefix: "trg" | "tkt") => card.match(new RegExp(`${prefix}_[\\w-]+`))?.[0];

export function openOnConversation(card: string, title = card.split("使用者：")[1] ?? "任务"): ToolCallSpec[] {
	const triggerId = ids(card, "trg")!;
	return [
		{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId, title, brief: title }] } },
		{ name: "reply", args: { text: `收到：${title}` } },
	];
}

export interface FakeWorker {
	spec: WorkerSpec;
	model: string;
	inputs: string[];
	report(params: Record<string, unknown>): unknown;
	settle(error?: string): void;
	request(method: string, params: unknown): unknown;
}

export type WorkerScript = (worker: FakeWorker, input: string) => void | Promise<void>;

export class FakeSpawner implements WorkerSpawner {
	readonly spawned: string[] = [];
	readonly stopped: string[] = [];
	spawnGate: Promise<void> | undefined;
	readonly workers = new Map<string, FakeWorker>();
	request!: (ticketId: string, token: string, method: string, params: unknown) => unknown;
	readonly #script: WorkerScript;

	constructor(script: WorkerScript) {
		this.#script = script;
	}

	async spawn(spec: WorkerSpec, events: WorkerEvents): Promise<WorkerHandle> {
		this.spawned.push(spec.ticketId);
		await this.spawnGate;
		let streaming = false;
		let alive = true;
		const worker: FakeWorker = {
			spec,
			model: formatModelRef(spec.model),
			inputs: [],
			request: (method, params) => this.request(spec.ticketId, spec.token, method, params),
			report: (params) => worker.request("worker.report", params),
			settle: (error) => {
				streaming = false;
				events.settled(error);
			},
		};
		this.workers.set(spec.ticketId, worker);
		const script = this.#script;
		return {
			get model() {
				return worker.model;
			},
			isStreaming: () => streaming,
			async setModel(next) {
				worker.model = formatModelRef(next);
			},
			async deliver(text) {
				worker.inputs.push(text);
				streaming = true;
				events.turnStarted();
				setImmediate(() => void script(worker, text));
			},
			stop: async () => {
				this.stopped.push(spec.ticketId);
				if (!alive) return;
				alive = false;
				setImmediate(() => events.exited());
			},
		};
	}
}

export function tempStateDir(): string {
	return mkdtempSync(join(tmpdir(), "psa-host-"));
}

export async function until(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

export async function startHost(brain: Brain, script: WorkerScript, options: Partial<HostOptions> = {}) {
	const router = fauxRouter(brain);
	const spawner = new FakeSpawner(script);
	const host = await Host.start({
		stateDir: tempStateDir(),
		createRouter: router.createRouter,
		createSpawner: () => spawner,
		log: () => {},
		workerModels: defaultWorkerModels(),
		...options,
	});
	spawner.request = (...args) => host.workers.handleRequest(...args);
	const said = () => host.kernel.conversation().filter((m) => m.who === "router").map((m) => m.text);
	return { host, router, spawner, said };
}
