import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, exitOnConfigError } from "../config-error.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { moduleNameProblem } from "../modules.ts";

const manifest = (name: string) => ({
	"//": "模块清单。name 必须等于目录名。defaultEnabled 写 false 时默认不加载，可在 config.json 的 modules 里打开。改完重启宿主。",
	name,
	sources: [
		{
			"//": "通用投递来源：just drop <来源> <线程> <正文> 投进来的触发。ignore 里的正则命中正文时，触发在调用模型前就被筛掉。",
			name,
			title: name,
			description: "一句话说明这个来源是什么，显示在页面「关注的来源」里",
			ignore: [],
		},
	],
});

const rules = (name: string) => `# ${name} 模块的规则

每条规则一个二级标题，标题就是规则 id（生效时是 ${name}/<标题>）。「来源」行写这条规则适用的来源，不写时适用于本模块声明的全部来源。下面是正文。

## example
来源: ${name}
来源 ${name} 的触发正文里出现「紧急」时，开任务核实，并在对话里告诉使用者。
`;

const skillsReadme = `把这个模块的技能放在这里：每个技能一个子目录，里面写 SKILL.md（Pi 的技能格式，开头写 name 和 description）。
Worker 处理依据本模块规则开出的任务时加载这些技能。
这个说明文件用 .txt，Pi 不会把它当成技能；不要在这一层放 .md 文件，Pi 会把它们都当成技能加载。
`;

function main(): void {
	const name = process.argv[2] ?? "";
	const problem = moduleNameProblem(name);
	if (problem) throw new ConfigError(`${problem}。用法：just module-new <模块名>`);
	const config = loadConfig();
	const root = join(config.stateDir, "modules");
	const dir = join(root, name);
	if (existsSync(dir)) throw new ConfigError(`${dir} 已存在，不覆盖。换个名字，或直接编辑那里的文件。`);
	const clash = loadModules(config).found.find((m) => m.name === name);
	if (clash) throw new ConfigError(`已有同名模块 ${name}（${clash.dir}），换个名字。`);

	mkdirSync(join(dir, "skills"), { recursive: true });
	const files: [string, string][] = [
		["module.json", JSON.stringify(manifest(name), null, "\t") + "\n"],
		["rules.md", rules(name)],
		[join("skills", "README.txt"), skillsReadme],
	];
	for (const [file, text] of files) writeFileSync(join(dir, file), text, { flag: "wx" });

	console.log(`已生成模块 ${name}：`);
	for (const [file] of files) console.log(`  ${join(dir, file)}`);
	console.log("下一步：");
	console.log("  1. 编辑 module.json 和 rules.md，把示例换成你的来源和规则；技能放进 skills/。");
	console.log("  2. 重启宿主（just host），新模块才会加载。");
	console.log("  3. 运行 just modules，确认它已启用、规则和来源都对。");
	if (!config.modulesDirs.map((d) => resolve(d)).includes(resolve(root))) {
		console.log(`注意：config.json 的 modulesDirs 不包含 ${root}，宿主不会加载这个模块，请把它加进 modulesDirs。`);
	}
}

try {
	main();
} catch (error) {
	exitOnConfigError(error);
}
