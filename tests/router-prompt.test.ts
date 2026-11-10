import assert from "node:assert/strict";
import test from "node:test";
import { routerSystemPrompt, routerTools } from "../src/host/router.ts";
import type { Kernel } from "../src/kernel/kernel.ts";
import type { Decision } from "../src/kernel/types.ts";

const ROSTER = "- 新闻队：查新闻、核对报道来源\n- 看盘队：盯行情：技术面、新闻和财报";

test("幕僚长的提示词有一份团队名册：团队名和说明原样列出，并说明 team 省略就是默认团队", () => {
	const prompt = routerSystemPrompt("", 200, ROSTER);
	const section = prompt.slice(prompt.indexOf("## 团队"), prompt.indexOf("## 授权"));
	assert.ok(section.endsWith(`${ROSTER}\n\n`), section);
	assert.match(section, /team 省略就是默认团队/);
});

test("没有别的团队时，名册一节照样在，写明只有默认团队", () => {
	const prompt = routerSystemPrompt("", 200, "");
	assert.match(prompt.slice(prompt.indexOf("## 团队"), prompt.indexOf("## 授权")), /（没有别的团队）\n\n$/);
});

test("route 工具的 open_ticket 可以带 team，原样交给内核", async () => {
	const seen: Decision[][] = [];
	const kernel = { config: { replyMaxChars: 200 }, route: (d: Decision[]) => (seen.push(d), [{ ok: true }]) } as unknown as Kernel;
	const route = routerTools(kernel, () => {}).find((t) => t.name === "route")!;
	const item = (route.parameters as any).properties.decisions.items;
	assert.equal(item.properties.team.type, "string");
	assert.ok(!(item.required ?? []).includes("team"));
	const decision = { kind: "open_ticket", basis: "request", triggerId: "trg_1", title: "t", brief: "b", team: "新闻队" };
	await (route.execute as any)("call", { decisions: [decision] });
	assert.deepEqual(seen, [[decision]]);
});
