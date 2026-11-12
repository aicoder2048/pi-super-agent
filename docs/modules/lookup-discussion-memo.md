# 讨论备忘：看盘队查股价的功能从哪里来，`lookup` 该不该是通用工具

2026-11-10 的几轮问答整理。前三节是查证过的事实，对照的是当天的代码和一个真实任务的会话记录；第四节是设计意见和一个还没定的决定。

## 起因

使用者在页面上问了六只科技股的行情，任务归到了「万壑松风 · 看盘队 #6」（`tkt_fac29705`）。使用者原以为报价是看盘队里某位专家成员查的，于是问：查股票数据是 us-market 模块做的吗？是技能，还是注册的命令？

## 1. 这次报价是谁查的

**是助手自己调用 `lookup` 工具查的。不是技能做的，也不是成员做的。**

任务的会话记录里，助手的工具调用依次是：

1. `read` 技能 `us-market-desk`。
2. `lookup us-market session`：拿纽约日期和交易时段。
3. `lookup us-market quote`：一次查六个代码。`SPACEX` 没有返回报价。
4. `dispatch_agent` 派给新闻研究员：只核实 SpaceX 的上市状态和代码。
5. `lookup us-market quote`：用核实到的代码 `SPCX` 再查，然后汇报。

没有派给行情分析师，是因为技能的派活表第一行写着「只问一个价格：不派，自己 `lookup`」。问「为什么跌」「技术面怎么看」时才会派给成员。

查股价这件事涉及三层，各在各的位置：

| 层 | 在哪里 | 做什么 |
|---|---|---|
| 数据源代码 | 宿主的 `src/sources/market/` | 真正请求行情接口，做缓存、排队、算指标 |
| 模块清单 | `modules/us-market/module.json` 的 `sources[].feed` | 声明启用 `massive-stocks` 这个数据源，来源名叫 `us-market`，并写自选股、档位等设置 |
| 技能 | `modules/us-market/skills/us-market-desk/SKILL.md` | 规定行情数字只用 `lookup us-market` 的结果，以及什么时候不派活 |

- **技能只是一份说明**，它本身不能查数据，只告诉模型用哪个工具、怎么用。
- **底层供应商是 Massive**：`module.json` 里这个数据源的 `baseURL` 是 `https://api.massive.com`，代码里另一个允许的地址是 `https://api.polygon.io`。宿主返回给助手的结果里不带供应商，所以助手回答「无法确认」是如实的。
- **密钥只在宿主手里**，助手和成员的进程都拿不到。

## 2. `lookup` 是哪个扩展注册的，怎么成为可用工具

**注册**：`src/worker/extension.ts`，仓库里唯一的 Worker 扩展。宿主启动任何助手或成员的 Pi 进程时都带 `--no-extensions -e src/worker/extension.ts`，只加载这一个扩展。它用 `pi.registerTool` 注册了：

- 所有进程都有：`web_get`、`lookup`。
- 只有助手有：`report`、`hand_back`、`read_ticket`，有团队时的 `dispatch_agent`，非推断任务的 `bg_start` 等。

`lookup` 自己不访问行情接口。它把请求经本机 socket 交给宿主（`worker.lookup`），宿主找到对应的数据源去查，再把结果返回。

**可用与否**由一份允许清单决定：

| 谁 | 允许清单从哪来 | 有没有 `lookup` |
|---|---|---|
| 助手，请求或规则的任务 | 不设限 | 有 |
| 助手，推断的任务 | `src/worker/tools.ts` 的 `INFERENCE_TOOLS` | 有 |
| 成员 | 任务依据允许的工具，和成员文件 `tools` 的交集 | `tools` 里写了才有 |

允许清单在两处生效：启动 Pi 时用 `--tools` 只激活清单里的工具；扩展里还有一道 `tool_call` 拦截，清单之外的调用一律挡下并说明原因。

模型怎么知道能查什么：工具说明里有一段「可查：…」，内容是每个数据源自带的帮助文字（`lookupHelp`），由宿主启动进程时传进去。

## 3. `lookup` 是不是看盘队专用

**不是。**

- **助手**：任何领域、甚至没有领域的助手都有 `lookup`。
- **成员**：按成员文件。看盘队四位的 `tools` 都写了 `lookup`；Pi专家队九位都没写，所以用不了。
- **宿主不按领域限制**：收到 `lookup` 请求时，只看来源名有没有登记过的数据源，不看任务属于哪个领域（`src/host/host.ts` 里传给 Workers 的 `lookup`）。所以 pi-pi 领域的助手，技术上也能调 `lookup us-market quote`。

us-market 模块专有的只有两样：`module.json` 声明了数据源（拿掉模块，数据源就不存在，谁调都得到「没有来源可查」）；技能教助手和成员怎么用它。

### 附带澄清：没有单独的「看盘队」模块目录

