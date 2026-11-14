# 模块技能（skills）使用备忘

2026-11-10 整理。写作时 Pi 版本 1.5.0；以下行为以本仓库代码为准，引用了出处，改代码后请一并核对。

## 1. 技能和提示词的区别

模块里有两种文字会交给模型，进上下文的方式不同：

| | 是什么 | 进上下文的方式 | 代价 |
|---|---|---|---|
| 提示词 | 成员 `agents/*.md` 的正文、宿主里的 `WORKER_PROMPT` / `MEMBER_PROMPT`（`src/host/pi-worker.ts`） | 每次调用都整段带上 | 一直占上下文 |
| 技能 | `skills/<名字>/SKILL.md`，Pi 的标准技能格式 | 系统提示词里只放 `name` 和 `description`；模型觉得用得上时才用 `read` 读全文 | 用到才花 |

由此得出两条写法规则：

- 每次都要遵守的短规则（例如「读过的文件不重读」）写进提示词。
- 篇幅长、只有某些任务用得上的知识（例如接口速查、派活做法）写成技能。`description` 要写清什么时候该读，模型靠它决定读不读。

技能要生效有两个前提：拿到它的助手或成员要有 `read` 工具（`tests/unit/first-teams.test.ts` 里有断言）；`SKILL.md` 要符合 Pi 的格式。`name` 只用小写字母、数字和连字符，最多 64 字符，最好和目录名一致；`description` 最多 1024 字符（见 Pi 的 `docs/skills.md`）。

例子：pi-pi 模块的 `pi-pi-desk`（给助手的派活做法）和 `pi-extension-basics`（扩展接口速查和原文索引）都是技能。九位专家的 `agents/*.md` 是提示词。

## 2. 技能放在哪里

Pi 本身有两种技能范围；Super Agent 不用这两种，用的是模块技能：

| 位置 | 范围 | Super Agent 的助手和成员能拿到吗 |
|---|---|---|
| `~/.pi/agent/skills/` | Pi 全局（user scope） | 拿不到 |
| 项目里的 `.pi/skills/` | Pi 项目（project scope），Pi 自动发现 | 拿不到 |
| `<模块目录>/skills/` | Super Agent 模块技能 | 只有这个模块领域的任务能拿到 |

原因：宿主启动助手和成员时先传 `--no-skills` 关掉 Pi 的自动发现，再用 `--skill <模块>/skills` 只加载本模块的技能（`src/host/pi-worker.ts` 的 `workerArgs` 和 `runMember`）。所以：

- 你直接运行 `pi` 时看不到模块技能。
- 你装在 `~/.pi/agent/skills/` 的技能，Super Agent 的助手和成员也拿不到。
- 仓库里 `.pi/skills/` 下的东西（例如笑话任务留下的 `joke`）是 Pi 的项目技能，和模块技能无关。

## 3. 模块目录有两处

宿主默认从两个目录读模块（`src/host/config.ts` 的 `modulesDirs`，可在 `config.json` 里改）：

| 目录 | 放什么 | 进不进仓库 |
|---|---|---|
| 仓库的 `modules/` | 随代码发布的模块：`pi-pi`、`us-market`、`toy-market` | 进 |
| `~/.pi-super-agent/modules/`（状态目录） | 你自己的私人模块，例如带私人规则的邮件领域 | 不进 |

状态目录的 `modules/` 不需要存在，不存在时宿主直接跳过（`src/modules.ts` 的 `Modules.load`）。设计依据是 ADR-0009：「使用者自己的领域也是模块，放在 `<状态目录>/modules/<名字>/`」。

一个模块的样子，两处一样：

```
<模块目录>/<名字>/
├── module.json              必须有。name 等于目录名；写了 title 和 description 才进幕僚长的领域名册
├── rules.md                 可选：规则
├── skills/<技能>/SKILL.md   可选：技能
└── agents/*.md              可选：成员，同时要在 module.json 写 team（队名）
```

限制：

- 两处有同名模块时，宿主启动报错。
- 状态目录下零散的 `agents/`、`teams.yaml` 不再读取，存在时启动报错并提示搬到哪里。
- 模块只在宿主启动时加载一次，新增或修改后要重启 `just host`。

## 4. 谁会用到模块技能

1. **宿主**：启动时加载全部模块（`src/host/main.ts`）。
2. **幕僚长**（Router）：开任务时从领域名册里选领域；规则开出的任务，领域就是规则所在的模块（ADR-0009）。幕僚长自己拿不到模块技能。
3. **这个领域任务的助手**：拿到模块的 `skills/`。
4. **这个领域的成员**：拿到模块的 `skills/`，再加成员文件 frontmatter 里 `skills` 写的目录（`src/modules.ts` 的 `kitFor`）。成员自己的技能目录必须在它的 `agents/` 目录里面。

没有领域的任务是单个助手，不带任何模块技能，也没有成员可派。

## 5. 新增或修改技能的检查清单

1. 放在模块的 `skills/<名字>/SKILL.md`。私人的放状态目录的模块，要发布的放仓库的 `modules/`。
2. 写好 `name` 和 `description`。`description` 写清「什么任务、什么时候读」，例如「动手前先读」或「成员不用读」。
3. 依据外部文档提炼的知识，写明依据的版本和原文位置，并告诉读者版本不同时以原文为准。
4. 长文档配一个章节索引，并写清怎么只读一节。注意 Pi 的 `grep` 工具用 ripgrep 正则：「或」写 `|`，不写 `\|`。
5. 加测试。参考 `tests/unit/first-teams.test.ts`：
   - 技能能被模块加载，助手和成员都拿得到。
   - 技能里写到的 `pi.*` / `ctx.*` 接口在本机 Pi 的 `types.d.ts` 里都有。
   - 索引里每一项都是原文里真实存在的标题。
6. 用 Pi 自己的加载函数核对没有诊断。在仓库根目录写一个小脚本（例如 `check.mjs`）：

   ```js
   import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
   const { skills, diagnostics } = loadSkillsFromDir({ dir: process.argv[2], source: "check" });
   console.log(skills.map((s) => s.name), diagnostics);
   ```

   然后运行：

   ```bash
   node --import ./src/pi-runtime.mjs check.mjs modules/<名字>/skills
   ```

7. 重启宿主，跑一个这个领域的真实任务，在执行过程里确认助手或成员读了这份技能。

## 6. 参考

- ADR-0008：助手可以带一个团队。
- ADR-0009：任务属于一个领域，领域就是模块。
- ADR-0012：成员的长回复由宿主存成文件。
- `docs/modules/module-design-review.md`：模块设计评审，第二节是 Pi专家队的 token 分析。
- `GLOSSARY.md`：模块、成员、团队、派活。
