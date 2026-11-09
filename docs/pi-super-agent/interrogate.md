# interrogate 结果（2026-11-08）

## Intent

使用者只对一个 Router 说话。Router 立即回应，在后台并行派出 Worker（每个任务一个 Pi 子进程）。外部触发（投递目录、定时器、模块）在没人开口时驱动工作。关掉客户端或杀掉宿主不丢任务、订阅和会话。只有使用者本人的话和使用者写的规则文件能授权，依据为推断的任务永远不能自行做对外动作。模型默认走 Codex 订阅，限流时回退到 DeepSeek 并有每日上限，代码层拒绝 Anthropic。

## 审查范围与审查员

- 范围：`e377ad8` 到快照 `2f8752f`（`mvp` 分支加当时未提交的 Stage 5 改动）。
- 审查员 P：继承父模型，worktree `.claude/worktrees/agent-a0eceffe858faa8df`，复现脚本在 `repro/`。
- 审查员 O：opus high，worktree `.claude/worktrees/agent-a96b8643066459461`，复现脚本在 `probes/`。
- 两人各报 14 条。协调者在各自 worktree 里重跑了全部命令。P 的 13 条和 O 的 14 条都复现了。P 的第 14 条已在快照之后由 TDD 单元修掉（`tests/watchdog-main.test.ts`）。没有丢弃任何发现。

## 按根因合并后的发现

| 编号 | 发现 | 来源 | 复现命令（在对应 worktree 根目录） | 违背的意图 |
|---|---|---|---|---|
| A | 叫停正在启动 Worker 的任务，宿主因 `no pending action` 崩溃；被叫停的 Worker 仍收到任务说明并开工 | P1、O1 | `repro/host-stop-during-spawn.ts`、`probes/p17-stop-crash.ts`、`probes/p16-stop-during-spawn.test.ts` | 叫停后不再接收输入；宿主不能崩溃 |
| B | `router.notify` 一进内存就记为完成。宿主被杀后，已交给 Router 的对话和触发永远停在 `to_router`；Router 一轮以非额度错误结束时，这批通知再也不会被处理 | P2、O2、O3 | `repro/host-kill-router-loss.ts phase1/phase2`、`probes/p5-kill-mid-turn*.test.ts`、`probes/p4-router-error.test.ts` | 重启不丢工作；通知不能丢 |
| C | 投递目录：字段类型错误的文件让扫描和宿主启动失败，后续触发全部卡住；同名文件第二次起被当作重复丢弃；半写入的文件被永久拒收 | P3、P4、P5、O11 | `repro/generic-repros.ts poison/reuse/partial`、`repro/host-poison.ts`、`probes/p11-generic-filename.ts`、`probes/p12-generic-partial.ts` | 放一个文件就是一条触发，事件不丢 |
| D | 推断任务限制不全：已结束的推断任务被订阅线程重新打开后，同时运行数超过 1；回复不带 `ticketId` 就绕过“不发确认”，汇报无需处理后仍可回复 | P6、P7、O6（部分）、O8 | `repro/kernel-repros.ts`（A、B 段）、`probes/p15-inference-reopen.ts` | ADR 0003 由程序执行的三条限制 |
| E | 依据由 Router 自报：一条旧对话可反复支撑任意多个请求任务；规则依据不要求触发命中规则，甚至不要求有触发 | O6 | `probes/p2-basis.ts` | 只有使用者的话和规则能授权 |
| F | 宿主 socket 的客户端角色没有认证，Worker 环境里就有 socket 路径，推断任务的 Worker 一条命令就能冒充使用者说话 | O5 | `probes/p1-authority.test.ts` | 只有使用者本人的话能授权 |
| G | 推断任务的对外命令拦截列表可被常见写法绕过（`git -C . push`、`curl --json`、`curl -d@file`、`gh api -f`、`python3 urlopen`） | P8、O7 | `repro/external-actions.ts`、`probes/p1b-blocklist.ts` | 推断任务不能做对外动作 |
| H | Worker 一轮以模型错误结束或子进程中途崩溃时，任务静默变成空闲，没有汇报，Watchdog 也看不到 | P9、O4 | `repro/host-worker-error.ts error`、`repro/host-worker-crash.ts`、`probes/p3-worker-error.test.ts`、`probes/p3b-worker-crash.test.ts` | 卡住的任务不能无声无息 |
| I | 汇报“就绪”并附问题、且不等待时，阶段显示“已结束”而不是“等你回答” | P10 | `repro/kernel-repros.ts`（C 段） | 规格阶段表第一条命中 |
| J | 客户端丢掉与上一条同一毫秒到达的回复；`say` 没有确认，宿主挂住时说的话丢了也不提示 | P11、O12、O13 | `repro/client-drops-reply.ts`、`probes/p6-client-same-ms.test.ts`、`probes/p14-hung-host.test.ts` | Router 的每条回复都要到达使用者 |
| K | 看板显示最早的两个已结束任务，最新的被折叠 | P12 | `repro/board-closed.ts` | 看板显示最近的状态 |
| L | 同一个系统问题，Watchdog 约每 30 分钟重复通知一次 | P13 | `repro/watchdog-repeat.ts` | 同一问题只通知一次 |
| M | 回退模型每日上限对已在运行的 Worker 不生效；Router 在回退模型上的用量不计入每日累计 | O9、O10 | `probes/p9-cap-overrun.test.ts`、`probes/p8-router-usage.test.ts` | 超过上限就停，用量按日累计 |
| N | 经 Bedrock、OpenRouter 等其他提供方调用的 Claude 模型能通过禁用检查 | O14 | `probes/p13-ban.ts` | 不误用按量计费的 Claude |
| O | Watchdog 会 SIGKILL 复用了心跳 pid 的无关进程 | P14 | 已修，见 `tests/watchdog-main.test.ts` | 不误杀 |

## 试过但没有问题的方向

- Router 的批量注入竞态：在最后一步的不同时机注入，两条通知每次都被处理（O 的 `probes/p10*`）。
- Router 的 `read` 工具确实是自定义工具，不是 Pi 内置的读文件工具（O 的 `probes/p7`）。
