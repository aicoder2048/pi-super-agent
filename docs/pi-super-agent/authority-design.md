# 授权边界设计（architect 合成结果）

修复 `interrogate.md` 的 D、E、F、G 四项。底线由程序执行，不靠提示词（ADR 0003）。

## Problem

Router 自己声明任务的依据，内核只做很少的核对。一条旧对话可以支撑任意多个请求任务，规则依据不需要触发。推断任务的并发只在开任务时检查，被订阅线程重新打开时会越过上限。推断任务的 Worker 有 bash，正则黑名单拦不住对外动作，还能连宿主 socket 冒充使用者。

约束：内核不依赖 Pi，是唯一的写入者。请求和规则任务保持全部能力。没有操作系统沙箱。

## Usage（调用方视角）

```ts
// Router 的 route 工具：依据仍由 Router 选择，内核核验证据
kernel.route([{ kind: "open_ticket", basis: "request", triggerId: "trg_对话", title, brief }]);
kernel.route([{ kind: "open_ticket", basis: "rule", ruleId: "toy-market/big-move", triggerId: "trg_行情", threads, title, brief }]);

// Router 的 reply 工具：必须注明因何而回
kernel.reply({ text: "收到，开始查。", cause: "trg_对话" });
kernel.reply({ text: "查到了：明天晴。", cause: "tkt_任务" });
kernel.reply({ text: "Codex 限流，已切到 DeepSeek。", cause: "act_通知" });

// 执行器按依据决定 Worker 的工具档位
workerArgs({ basis: "inference", ... }); // --tools read,grep,find,ls,report,hand_back,read_ticket --no-mcp
```

## Shape

1. **证据只来自触发的去向（E）。** 一条触发只能在它离开 `to_router` 的那一批 `route` 里被引用；同一批里可以开多个任务（“做 A 和 B”）。被程序层过滤（`ignored`）、已处理过的触发都不能再支撑开任务、转交或忽略。
   - `request` 要求触发在对话线程里。
   - `rule` 要求有触发、触发不在对话线程、规则 id 存在，且触发的来源在规则的适用范围内。模块规则的范围是模块声明的来源；使用者规则写 `来源: a, b` 一行，不写则适用于所有非对话来源（保持现有规则可用）。
   - 候选触发卡片上列出“适用规则”，Router 不必猜。
2. **推断并发的唯一闸门是 `claimSlot`（D）。** 进入 `running` 只有这一个入口。已有推断任务在运行时，另一个推断任务拿不到名额，保持排队；`#wakeNextQueued` 跳过被这条规则挡住的推断任务，免得卡住整个队列。开任务时的检查保留，只管每日总数。
3. **回复必须注明原因（D）。** `reply` 带 `cause`，只接受三种：
   - 对话触发 `trg_`：回应使用者的话；
   - 任务 `tkt_`：任务的最近汇报必须是可以回应的结果。推断任务只有就绪、受阻、失败或带问题时可回应；进展和无需处理都不行；
   - 通知 `act_`：`router.notify` 里 kind 为 notice 的动作，卡片上印出它的 id。
   每个 cause 最多回复 2 条（`repliesPerCause`）。候选触发不能作为 cause：Router 不能为一条原始事件主动开口，只能开推断任务等结果。
4. **推断 Worker 只读（G、F）。** 依据为推断的任务，Worker 只拿 Pi 的 `read, grep, find, ls` 和 `report, hand_back, read_ticket`，并加 `--no-mcp`。扩展里再按工具名白名单拦一次，两层有一层生效即可。没有 bash、不能写文件、没有后台命令，也就连不上宿主 socket，正则黑名单 `external-actions.ts` 删除。
5. **环境变量只在扩展里用一次（F 的补充）。** 扩展加载时读完 `PSA_*` 就从 `process.env` 删掉，请求和规则 Worker 的 bash 子进程不再继承 socket 路径和令牌。

## Synthesis decision

- 两位设计员（opus high、继承父模型）各交两个方案，推荐的方案 A 结构一致：内核按去向核验证据、`claimSlot` 闸门、回复带原因、推断 Worker 只读并关 MCP。两人的方案 B 都把推断任务改成宿主进程内的会话，都因“同一件事两种做法”被自己否掉。方案收敛，按 arena 规则直接采用共识形状。
- 交叉评审跳过：配置的评审池只有 Claude 族，与父模型同族。
- 底：opus 的 A（回复原因用卡片上印的 id、每个原因限回复次数、规则适用来源）。
- 嫁接：继承父模型方案的“候选触发卡片列出适用规则”。
- 没采用：opus 的拆分 socket。推断 Worker 已没有执行代码的工具，请求和规则 Worker 本就有使用者的全部权限，拆分不增加保证，只增加一个 socket。继承父模型方案的“触发 1 小时时效”：去向一经处理即不可再用，已经覆盖重复引用的问题。

## Tradeoffs accepted

- 我们接受推断任务不能联网、不能跑命令，换来“推断任务不能对外”由工具集保证，而不是由黑名单猜测。
- 我们接受 Router 不能为原始事件主动开口，换来推断任务真正安静。
- 我们接受同用户的进程（包括请求和规则 Worker）仍能冒充使用者、伪造来源、改规则文件；只有操作系统沙箱能关掉，规格已把沙箱列为接入第一个外部内容模块前的前置条件。

## Alternatives considered

- 授权凭据表（grants），Router 每个命令交出凭据 id：已处理状态在去向和凭据表里各存一份，分裂了所有权。
- 推断任务在宿主进程内运行：两套任务执行器，H、M 这类修复要做两遍。

## Open questions and risks

- Pi 是否严格遵守 `--tools` 和 `--no-mcp`：用真实 Pi 冒烟确认工具列表恰好是那 7 个（Phase C 第 6 步）。
- 推断任务是否需要一个只读联网工具（例如只能 GET）？本轮不加，留给使用者决定。

## Next implementation step

先写内核测试：同一条对话触发在第二批 `route` 里开请求任务被拒绝。
