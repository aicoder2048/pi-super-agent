import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUNTIMES, toolEffect, type AgentDescriptor, type Component, type Digest, type FieldDescriptor, type ModuleName, type ToolEffect } from "./manifest.ts";
import { catalogueText, foundText, searchKnowledge, type Knowledge, type KnowledgeBase } from "./knowledge.ts";
import { AUTHORITY, effectOf, senderOf, type Caller, type Gateway, type Refusal, type Json, type Reply, type Request } from "./protocol.ts";
import { LIMIT_MS, runModuleCodeAsync } from "./run-code.ts";
import { scanPackage } from "./validate.ts";

export interface GatewayPorts {
	copyDir(module: ModuleName, digest: Digest): string;
	/** The version the module serves now, read from memory on every call. Undefined: switched off or gone, so its open tickets reach nothing. */
	serving(module: ModuleName): Digest | undefined;
	dataDir(module: ModuleName): string;
	/** A value from the host's secrets file. */
	secret(name: string): string | undefined;
	log(line: string): void;
	limitMs?: number;
}

type Tool = Extract<Component, { kind: "tools" }>;
type Copy = { module: ModuleName; digest: Digest; dir: string; tools: readonly Tool[]; knowledge: readonly Knowledge[]; agents: readonly AgentDescriptor[] };
type Capability = { effect: ToolEffect; run: () => Promise<Reply> };

const fieldsHelp = (fields: Readonly<Record<string, FieldDescriptor>>) =>
	Object.entries(fields).map(([name, f]) => `${name}（${f.type}，${f.title}${f.unit ? `，${f.unit}` : ""}）`).join("、") || "无";

const useOf = (request: Request): string => (request.kind === "tool" ? `tools/${request.name}` : request.kind === "knowledge" ? "knowledge" : `${request.kind}/${request.collection}`);

const moduleOf = (caller: Caller) => (caller.who === "worker" ? caller.pin.module : caller.module);

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
		const { components } = scan.scan;
		const copy = {
			module, digest, dir,
			tools: components.filter((c): c is Tool => c.kind === "tools"),
			knowledge: components.filter((c): c is Knowledge => c.kind === "knowledge"),
			agents: components.flatMap((c) => (c.kind === "agents" ? [c.agent] : [])),
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
	const authorityRefusal = (caller: Caller, request: Request, tool: ToolEffect): Refusal | undefined => {
		const effect = effectOf(request, tool);
		const sender = senderOf(caller);
		return AUTHORITY[effect].includes(sender) ? undefined : { code: "not-allowed", sender, note: `a ${effect} call is for ${AUTHORITY[effect].join(", ")}` };
	};

	const find = (copy: Copy, request: Request): Capability | undefined => {
		if (request.kind === "tool") {
			const tool = copy.tools.find((t) => t.name === request.name);
			return tool && { effect: toolEffect(tool.tool), run: () => runTool(copy, tool, request.input) };
		}
		if (request.kind === "knowledge" && request.op === "search" && copy.knowledge.length > 0) {
			return { effect: "pure", run: async () => search(copy, request.query) };
		}
		return undefined;
	};
	/** The protocol's order: resolve in the pinned version, the module's state, the member's `uses`, the authority table. */
	const resolve = (caller: Caller, request: Request): { refusal: Refusal } | Capability => {
		const serving = ports.serving(moduleOf(caller));
		const copy = callerCopy(caller, serving);
		const found = copy && find(copy, request);
		if (copy === undefined || found === undefined) return { refusal: { code: "no-such-capability" } };
		if (serving === undefined) return { refusal: { code: "module-disabled" } };
		const refusal = memberRefusal(caller, copy, useOf(request)) ?? authorityRefusal(caller, request, found.effect);
		return refusal ? { refusal } : found;
	};
	const knowledgeOf = (copy: Copy): KnowledgeBase => ({ module: copy.module, digest: copy.digest, copyDir: copy.dir, dataDir: ports.dataDir(copy.module), docs: copy.knowledge });

	const search = (copy: Copy, query: string): Reply => {
		const found = searchKnowledge(knowledgeOf(copy), query);
		return { ok: true, output: foundText(copy.module, query, found), private: false, passages: found.passages };
	};

	const runTool = async (copy: Copy, tool: Tool, input: Json): Promise<Reply> => {
		const secrets = Object.fromEntries((tool.tool.secrets ?? []).flatMap((name) => {
			const value = ports.secret(name);
			return value === undefined ? [] : [[name, value]];
		}));
		const ran = await runModuleCodeAsync(join(copy.dir, "tools", tool.name), RUNTIMES[tool.tool.runtime ?? "node"], input, secrets, ports.limitMs ?? LIMIT_MS);
		return ran.ok ? { ok: true, output: ran.output, private: false } : { ok: false, refusal: { code: "provider-failed", note: ran.note } };
	};

	return {
		async call(caller, request) {
			const started = Date.now();
			let reply: Reply;
			try {
				const resolved = resolve(caller, request);
				reply = "refusal" in resolved ? { ok: false, refusal: resolved.refusal } : await resolved.run();
			} catch (error) {
				reply = { ok: false, refusal: { code: "provider-failed", note: String((error as Error)?.message ?? error) } };
			}
			const who = caller.who === "page" ? "page" : `${caller.ticket} ${caller.member ?? "helper"} ${caller.basis}`;
			ports.log(`[gateway] ${moduleOf(caller)} ${useOf(request)} ${who} ${reply.ok ? "ok" : reply.refusal.code} ${Date.now() - started} ms`);
			return reply;
		},
		catalogue(caller) {
			const copy = callerCopy(caller, undefined);
			if (copy === undefined) return [];
			const probe = (t: Tool): Request => ({ kind: "tool", name: t.name, input: null });
			const tools = copy.tools
				.filter((t) => !memberRefusal(caller, copy, `tools/${t.name}`) && !authorityRefusal(caller, probe(t), toolEffect(t.tool)))
				.map((t) => ({ request: "tool" as const, name: t.name, title: t.tool.title, help: `${t.tool.description} 输入：${fieldsHelp(t.tool.input)}。输出：${fieldsHelp(t.tool.output)}。` }));
			const knowledge = copy.knowledge.length > 0 && !memberRefusal(caller, copy, "knowledge") ? [{ request: "knowledge" as const, name: "knowledge", title: "模块知识", help: catalogueText(knowledgeOf(copy)) }] : [];
			return [...tools, ...knowledge];
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
			return `成员 ${refusal.member} 的 uses 没有列这一项，用不了`;
		case "not-allowed":
			return refusal.sender === "inference"
				? "推断开的任务只读，不能调会改变外面东西的工具。需要时请在汇报里请使用者在对话里提出"
				: "只有使用者在对话里开、只听过使用者的话的任务才能做这件事。请在汇报里请使用者在对话里重新说一次";
		case "bad-input":
		case "provider-failed":
			return `工具这一次出错：${refusal.note}`;
	}
}
