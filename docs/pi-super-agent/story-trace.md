# 用户故事对照（完成判定 P3）

对照规格 `mvp-spec.md` 的 36 条用户故事。分支 `mvp` @ `26e11dc`，自动测试 197 个全部通过。

- **覆盖**：有自动测试断言该行为。宿主层测试用真实的 `Kernel` 和真实的 `Router` 会话，模型和 Worker 由测试替身扮演；凡是行为依赖真实模型或真实 Pi 子进程的，另列真实检查。
- **真实检查**：记在 `decisions.tsv` 里阶段为 `verify`、`live`、`accept` 或 `story-*` 的行，以及 `evidence/` 下的截屏文本。
- **部分**：主要行为有证据，某个方面没有，写明是哪一面以及为什么接受。

| 编号 | 故事 | 状态 | 自动测试 | 真实检查 |
|---|---|---|---|---|
| 1 | 随时说话，立即回应 | 覆盖 | `host.test.ts` 连发两句 | 验收第 1、2 步（`evidence/step1-2.txt`） |
| 2 | 同时推进多项任务 | 覆盖 | `host.test.ts` 连发两句、名额满时排队 | 验收第 1、2 步 |
| 3 | 只面对一个 Agent | 覆盖 | `host.test.ts` Worker 推理不出现在回复里 | 验收全程 |
| 4 | “刚才那个改成方案 B” | 覆盖 | `host.test.ts` 对话卡片列出任务，只凭卡片转交 | 状态目录迁移检查里“刚才那个写 note.txt 的任务”（`story-36` 行） |
| 5 | 回复不超过 200 字 | 覆盖 | `kernel.test.ts` 回复超过 200 字被拒绝 | 无需 |
| 6 | 确认一次后保持安静 | 覆盖 | `kernel.test.ts` 进展不通知、回复必须注明原因 | 验收第 6 步全程安静 |
| 7 | 只收到一个具体问题 | 覆盖 | `stories.test.ts` 故事 7 | 故事 14 检查里 Router 只问了一个问题 |
| 8 | 随时叫停 | 部分 | `kernel.test.ts` 叫停不再接收输入、`host.test.ts` 启动中叫停 | 没有对真实 Pi 子进程做叫停检查；`RpcClient.stop` 与宿主停机共用同一路径，宿主停机在验收第 5 步覆盖 |
| 9 | 任何脚本都能投递触发 | 覆盖 | `sources.test.ts`、`host-events.test.ts` | 验收第 3 步 |
| 10 | 定时器产生触发 | 覆盖 | `sources.test.ts` 定时器、`stories.test.ts` 故事 10 | 没有真实检查；定时器不涉及模型 |
| 11 | 后续触发直达 Worker | 覆盖 | `host-events.test.ts` 已订阅线程直达 | 验收第 3 步（去向 `delivered`，Router 无决定） |
| 12 | 用自然语言写规则 | 覆盖 | `modules.test.ts` 规则与适用来源、`stories.test.ts` 故事 12（规则进入 Router 提示词） | 验收第 6 步 |
| 13 | 无关触发在调用模型前筛掉 | 覆盖 | `host-events.test.ts` 程序层过滤不调用模型 | 验收第 6 步（+0.2% 被过滤） |
| 14 | 没有规则也能自行判断 | 覆盖 | `host-events.test.ts` 推断任务 | `live` 行：安全公告触发自行开推断任务 |
| 15 | 推断任务先悄悄做 | 覆盖 | `kernel.test.ts` 推断任务不发确认、无需处理后不能回复 | 故事 14 检查（进展不打扰，受阻才开口） |
| 16 | 推断任务不能对外 | 覆盖 | `worker-tools.test.ts`、`worker-extension.test.ts` | `verify` 行：真实 Pi 工具列表 |
| 17 | 提起旧事能找回上下文 | 部分 | `host-events.test.ts` 逐跳读取、`host.test.ts` 对话卡片列出任务 | 卡片只列进行中和最近 3 个结束的任务；更早的旧事靠 `read` 逐跳和 Router 会话记忆，会话压缩之后的找回没有专门检查 |
| 18 | 看板显示阶段和最近汇报 | 覆盖 | `kernel.test.ts` 阶段表、`client.test.ts` 看板 | 验收截屏 |
| 19 | 模型、工具次数、token、时长 | 覆盖 | `worker-events.test.ts`、`kernel.test.ts` 看板、`client.test.ts` | 验收截屏（工具 3、9.4k tok） |
| 20 | 只读翻看 Worker 过程 | 覆盖 | `stories.test.ts` 故事 20、`client.test.ts` | Stage 4 备注里的 `/watch` |
| 21 | 看到每条触发的去向 | 覆盖 | `trigger-log.test.ts` | `story-21` 行：`just log` 在验收状态目录上运行 |
| 22 | 关掉客户端后继续运行 | 覆盖 | `stories.test.ts` 故事 22 | Stage 4 备注（关掉客户端后在 52 列重开） |
| 23 | 重启后任务、订阅、会话都在 | 覆盖 | `recovery.test.ts`、`router-durability.test.ts`、`stories.test.ts` 故事 23 | 验收第 5 步 |
| 24 | 停机期间投递的触发恢复后处理 | 覆盖 | `sources.test.ts` 积压文件、`router-durability.test.ts` | 无需 |
| 25 | 宿主无响应时自动拉起 | 覆盖 | `watchdog-main.test.ts`、`watchdog.test.ts` | `live` 行：kill -9 后 13 秒拉起；验收第 5 步 |
| 26 | 长时间无进展时通知 | 覆盖 | `watchdog.test.ts`、`host-events.test.ts` Watchdog 通知卡片 | `live` 行：90 秒无进展的通知经 Router 转告 |
| 27 | 消息失败后自动重试 | 覆盖 | `kernel.test.ts` 退避、`stories.test.ts` 故事 27、`router-durability.test.ts` | 无需 |
| 28 | 默认走 Codex 订阅 | 覆盖 | `stories.test.ts` 故事 28、`models.test.ts` | 全部真实检查都走 Codex |
| 29 | 限流时回退到 DeepSeek | 部分 | `fallback.test.ts`、`wiring.test.ts`、`stories.test.ts` 故事 29 | 真实限流无法有意触发；Worker 一侧的 `client.setModel` 只有测试替身覆盖 |
| 30 | 回退用量的每日上限 | 覆盖 | `fallback.test.ts` 四条、`kernel.test.ts` | 无需 |
| 31 | 代码层拒绝 Anthropic | 覆盖 | `models.test.ts` 含经其他提供方的 Claude | 无需 |
| 32 | 来源内容只当数据 | 覆盖 | `host-events.test.ts` 来源指令不构成请求、`kernel.test.ts` 证据核验 | 同用户进程仍能伪造来源，没有沙箱，见 `authority-design.md` 的取舍 |
| 33 | 规则只能由我编辑 | 覆盖 | `host.test.ts` Router 工具集、`kernel.test.ts` 规则依据 | 请求和规则 Worker 有 bash，能改规则文件，同上 |
| 34 | 加模块不改内核 | 覆盖 | `modules.test.ts`、`kernel.test.ts` 内核不引用 Pi | 玩具模块 |
| 35 | 以后用桌面端或手机端 | 范围外 | `client.test.ts` 协议不含 TUI 控制字符 | 规格“不在范围内”：桌面端和手机端 |
| 36 | 复制状态目录就能迁移 | 覆盖 | `relocate.test.ts` | `story-36` 行：A 开任务、搬到 B、续上并记得暗号 |

## 部分覆盖项为什么接受

- **8**：叫停在内核和宿主两层都有测试；真实子进程的停止与宿主停机走同一个 `stop()`，后者有真实检查。
- **17**：找回近期上下文已由卡片保证；更早的旧事依赖模型按 id 逐跳读取，属于模型能力，没有确定性的测试方法。
- **29**：真实的 Codex 限流无法按需制造；切换逻辑在真实 Router 会话上有测试。
