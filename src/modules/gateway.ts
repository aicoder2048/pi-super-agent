import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetched } from "./connectors/attachment.ts";
import { externalTool, RUNTIMES, toolEffect, type AgentDescriptor, type Component, type Digest, type ExternalTool, type FieldDescriptor, type ModuleName, type ToolEffect, type ToolFetch, type ToolPort } from "./manifest.ts";
import { DataInputError, type ModuleRows, type ToolCalls, type WatchRequest } from "./instance-data.ts";
import { catalogueText, foundText, searchKnowledge, type Knowledge, type KnowledgeBase } from "./knowledge.ts";
import { AUTHORITY, effectOf, senderOf, type Caller, type Gateway, type Refusal, type Json, type Reply, type Request, type WorkerCaller } from "./protocol.ts";
import { writeDraft, type GooglePort } from "./google-port.ts";
import { readForTool } from "./ocr-port.ts";
import type { Ocr } from "../ocr/result.ts";
import { lockOf, venvInstalled } from "./files.ts";
import { LIMIT_MS, runModuleCodeAsync, type ModuleSecretLookup } from "./run-code.ts";
import { scanPackage } from "./validate.ts";

export interface GatewayPorts {
	copyDir(module: ModuleName, digest: Digest): string;
	/** The version the module serves now, read from memory on every call. Undefined: switched off or gone, so its open tickets reach nothing. */
	serving(module: ModuleName): Digest | undefined;
	dataDir(module: ModuleName): string;
	rows: ModuleRows;
	/** Each tool call that ran goes into the data.db of the module it ran in; a failed write is logged, never the call's failure. */
	toolCalls?: ToolCalls;
	/** `module` is the module whose code runs, so a tool reads its own module's `.env`. */
	secret: ModuleSecretLookup;
	log(line: string): void;
	limitMs?: number;
	google?: GooglePort;
	ocr?: Ocr;
	/** What a tool's `fetch` names, fetched into `dir` before its code runs; a string is the refusal. `components` are the serving version's. */
	fetch?: Partial<Record<ToolFetch, (module: ModuleName, components: readonly Component[], input: Json, dir: string) => Promise<Fetched | string>>>;
	/** Marks another module's copy as in use while a call from outside runs in it, so the host does not collect it; the result releases it. */
	hold?(module: ModuleName, digest: Digest): () => void;
}

type Tool = Extract<Component, { kind: "tools" }>;
type Collection = Extract<Component, { kind: "data" }>;
type Copy = {
	module: ModuleName;
	digest: Digest;
	dir: string;
	components: readonly Component[];
	tools: readonly Tool[];
	knowledge: readonly Knowledge[];
	collections: readonly Collection[];
	agents: readonly AgentDescriptor[];
	feedSources: readonly string[];
	exports: readonly string[];
	/** `module.json`'s `uses`: the external tools of a module without members. */
	uses: readonly string[];
};
type Capability = { effect: ToolEffect; run: () => Promise<Reply> };

const fieldsHelp = (fields: Readonly<Record<string, FieldDescriptor>>) =>
	Object.entries(fields).map(([name, f]) => `${name}（${f.type}，${f.title}${f.unit ? `，${f.unit}` : ""}）`).join("、") || "无";

const toolHelp = ({ tool }: Tool) => `${tool.description} 输入：${fieldsHelp(tool.input)}。输出：${fieldsHelp(tool.output)}。`;

/** A helper's catalogue is fixed when it starts, and the provider may open or upgrade after that. */
const LIVE_NOTE = "说明取自启动时，以调用结果为准。";

const useOf = (request: Request): string => (request.kind === "tool" ? `tools/${request.name}` : request.kind === "knowledge" ? "knowledge" : `${request.kind}/${request.collection}`);

const whoOf = (caller: Caller) => (caller.who === "page" ? "page" : `${caller.ticket} ${caller.member ?? "helper"}`);

const moduleOf = (caller: Caller) => (caller.who === "worker" ? caller.pin.module : caller.module);

type ToolRequest = Extract<Request, { kind: "tool" }>;
type ExternalCall = { caller: WorkerCaller; request: ToolRequest; target: ExternalTool };

