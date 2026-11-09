import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadRoster } from "../src/host/wiring.ts";
import { Modules } from "../src/modules.ts";
import { EXPERT_TOOLS, expertTools, toolAllowlist } from "../src/worker/tools.ts";

const modules = Modules.load([fileURLToPath(new URL("../modules", import.meta.url))]);
const config = {
	rolesDir: join(tmpdir(), "psa-no-user-roles"),
	models: { router: { provider: "openai-codex", id: "gpt-6.1-terra" }, worker: { provider: "openai-codex", id: "gpt-6.1-sol" } },
};
const roster = loadRoster(config as Parameters<typeof loadRoster>[0], modules);
const MARKET = { "market-analyst": "行情分析师", "technical-analyst": "技术分析师", "news-researcher": "新闻研究员", "earnings-reader": "财报解读" };
const PI_PI = ["agent-expert", "cli-expert", "config-expert", "ext-expert", "keybinding-expert", "prompt-expert", "skill-expert", "theme-expert", "tui-expert"];

test("仓库里的角色文件都能加载：看盘模块带来四位专家，pi-pi 模块带来九位 Pi 开发专家，牵头角色仍只有副幕僚长", () => {
	assert.deepEqual(roster.names("lead"), ["deputy"]);
	assert.deepEqual(roster.names("expert"), ["general", ...Object.keys(MARKET), ...PI_PI].sort());
	for (const [name, title] of Object.entries(MARKET)) assert.equal(roster.get(name)?.title, title, name);
	for (const name of PI_PI) assert.match(roster.get(name)!.title, /\p{Script=Han}/u, `${name} 有中文职称`);
});

test("看盘专家被会诊时拿到的工具就是它自己那份最小清单", () => {
	const tools = (name: string) => expertTools(roster.get(name)!.tools);
	assert.deepEqual(tools("market-analyst"), ["web_get", "lookup"]);
	assert.deepEqual(tools("technical-analyst"), ["lookup"]);
	assert.deepEqual(tools("news-researcher"), ["web_get", "lookup"]);
	assert.deepEqual(tools("earnings-reader"), ["web_get", "lookup"]);
});

test("大波动规则只建议请教行情分析师和技术分析师，名字都在专家名册里", () => {
	const experts = modules.ruleExperts("us-market/big-move");
	assert.deepEqual(experts, ["market-analyst", "technical-analyst"]);
	for (const name of experts!) assert.equal(roster.get(name)?.kind, "expert", name);
});

test("推断任务只读：仓库里任何角色当牵头人或被会诊，都拿不到改文件、执行命令和后台命令", () => {
	const readOnly = new Set<string>([...EXPERT_TOOLS, "report", "hand_back", "read_ticket", "consult"]);
	assert.ok(roster.get("ext-expert")!.tools!.includes("bash"), "pi-pi 专家自己写了 bash，检查才有意义");
	for (const name of roster.names()) {
		const role = roster.get(name)!;
		const inference = toolAllowlist("inference", role.tools, role.kind === "lead")!;
		assert.deepEqual(inference.filter((t) => !readOnly.has(t)), [], `${name} 在推断任务里`);
		assert.deepEqual(expertTools(role.tools).filter((t) => !(EXPERT_TOOLS as readonly string[]).includes(t)), [], `${name} 被会诊时`);
	}
});
