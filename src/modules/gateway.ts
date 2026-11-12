import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUNTIMES, toolEffect, type AgentDescriptor, type Component, type Digest, type FieldDescriptor, type ModuleName } from "./manifest.ts";
import { AUTHORITY, effectOf, senderOf, type Caller, type Gateway, type Refusal, type Reply, type Request } from "./protocol.ts";
import { LIMIT_MS, runModuleCodeAsync } from "./run-code.ts";
import { scanPackage } from "./validate.ts";

export interface GatewayPorts {
	copyDir(module: ModuleName, digest: Digest): string;
	/** The version the module serves now, read from memory on every call. Undefined: switched off or gone, so its open tickets reach nothing. */
	serving(module: ModuleName): Digest | undefined;
	/** A value from the host's secrets file. */
	secret(name: string): string | undefined;
	log(line: string): void;
	limitMs?: number;
}

type Tool = Extract<Component, { kind: "tools" }>;
type Copy = { dir: string; tools: readonly Tool[]; agents: readonly AgentDescriptor[] };
type ToolRequest = Extract<Request, { kind: "tool" }>;

const fieldsHelp = (fields: Readonly<Record<string, FieldDescriptor>>) =>
	Object.entries(fields).map(([name, f]) => `${name}（${f.type}，${f.title}${f.unit ? `，${f.unit}` : ""}）`).join("、") || "无";

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
		const copy = { dir, tools: components.filter((c): c is Tool => c.kind === "tools"), agents: components.flatMap((c) => (c.kind === "agents" ? [c.agent] : [])) };
		copies.set(key, copy);
		return copy;
	};
	const callerCopy = (caller: Caller, serving: Digest | undefined) => copyOf(moduleOf(caller), caller.who === "worker" ? caller.pin.digest : serving);
	const memberRefusal = (caller: Caller, copy: Copy, tool: Tool): Refusal | undefined => {
		if (caller.who === "page" || caller.member === null) return undefined;
		const uses = copy.agents.find((a) => a.name === caller.member)?.uses ?? [];
		return uses.some((use) => use === `tools/${tool.name}`) ? undefined : { code: "not-in-uses", member: caller.member };
	};
	const authorityRefusal = (caller: Caller, request: Request, tool: Tool): Refusal | undefined => {
		const effect = effectOf(request, toolEffect(tool.tool));
		const sender = senderOf(caller);
		return AUTHORITY[effect].includes(sender) ? undefined : { code: "not-allowed", sender, note: `a ${effect} call is for ${AUTHORITY[effect].join(", ")}` };
	};

	/** The protocol's order: resolve in the pinned version, the module's state, the member's `uses`, the authority table. */
	const resolve = (caller: Caller, request: Request): { refusal: Refusal } | { copy: Copy; tool: Tool; request: ToolRequest } => {
		const serving = ports.serving(moduleOf(caller));
		const copy = callerCopy(caller, serving);
		const tool = request.kind === "tool" ? copy?.tools.find((t) => t.name === request.name) : undefined;
		if (copy === undefined || tool === undefined || request.kind !== "tool") return { refusal: { code: "no-such-capability" } };
		if (serving === undefined) return { refusal: { code: "module-disabled" } };
		const refusal = memberRefusal(caller, copy, tool) ?? authorityRefusal(caller, request, tool);
		return refusal ? { refusal } : { copy, tool, request };
	};

	const run = async ({ copy, tool, request }: { copy: Copy; tool: Tool; request: ToolRequest }): Promise<Reply> => {
		const secrets = Object.fromEntries((tool.tool.secrets ?? []).flatMap((name) => {
			const value = ports.secret(name);
			return value === undefined ? [] : [[name, value]];
		}));
		const ran = await runModuleCodeAsync(join(copy.dir, "tools", tool.name), RUNTIMES[tool.tool.runtime ?? "node"], request.input, secrets, ports.limitMs ?? LIMIT_MS);
		return ran.ok ? { ok: true, output: ran.output, private: false } : { ok: false, refusal: { code: "provider-failed", note: ran.note } };
	};

	return {
		async call(caller, request) {
			const started = Date.now();
			let reply: Reply;
			try {
				const resolved = resolve(caller, request);
				reply = "refusal" in resolved ? { ok: false, refusal: resolved.refusal } : await run(resolved);
			} catch (error) {
				reply = { ok: false, refusal: { code: "provider-failed", note: String((error as Error)?.message ?? error) } };
			}
			const who = caller.who === "page" ? "page" : `${caller.ticket} ${caller.member ?? "helper"} ${caller.basis}`;
			const what = request.kind === "tool" ? `tools/${request.name}` : request.kind;
			ports.log(`[gateway] ${moduleOf(caller)} ${what} ${who} ${reply.ok ? "ok" : reply.refusal.code} ${Date.now() - started} ms`);
			return reply;
		},
		catalogue(caller) {
			const copy = callerCopy(caller, undefined);
			if (copy === undefined) return [];
			const probe = (t: Tool): Request => ({ kind: "tool", name: t.name, input: null });
			return copy.tools
				.filter((t) => !memberRefusal(caller, copy, t) && !authorityRefusal(caller, probe(t), t))
				.map((t) => ({ request: "tool" as const, name: t.name, title: t.tool.title, help: `${t.tool.description} 输入：${fieldsHelp(t.tool.input)}。输出：${fieldsHelp(t.tool.output)}。` }));
		},
	};
}

/** What the Worker reads when the Gateway says no, so it can tell the user and wrap up. */
export function refusalText(refusal: Refusal): string {
	switch (refusal.code) {
		case "no-such-capability":
			return "本任务所属模块的这个版本里没有这个工具，能调的见 domain_tool 的说明";
		case "module-disabled":
			return "本任务所属模块已停用，它的工具都调不了了。请用 report 汇报做到哪里，然后收尾";
		case "not-in-uses":
			return `成员 ${refusal.member} 的 uses 没有列这个工具，调不到`;
		case "not-allowed":
			return refusal.sender === "inference"
				? "推断开的任务只读，不能调会改变外面东西的工具。需要时请在汇报里请使用者在对话里提出"
				: "只有使用者在对话里开、只听过使用者的话的任务才能做这件事。请在汇报里请使用者在对话里重新说一次";
		case "bad-input":
		case "provider-failed":
			return `工具这一次出错：${refusal.note}`;
	}
}