只有一个模块 `modules/us-market/`。「看盘队」是这个模块里团队的名字，写在 `module.json` 的 `team` 字段：

```
modules/us-market/
├── module.json                       模块名 us-market，team 写着「看盘队」，sources 里声明行情数据源
├── rules.md                          规则
├── skills/us-market-desk/SKILL.md    共同做法
└── agents/                           这四个文件就是看盘队
    ├── market-analyst.md             行情分析师
    ├── technical-analyst.md          技术分析师
    ├── news-researcher.md            新闻研究员
    └── earnings-reader.md            财报解读
```

来源、领域、团队是同一个模块的三个面。来源名和模块名恰好都是 `us-market`，所以看起来像两样东西。领域就是模块（ADR-0009），没有单独的「来源模块」和「领域模块」。「Pi专家队」是另一个模块 `modules/pi-pi/` 的团队，和看盘无关。

## 4. 设计意见：`lookup` 该不该属于领域模块

使用者的意见：这个工具看起来不应该是 Super Agent 的通用工具，而应该属于领域模块。

结论是**对了一半**。分三层看：

| 层 | 现状 | 判断 |
|---|---|---|
| `lookup` 这个工具本身 | 宿主的 Worker 扩展，所有助手都有 | 它只是一条通道（来源、操作、参数），通道做成通用的没问题 |
| 行情数据源的代码 | 宿主的 `src/sources/market/` | ADR-0005 的有意决定，理由仍然成立 |
| 谁能查哪个数据源 | 没有限制 | **使用者说得对，应该按领域收紧** |

**数据源代码为什么放在宿主**（ADR-0005）：

- 行情轮询要和宿主同生共死，游标和触发在同一个数据库里，崩溃重放不会重复。
- 免费档每分钟只有 5 次请求，看盘轮询和助手查价必须共用一份额度，宿主里只能有一个行情客户端。
- 模块自带代码让宿主加载，模块就从「数据」变成「任意代码」，跑在宿主进程里。ADR 把它列为没有采用的做法。

**所有助手都有 `lookup` 的理由已经过时。** ADR-0005 写的是「每种依据都有这个工具，包括推断任务；可查的来源和操作写在工具描述里，因为推断任务没有规则，不加载模块 skill」。这是 ADR-0009 之前写的。现在任务属于一个领域，推断任务也拿得到模块技能。

现状带来的两个实际问题：

- 别的领域的助手也带着 `lookup` 和一段用不上的行情帮助文字，每一轮都占上下文。
- 以后如果加带私人数据的数据源（例如邮箱），任何领域的任务都能查，是一个安全口子。现在只有只读的行情，问题不大。

## 5. 建议的改法（还没做）

不搬代码，只收紧访问范围：

1. **宿主按领域校验**：任务只能查它所属领域的模块声明的数据源。
2. **工具按领域出现**：任务的领域没有声明数据源时，不给它的助手注册 `lookup`；工具说明里只列本领域的数据源。
3. **没有领域的通用助手怎么办**，见下面的待定事项。

改完之后，从使用上看 `lookup us-market` 就是 us-market 领域的工具，代码仍在宿主里。

涉及的文件：`src/host/host.ts`、`src/host/workers.ts`、`src/worker/extension.ts`；另要一份 ADR 更新 ADR-0005 的那句话；`docs/modules/module-user-guide.md` 的第 4 章和第 7 章跟着改。

## 6. 待定事项

**没有领域的通用助手，是保留查询能力，还是一起收紧？**

- 保留：使用者在对话里随口问一个股价，即使幕僚长没把任务归到 us-market，通用助手也能查到。代价是通用助手仍能查所有数据源，第 4 节的安全口子只关了一半。
- 收紧：只有归到对应领域的任务能查。更干净，但幕僚长归错领域时，使用者会得到「查不了」。

这个决定由使用者做。定了之后再动手。

## 依据

| 内容 | 位置 |
|---|---|
| 这次任务的工具调用 | `~/.pi-super-agent/sessions/workers/` 下任务 `tkt_fac29705` 的助手会话 |
| `lookup` 和 `web_get` 的注册、允许清单的拦截 | `src/worker/extension.ts` |
| 各依据和成员的工具清单 | `src/worker/tools.ts` |
| 宿主处理 `worker.lookup` | `src/host/workers.ts`、`src/host/host.ts` |
| 数据源的登记 | `src/sources/feeds.ts`、`src/sources/market/` |
| 模块对数据源的声明 | `modules/us-market/module.json` |
| 设计决定 | `docs/adr/0005-real-market-source-in-host.md`、`docs/adr/0009-a-ticket-belongs-to-one-domain-and-the-domain-is-a-module.md` |
| 相关文档 | `docs/modules/module-user-guide.md`、`docs/modules/module-skills-memo.md` |
