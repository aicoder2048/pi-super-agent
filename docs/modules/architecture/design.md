# 领域模块架构设计：目录就是清单，一个能力协议服务一切

这份设计只出方案，不改宿主代码。配套文件有四组。`sketch/` 是类型草图、能运行的校验器和三份测试。`sample/personal-health/` 是按这个布局写出的医疗健康模块包。`sample/broken/` 是二十二个必须被拒绝的坏包。`sample/update/` 是同一个模块的四个版本，演示数据结构只能加。括号里的编号对应 `requirements.md`。

草图里有函数体的部分都跑过。`validate.ts` 和 `sandbox.ts` 是整个文件。`lifecycle.ts` 是 `transition`、`resume`、`settle`、`describe`。`manifest.ts` 是 `derivePermissions`、`feedClass`、`needsCard`、`grantChanges`、`toolEffect`、`structureProblems`。`protocol.ts` 是 `effectOf`、`allowed`、`mayRead`、`mayContinueOn`、`triggerBodyFor`。其余只有签名。`node --test sketch/*.test.ts` 跑 29 条测试。测试文件和草图在同一个 `tsconfig.json` 里做类型检查。

文中写「实测」的句子，都是这一轮在这台机器上运行得到的结果（macOS，Homebrew 装的 Node 26.5）。

## Problem

使用者要一次把「领域模块」的架构理清。加一个领域不改宿主（G1）。模块能插拔（G2）。不懂编程的人能做出一个模块（G3）。一个领域要的东西都放得进同一个模块（G4）。安全和功能分开处理（G5）。目标模块是个人医疗健康，它同时用到知识、数据、工具、技能、feed 和专家团队六类组成。

今天的形状挡住了这些目标，原因有四个，都来自 `current-state.md`。

1. 宿主启动时把 `Modules` 读成一个不可变对象，然后拆开塞进内核、幕僚长的提示词、Worker 执行器、feed 表和页面。没有一个地方能在运行中换掉它。
2. 模块只能带数据和路径。要执行的东西都在宿主的 `src/sources/` 里，靠 `FEEDS` 和 `DOMAIN_GATED_TOOLS` 两张写死的表登记。`Feed` 接口是照行情长出来的，`tripwires()` 是必填项。
3. 个人数据没有位置。自选股写在 `module.json` 里，盯盘条件是按来源名存的一个不透明文本。`state.db` 里没有一张表按模块做键。
4. 一个坏模块能让宿主起不来，哪怕它是停用的。

设计必须守住这些约束。ADR-0003 规定权威只来自使用者的话、规则文件和宿主出的卡片。ADR-0002 规定幕僚长在进程内，Worker 是子进程。ADR-0009 规定一个任务属于一个领域。ADR-0017 规定宿主行不经过幕僚长。一台宿主只服务一个人。宿主里不假设任何按量计费的模型。设计有意推翻的是 ADR-0005 里「模块不带代码」那一条。

有两个事实必须写在最前面。

第一，`request` 和 `rule` 任务的 Worker 带着 `bash`，和宿主是同一个系统用户，没有沙箱。这份设计里所有「Worker 只能经工具读数据」的保证，在 Worker 沙箱落地前都只对守规矩的 Worker 成立。

第二，宿主今天只在 macOS 上运行。模块代码的沙箱用的是 macOS 的 `sandbox-exec`。别的操作系统要先有自己的沙箱配置，模块代码才许在那里运行。

设计有两条主线。第一条是目录就是清单。模块里有什么，由文件夹说了算，没有第二份要手工同步的清单，权限也不例外。第二条是一个能力协议。模块在运行时做的每一件事都走同一个入口。「Tradeoffs accepted」写明这两条在哪里吃力。

## Usage (caller's view)

先写三种使用者眼里的样子，类型草图从这里推出来。

### 做模块的人看到的

一个模块就是一个文件夹。放进去一个子文件夹，就多一个组成。没有任何地方要「登记」它，也没有任何地方要写「我要什么权限」。

```
personal-health/                       模块包：对任何人都一样的内容，只读
  module.json                          只有两样：是谁、哪个版本
  README.md
  rules.md                             什么情况下开任务
  knowledge/<名字>/source.json         一份知识的出处、版本、权威程度、能不能随包分享
  knowledge/<名字>/*.md                正文（只有可分享的才放）
  data/<名字>/collection.json          一类数据长什么样、属于哪一级、能不能设提醒条件
  data/<名字>/seed.json                随包分享的默认行（只有可分享的那一级才许有）
  tools/<名字>/tool.json               输入、输出、单位、公式出处；联网的还要写地址和效果
  tools/<名字>/index.ts                计算代码
  tools/<名字>/cases.json              测试用例
  skills/<名字>/SKILL.md               一个技能（文件夹里只许有 Markdown）
  feeds/<名字>/feed.json               用哪个连接器、多久看一次、问使用者要什么、结果去哪里
  feeds/<名字>/index.ts                只有要解析特殊格式时才有
  feeds/<名字>/fixtures/*.json         预演用的样例
  agents/<名字>.md                     一位专家。开头几行写它有哪些 Pi 工具、能用模块里的哪些能力
  evals/<名字>.md                      一道考题
```

这张图就是全部。图上没有的文件和文件夹，校验器一律拒绝。符号链接也一律拒绝。

`module.json` 的全部内容：

```json
{
  "schema": 1,
  "name": "personal-health",
  "version": "0.1.0",
  "title": "个人医疗健康",
  "description": "体检和检验报告、用药、指标跟踪和越线提醒、多学科会诊",
  "team": "健康顾问团"
}
```

组成用到什么，写在组成自己的描述文件里。下面是 us-market 迁移后查报价的工具，它要联网：

```json
{
  "title": "查报价",
  "description": "查一只股票的最新报价",
  "input": { "symbol": { "type": "text", "title": "代码" } },
  "output": { "price": { "type": "number", "title": "最新价" } },
  "network": [{ "host": "api.massive.com", "perMinute": 5, "secret": "MASSIVE_API_KEY" }],
  "effect": "read"
}
```

三条命令覆盖制作的全过程：

```
just module new heart-failure --template team   # 复制一个模板文件夹
just module check ~/.pi-super-agent/modules/heart-failure
ok heart-failure@0.1.0 | knowledge=1 data=0 tools=0 skills=2 feeds=0 agents=3 evals=1 | rules=0 code=0 | data-classes=none | derived-permissions=connectors:none network:none host:none members:none | card=no | digest=... grant-key=... granted-files=5
just module try heart-failure                   # 预演：临时状态目录、假连接器、不发 Telegram
```

校验失败时，每个问题一行，带路径和原因：

```
tools/bmi/cases.json: test case 1 "70 千克、1.75 米" failed: expected {"bmi":22.857}, got {"bmi":40}
skills/notes/upload.ts: is code, but not the entry of a tool or a feed handler; no other code may be in a package
skills/shared: is a symbolic link; a package holds real files and folders only
module.json: unknown key "permissions"
```

### Worker 看到的

不管任务属于哪个模块，Worker 只多出四个工具，名字固定：`domain_tool`、`knowledge`、`data`、`watch`。宿主在启动 Worker 时给它这个任务能用的目录。目录来自任务钉住的那个版本，并且已经按成员的 `uses` 收窄。

```
domain_tool { name: "insulin-sensitivity", input: { fastingGlucose: 5.0, fastingInsulin: 10 } }
  -> { homaIr: 2.2222, quicki: 0.3385 }

knowledge { op: "search", query: "HFrEF SGLT2 抑制剂 推荐等级" }
  -> [{ doc: "2022-aha-acc-hfsa-hf", title: "…心力衰竭管理指南", version: "2022",
        authority: "authoritative", section: "7.3.4", text: "…" }]

data { collection: "lab-results", op: "query", query: { where: { item: "CEA" }, limit: 20 } }
  -> [{ id: "…", fields: { item: "CEA", value: 5.2, … }, confirmed: false,
        from: { collection: "documents", row: "…" } }]
  或者拒绝：{ code: "provider-not-routed", class: "private", provider: "deepseek" }

data { collection: "lab-results", op: "put", rows: [ … ], from: { collection: "documents", row: "…" } }
  -> 写进去的行，每一行 confirmed 都是 false

watch { collection: "lab-results", op: "set", watch: { key: "CEA", condition: { when: "rising-streak", times: 3 } } }
  -> 当前清单；或者拒绝：{ code: "not-allowed", sender: "rule", note: "改提醒条件要使用者亲口要求" }
```

### 写模块代码的人看到的

工具是一个默认导出的函数。feed 的代码是另一个默认导出的函数。它们不 `import` 宿主的任何东西，也不 `import` 包里的别的文件。

```ts
// tools/insulin-sensitivity/index.ts
export default function insulinSensitivity(input: { fastingGlucose: number; fastingInsulin: number }) {
	return { homaIr: (input.fastingGlucose * input.fastingInsulin) / 22.5, quicki: /* … */ 0 };
}

// tools/quote/index.ts：联网的工具多拿到一个 host，只有 fetch
export default async function quote(input: { symbol: string }, host: { fetch(url: string): Promise<{ status: number; body: string }> }) {
	const reply = await host.fetch(`https://api.massive.com/…/${input.symbol}`);
	return { price: JSON.parse(reply.body).price };
}

// feeds/device-webhook/index.ts：厂商格式进，设备读数出
export default function parse(input: { items: Item[] }): { records: Reading[] } { /* … */ }
```

### 宿主内部的三个调用点

```ts
// 1. 内核改一处：domains 从一张表变成一个函数，内核每次用时调用它
const live = createLiveRegistry();
new Kernel({
	domains: () => live.current().domainBook(),
	sourcePolicy: (trigger) => live.current().sourcePolicy(trigger),
	ruleAllows: (rule, source) => live.current().ruleAllows(rule, source),
});

// 2. 生命周期：纯函数算出下一条记录，记录自己带着还没做的动作
await lifecycle.submit(module, { type: "granted", cardId, at });
//    里面是：record = transition(record, event).record，存下，再按顺序做 record.pending

// 3. Worker 的每一次模块调用都走同一个入口
const reply = await gateway.call(caller, { kind: "tool", name, input });
```

## Shape

### 1. 第一条规则：模块包和实例数据（I1 I2 I3 D1）

判断一样东西放哪边，只问一句：**换一个使用者，它还一样吗？** 一样的进模块包，不一样的进实例数据。使用者的病历、阈值、自选股、文件夹位置、各服务的授权，都是实例数据。

```
<stateDir>/modules/<name>/                  使用者自己装的模块包（仓库里的 modules/ 是内置的）
<stateDir>/module-store/<name>/<digest>/    宿主留的只读副本，一个版本一份，按内容哈希命名
<stateDir>/modules-data/<name>/             这个模块的实例数据
  data.db                                   各个 collection 的行（每行记着来源原件和是否已确认）、提醒条件、
                                            feed 游标、使用者填的设置、访问记录、当前结构来自哪个版本
  blobs/<sha256>                            报告原件
  knowledge/<doc>/                          使用者自己导入的受版权保护的全文
  index/                                    知识检索索引，可以随时重建
<stateDir>/connectors/<id>/                 连接器的授权（OAuth 令牌），属于宿主，不属于任何模块
state.db                                    每个模块的生命周期记录（状态、授权、还没做完的动作）、
                                            任务钉住的版本、每个模型会话读过的最高数据级别
