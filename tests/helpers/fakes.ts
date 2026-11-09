import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../../src/host/router.ts";
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

export function fauxRouter(brain: Brain): FauxRouterHandle {
	const batches: string[][] = [];
	const faux = fauxProvider({ models: [{ id: "router" }] });
	let callCount = 0;
	const respond = async (context: any) => {
		callCount++;
		const messages = context.messages as any[];
		const trailing: string[] = [];
		for (let i = messages.length - 1; i >= 0 && messages[i].role === "user"; i--) {
			trailing.unshift(...messageText(messages[i]).split(/\n\n(?=\[)/));
		}
		const toolResults: string[] = [];
		for (let i = messages.length - 1; i >= 0 && messages[i].role === "toolResult"; i--) toolResults.unshift(messageText(messages[i]));
		if (trailing.length) batches.push(trailing);
		const calls = trailing.length || toolResults.length ? await brain(trailing, callCount, toolResults) : [];
		if (calls.length === 0) return fauxAssistantMessage(fauxText("ok"));
		return fauxAssistantMessage(calls.map((c) => fauxToolCall(c.name, c.args as any)), { stopReason: "toolUse" });
	};
	const step = (context: any) => respond(context);
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
			return Router.create({
				kernel: deps.kernel,
				modelRuntime,
				model: faux.getModel(),
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
	inputs: string[];
	report(params: Record<string, unknown>): unknown;
	settle(): void;
	request(method: string, params: unknown): unknown;
}

export type WorkerScript = (worker: FakeWorker, input: string) => void | Promise<void>;

export class FakeSpawner implements WorkerSpawner {
	readonly spawned: string[] = [];
	readonly workers = new Map<string, FakeWorker>();
	request!: (ticketId: string, token: string, method: string, params: unknown) => unknown;
	readonly #script: WorkerScript;

	constructor(script: WorkerScript) {
		this.#script = script;
	}

	async spawn(spec: WorkerSpec, events: WorkerEvents): Promise<WorkerHandle> {
		this.spawned.push(spec.ticketId);
		let streaming = false;
		let alive = true;
		const worker: FakeWorker = {
			spec,
			inputs: [],
			request: (method, params) => this.request(spec.ticketId, spec.token, method, params),
			report: (params) => worker.request("worker.report", params),
			settle: () => {
				streaming = false;
				events.settled();
			},
		};
		this.workers.set(spec.ticketId, worker);
		const script = this.#script;
		return {
			model: "fake/worker",
			fellBack: false,
			isStreaming: () => streaming,
			async deliver(text) {
				worker.inputs.push(text);
				streaming = true;
				events.turnStarted();
				setImmediate(() => void script(worker, text));
			},
			async stop() {
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
		...options,
	});
	spawner.request = (...args) => host.workers.handleRequest(...args);
	const said = () => host.kernel.conversation().filter((m) => m.who === "router").map((m) => m.text);
	return { host, router, spawner, said };
}
