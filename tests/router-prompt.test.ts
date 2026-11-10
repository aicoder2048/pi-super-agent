import assert from "node:assert/strict";
import test from "node:test";
import { routerSystemPrompt, routerTools } from "../src/host/router.ts";
import type { Kernel } from "../src/kernel/kernel.ts";
import type { Decision } from "../src/kernel/types.ts";

const ROSTER = "- news（新闻）：查新闻、核对报道来源\n- us-market（美股行情）：行情、个股、财报和相关新闻";

test("幕僚长的提示词有一份领域名册：原样列出，并说明 domain 填名册里的英文名、省略就是不属于任何领域；不再提团队", () => {
	const prompt = routerSystemPrompt("", 200, ROSTER);
	const section = prompt.slice(prompt.indexOf("## 领域"), prompt.indexOf("## 授权"));
	assert.ok(section.endsWith(`${ROSTER}\n\n`), section);
	assert.match(section, /填 domain/);
	assert.match(section, /省略就是不属于任何领域/);
	assert.doesNotMatch(prompt, /团队|team/);
});

test("没有可选的领域时，名册一节照样在，写明没有", () => {
	const prompt = routerSystemPrompt("", 200, "");
	assert.match(prompt.slice(prompt.indexOf("## 领域"), prompt.indexOf("## 授权")), /（没有可选的领域）\n\n$/);
});

test("route 工具的 open_ticket 可以带 domain，原样交给内核；没有 team 参数", async () => {
	const seen: Decision[][] = [];
	const kernel = { config: { replyMaxChars: 200 }, route: (d: Decision[]) => (seen.push(d), [{ ok: true }]) } as unknown as Kernel;
	const route = routerTools(kernel, () => {}).find((t) => t.name === "route")!;
	const item = (route.parameters as any).properties.decisions.items;
	assert.equal(item.properties.domain.type, "string");
	assert.ok(!(item.required ?? []).includes("domain"));
	assert.equal(item.properties.team, undefined);
	const decision = { kind: "open_ticket", basis: "request", triggerId: "trg_1", title: "t", brief: "b", domain: "news" };
	await (route.execute as any)("call", { decisions: [decision] });
	assert.deepEqual(seen, [[decision]]);
});
