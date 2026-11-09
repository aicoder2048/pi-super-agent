export type Role = "router" | "worker";

export interface ModelRef {
	provider: string;
	id: string;
}

export const BANNED_PROVIDERS: readonly string[] = ["anthropic"];

export const DEFAULT_MODELS: Readonly<Record<Role | "fallback", string>> = {
	router: "openai-codex/gpt-6.1-terra",
	worker: "openai-codex/gpt-6.1-sol",
	fallback: "deepseek/deepseek-flash",
};

export function parseModelRef(ref: string): ModelRef {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) throw new Error(`模型写法应为 provider/id：${ref}`);
	const model = { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
	assertAllowed(model);
	return model;
}

export function assertAllowed(model: ModelRef): void {
	if (BANNED_PROVIDERS.includes(model.provider.toLowerCase())) {
		throw new Error(`拒绝使用 ${model.provider}/${model.id}：${model.provider} 走按量计费 API，Super Agent 禁用该提供方`);
	}
}

export function formatModelRef(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}