config.json                                 使用者的 dataRoutes：每一级数据能给哪些模型提供方读
```

- 宿主从不往模块包里写（I1）。它要一份稳定的副本时，写的是自己的 `module-store/`。副本里只有扫描认可的文件。
- 实例数据按模块隔离，只有 `InstanceData` 这一个模块能打开它（I2）。模块自己的代码也拿不到文件，只能经 `HostPort.query` 读自己 collection 的行。这一条由操作系统的沙箱执行，见第 5 节。
- 拿掉模块包，状态变成「包不在了」，数据原样留着。包回来，接上（I3）。删除数据是单独的动作，需要使用者亲手确认，不可恢复。
- 规则落在校验器里，不靠自觉。`data/<名字>/` 里只许有 `collection.json` 和 `seed.json`。`seed.json` 是随包分享的默认行，例如默认自选股，只许出现在 `shareable` 的 collection 里。坏包 `seed-in-private-collection` 就是这一条。feed 里使用者要填的东西写在 `ask` 里，答案存进实例数据，包里只有问题。
- 实例数据不分版本。它只有一份，所有版本的任务读的都是它当前的结构。第 6 节说明为什么这是安全的。

### 2. 清单：声明什么，推导什么（S2）

`module.json` 只有身份（`name`、`title`、`description`、`team`）和版本。**组成清单不声明，权限也不声明，两样都由扫描目录推导。**

| 在哪里 | 内容 |
|---|---|
| `module.json` | 身份、版本 |
| 每个组成自己的描述文件 | 这个组成是什么，它用到什么（连接器、网络地址和额度和密钥名字、Pi 工具、模块里的能力），它的数据属于哪一级 |
| 推导出来，不写 | 组成清单、权限、来源名（`<模块>/<feed>`）、feed 的级别、规则的默认范围、工具的效果、版本哈希、需不需要出卡片 |

**权限是推导出来的。** 纯函数 `derivePermissions`（`sketch/manifest.ts`）读全部组成，算出确认卡片上显示的那一份权限。规则有八条：

| 描述文件里写了 | 推导出 |
|---|---|
| `feed.json` 的 `connector` | 用这个连接器 |
| `feed.json` 的 `notice` | 宿主能力 `trigger`，给幕僚长发触发 |
| `feed.json` 的 `into` | 这个 feed 的级别，等于它写进去的那个 collection 的级别。没有 `into` 的 feed 是 `local-only` |
| `collection.json` 的 `watch` | 宿主能力 `alert`，条件满足时直接提醒使用者 |
| `collection.json` 的 `class` | 这个 collection 存的数据属于哪一级 |
| `tool.json` 或 `feed.json` 的 `network` | 这些地址，每个地址带额度和密钥名字 |
| `tool.json` 的 `servedBy` | 这项宿主能力，以及宿主给它定死的效果（`authoring` 是 `write`） |
| `agents/<名字>.md` 开头的 `tools` | 哪位成员有能改文件、能运行程序的 Pi 工具（`bash`、`write`、`edit`） |

所以卡片上的权限永远正好是模块实际用到的，没有第二份清单可以和它对不上。`module.json` 里写 `permissions` 会被拒绝，和任何不认识的键一样（坏包 `hand-written-permissions`）。写 `skills`、`tools`、`sources` 这类键也被拒绝（坏包 `declares-components`）。今天的宿主对不认识的键是悄悄忽略。

备忘第 4 节画的 `module.json` 里列着权限和组成。这份设计把两样都改成了推导，`module.json` 里没有它们。目录的布局和备忘一致，清单的内容和备忘不一致，这是有意的。

一个模块对一个地址只有一份额度和一个密钥。两个组成用同一个地址时，各自写的 `perMinute` 和 `secret` 必须相同，不同就拒绝。比较之前，地址先转成小写并去掉末尾的点，所以 `API.Example.com.` 和 `api.example.com` 是同一个地址（坏包 `one-host-two-budgets`）。密钥只和网络地址绑在一起。宿主的代理在发往这个地址的请求上附上密钥，模块代码从头到尾拿不到密钥的值，也就没法把它发到别处。

**闭包规则。** 包里能有的代码文件只有两种：工具的 `index.ts`，和 `feed.json` 点名的那个 handler。别处的代码文件一律拒绝，布局没有定义的文件和文件夹也一律拒绝（坏包 `stray-code`）。理由是带 `bash` 的 Worker 能运行它读得到的任何脚本。技能文件夹里藏一个脚本，它不在确认卡片上，却可能被运行。有了闭包规则，卡片上列出的代码文件就是包里的全部代码。闭包规则有三条配套的规定：

- **符号链接一律拒绝**，不管它在哪里、指向哪里，报错时点名（坏包 `symlink-in-package`，它用一个链接把另一个文件夹里的脚本带进技能目录）。链接能让扫描、哈希和 Worker 看到包外面的文件。
- **以点开头的文件和文件夹不算包的一部分。** 它们不计入哈希，不复制进副本。检查工具用例时，代码从一份只含认可文件的临时副本启动，所以点开头的文件根本不在那里（坏包 `tool-imports-dot-file`）。
- **代码进程只读得到入口文件这一个文件。** 它读不到同一个文件夹里的 `tool.json` 和 `cases.json`。所以代码没法藏在描述文件里再由入口取出来执行，测试的期望值也到不了被测的代码手里。

**扫描产出两个哈希。**

- `digest`：全部文件的哈希。任务钉住的就是它。
- `grantKey`：使用者点卡片确认的东西。规则只有一句：**包里的每一个文件都算，Markdown 正文和测试材料除外。**

具体说，`grantKey` 包含 `module.json`（不含 `version` 那一行）、每一个描述文件（`tool.json`、`feed.json`、`collection.json`、`source.json`、`seed.json`）、每一个代码文件、`rules.md` 全文、每个 `agents/*.md` 开头的 front matter。它不包含技能、知识和专家提示词的 Markdown 正文，不包含 `README.md` 和 `NOTICE.md`，不包含 `evals/`、`cases.json` 和 `fixtures/`。每个文件按「路径长度、路径、内容长度、内容」的顺序进哈希，两组不同的文件不可能拼出同一串字节。扫描同时留下每个文件各自的哈希（`PackageScan.granted`），宿主把它和授权一起存下。

**什么时候不出卡片。** 只有一种包不用卡片：没有 `rules.md`，没有代码，除了 `module.json` 和知识的 `source.json` 以外没有别的描述文件，并且没有哪位成员列了 `bash`、`write`、`edit` 或任何 `uses`。这样的包只有技能、知识和只读的成员，做不出今天默认之外的事。纯函数 `needsCard` 就是这一条。今天的 pi-pi 属于这一种。只有规则的模块要出卡片，因为规则决定什么时候开任务。

**专家文件里哪一部分带权力。** 正文不带，它只是提示词。front matter 带，因为 `tools` 决定成员有哪些 Pi 工具，`uses` 决定它能调用模块里的哪些能力。所以 front matter 要校验，也在 `grantKey` 里。`tools` 必须写，每一个都必须是宿主认识的成员工具（今天 `src/worker/tools.ts` 的 `MEMBER_TOOLS`）。不认识的工具名被拒绝（坏包 `agent-unknown-tool`），front matter 里不认识的键也被拒绝。今天的宿主对没写 `tools` 的成员是「不加限制」，新布局里没写就是拒绝。

**制作工具要的 `authoring` 写在哪里。** 写在它的一个工具描述文件里：`tools/draft/tool.json` 写 `"servedBy": "authoring"`。这个工具没有 `index.ts`，由宿主来服务，`derivePermissions` 由它推导出宿主能力 `authoring`。宿主服务的工具不许自己写 `effect`，效果由宿主按能力定死，`authoring` 是 `write`（坏包 `host-served-tool-states-effect`，它想把起草工具写成 `read`）。宿主不认识的 `servedBy` 被拒绝。选这个位置有两个理由。第一，权限一律来自组成的描述文件，这里不开例外。第二，Worker 经 `domain_tool` 调用它，`Gateway` 已有的检查全部适用，不用为制作工具多一种请求。

### 3. 六类组成：包里的位置和宿主里的机制（G4）

| 组成 | 包里的位置 | 谁来服务 | Worker 怎么用到 |
|---|---|---|---|
| 知识 K1 | `knowledge/<doc>/source.json` 加 `*.md` | 宿主的默认提供者。按标题切段，建全文索引 | `knowledge { search \| read }`，每段带文档、版本、章节、权威程度 |
| 数据 K2 | `data/<collection>/collection.json` | 宿主的默认提供者。`data.db` 加 `blobs/` | `data { query \| put \| open-blob }`，按分级和路由放行，每次调用记一笔 |
| 工具 K3 | `tools/<tool>/{tool.json,index.ts,cases.json}` | 模块的代码，每次调用一个新进程 | `domain_tool { name, input }`。不联网的工具和只读的联网工具，推断任务也能用 |
| 技能 K4 | `skills/<skill>/SKILL.md` | 不经过协议。Pi 从任务钉住的副本读文件 | `--skill <副本>/skills` |
| Feeds K5 | `feeds/<feed>/feed.json`，可带一个 handler | 连接器（宿主）加可选的解析代码（每次调用一个新进程） | Worker 不调用。只有宿主的调度器调用 |
| 专家团队 K6 | `agents/<name>.md` | 不经过协议。宿主读成员定义，派活时启动成员 | `dispatch_agent`。成员的 `tools` 和 `uses` 决定它够得着什么 |

**K1 知识。** `license` 是 `user-import` 的文档，包里只有出处，不许有正文（坏包 `bundled-copyrighted-text`）。使用者在模块页导入自己取得的全文，放进实例数据。缺正文时模块照常启用，页面写明「缺 1 份知识，请导入」。随包的知识算 `shareable`，使用者导入的全文算 `private`。检索用 SQLite 全文索引，不用向量（见 D6）。实测：Node 26.5 自带的 SQLite 是 3.54.1，带 FTS5 和 trigram 分词，中文按子串能查到。

**K2 数据。** `collection.json` 写字段、类别（`record` 或 `series`）和分级。原件进 `blobs/`，结构化的行进 `data.db`，行里用 `blob` 类型的字段指向原件。导入有两条路：使用者在模块页拖进文件，或者 feed 送来。之后由技能（例如 `report-review`）解读，把数值写进 `series`。`watch` 点名的三个字段必须是这个 collection 自己的字段（坏包 `watch-names-inherited-key`，它点了 `constructor` 和 `toString`）。

**提取出来的行先是「未确认」。** Worker 写进去的每一行都带 `confirmed: false`。它是从一份原件里读出来的，就在 `put` 里用 `from` 指明那份原件。模型从 PDF 里读数值会读错，所以这些行在使用者核对之前不算定论。使用者在模块页上对照原件确认或改正，这是只有页面能发的请求（`data confirm`）。feed 的代码送来的行和使用者自己填的行，从一开始就是已确认的。未确认的数据点照常参加条件检查，见第 7 节。

**K3 工具。** 一个工具三件东西，缺一样都拒绝。校验和启用前，宿主跑一遍 `cases.json`，有一条不对就是「无效」，原因写到第几条（坏包 `tool-case-fails`）。`sketch/validate.ts` 真的这样跑，做法有四条：

1. 每条用例起一个新进程，进程在第 5 节的两层沙箱里。
2. 进程只拿到这一条用例的输入，联网的工具再多拿到 `replay` 里的假应答。它拿不到期望值。
3. 进程交回一个值。和期望值比较这一步在沙箱外面，由校验器做。
4. 进程从一份只含认可文件的临时副本启动，不从作者的文件夹启动。

所以工具没法自己写一份「通过」的结论（坏包 `tool-forges-verdict`）。实测：读别处的文件被挡住（坏包 `tool-reads-outside`），自己发请求被挡住（坏包 `tool-fetches-directly`），用 `node:sqlite` 打开别处的文件被挡住（坏包 `tool-opens-sqlite-outside`），给启动它的进程发信号被挡住（坏包 `tool-signals-parent`）。机器上没有 `/usr/bin/sandbox-exec` 时，检查直接失败并写明原因，不会退回到不带沙箱地运行。实测：把草图里的这个路径改成一个不存在的文件，医疗样例被拒绝，原因是 `cannot be checked: … is missing`。

工具的效果只有三种。没有 `network` 的工具是 `pure`，不用写，写了反而被拒绝。有 `network` 的工具必须写 `effect`，取 `read` 或 `write`（坏包 `network-tool-without-effect`）。`read` 是一个承诺，承诺这次调用不改变外面的任何东西。宿主的代理让它兑现，`read` 的工具只放行 GET。联网工具的测试用例必须带 `replay`，校验从不碰真网络。今天 us-market 的 `lookup` 里查报价、查财报，迁移后就是几个 `effect` 为 `read` 的工具。

**K4 技能。** 和今天一样。技能文件夹里只许有 Markdown。「越线预警」不靠技能记，靠第 7 节的条件机制，技能里只教 Worker 怎么用 `watch`。

**K6 专家团队。** 成员文件的 front matter 写 `tools` 和 `uses`。`uses` 列出它能用的能力，例如 `uses: knowledge, data/lab-results, tools/insulin-sensitivity`。没列的调不到，引用了包里没有的会被拒绝（坏包 `agent-unknown-capability`）。影像科顾问能读 `documents`，临床药师只能读 `lab-results`，这就是「按数据权限分工」。会诊先做成一个技能（`skills/mdt`）：领队把同一份材料清单同时派给几位成员，各自回复，再汇总并列出分歧。今天的 `DispatchDesk` 已经支持并行派活，所以不用改宿主。常用以后再考虑做成宿主的协作模式。

### 4. 一个能力协议（G1 S1）

模块在运行时做的每一件事，都是一次 `Gateway.call(caller, request)`（`sketch/protocol.ts`）。`Request` 是一个封闭的联合类型：`tool`、`knowledge`、`data`、`watch`、`feed`。`Gateway` 是唯一的入口，它按固定顺序做七件事：

1. 在调用者**钉住的那个版本**里找到这个能力。找不到就拒绝。别的模块的能力根本不在目录里，今天「拿到 `lookup` 就能查宿主上所有 feed」的缺口因此关上。
2. 看模块状态，读的是 `state.db` 里的生命周期记录。停用了就返回 `module-disabled`。
3. 成员调用时，查它的 `uses`。
4. 用 `allowed(caller, request)` 查权限表。
5. 用 `mayRead` 对照数据分级和使用者的路由表（第 8 节）。
6. 交给提供者。
7. 给结果贴上分级，把这个会话读过的最高级别抬到这一级，在模块的访问记录里记一笔。

**权限表按效果和调用者的种类两头做键。** 效果有四种，由 `effectOf` 算出。调用者有六种，由 `senderOf` 算出。「只听过使用者的 request 任务」单独算一种，它是唯一带着使用者权威的 Worker（ADR-0003）。任务只要读过不是使用者亲口说的内容，就不再是这一种。

| 效果 | 哪些请求 | 只听过使用者的 request 任务 | 其他 request 任务 | rule 任务 | 推断任务 | 页面 | 调度器 |
|---|---|---|---|---|---|---|---|
| `pure` | 没有 `network` 的工具 | 可以 | 可以 | 可以 | 可以 | 可以 | 不行 |
| `read` | 查知识、读数据、看条件清单、`effect` 为 `read` 的联网工具 | 可以 | 可以 | 可以 | 可以 | 可以 | 不行 |
| `write` | 写数据、`effect` 为 `write` 的工具、宿主服务的 `authoring` 工具 | 可以 | 可以 | 可以 | 不行 | 可以 | 不行 |
| `user-authority` | 改提醒条件 | 可以 | 不行 | 不行 | 不行 | 可以 | 不行 |

有两种请求各自只有一个发送者，不看效果：

| 请求 | 只有谁能发 |
|---|---|
| `data confirm`（确认或改正一行） | 页面 |
| `feed collect`（把一批 `items` 交给 feed） | 调度器。调度器也只发这一种 |

`sketch/protocol.ts` 里的 `allowed` 就是这两张表，`sketch/protocol.test.ts` 把 14 种请求乘 6 种调用者的 84 个格子逐个核对过。推断任务只许 `pure` 和 `read`。所以只读的联网工具推断任务能用，今天推断任务能调用 `lookup`，迁移后这一点不变。`user-authority` 那一行就是今天 `#tripwireRefusal` 的规则，从盯盘专用变成对所有模块通用（S4）。

工具的效果有三个来源。没有 `network` 的是 `pure`，有 `network` 的是它自己写的 `read` 或 `write`，宿主服务的由宿主定死（`toolEffect`）。包没法把一个会写东西的宿主工具标成 `read`。

提供者只有两种，`Gateway` 不区分：

- **宿主的默认提供者**：知识检索、数据读写、条件、只用连接器的 feed、带 `servedBy` 的工具。模块什么代码都不用写。
- **模块的代码**：工具和 feed 的 handler。

**每次调用一个新进程（S1）。** 宿主为每一次工具调用、每一次 handler 调用起一个进程，进程在第 5 节的两层沙箱里，只读得到入口文件，环境变量是空的，有时限。调用结束进程就退出。实测：带两层沙箱起一个空的 Node 进程大约 26 毫秒，不带沙箱大约 22 毫秒，操作系统那一层多出来大约 5 毫秒。进程再加载一个一行的 `.ts` 入口文件，合计大约 44 毫秒，多出来的是 Node 剥离类型的时间。每个数是 20 次启动的平均，跑了三轮，各轮相差不到 1 毫秒。这些数不包括代码自己的运行时间。

进程和宿主之间是进程的标准输入输出上的 JSON 行。没有 socket，没有令牌，所以没有 `PSA_TOKEN` 那种能从 `ps` 里偷走的东西。宿主发一行 `run`，进程在运行中可以向上问宿主，最后回一行 `done`。进程只拿到输入。对它的输出下任何结论，都在进程外面。向上的调用只有三个（`HostPort`）：

- `fetch`：只能到这个组成的 `network` 里写过的地址。宿主代发，限速，附密钥，不跟随到别处的跳转。
- `query`：读自己模块的行。带 `network` 的代码只读得到 `shareable` 的行，见第 8 节。
- `watchedKeys`：使用者在一个 collection 上盯着哪些 key。

没有常驻进程，所以没有闲置退出，没有崩溃恢复，停用时也没有进程要杀。一次调用崩了，只是这一次调用失败。旧任务用旧代码这件事也变简单了，进程从任务钉住的那个副本启动。

这个协议藏在后面的东西有：权限检查、分级和路由、访问记录、版本解析、进程的启动和时限、额度排队、密钥。露给调用者的只有一个函数和一个请求联合类型。Worker 一侧的线上格式（`worker.call`）和进程一侧的帧格式都不出现在公共类型里。今天的 `worker.lookup`、`worker.tripwire`、`DOMAIN_GATED_TOOLS`、`lookupHelp`、`tripwireHelp` 在迁移完成时一起删掉，同一件事只留一条路。

### 5. 模块代码能碰到什么：沙箱和确认卡片（S2 S3 S5 G5）

功能由模块的代码决定，安全由宿主按推导出的权限执行，两件事在两个地方（G5）。模块代码可以联网，这是功能。它只能经宿主的代理到写过的地址，这是安全。

**代码在哪里跑。** 只在每次调用的那个进程里（S1）。进程外面有两层墙，模块代码从不在缺任何一层的情况下运行。

- **主墙是操作系统的沙箱。** macOS 上是 `sandbox-exec`，配置由 `sandboxProfile(entryFile, nodePath)` 生成（`sketch/sandbox.ts`）。配置默认全部拒绝，然后只放行这几样：执行 Node 这一个程序，读系统库和 Node 自己的库，读包里的**一个文件**（入口文件），给自己发信号。不许写任何文件，不许开任何网络连接，不许起别的进程，不许给别的进程发信号。
- **第二层是 Node 自己的权限模型**，`node --permission --allow-fs-read=<入口文件>`。它挡得住 `fs`、`fetch`、子进程和线程，报错也更好懂。
- 进程的环境变量是空的，工作目录是 `/`，V8 的堆上限是 256 MB，到时限由宿主杀掉。

为什么不能只靠第二层。实测：只用 `node --permission` 时，工具用 `node:sqlite` 能读沙箱外的数据库，能在沙箱外新建文件，能给父进程发信号，能调低父进程的优先级。四样都成功。套上 `sandbox-exec` 以后，同一个探针四样都被挡住，`fetch` 也被挡住，进程里只有 macOS 自己加的一个环境变量 `__CF_USER_TEXT_ENCODING`。第一样尤其要紧，别的模块的 `data.db` 就是 SQLite 文件。

这一层有三个已知的限制。第一，macOS 把 `sandbox-exec` 标成了不推荐，它今天能用，哪天被拿掉就要换成别的机制。第二，配置只在 Homebrew 装的 Node 上跑过。别的装法的 Node 链接的库在别的位置，`nodeLibraries` 要跟着补。第三，没有 CPU 配额，只有时限。

同一个启动器以后给 Worker 沙箱用，但 Worker 要的配置宽得多，要另写一个生成函数（D2）。

**宿主只给写过的。** 网络经 `HostPort.fetch`，连接器经调度器，触发和提醒经宿主。没有别的口子（S2）。

**确认卡片。** 第一次启用，或者 `grantKey` 变了，宿主出一张卡片。id 是 `ask_mod_<模块>_<grantKey 前 16 位>_<第几张>`。文字由程序拼，分两部分。第一部分是推导出的权限：用哪些连接器，到哪些地址、额度多少、附哪个密钥，用哪些宿主能力，存哪几类数据各属于哪一级，每个 feed 属于哪一级，哪位成员有 `bash`、`write`、`edit`，带了哪些代码文件。第二部分是和上一次授权相比，`grantKey` 里的哪些文件是新增的、改过的、删掉的（`grantChanges`）。使用者亲手点了才启用（S3）。做法照搬成员上限卡片：id 前缀在 `Host.answer` 里先于内核处理，IM 来的回答用 `not_here` 拒绝，先存后生效，使用者的选择作为使用者的一句话出现在对话里。

**一张卡片只能答一次。** 卡片 id 里带着 `grantKey`，所以旧卡片授不了新版本。id 里还带着这是第几张，所以被拒绝的卡片就此作废，和 `src/kernel/cap-ask.ts` 里 `CAP_ASK_NEXT.declined = []` 是同一条规则。宿主记着使用者拒绝过哪些 `grantKey`。同一个 `grantKey` 再出现时（例如只改了 Markdown，或者把开关关了再开），状态直接是「已拒绝」，不再出卡片。使用者想再看一次，在模块页上点「重新考虑」，宿主出一张新卡片，序号加一。

**授权是一组，不是一格。** 记录里存的是使用者同意过的每一个 `grantKey`。更新被同意、接着迁移失败时，旧版本继续服务，它自己的授权还在。

**只改 Markdown 的新版本。** 技能、知识正文、专家提示词、考题都不在 `grantKey` 里，`version` 也不在。只改了这些的新版本直接换上，宿主发一条本机收据「个人医疗健康 已更新到 0.1.1，只改了技能和知识」。改了别的任何文件，都要重新确认。

**撤销。** 停用就是撤销（S5）。记录一存下，状态就是「已停用」，`Gateway` 的第 2 步读的是这条记录，所以之后的调用立刻返回 `module-disabled`。状态机同时排上 `publish`，把模块从模块表里拿掉，调度器跟着模块表摘掉它的条目。没有常驻的子进程要停。停用那一刻正在进行的调用，它向上的请求从此被拒绝，它自己最多活到时限。授权记录留着，同一个 `grantKey` 再启用时不再问。

**审计。** 内置模块随仓库审查。其他模块，宿主把扫描的结果写在卡片上，由使用者决定。闭包规则保证卡片上的代码文件清单是完整的。第三方审计和签名等开源以后再做。

### 6. 生命周期状态机和热插拔（L1 H1 H2 H3 H4 H5 H6 G2）

**状态。** `sketch/lifecycle.ts` 里是一个可辨识联合加一个纯函数 `transition(record, event)`。

| 状态 | 含义 | 页面上的字 |
|---|---|---|
| `missing` | 没见过包，或者包被拿掉了。实例数据留着。记录里还记着开关是开是关 | 包不在了 |
| `disabled` | 包在，使用者关着。什么都不运行 | 已停用 |
| `staging / checking` | 开着，正在检查 | 检查中 |
| `staging / invalid` | 检查或迁移没过，带每一条原因 | 无效：`<路径>`：`<原因>` |
| `staging / awaiting-grant` | 等使用者点卡片 | 等待确认 |
| `staging / declined` | 使用者没同意。只有「重新考虑」能再出卡片 | 已拒绝 |
| `staging / migrating` | 正在给实例数据加上新版本多出来的结构。带着这是第几次迁移 | 迁移中 |
| `active` | 正在服务。`update` 是正在进来的新版本，走同样的五个阶段 | 运行中（新版本等待确认…） |

| 事件 | 从哪里来 | 转移 |
|---|---|---|
| `package-found` | 文件监视器 | `missing`→`disabled`（开关开着的话直接进 `checking`）。`active` 里开始一次更新。`staging` 里换成检查新版本 |
| `package-gone` | 文件监视器 | 任何状态→`missing` |
| `enable` / `disable` | 使用者在页面、TUI 或 `just module on\|off` | `disabled`→`checking`。任何开着的状态→`disabled`。在 `missing` 里只改开关，包回来时照开关办 |
| `checked` | 校验器 | `checking`→`invalid`，或 `migrating`（已有这个 `grantKey` 的授权，或者不需要卡片），或 `declined`（这个 `grantKey` 被拒绝过），或 `awaiting-grant` |
| `granted` / `declined` | 使用者点卡片 | `awaiting-grant`→`migrating` 或 `declined`。卡片 id 对不上的一律不理 |
| `reconsider` | 使用者在模块页点「重新考虑」 | `declined`→`awaiting-grant`，出一张序号加一的新卡片。更新被拒绝时也一样，旧版本照常服务 |
| `migrated` / `migration-failed` | 迁移执行器，带着第几次迁移 | `migrating`→`active`，或 `invalid`（更新时旧版本继续服务）。次数对不上的一律不理 |
| `purge` | 使用者确认删除数据 | 只在 `missing` 和 `disabled` 里有效 |

不适用的事件原样返回同一条记录，不产生动作，所以重复和迟到的事件无害。无效的模块只是自己停在「无效」，宿主照常启动。

**记录自己带着还没做的动作（L1）。** 一个模块一条记录，存在 `state.db` 的 `module_states` 表里。记录里除了状态，还有五样：同意过的 `grantKey`（一组）、拒绝过的 `grantKey`、出过几张卡片、做过几次迁移、还没做的动作 `pending`。`transition` 把这一步要做的动作接在 `pending` 后面。驱动器对一个模块这样工作：

1. 把记录存下。
2. 做 `pending` 的第一个动作。`check` 和 `migrate` 做完会有一个结果事件。
3. 把记录去掉这个动作（`settle`），有结果事件就再过一次 `transition`，存下。回到第 2 步，直到 `pending` 空了。

三条性质由这个做法直接得到。

- **崩溃不丢动作。** 重启后 `resume(record)` 就是 `record.pending`，从断掉的地方接着做。每个动作都能安全地做两次。
- **一个模块的动作一个一个做，不并行。** 迁移还没做完时使用者要删数据，`purge-data` 排在 `migrate` 后面，迁移做完或者恢复完才轮到它。两次迁移也不会重叠。
- **迟到的结果认不错。** `migrate` 带着一个只增不减的次数，`migrated` 和 `migration-failed` 把它带回来。阶段里记的次数和结果带回的次数不一样，这个结果就是上一次迁移的，不理它。

状态机发出的动作只有七种：`check`、`issue-card`、`withdraw-card`、`migrate`、`publish`、`mark-tickets`、`purge-data`。没有「停掉进程」这个动作，因为没有常驻的进程。

`sketch/lifecycle.test.ts` 有 11 条写死的场景和一个随机测试。随机测试模拟一个按顺序做 `pending` 的驱动器，跑 30000 轮，每轮 40 步，到达过每一个状态和阶段。它核对的不变量有：使用者最后一次是关，模块就不在开着的状态。停用或拿掉之后不再服务。正在服务的版本一定有授权。更新失败不会丢掉正在服务的版本。被拒绝的卡片之后不会被接受。卡片 id 和迁移次数不重复。重复的事件不改变记录。`pending` 做完以后，模块表里服务的版本和记录里写的一致。实测：全部通过，用时大约 1 秒。

**热插拔。** 快照 `RegistrySnapshot` 和今天的 `Modules` 一样不可变。变的是没有谁再握着快照，大家握着 `LiveRegistry`，要用时问 `current()`。发布新快照是一次赋值，读的人要么看到整张旧表，要么看到整张新表（H1）。`current-state.md` 里列的每一个启动时冻结的对象，对应如下：

| 今天冻结的东西 | 热插拔时怎么换 |
|---|---|
| `Modules` | 变成 `RegistrySnapshot`。`withModule()` 从旧快照算出新快照，`publish()` 换上 |
| 内核的 `book` | 今天 `Kernel` 把传进来的 `DomainBook` 这张表自己存下（`src/kernel/kernel.ts:185`、`:210`），所以要改内核。`domains` 选项从一张表变成一个返回当前表的函数，内核每次用时调用 |
| 内核的 `sourcePolicy`、`ruleAllows` | 本来就是函数，签名不变。`SourcePolicy` 收的是一个 `TriggerSubmission`（`src/kernel/types.ts:75`）。函数体改成读 `live.current()` |
| 内核的 `isMarketSource` | 删掉。它今天只做一件事，就是让行情来源开出的 rule 任务用「行情」这个 Worker 角色。这个角色改由模块的规则和技能表达，见第 10 节 |
| 幕僚长的提示词 | 今天名单和规则全文都写在系统提示词里，触发卡片上只有规则的 id（`src/host/router.ts:126`）。改成程序在**每一次**给幕僚长的输入前面加一段（`preamble()`）：当前名单，每个模块一行，最多 60 字，加上当前每一条规则的全文。触发卡片照旧带适用规则的 id（H2）。不依赖 Pi 能不能中途改系统提示词 |
| `PiWorkerSpawner` 的 `lookupHelp`、`tripwireHelp` | 删掉。每个 Worker 启动时拿 `gateway.catalogue(caller)`，只有它那个模块、那个版本、那个成员能用的能力 |
| `WorkerExecutor` 的 `kitFor` | 不再问当前快照，改问 `ModuleStore.open(ticket.pin)`。技能目录指向副本，不指向作者正在改的文件夹 |
| `Host.#kitFor`（`src/host/host.ts:118`、`:394`） | 页面显示任务对话时，用它查团队成员的称呼。同样改问 `ModuleStore.open(ticket.pin)`，旧任务显示的是它开始时那个版本的成员 |
| `Host` 的 `feeds` 表、`timer`、`#watching` | 换成 `Scheduler`。它订阅 `onChange`，被拿掉或被替换的模块的条目先停，新的再起（H3）。游标按 `<模块>/<feed>` 存在各自的实例数据里。定时器就是用 `timer` 连接器的 feed。页面的来源清单每次从当前快照现算 |
| `createHostOptions` 里只跑一次的 feed 工厂 | 没有了。模块代码在被调用时才起进程，密钥在代理发请求时才读 |
| `just redeploy` | 只在宿主自己的代码变了时才需要 |

**正在跑的任务（H4）。** 任务开出来时，在 `tickets` 上记下 `module_digest`。之后它的技能、专家定义、工具代码、知识都从这个版本的副本来，重新唤醒也一样。新任务用新版本。「版本跟着任务走」对代码和技能没有例外，任务从头到尾不换版本。副本在没有任务钉着、不是当前版本、也不是实例数据当前结构所属的版本时才回收。

实例数据不跟版本走，它只有一份。钉着旧版本的任务读的是当前结构。这之所以安全，是因为**新版本对数据结构只能加，不能减**。它可以加一个 collection，可以给已有的 collection 加一个字段。它不能删掉或改名一个 collection 或字段，不能改字段的类型或单位，不能改 collection 的种类（`kind`，也就是 `record` 或 `series`），不能拿掉 `watch`。所以旧版本认识的每一样东西都还在原处，含义也没变。改名在校验器看来就是删掉一个再加一个，同样被拒绝。旧的行里，新字段是空的。

**这条规则怎么检查。** `data.db` 记着它当前的结构来自哪个版本（`InstanceHandle.structuredTo`），`module-store/` 留着那个版本的副本。`checking` 阶段把这个副本当作上一个版本交给同一个扫描，扫描用 `structureProblems` 比较两边的 `collection.json`。第一次启用和删除数据之后没有上一个版本，不比较。作者在本地用 `just module check <目录> --previous <旧版本目录>` 做同一件事。`sample/update/` 是一组例子：

```
node sketch/validate.ts sample/update/0.2.0-adds-field/health-lite --previous sample/update/0.1.0/health-lite
ok health-lite@0.2.0 | …
node sketch/validate.ts sample/update/0.2.0-renames-field/health-lite --previous sample/update/0.1.0/health-lite
data/lab-results/collection.json: field "lab" was removed; a new version may add collections and fields, never remove or rename one
node sketch/validate.ts sample/update/0.2.0-changes-unit/health-lite --previous sample/update/0.1.0/health-lite
data/lab-results/collection.json: field "value" changed unit from mmol/L to mg/dL; the stored numbers would silently mean something else, so a field keeps its unit
```

分级变了不算结构变化。它改的是 `collection.json`，所以 `grantKey` 变，要重新确认。

**停用后的去向（H5）。** 停用或拿掉模块时，状态机发出 `mark-tickets`。这个模块开着的任务保留钉住的技能和专家定义（它们只是文件），继续跑，但每一次能力调用都返回 `module-disabled`，不再有代码运行，不再读数据。任务卡片上标「所属模块已停用」，Worker 收到一条说明，可以收尾或交回。这比今天 ADR-0009 的做法（任务退化成没有领域的 Worker）多保留了技能，少了权限。

**更新（H6）。** 更新就是 `active` 里的 `update` 走完五个阶段：装上新版本，检查，需要时出卡片，迁移，换上。旧版本一直服务到新版本 `migrated`。推导出的权限变多时一定改了某个描述文件，`grantKey` 一定变，所以一定出新卡片，上面写明多了什么。迁移是声明式的，模块不带迁移代码。宿主比较新旧 `collection.json`，先拍实例数据的快照，再建新的 collection、加新的字段、把新 collection 的 `seed.json` 写进去。失败时驱动器恢复快照，`update` 停在「无效」，旧版本继续服务，它的授权不受影响。迁移不用等正在跑的 Worker 结束，因为加出来的东西旧任务看不见也用不着。

### 7. 连接器、领域 feed 和通用的条件机制（K5 D4 D7）

#### feed 和模块是什么关系

feed 是超级智能体的一个重点设计。外面世界的每一样东西，都是经一个 feed 进来的。今天只有少数几个实例，这个设计不限制它的数量和种类。

**连接器属于宿主，和领域无关。** 它只回答一个问题：怎么够到外面的一种服务。授权、限速、重试都归它，它把外面的东西变成一批 `items`。连接器的授权存在 `<stateDir>/connectors/`，模块拿不到。第一批有八个：`inbox`、`timer`、`rss`、`http-poll`、`literature-search`、`webhook`、`mail`、`google-drive`。

**feed 属于模块，是一份声明。** 它把一个连接器（或者一段能联网的 handler）绑到这个领域上，回答四个问题：看什么，多久看一次，要使用者填什么，结果去哪里。结果的去处是一个 collection（`into`），或者一条给幕僚长的触发（`notice`），或者两样都有。

两者的关系有七条：

1. **一个 feed 只属于一个模块。** 它的来源名是 `<模块>/<feed>`，由宿主生成，模块之间不会撞名。
2. **几个模块可以用同一个连接器。** 各有各的设置，各有各的游标。医疗模块和另一个模块都用 `mail`，互相看不到对方的发件人清单和进度。连接器的授权只有一份，在宿主手里。
3. **一个模块可以有很多 feed，也可以一个都没有。** pi-pi 没有 feed。医疗样例有四个。
4. **给已有的连接器再加一个 feed 实例，不写代码，不改宿主。** 多放一个 `feeds/<名字>/feed.json` 就行。例如再跟踪一个 RSS，就是再多一个用 `rss` 连接器的文件夹。
5. **接一种新的外部服务有两条路。** 宿主加一个新连接器，所有模块都能用，授权和限速由宿主统一管。或者模块自己带一个能联网的 handler，写明 `network`，经宿主的代理去取。第二条路不用改宿主，但只适合 `shareable` 的 feed，见下面的限制。
6. **feed 能做的只有两件事。** 它产出行，行进它自己模块的 collection。它产出触发，触发交给幕僚长按规则处理。它拿不到任何权威。它送来的内容一律是数据（ADR-0003，S4），读过它的任务改不了提醒条件。feed 不能调用别的能力，不能给别的模块写数据，不能直接提醒使用者。
7. **feed 的生命周期跟着模块。** 模块变成 `active`，调度器就把它的 feed 排上。模块停用或被拿掉，它的 feed 立刻停。feed 的版本和模块里别的东西一样被钉住。调度器用的是正在服务的那个版本的 `feed.json` 和 handler。更新换上新版本时，旧条目先停，新条目再起，游标留在实例数据里接着用。

今天的三种入口和医疗样例的四个 feed，按这两层拆开是这样：

| 今天的入口，或样例里的 feed | 连接器（宿主） | feed（模块） |
|---|---|---|
| `FEEDS` 里由宿主运行的行情 feed（us-market） | 没有。行情服务是一种新的外部服务，走第二条路 | `us-market/quotes`：一个带 `network` 的 handler 去取报价，写进 `shareable` 的 `quotes`，把行情变化发成触发 |
| 收件箱投递（toy-market 的假行情） | `inbox` | `toy-market/ticks`：写进 `shareable` 的 `ticks`，用 `ignore` 滤掉涨跌不到 1% 的，其余发触发 |
| 定时器 | `timer` | `<模块>/<名字>`：只有 `every` 和一句固定的 `notice`，到点发一条触发。它没有 `into`，所以是 `local-only`，见「Open questions」第 17 条 |
| `drive-checkups` | `google-drive` | 每小时看一次。问使用者是哪个文件夹。原件进 `private` 的 `documents`，发一句固定的触发 |
| `hospital-mail` | `mail` | 每 15 分钟看一次。问使用者哪些发件人算医院。附件进 `documents`，发一句固定的触发 |
| `device-webhook` | `webhook` | 设备推来数据时由一个不联网的 handler 把厂商格式转成读数，写进 `private` 的 `device-readings`。不发触发 |
| `targeted-drug-research` | `literature-search` | 每天查一次。问使用者跟踪哪些药。结果进 `shareable` 的 `research-updates`，触发里带标题和链接 |

#### feed 怎么运行

`feed.json` 里写了宿主没有的连接器会被拒绝。大部分 feed 一行代码都不用写，样例里四个 feed 有三个是纯声明。

宿主的调度器负责节奏。到点了它调用连接器，把 `items` 交给 `feed` 能力（`collect`），拿回 `Collected`：要存的行、要发的触发、新的游标。然后由**宿主**去存、去提交、去挪游标。feed 的代码因此没有启停状态，是一个「输入到输出」的函数，每次调用是一个新进程。同一批 `items` 跑两次，行和触发都按 `id` 去重。`collect` 只有调度器能发，轮询和连接器的推送都经它。收件箱投递必须指向一个用 `inbox` 连接器的 feed，今天「投递文件可以自称任何来源」的缺口关上。

feed 可以写 `ignore`，一组正则表达式。触发的正文匹配上任何一条，宿主就把它丢掉，幕僚长看不到。这是今天 `sources[].ignore` 的原样搬迁。

#### feed 的级别，和私密内容走不出去的三道闸

**每个 feed 都有级别。** 它等于 `into` 指的那个 collection 的级别。没有 `into` 的 feed 什么都不存，也就没有任何地方说过它的内容可以出本机，所以它是 `local-only`。feed 碰到的每一样东西都是这个级别：连接器给的 `items`，交给 handler 的输入，发出去的触发。纯函数 `feedClass` 就是这一条。

外部来的内容一律是数据（S4）。在这之上，级别管着三个出口：

1. **带字段的 `notice`。** `notice` 里有 `{{字段}}`，feed 的内容就会跟着触发走。只有 `shareable` 的 feed 许这样写。别的 feed，`notice` 必须是固定文字（坏包 `private-data-in-notice` 写进一个 `local-only` 的 collection，坏包 `notice-template-without-into` 干脆不写 `into`，两个都被拒绝）。
2. **能联网的 handler。** handler 写了 `network`，它拿到的 `items` 就可能被发到那个地址。只有 `shareable` 的 feed 许带这样的 handler（坏包 `network-handler-on-private-feed`）。不联网的 handler 不受限制，医疗样例里解析设备数据的那一个就是。
3. **给幕僚长的触发。** 触发带着 feed 的级别。宿主先用 `mayRead` 查幕僚长跑的那个提供方能不能读这一级。能，幕僚长收到触发的正文。不能，它收到一句固定的话「有新内容，请在本机查看」（`triggerBodyFor`），线程的标题和发出者这时一并换成来源名。幕僚长仍然看得到来源名和适用规则的 id，所以按来源写的规则照样能开任务。固定文字的 `notice` 也走这一道，因为触发的线程和发出者同样来自 `items`。

医院邮件里写「请立即停药」，在哪一步都只是一行数据。读过触发内容的任务改不了提醒条件。

**webhook。** 不开公网入站。`webhook` 连接器挂在已有的网页服务上，路径是 `/hook/<模块>/<feed>/<随机串>`，只在本机和 tailnet 内可达。只能推到公网的设备，改成厂商云端加定期拉取。要不要用 Tailscale Funnel 开一个公网入口，只有使用者能定。

#### 条件机制（tripwire 通用化）

一个 `series` 类的 collection 在描述文件里写 `"watch": { key, value, at }`，它就能被设条件。条件是使用者的实例数据，存在这个模块的 `data.db` 里。条件的种类是宿主内置的一个小集合：`above`、`below`、`rising-streak`、`falling-streak`、`change-pct`、`crosses-average`。**检查发生在数据写入时。** 有新的行写进这个 series，宿主就对这个 key 的条件算一遍，满足了就发一条宿主行（ADR-0017），用 `<条件 id>@<数据点时间>` 去重。提醒的文字由程序用 collection 的标题、key、数值、单位、时间拼出来，模型和模块代码都不参与。

**未确认的数据点也会触发。** 等使用者确认完再提醒，就可能晚几天。所以条件在未确认的点上照常检查，满足了照常提醒，提醒的文字里写明「这个数值是从报告里提取的，未经确认」。使用者确认或改正之后，宿主对这个点重算一次。条件仍然满足，补一行「已确认」。不再满足，补一行「已撤回」。这和行情模块今天「盘中怀疑、收盘确认或撤回」是同一个形状。

这一个机制同时服务两个模块。us-market 的盯盘条件是 `quotes` 这个 series 上的条件，医疗模块的肿瘤标志物预警是 `lab-results` 上的条件。`HostPort.watchedKeys()` 让 feed 知道还要多拉哪些 key，对应今天「自选股 ∪ 盯盘代码」。提醒在 Telegram 上显示多少，由 collection 的分级决定，见第 8 节。

### 8. 数据分级和路由表（D5 K2）

三级，从松到严排成一条线，由宿主定义，模块不能新增：

| 级别 | 意思 | 例子 |
|---|---|---|
| `shareable` | 可以出本机 | 行情报价、文献检索结果、随包的知识 |
| `private` | 只给使用者点过头的模型提供方 | 检验指标、报告原件、设备读数 |
| `local-only` | 只给本机上的模型 | 基本信息 |

**模块只说自己的数据属于哪一级。每一级能去哪里，由使用者的路由表决定。** 路由表是 `config.json` 里的 `dataRoutes`，每一级列出能读它的模型提供方。表里写的是提供方的名字，不是模型的名字。提供方的名字就是模型写法 `provider/id` 里斜杠前面那一段，`openai-codex/gpt-5.2` 的提供方是 `openai-codex`。

```json
"dataRoutes": {
  "shareable": ["openai-codex", "deepseek"],
  "private": ["openai-codex"],
  "local-only": []
}
```

`local-only` 那一行只能写本机上的提供方，写了别的，宿主拒绝这份配置。没有写 `dataRoutes` 时，`shareable` 给全部已配置的提供方，另外两级不给任何模型。所以默认是关着的，使用者不做决定，私密数据就不会被任何模型读到。模块页会提示「这个模块有私密数据，还没有允许任何模型读」。

**读的规则只有一条**，`mayRead(reader, class, routes)`，两个条件都要满足：

1. 读的人的许可级别不低于数据的级别。
2. 读的人跑在一个模型提供方上时，这个提供方在路由表的这一级里。

规则不认识的东西一律拒绝。不在三级里的级别，路由表里没写的那一级，都是不许读。

许可级别不是谁声明的，由读的人自己往外的口子决定：

| 读的人 | 许可级别 | 模型提供方 |
|---|---|---|
| 网页和 TUI | `local-only` | 没有 |
| Worker | `local-only` | 它跑的那个提供方，由路由表把关 |
| 幕僚长 | `local-only` | 它跑的那个提供方，由路由表把关 |
| 没有 `network` 的模块代码 | `local-only` | 没有 |
| 有 `network` 的模块代码 | `shareable` | 没有 |
| Telegram | `shareable` | 没有 |

有 `network` 的模块代码能把读到的东西发给它写过的地址，所以它只读得到 `shareable`。us-market 的行情 feed 读自选股没有问题，自选股是 `shareable`。

`sketch/protocol.test.ts` 把 7 种读的人、3 级、512 张路由表的 10752 种组合全部核对过。实测：没有一种组合让非 `shareable` 的数据到达 Telegram 或能联网的模块代码，也没有一种组合让模型读到路由表没给它的级别。

执行点有五个，都在宿主里，用的是同一条规则：

1. **读的时候。** `Gateway` 的第 5 步。云端模型上的 Worker 读 `local-only` 的数据，或者读一个没给它的提供方开放的 `private` collection，都返回 `provider-not-routed`，带着级别和提供方的名字。
2. **feed 的内容进来的时候。** 第 7 节的三道闸。带字段的 `notice` 和能联网的 handler 在校验时就被拒绝，给幕僚长的触发在发出时过 `mayRead`。
3. **任务往外说的时候。** 任务读过的最高级别记在任务上。它的汇报完整显示在网页和 TUI。别的去处各自过一遍 `mayRead`，过不了的只收到一行「有新汇报，请在本机查看」。Telegram 只收 `shareable` 的全文。幕僚长的提供方不在这一级的路由里时，幕僚长也只收到这一行。
4. **宿主自己往外说的时候。** 条件触发的提醒是宿主行。collection 是 `shareable` 的，全文发到 Telegram。其他级别，Telegram 上只有一句「个人医疗健康有一条新提醒，请在本机查看」，完整内容只在网页和 TUI。这就是今天「收据只在本机」的通用版。
5. **会话换提供方的时候。** 见下一段。

**一个会话不能带着读过的东西换到没被允许的提供方。** 模型会话会把读过的内容带进之后的每一轮。今天宿主在模型额度用尽或被限流时，会把正在跑的 Worker 会话和幕僚长的会话原地切到回退模型（`src/host/workers.ts:271-288`，`src/host/router.ts:333`）。回退模型在另一家提供方时，这家提供方就拿到了这个会话读过的一切，而 `mayRead` 只在读的那一刻查过原来那一家。所以加一条规则：每个模型会话记着它读过的最高级别，`Gateway` 每次答复都把它抬上去。宿主切换会话的提供方之前先问 `mayContinueOn(最高级别, 新提供方, 路由表)`。不许，就不切。任务停下来等，使用者收到一条宿主行「个人医疗健康的任务读过私密数据，回退模型的提供方没有被允许读这一级，任务在等主模型恢复」，和今天每日上限挡住任务时的做法一样。没读过模块数据的会话照旧切换。

这一版里，使用者不能逐个 collection 改级别。级别是模块包的内容，对所有人一样。使用者要调的是路由表，它对所有模块一起生效。要不要让使用者把单个 collection 调严（只许调严），是一个留给使用者的决定，见「Open questions」第 14 条。

### 9. 制作工具、模板、校验和预演，以及模块页（B1 B2 B3 P1 G3）

- **模板（B1）。** 模板就是模块包，放在 `templates/` 下，三种：`notes`（知识加技能）、`team`（再加专家和考题）、`full`（再加数据、feed 和一个工具）。`just module new <名字> --template <模板>` 是复制文件夹加改名。因为目录就是清单，加一个组成等于复制一个组成文件夹。权限是推导的，所以复制完不用再去别处补一笔。
- **校验（B3）。** `just module check <目录>` 就是 `sketch/validate.ts` 这个扫描：符号链接、`module.json`、每个描述文件、专家的 front matter、所有引用、闭包规则、feed 的级别、推导权限、工具用例在两层沙箱里跑。宿主的 `checking` 阶段跑的是同一段代码，所以「本地检查过了」和「宿主会接受」是一回事。
- **预演（B3）。** `just module try <名字>` 起一个临时状态目录，用同一套宿主代码，但连接器换成读 `feeds/<feed>/fixtures/` 里的样例，所有对外的出口（Telegram、宿主行）换成记录器，实例数据是空的。它把 `evals/` 里的每道题当成一个 `request` 任务跑一遍，核对 `uses`（必须调用过的能力）和 `expect`（必须出现的话），打印对话和结果。预演要调用模型，用的是使用者给 Worker 配的模型，费用和选哪家由使用者定。
- **制作工具（B2）。** 它是一个模块 `module-builder`：一支团队（访谈、搭结构、整理知识、出考题、检查），几份技能，一个由宿主服务的工具 `draft`（第 2 节）。`draft` 能在 `<stateDir>/modules/<草稿>/` 里建文件、跑校验、跑预演，写不到别处。它的效果是宿主定死的 `write`，推断任务用不了。它做出来的模块停在「已停用」，要使用者自己打开、自己点卡片。制作工具是模型，模型给不了授权。非程序员走这条路：用聊天说想要什么，制作团队填好文件夹，使用者看校验结果和预演对话，然后点启用。
- **模块页（P1）。** `BoardState` 多一个 `modules` 字段，每个模块一张卡。卡上有状态和原因（`describe(record)`）、版本和哈希、推导出的权限和已确认的权限、和上次授权相比改了哪些文件、每个 feed 的级别和上次成功时间和问题（`Scheduler.health`）、实例数据占用（`InstanceData.sizeBytes`）、等使用者确认的行数、还钉着旧版本的任务数、缺哪些要导入的知识、`ask` 里还没填的设置、路由表挡住了哪一级数据。按钮有启用、停用、确认卡片、重新考虑、导入知识、确认或改正提取出的行、看数据清单和访问记录、删除数据（要再输入一次模块名）。Telegram 上只有提示，没有按钮，和成员上限卡片一致。

### 10. 迁移路径：每一步都能单独上线

**新旧两种布局怎么共存。** 今天的三个模块没有一个能通过新的扫描，也没有一份 `module.json` 能同时满足两个加载器。新扫描拒绝 `sources`、`tools` 这些键，旧加载器又靠它们工作。所以定一条规则：**`module.json` 里写着 `"schema": 1` 的文件夹是新布局，别的都是旧布局。** 新布局的文件夹交给新扫描。旧布局的文件夹照旧交给今天的加载器，行为和今天完全一样，直到它被转换的那一步。一个模块要么是旧的要么是新的，没有一半一半，所以每个模块在一步里整个转换。最后一个模块（us-market）转换的那一步，同时删掉旧加载器。

| 步骤 | 内容 | 上线后看得见的变化 |
|---|---|---|
| 1 | 扫描器和 `just module check`，按 `"schema": 1` 分流。新布局的坏包只标「无效」，不阻止宿主启动。旧布局的三个模块原样由旧加载器加载。修正过期文档（见表后） | 新布局的包能被检查。今天的模块行为不变 |
| 2 | `module-store/`、`tickets.module_digest`、`LiveRegistry`、状态机和它的记录、文件监视器、确认卡片、幕僚长每次输入前的名单和规则全文。内核的 `domains` 改成函数。开关从 `config.json` 一次性导入（见下）。转换 pi-pi，它只有技能和只读的专家，不用卡片。模块页第一版：状态、开关、卡片 | 纯内容的模块可以不重启地装上、换掉、关掉 |
| 3 | `Gateway`、权限表、两层沙箱的启动器、`domain_tool` | 新布局的模块能带工具 |
| 4 | `modules-data/`、数据提供者、路由表 `dataRoutes`、条件机制、知识提供者。**这一步必须同时实现「会话换提供方前先问 `mayContinueOn`」**，因为从这一步起才有分了级的数据可读 | 新布局的模块能有数据、提醒条件和知识检索 |
| 5 | 连接器和调度器：`inbox`、`timer`、`rss`、`http-poll`，feed 的级别和 `ignore`。转换 toy-market，作为转换 us-market 之前的演练：来源改名、规则里的来源行、`config.json` 里的来源设置都在它身上先走一遍。toy-market 顶层的 `feed.ts` 是仓库外的生产者，挪出模块包 | 加一种数据源不改宿主 |
| 6 | 转换 us-market，一步做完：`lookup` 的各个操作变成带 `network`、`effect` 为 `read` 的工具。行情 feed 从 `src/sources/market/` 搬进 `feeds/quotes/`。自选股搬进一个 `shareable` 的 collection，默认值放 `seed.json`。盯盘条件从 `source_user_data` 搬成 `quotes` 上的条件。同一步里删掉旧加载器、`FEEDS`、`DOMAIN_GATED_TOOLS`、`worker.lookup`、`worker.tripwire`、`Feed.tripwires`、`isMarketSource` | us-market 第一次出确认卡片。改自选股不用重启 |
| 7 | `module-builder`、模板、预演、模块页完整版 | 非程序员能从零做出模块 |
| 8 | 试点。先一个低风险模块，再医疗健康。`mail`、`google-drive`、`webhook` 连接器和 Worker 沙箱在医疗健康之前落地 | |

**转换时会丢的东西，每一样的去处。**

| 今天清单里的东西 | 新布局里 |
|---|---|
| `sources[].ignore` | 搬成 `feed.json` 的 `ignore`，含义不变 |
| `defaultEnabled: false` | 不需要了。新发现的包一律从「已停用」开始 |
| `config.json` 的 `modules` 开关 | 第 2 步一次性导入成各模块记录里的开关，导入时把今天的 `defaultEnabled` 也算进去。之后开关只有 `state.db` 这一个主人，`config.json` 里的那一段删除 |
| `sources[].market: true` 和内核的 `isMarketSource` | 删除。它今天让行情来源开出的 rule 任务用「行情」这个 Worker 角色。第 6 步必须拿出证据，证明这个角色靠模块的规则和技能照样成立。这是一条风险，见「Open questions」第 12 条 |
| `rules.md` 里的 `来源: us-market` | 来源改名后要写成 `来源: us-market/quotes`。和改名在同一步里改 |
| `config.json` 的 `sources.us-market` 设置 | 来源改名后这个键就不认识了，今天的宿主遇到不认识的来源名会拒绝启动（`src/host/wiring.ts:52-53`）。和改名在同一步里改写 |

第 1 步要修正的过期文档，都是把已经合并的 PR #27（提交 `cefb2c1`）说成没合并，或者说没有开关：

- `docs/adr/0009-a-ticket-belongs-to-one-domain-and-the-domain-is-a-module.md` 第 44 行，「模块没有单独的开关」。
- `docs/modules/module-architecture-upgrade-memo.md` 第 50 到 51 行（2.1 节）和第 280 行（M0「合并 PR #27」）。
- `docs/modules/module-user-guide.md` 第 1025 行，和它自己第 578 到 580 行矛盾。
- `docs/modules/module-code-and-feeds-memo.md` 第 102、109、124 行。

来源改名（`us-market` 变成 `us-market/quotes`，`toy-market` 变成 `toy-market/ticks`）不重写历史行。转换的那一步只搬 `source_cursors` 和 `source_user_data` 两处，旧的触发、线程和宿主行留在旧名字下当历史。us-market 的切换放在休市时做，因为行情线程按天开，当天订阅旧线程的任务收不到新来源的触发。

### 11. 九个决定

| 编号 | 建议 | 谁来定 |
|---|---|---|
| D1 | 分界按「换一个人还一样吗」。实例数据在 `<stateDir>/modules-data/<模块>/`，只有宿主能打开。拿掉模块时默认保留 | 建议可以直接采用。**要不要提供一键删除数据，由使用者定**，建议提供，但要再输入一次模块名 |
| D2 | 模块代码每次调用起一个新进程，外面是操作系统的沙箱加 Node 的权限模型两层，标准输入输出通信，无网络，只读得到入口文件。先做模块代码的沙箱（它没有 `bash`，要挡的东西少得多），再做 Worker 沙箱，两者共用一个启动器 | 方向可以直接采用。**医疗数据进来之前 Worker 沙箱必须到位，这个先后只有使用者能拍板**，因为它决定试点的时间 |
| D3 | 第一步不需要热插拔，步骤 1 没有它也有用。它在步骤 2 落地，因为不可变快照加一次赋值很便宜。正在跑的任务用开始时的版本跑完，没有例外。数据不分版本，靠「结构只能加」保证旧任务读得对 | 可以直接采用 |
| D4 | 连接器先属于宿主，放在宿主源码里。以后要不要能单独安装，现在不做决定。webhook 只在 tailnet 内接收 | 分层可以直接采用。**要不要开任何公网入口，只有使用者能定** |
| D5 | 三级：`shareable`、`private`、`local-only`。模块定级别，使用者的 `dataRoutes` 定每一级给哪些模型提供方。宿主在五个执行点用同一条规则。加密先靠 FileVault 和 0700 的状态目录。`local-only` 的 collection 可选用钥匙串里的密钥做应用层加密 | **路由表怎么填（也就是医疗数据给不给云端模型看、给哪一家），要不要应用层加密，要不要配本机模型，只有使用者能定** |
| D6 | 先不用向量。SQLite 全文索引，中文用 trigram 分词（已实测可用），Worker 自己换几种说法查。`knowledge` 的接口不暴露检索方式，以后加向量排序不改接口 | 可以直接采用。**哪天要加向量，嵌入模型用哪家、怎么计费，由使用者定。** 本机嵌入模型没有按量费用 |
| D7 | 现在就定接口（本设计第 7 节），在步骤 4 和数据层一起实现，早于医疗试点。us-market 是第一个使用者，医疗指标是第二个 | 可以直接采用 |
| D8 | 制作工具做成一个模块。启用和授权由使用者亲手点卡片，需要一条新的 ADR 把 ADR-0010 的做法扩展到模块 | 做成模块可以直接采用。**「只改了 Markdown 的新版本不用重新确认」这一条请使用者定**，它换来的是边改边看效果 |
| D9 | 先用低风险的领域跑通：一个「文献和 RSS 跟踪」模块。它正好是医疗模块的第四个 feed，做完直接并进去，不浪费 | **只有使用者能定** |

## Synthesis decision

这一轮在 arena 里出了两份候选设计。底稿是候选 B，再从候选 A 接过来六样东西。合成之后又做了一轮对抗审查，结果在本节最后。

**为什么用 B 做底稿。**

- 它的目录布局和使用者自己那份备忘第 4 节画的布局一致。备忘把权限和组成列在 `module.json` 里，这份设计把两样都改成了推导，这一点和备忘不同。
- 不懂编程的人加一个组成，就是复制一个文件夹，不用再去改一份总清单。
- 它的状态机把「正在进来的版本」嵌在「正在服务」里面，更新期间旧版本继续服务这件事直接写在类型里。
- 它让模块代码能联网，但只能经宿主的代理。使用者的原则是「不能为了安全放弃模块的功能」。候选 A 的模块代码只能是纯函数，联网只能靠宿主内置的连接器，等于放弃了这部分功能。

**从 A 接过来的六样。**

1. 权限由组成推导，不手写。B 原来在 `module.json` 里手写一份 `permissions`，再用 `unused-permission` 和「连接器没声明」两条检查把它和组成对齐。现在没有那份清单，两条检查也就没有了。
2. 数据分级改成 `shareable`、`private`、`local-only`，每一级去哪里由使用者的路由表决定。B 原来的中间一级叫 `cloud-ok`，并且让使用者在确认卡片上逐个 collection 改级别。
3. Worker 从原件里提取出来的行先是「未确认」，使用者在模块页确认或改正。
4. 闭包规则：包里只许有工具入口和 feed handler 这两种代码文件，布局之外的文件一律拒绝。
5. 数据迁移是声明式的，只能加。B 原来允许模块带 `migrations/<n>/migrate.ts`，为此要等 Worker 结束，还要给旧任务换钉版本。这些都删了。
6. 每次调用一个新进程。B 原来给每个（模块，版本）留一个常驻子进程。

**没有接的。**

- A 把全部组成写进一份 `module.json`，医疗样例那份有 121 行。它是一份要和目录手工同步的清单，非程序员最容易在这里出错。
- A 规定连接器是到达网络的唯一途径。每接一种新服务都要改宿主，和 G1 冲突。
- A 为了让 `us-market` 的旧行不用迁移，规定「feed 名等于模块名时，来源名不带前缀」。这是一条只为一个模块存在的特例。本设计的来源名一律是 `<模块>/<feed>`。

**交叉评审没有做。** arena 本来要让另一个模型家族的评审来挑两份候选的毛病。这次配置的评审模型和本次会话用的模型全在同一个家族，它们的意见不独立，所以跳过了。选底稿和选哪些东西接过来，是协调者自己读完两份设计后定的。

### Interrogation

合成之后，两个对抗者各自攻击这份设计。A1 攻校验器、权限推导和沙箱。A2 攻状态机、访问规则，以及设计和今天代码的契合。协调者把每一条都重跑了一遍，24 条复现。下面每条一行：问题，改法，现在由哪个坏包或哪条测试守着。其中 22 条有代码可跑，改完之后它们的复现命令都重跑过，都不再复现。A2-7 和 A2-8 是设计文字和今天的代码对不上，对照代码改了文字。

A1 的 12 条：

| 编号 | 问题 | 改法 | 守着它的 |
|---|---|---|---|
| A1-F1 | `node:sqlite` 绕过 `node --permission`，工具能读写、新建沙箱外的 SQLite 文件 | 操作系统的沙箱做主墙，只许读入口文件 | 坏包 `tool-opens-sqlite-outside` |
| A1-F2 | 校验器看不见符号链接，Node 却跟着它走 | 包里任何符号链接都拒绝并点名 | 坏包 `symlink-in-package` |
| A1-F3 | 工具能给父进程发信号，能调低它的优先级 | 沙箱只许进程给自己发信号 | 坏包 `tool-signals-parent` |
| A1-F4 | 工具能伪造用例的判定结果 | 每条用例一个进程，进程只拿到输入，比较在沙箱外面 | 坏包 `tool-forges-verdict` |
| A1-F5 | 校验器把宿主的全部环境变量传给工具 | 进程的环境变量是空的 | 测试 `a tool sees no environment variable of the host` |
| A1-F6 | `grantKey` 的拼接有歧义，代码在两个文件之间挪动，哈希不变 | 每个文件按路径长度、路径、内容长度、内容进哈希 | 测试 `code that moves from one file to another changes the grant key` |
| A1-F7 | 代码可以藏在 `tool.json` 里，改它 `grantKey` 不变 | 每个描述文件都在 `grantKey` 里。入口也读不到 `tool.json` | 测试 `every descriptor is in the grant key` 和 `a tool cannot read its own tool.json or cases.json` |
| A1-F8 | 以点开头的代码在检查时真的会运行 | 用例从只含认可文件的临时副本启动 | 坏包 `tool-imports-dot-file` |
| A1-F9 | 成员的 `tools` 和 `uses` 不校验，改了也不出卡片 | front matter 要校验，并且在 `grantKey` 里 | 坏包 `agent-unknown-tool`，测试 `a member's front matter is validated and is in the grant key` |
| A1-F10 | 改 feed 的 `into` 和连接器的 `settings` 不出卡片 | `feed.json` 整个在 `grantKey` 里 | 测试 `every descriptor is in the grant key` |
| A1-F11 | 去掉 `into`，私密内容就能写进 `notice` 模板 | 每个 feed 都有级别，没有 `into` 的是 `local-only` | 坏包 `notice-template-without-into` |
| A1-F12 | 同一个地址加一个尾点算两个地址。`unit` 变了不算结构变化。`watch` 能指向原型链上的键 | 地址先规范化。`unit` 变化算结构问题。`watch` 的键必须是自己的字段 | 坏包 `one-host-two-budgets` 和 `watch-names-inherited-key`，测试 `an update that changes a field's unit is refused` |

A2 的 12 条：

| 编号 | 问题 | 改法 | 守着它的 |
|---|---|---|---|
| A2-1 | 包不在时点的「停用」被丢掉，包回来后模块自己又开始服务 | `missing` 里的 `disable` 把开关关上 | 测试 `a disable while the package is away keeps the module off` |
| A2-2 | `resume` 补不出三种动作，崩溃会丢动作 | 记录自己带着 `pending`，`resume` 就是它 | 测试 `a crash after the record is persisted loses no effect` |
| A2-3 | 状态机不跟踪正在进行的迁移。迁移中能删数据，迟到的结果会被认错，两次迁移能重叠 | 迁移带次数，结果带回次数。一个模块的动作一个一个做 | 测试 `a purge asked for during a migration is queued behind it` 等三条。「一个一个做」是驱动器的规则，草图里没有驱动器，所以「迁移和删除不会同时进行」这一点没有测过，要等实现时验证 |
| A2-4 | 只有规则的模块改 `rules.md` 不出卡片 | 有 `rules.md` 的包一律要卡片 | 测试 `a module with only rules asks for a card` |
| A2-5 | 私密连接器的内容能到达能联网的 handler，也能不带级别地进幕僚长 | feed 的级别管住带字段的 `notice`、能联网的 handler 和给幕僚长的触发 | 坏包 `network-handler-on-private-feed` 和 `notice-template-without-into`，测试 `a trigger of a feed reaches the Router only when…` |
| A2-6 | 模型回退在同一个会话里换提供方，`mayRead` 只在读的那一刻查 | 会话记着读过的最高级别，切换前问 `mayContinueOn` | 测试 `mayContinueOn: a session moves to another provider only if…` |
| A2-7 | 今天的三个模块全被新扫描拒绝，一份 `module.json` 不能同时满足两个加载器 | 按 `"schema": 1` 分流，旧加载器留到最后一个模块转换时删。丢掉的四样东西各有去处 | 第 10 节。这一条没有代码可测 |
| A2-8 | 「内核的构造约定不变」对今天的 `Kernel` 不成立 | 改成事实：`domains` 要变成函数，`sourcePolicy` 收一个触发，规则全文要随每次输入走，补上 `Host.#kitFor` | 第 6 节的热插拔表。这一条没有代码可测 |
| A2-9 | 被拒绝的卡片会用同一个 id 再发出来并被接受 | 卡片 id 带序号，拒绝是终局，只有 `reconsider` 再出新卡片 | 测试 `a declined card is final` 和 `reconsider opens a new card with the next number` |
| A2-10 | 授权只有一格，更新失败会抹掉正在服务的版本的授权 | 授权是一组 `grantKey` | 测试 `a granted update whose migration fails leaves the serving version's grant in place` |
| A2-11 | 权限表只按效果做键，表达不了「只有页面能确认」这类限制 | 表按效果和调用者的种类做键，两种请求各有唯一的发送者，宿主服务的工具效果由宿主定 | 测试 `allowed agrees with the written table for every request and every caller kind`，坏包 `host-served-tool-states-effect` |
| A2-12 | `mayRead` 遇到表外的输入会抛异常或放行 | 不认识的级别和没写的那一级一律拒绝。注释里把路由表写成模型名的错改掉 | 测试 `mayRead refuses what it does not know` |

**守住了的。** A1 另有 20 项尝试没有攻破，A2 另有 13 项。其中两项是大范围的：`mayRead` 在 10752 种组合里没有一次放错。随机测试跑了 200000 轮，停用之后没有一次还在服务。改完之后这两项都重跑过，结果不变。

## Tradeoffs accepted

- 我们接受**文件多**，换来没有登记步骤。医疗样例有 31 个文件。每个都很小，而且加一个组成只动一个文件夹。
- 我们接受**同一个地址的额度和密钥名要在每个用到它的描述文件里各写一遍**，换来没有手写的权限清单。us-market 迁移后有几个工具和一个 feed 都用 `api.massive.com`，每个文件里都是同一行。写得不一样时校验器拒绝，所以不会悄悄走样，但这一行确实重复了。
- 我们接受**技能和专家定义不走能力协议**，换来不和 Pi 自己读技能的方式对着干。所以「一个协议服务一切」实际是服务了六类里的四类。另外两类靠钉住的副本保证版本一致。
- 我们接受 **feed 被压成「调度器调用、函数返回」**，换来 feed 没有启停状态、能按模块单独停、崩了不拖累宿主。代价是长连接的数据源（websocket 行情）放不进这个形状，us-market 今天自己管的 12 秒间隔队列要改写成代理上的 `perMinute` 额度。这是协议最吃力的地方。
- 我们接受**要把内容带给幕僚长的 feed 必须先有一个 `shareable` 的 collection 接着**，换来 feed 的级别只有一个来源。代价是哪怕只想转发一句话的 feed，也要多写一个 `collection.json`。医疗样例的研究进展和 toy-market 的假行情都因此多了一个 collection。
- 我们接受**能联网的 handler 只许出现在 `shareable` 的 feed 上**，换来私密内容到不了能联网的代码。代价是连接器没有覆盖到的私密服务，不能靠模块自己的代码去接，只能等宿主加连接器。
- 我们接受**请求种类是封闭的**，换来 `Gateway` 的权限表可以穷举。模块不能发明新的请求种类。us-market 的 `lookup` 因此要拆成几个工具。
- 我们接受**只读的联网工具对推断任务开放**，换来迁移不拿走今天已有的能力。代价是推断任务传给工具的输入会被发到工具写过的那个地址。地址是使用者在卡片上确认过的，今天的 `lookup` 也是这样。
- 我们接受**分级按会话粗粒度地传染**，换来执行点在宿主里而且简单。一个任务读过一次检验指标，它之后所有汇报在 Telegram 上都只有一行提示，哪怕那条汇报里没有数字。它也从此不能回退到没被允许的提供方，主模型不可用时只能等。
- 我们接受**每次调用付一次进程启动的开销**（实测带一个 `.ts` 入口约 44 毫秒），换来没有常驻进程、没有崩溃恢复、停用时没有东西要杀。代价是模块代码在两次调用之间留不住任何东西，一个任务连续调用一百次工具，光启动就是四秒多。
- 我们接受**一个模块的生命周期动作排队做**，换来迁移、删除和发布不会互相踩。代价是一次慢的检查或迁移做完之前，这个模块后面的动作都在等。停用不受影响，它在记录存下的那一刻就生效。
- 我们接受**数据结构只能加**，换来模块不带迁移代码、旧任务不用换版本。代价是起错的字段名和单位会一直留着。要改只能加一个新字段，让新版本的技能改用它。
- 我们接受**包里只许有入口代码，而且入口读不到包里的别的文件**，换来确认卡片上的代码清单是完整的，测试的期望值到不了被测的代码。代价是一个工具不能把代码拆成几个文件，不能带数据表文件，技能也不能带脚本。
- 我们接受**确认卡片比上一版出得多**，换来卡片盖住每一样带权力的东西。改一条规则、改一位成员的工具、改 feed 的一项设置，都要重新确认。只有技能、知识和只读成员的模块仍然不用卡片。
- 我们接受**被拒绝的 `grantKey` 一直是拒绝，直到使用者点「重新考虑」**，换来一张卡片只能答一次。代价是使用者把开关关了再开，看到的仍是「已拒绝」，要多点一下。
- 我们接受**级别由模块作者定、使用者改不了单个 collection**，换来模块只描述数据、路由只有一张表。代价是作者把一类数据定成 `local-only`，没有本机模型的使用者就没有任何专家读得到它，他只能去改包。作者应当少用 `local-only`。这一条有一个留给使用者的决定，见「Open questions」第 14 条。
- 我们接受**提取出来的数值要使用者逐条确认**，换来错误的提取不会悄悄变成定论。代价是使用者多一件要做的事，而且未确认的点会先触发一次带说明的提醒。
- 我们接受**模块代码今天只能在 macOS 上运行**，换来一道实测挡得住的墙。代价是宿主搬到别的操作系统之前，要先为它写沙箱配置并重跑这一套探针。

## Alternatives considered

- **一个大清单。** `module.json` 里列出全部组成和各自的设置，目录只是存放。这是候选 A 的做法。调用者看到的接口深度相同，但作者每加一个组成要改两处，这正是红旗清单里的「手工同步的清单」。输在作者一侧的负担。
- **手写一份权限清单，再两头检查。** 这是底稿原来的做法。`module.json` 里有 `permissions`，组成用了没请求的拒绝，请求了没人用的也拒绝（`unused-permission`）。使用者确认的东西集中在一个文件里，但加一个用新连接器的 feed 要改两个文件，而且那两条检查存在的唯一目的是防这份清单走样。推导之后清单和检查一起消失。
- **`grantKey` 只算一张清单：推导出的权限、代码文件和 `rules.md`。** 这是对抗审查之前的做法。清单上漏一样，那一样就能不经确认地改。审查找出四样漏掉的：`tool.json` 里的内容，成员的 front matter，feed 的 `into` 和 `settings`。反过来定规则（全部都算，只排除 Markdown 正文和测试材料）就不用再去猜还漏了什么。
- **每类组成一套宿主机制。** 知识一个工具和权限检查，数据一个，工具一个，feed 沿用 `Feed` 接口。每一套单看都更贴合，联网的行情 feed 也不用改形状。但权限、分级、访问记录、版本解析要写四遍，今天 `lookup` 和 `tripwire` 两套检查各有各的缺口就是这样来的。输在同一件事有多条路。
- **宿主进程内加载模块代码。** 最省事，feed 可以保持今天的形状。运行时什么都挡不住，一个坏模块拿到全部密钥。feeds 备忘的方向 B，已经被否过。
- **模块代码只能是纯函数，联网只靠宿主的连接器。** 这是候选 A 的做法。沙箱最严，卡片最好懂。但每接一种新服务都要改宿主，使用者明说过不为安全放弃功能。
- **只用 `node --permission` 做沙箱。** 这是对抗审查之前的做法。不依赖操作系统，哪里都能跑。实测它挡不住 `node:sqlite`、信号和优先级，所以只能当第二层。
- **模块代码自己联网，用系统沙箱限制出站地址。** feed 的写法更自由。但密钥必须交给模块代码，额度也没法统一排队，而且 `sandbox-exec` 按地址过滤并不可靠。输在密钥离开了宿主。本设计用 `sandbox-exec` 只做「全部不许」，不做按地址放行。
- **每个（模块，版本）一个常驻子进程。** 这是底稿原来的做法。省掉每次调用的启动开销，代码可以在内存里留缓存。但要管闲置退出、崩溃重启、停用时杀进程，更新后短时间内还有两个进程。实测启动只要几十毫秒，不值得为它养一套进程管理。
- **重启后从状态推算该补做哪些动作。** 这是对抗审查之前 `resume` 的做法。记录里少一个字段。但 `disable`、`purge`、撤回卡片这三种动作从状态里推不出来，崩溃就丢了。把动作直接记在记录里以后，没有什么要推算。
- **模块带迁移代码**（`migrations/<n>/migrate.ts`）。能改名、能删字段、能重排数据。但迁移代码要在子进程里跑，要等正在跑的 Worker 结束，迁移后旧任务要换钉到新版本，「版本跟着任务走」就有了例外。只能加的规则把这些全省了。
- **中间一级叫 `cloud-ok`，使用者在卡片上逐个 collection 改级别。** 这是底稿原来的做法。它把「云端」当成一个整体，可使用者信任的是具体的某一家提供方。逐个改级别也让同一个包在不同机器上有不同的含义。路由表把「数据是什么」和「数据去哪里」分给了模块和使用者。
- **feed 没有 `into` 时让作者自己写一个级别。** 少写一个 `collection.json`。但级别就有了两个来源，作者可以把读邮件的 feed 标成 `shareable`，卡片上要多解释一样东西。没有选它。
- **不留副本，任务直接读模块目录。** 省掉 `module-store/`。但作者一保存，正在跑的任务就变了行为，使用者确认过的版本也可能被悄悄换掉。H4 和 S3 都守不住。

## Open questions and risks

1. 在 Worker 沙箱落地之前，带 `bash` 的 Worker 能直接读 `modules-data/`，也能自己联网。分级、路由表和访问记录在那之前只约束守规矩的 Worker。使用者是否接受「沙箱没到位，医疗数据不进来」？
2. 只改 Markdown 的新版本不出卡片，是否可以？专家的提示词和技能能改变 Worker 的行为，但改不了它的权限。
3. 路由表默认把 `private` 和 `local-only` 关着。使用者要先决定 `private` 给哪一家提供方，医疗模块的专家才读得到检验指标和报告。`local-only` 要有本机模型才用得上，使用者打算配吗？
4. 宿主怎么认定一个提供方「在本机」？我的建议是看它的地址是不是回环地址。这一条没有对照现在的模型配置代码验证过。
5. 幕僚长每次输入都带名单和规则全文，模块多了以后占多少上下文？十个模块的名单大约一千字，规则全文今天已经在系统提示词里，只是换了位置。合计没有量过。
6. 幕僚长收不到路由表挡住的汇报和触发的正文时，它还能不能做好分派？这是推断，没有试过。使用者把幕僚长用的提供方放进 `private` 那一行，问题就不存在。
7. 操作系统的沙箱今天靠 `sandbox-exec`，macOS 已经把它标成不推荐。它被拿掉的那一天，模块代码要换一种机制才能继续运行。配置也只在 Homebrew 装的 Node 上跑过。是否接受这个依赖？ 另外，现在的沙箱规则整体放行了 `mach-lookup` 和读文件元数据，没有试过模块代码能不能经系统服务做出别的事。上线前要把这两条收窄到 Node 启动真正需要的那几项。
8. 一个联网工具自称 `read`，代理只能保证它用的是 GET。对方的 GET 接口有副作用时，宿主看不出来。这一条靠使用者在卡片上看地址来判断。
9. 条件的种类是宿主内置的。有模块需要内置集合之外的条件时怎么办？我倾向于到时候再加一种「用本模块的一个 `pure` 工具当判断函数」，现在不做。
10. 数据结构只能加。作者起错了名字或单位，或者一个字段确实不该再留，只能让它空着。要不要留一条「使用者在模块页上亲手删掉一个空字段」的路，现在不做，等真的遇到再定。
11. 使用者要逐条确认提取出来的数值。一份体检报告有几十项，页面要能一屏对照原件批量确认，否则没人会做。这个页面需要一个原型。
12. us-market 的转换（步骤 6）是迁移里风险最大的一步，它是每天在用的功能，而且必须一步做完。这一步还要拿掉 `isMarketSource`，「行情」这个 Worker 角色能不能只靠规则和技能立住，没有试过。步骤 5 用 toy-market 演练一遍，是为了降低这个风险，但 toy-market 没有联网的 feed，也没有盯盘条件，演练盖不住全部。
13. 模块代码只许 TypeScript，Node 自带的类型擦除直接运行，不装依赖，一个组成只有一个代码文件，这个文件读不到别的文件。医疗计算以后要 Python 的库或者一张大的数据表时，是加第二种运行时，还是把那类计算留在技能里让带 `bash` 的 Worker 去跑？
14. **要不要让使用者把单个 collection 的级别调严（只许调严，不许调松）？** 这一版是不许。我建议许。调严以后的级别存在实例数据里，模块包不变，`mayRead` 取两者里更严的那一个。它解决的是「作者定成 `private`，我想让它只留在本机」。只有使用者能定。
15. 模型回退被挡住时，任务停下来等主模型恢复。主模型长时间不可用时，读过私密数据的任务就一直等着。使用者是否接受？另一条路是把回退模型的提供方也放进 `private` 那一行。
16. 带字段的 `notice` 要求 feed 写进一个 `shareable` 的 collection。纯转发的 feed 为此多存了一份它本来不需要的行。数据量大时要不要给这类 collection 一个保留期限，现在没有定。
17. 没有 `into` 的 feed 一律是 `local-only`，只用 `timer` 的 feed 也不例外。它的 `notice` 是包里写死的一句话，不含任何外来内容，可幕僚长的提供方不在 `local-only` 那一行时，它收到的仍是那句「有新内容，请在本机查看」，只能靠来源名和规则决定做什么。要不要规定「`timer` 连接器不带外来内容，只用它的 feed 算 `shareable`」？这会让级别多一个来源，我没有加，留给使用者定。
18. 工具的测试用例写 `"expect": {}` 时，任何返回值都算通过，因为比较只看 `expect` 里列出的键。考题有「什么都不查就拒绝」的规则，工具用例还没有。实现时要补上，同时把靠抛异常被拒的几个坏样例改成带真实期望值。

## Next implementation step

把 `sketch/validate.ts` 的扫描和 `sketch/sandbox.ts` 的启动器搬进 `src/modules/`，接到 `just module check` 上。宿主启动时按 `"schema": 1` 分流。写了它的文件夹交给新扫描，扫描不过的标成「无效」，宿主照常启动。没写它的文件夹照旧交给今天的加载器，一行不改。同一个 PR 里修正第 10 节列出的四处过期文档。这一步不转换任何现有模块。