/** A Worker's tool call named `<module>/tools/<name>` for a module other than its ticket's. */
const externalOf = (caller: Caller, request: Request): ExternalCall | undefined => {
	if (caller.who !== "worker" || request.kind !== "tool") return undefined;
	const target = externalTool(request.name);
	return target === undefined || target.provider === caller.pin.module ? undefined : { caller, request, target };
};

export function createGateway(ports: GatewayPorts): Gateway {
	// A kept copy never changes, so each one is scanned once. A copy not there yet is not remembered.
	const copies = new Map<string, Copy>();
	const copyOf = (module: ModuleName, digest: Digest | undefined): Copy | undefined => {
		if (digest === undefined) return undefined;
		const key = `${module}/${digest}`;
		const known = copies.get(key);
		if (known !== undefined) return known;
		const dir = ports.copyDir(module, digest);
		const scan = existsSync(dir) ? scanPackage(dir, { runCases: false, folder: module }) : undefined;
		if (!scan?.ok) return undefined;
		const { components, manifest } = scan.scan;
		const copy = {
			module, digest, dir, components,
			exports: manifest.exports ?? [],
			uses: manifest.uses ?? [],
			tools: components.filter((c): c is Tool => c.kind === "tools"),
			knowledge: components.filter((c): c is Knowledge => c.kind === "knowledge"),
			collections: components.filter((c): c is Collection => c.kind === "data"),
			agents: components.flatMap((c) => (c.kind === "agents" ? [c.agent] : [])),
			feedSources: components.flatMap((c) => (c.kind === "feeds" ? [`${module}/${c.name}`] : [])),
		};
		copies.set(key, copy);
		return copy;
	};
	const callerCopy = (caller: Caller, serving: Digest | undefined) => copyOf(moduleOf(caller), caller.who === "worker" ? caller.pin.digest : serving);
	const memberRefusal = (caller: Caller, copy: Copy, use: string): Refusal | undefined => {
		if (caller.who === "page" || caller.member === null) return undefined;
		const uses = copy.agents.find((a) => a.name === caller.member)?.uses ?? [];
		return uses.some((u) => u === use) ? undefined : { code: "not-in-uses", member: caller.member };
	};
	/** A member's external tools are in its own `uses`; a caller with no member gets every external tool its module lists anywhere. */
	const externalUses = (caller: WorkerCaller, copy: Copy): string[] => {
		const uses = caller.member === null ? [...copy.uses, ...copy.agents.flatMap((a) => a.uses)] : (copy.agents.find((a) => a.name === caller.member)?.uses ?? []);
		return [...new Set(uses.filter((use) => (externalTool(use)?.provider ?? copy.module) !== copy.module))];
	};
	/** Read on every call: the provider's serving version may change between two calls of one ticket. */
	const provided = ({ provider, tool: name }: ExternalTool): { copy: Copy; tool: Tool } | { refusal: Refusal } => {
		const copy = copyOf(provider, ports.serving(provider));
		if (copy === undefined || !existsSync(copy.dir)) return { refusal: { code: "provider-absent", note: `${provider} 没装或没开` } };
		const tool = copy.exports.includes(`tools/${name}`) ? copy.tools.find((t) => t.name === name) : undefined;
		return tool ? { copy, tool } : { refusal: { code: "provider-absent", note: `${provider} 现在没有开放 ${name}` } };
	};
	const authorityRefusal = (caller: Caller, request: Request, tool: ToolEffect): Refusal | undefined => {
		const effect = effectOf(request, tool);
		const sender = senderOf(caller);
		return AUTHORITY[effect].includes(sender) ? undefined : { code: "not-allowed", sender, note: `a ${effect} call is for ${AUTHORITY[effect].join(", ")}` };
	};

	const find = (copy: Copy, request: Request, caller: Caller): Capability | undefined => {
		if (request.kind === "tool") {
			const tool = copy.tools.find((t) => t.name === request.name);
			return tool && { effect: toolEffect(tool.tool), run: () => runTool(copy, tool, request.input) };
		}
		if (request.kind === "knowledge" && request.op === "search" && copy.knowledge.length > 0) {
			return { effect: "pure", run: async () => search(copy, request.query) };
		}
		if (request.kind === "data" && request.op !== "open-blob" && copy.collections.some((c) => c.name === request.collection)) {
			return { effect: "pure", run: async () => rows(copy.module, request, whoOf(caller)) };
		}
		if (request.kind === "watch" && copy.collections.some((c) => c.name === request.collection && c.collection.watch !== undefined)) {
			return { effect: "pure", run: async () => conditions(copy.module, request, whoOf(caller)) };
		}
		return undefined;
	};
	/** The protocol's order: resolve in the pinned version, the module's state, the member's `uses`, the authority table. */
	const resolve = (caller: Caller, request: Request): { refusal: Refusal } | Capability => {
		const serving = ports.serving(moduleOf(caller));
		const copy = callerCopy(caller, serving);
		const found = copy && find(copy, request, caller);
		if (copy === undefined || found === undefined) return { refusal: { code: "no-such-capability" } };
		if (serving === undefined) return { refusal: { code: "module-disabled" } };
		const refusal = memberRefusal(caller, copy, useOf(request)) ?? authorityRefusal(caller, request, found.effect);
		return refusal ? { refusal } : found;
	};
	/** Another module's exported tool: the caller's module and `uses` from its pinned copy, the tool from the provider's serving copy. */
	const resolveExternal = ({ caller, request, target }: ExternalCall): { refusal: Refusal } | Capability => {
		if (ports.serving(caller.pin.module) === undefined) return { refusal: { code: "module-disabled" } };
		const own = copyOf(caller.pin.module, caller.pin.digest);
		if (own === undefined) return { refusal: { code: "no-such-capability" } };
		if (!externalUses(caller, own).includes(request.name)) return { refusal: { code: "not-in-uses", member: caller.member } };
		const found = provided(target);
		if ("refusal" in found) return found;
		const effect = toolEffect(found.tool.tool);
		const refusal = authorityRefusal(caller, request, effect);
		return refusal ? { refusal } : { effect, run: () => runExternal(found.copy, found.tool, request.input) };
	};
	const knowledgeOf = (copy: Copy): KnowledgeBase => ({ module: copy.module, digest: copy.digest, copyDir: copy.dir, dataDir: ports.dataDir(copy.module), docs: copy.knowledge });

	const search = (copy: Copy, query: string): Reply => {
		const found = searchKnowledge(knowledgeOf(copy), query);
		return { ok: true, output: foundText(copy.module, query, found), passages: found.passages };
	};

	/** Rows and conditions are kept in the serving version's structure: a ticket pinned to an older one reaches them through the stored aliases. */
	const withServing = (module: ModuleName, use: (serving: Copy) => Reply): Reply => {
		const serving = copyOf(module, ports.serving(module));
		if (serving === undefined) return { ok: false, refusal: { code: "module-disabled" } };
		try {
			return use(serving);
		} catch (error) {
			if (error instanceof DataInputError) return { ok: false, refusal: { code: "bad-input", note: error.message } };
			throw error;
		}
	};
	const rows = (module: ModuleName, request: Extract<Request, { kind: "data" }>, who: string): Reply =>
		withServing(module, ({ collections, feedSources }) => {
			if (request.op !== "write") {
				const read = ports.rows.query(module, collections, request.collection, request.op === "query" ? request.query : {}, who);
				return { ok: true, output: { collection: read.collection, rows: read.rows as unknown as Json } };
			}
			// Rows marked with a feed's source and no later edit are what the feed stored; draft-reply trusts exactly that.
			if (feedSources.includes(request.from.trim())) return { ok: false, refusal: { code: "bad-input", note: `from 不能写 ${request.from.trim()}：那是 feed 存信用的来源名，任务写的行要写自己的来源` } };
			const written = ports.rows.write(module, collections, request.collection, request.rows, request.from, who);
			if (written.alertProblem !== undefined) ports.log(`[gateway] ${module} ${written.collection}：写进去了，但提醒条件没检查成：${written.alertProblem}`);
			return { ok: true, output: { collection: written.collection, rows: written.rows as unknown as Json }, alerts: written.alerts };
		});
	const conditions = (module: ModuleName, request: WatchRequest, who: string): Reply =>
		withServing(module, ({ collections }) => {
			const watched = ports.rows.watch(module, collections, request, who);
			return { ok: true, output: { collection: watched.collection, ...watched.output } as unknown as Json };
		});

	/** The fetched file lives only for the call: the folder goes once the tool and its port are done. */
	const runTool = async (copy: Copy, tool: Tool, input: Json): Promise<Reply> => {
		const kind = tool.tool.fetch;
		if (kind === undefined) return runCode(copy, tool, input);
		const fetch = ports.fetch?.[kind];
		const serving = copyOf(copy.module, ports.serving(copy.module));
		if (fetch === undefined || serving === undefined) return { ok: false, refusal: { code: "provider-failed", note: `这台宿主取不了 ${kind}` } };
		const dir = mkdtempSync(join(tmpdir(), "psa-fetch-"));
		try {
			const fetched = await fetch(copy.module, serving.components, input, dir);
			if (typeof fetched === "string") return { ok: false, refusal: { code: "provider-failed", note: fetched } };
			return await runCode(copy, tool, { ...(input as object), fetched } as Json);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	/** A failure while the provider's lock has no installed environment is that, not the tool's own words, which speak to the provider's user. */
	const runExternal = async (copy: Copy, tool: Tool, input: Json): Promise<Reply> => {
		const release = ports.hold?.(copy.module, copy.digest);
		try {
			let reply: Reply;
			try {
				reply = await runTool(copy, tool, input);
			} catch (error) {
				reply = { ok: false, refusal: { code: "provider-failed", note: String((error as Error)?.message ?? error) } };
			}
			if (reply.ok || reply.refusal.code !== "provider-failed") return reply;
			const lock = lockOf(copy.dir);
			if (lock !== undefined && !venvInstalled(ports.dataDir(copy.module), lock)) return { ok: false, refusal: { code: "provider-absent", note: `${copy.module} 的运行环境还没装好` } };
			return { ok: false, refusal: { ...reply.refusal, provider: copy.module } };
		} finally {
			release?.();
		}
	};
	const runCode = async (copy: Copy, tool: Tool, input: Json): Promise<Reply> => {
		const secrets = Object.fromEntries((tool.tool.secrets ?? []).flatMap((name) => {
			const value = ports.secret(copy.module, name);
			return value === undefined ? [] : [[name, value]];
		}));
		const ran = await runModuleCodeAsync({ packageDir: copy.dir, component: join("tools", tool.name), dataDir: ports.dataDir(copy.module) }, RUNTIMES[tool.tool.runtime ?? "node"], input, secrets, { limitMs: ports.limitMs ?? LIMIT_MS });
		if (!ran.ok) return { ok: false, refusal: { code: "provider-failed", note: ran.note } };
		if (tool.tool.port === undefined) return { ok: true, output: ran.output };
		const done = await PORTS[tool.tool.port](ran.output, copy);
		return typeof done === "string" ? { ok: false, refusal: { code: "provider-failed", note: done } } : { ok: true, ...done };
	};
	const PORTS: Record<ToolPort, (output: Json, copy: Copy) => Promise<{ output: Json; receipt?: string } | string>> = {
		"gmail.createDraft": async (output) => (ports.google === undefined ? "这台宿主没有接 Google，建不了草稿" : writeDraft(ports.google, output)),
		ocr: (output, copy) => readForTool(ports.ocr, ports.dataDir(copy.module), output),
	};

	return {
		async call(caller, request) {
			const started = Date.now();
			const external = externalOf(caller, request);
			let reply: Reply;
			let ran = false;
			try {
				const resolved = external ? resolveExternal(external) : resolve(caller, request);
				ran = !("refusal" in resolved);
				reply = "refusal" in resolved ? { ok: false, refusal: resolved.refusal } : await resolved.run();
			} catch (error) {
				reply = { ok: false, refusal: { code: "provider-failed", note: String((error as Error)?.message ?? error) } };
			}
			const ms = Date.now() - started;
			const outcome = reply.ok ? "ok" : reply.refusal.code;
			const who = caller.who === "page" ? "page" : `${whoOf(caller)} ${caller.basis}`;
			const [owner, use] = external ? [external.target.provider, `tools/${external.target.tool}`] : [moduleOf(caller), useOf(request)];
			ports.log(`[gateway] ${owner} ${use} ${who} ${outcome} ${ms} ms${external ? ` from=${moduleOf(caller)}` : ""}`);
			if (ran && request.kind === "tool") {
				const by = caller.who === "page" ? { ticket: null, member: null, basis: "page" } : { ticket: caller.ticket, member: caller.member, basis: caller.basis };
				try {
					ports.toolCalls?.recordToolCall(owner, { caller: moduleOf(caller), ...by, tool: use, outcome, ms });
				} catch (error) {
					ports.log(`[gateway] ${owner} ${use}：_tool_calls 没记上：${String((error as Error)?.message ?? error)}`);
				}
			}
			return reply;
		},
		catalogue(caller) {
			const copy = callerCopy(caller, undefined);
			if (copy === undefined) return [];
			const probe = (t: Tool): Request => ({ kind: "tool", name: t.name, input: null });
			const tools = copy.tools
				.filter((t) => !memberRefusal(caller, copy, `tools/${t.name}`) && !authorityRefusal(caller, probe(t), toolEffect(t.tool)))
				.map((t) => ({ request: "tool" as const, name: t.name as string, title: t.tool.title, help: toolHelp(t) }));
			const external = externalUses(caller, copy).map((name) => {
				const found = provided(externalTool(name)!);
				return "refusal" in found
					? { request: "tool" as const, name, title: name, help: `${externalTool(name)!.provider} 现在用不了，调用会回原因。${LIVE_NOTE}` }
					: { request: "tool" as const, name, title: found.tool.tool.title, help: `${toolHelp(found.tool)}${LIVE_NOTE}` };
			});
			const knowledge = copy.knowledge.length > 0 && !memberRefusal(caller, copy, "knowledge") ? [{ request: "knowledge" as const, name: "knowledge", title: "模块知识", help: catalogueText(knowledgeOf(copy)) }] : [];
			const data = copy.collections
				.filter((c) => !memberRefusal(caller, copy, `data/${c.name}`))
				.map((c) => ({ request: "data" as const, name: c.name, title: c.collection.title, help: `${c.collection.kind}，${c.collection.class}。字段：${fieldsHelp(c.collection.fields)}` }));
			const watch = copy.collections.flatMap(({ name, collection: { title, watch } }) =>
				watch === undefined || memberRefusal(caller, copy, `watch/${name}`) ? [] : [{ request: "watch" as const, name, title, help: `key 是 ${watch.key} 字段的值，盯 ${watch.value}，时间看 ${watch.at}` }],
			);
			return [...tools, ...external, ...knowledge, ...data, ...watch];
		},
	};
}

/** What the Worker reads when the Gateway says no, so it can tell the user and wrap up. */
export function refusalText(refusal: Refusal): string {
	switch (refusal.code) {
		case "no-such-capability":
			return "本任务所属模块的这个版本里没有这一项，能用的见 domain_tool 和 knowledge 的说明";
		case "module-disabled":
			return "本任务所属模块已停用，它的工具和知识都用不了了。请用 report 汇报做到哪里，然后收尾";
		case "not-in-uses":
			return refusal.member === null ? "本模块没有在 uses 里列这个外部工具，用不了" : `成员 ${refusal.member} 的 uses 没有列这一项，用不了`;
		case "provider-absent":
			return `${refusal.note}，这部分没做。在汇报里写明哪部分没做、为什么，其余照常做完`;
		case "not-allowed":
			return refusal.sender === "inference"
				? "推断开的任务只读，不能写模块数据、不能设或删提醒条件，也不能调会改变外面东西的工具。需要时请在汇报里请使用者在对话里提出"
				: "只有使用者在对话里开、只听过使用者的话的任务才能做这件事。请在汇报里请使用者在对话里重新说一次";
		case "bad-input":
			return `工具这一次出错：${refusal.note}`;
		case "provider-failed":
			return `${refusal.provider === undefined ? "" : `${refusal.provider} 的`}工具这一次出错：${refusal.note}`;
	}
}
