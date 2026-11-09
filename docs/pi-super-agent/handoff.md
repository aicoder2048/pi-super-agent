# 交接：Pi Super Agent MVP（2026-11-08 会话结束时）

新会话请先读：本文件、`~/.claude/projects/-Users-szou-Python-Playground-PiSuperAgent/memory/pstack-full-adherence.md`（必须走完整 pstack 流程）、`docs/pi-super-agent/figure-it-out.md` 的 Phase E。

## 已完成

- MVP 六个阶段加一轮 figure-it-out 审计整改，已作为 PR 栈 #4 到 #10 全部 squash 合并进 `main`（`519487b`）。
- 每个 PR 合并前都有独立验证者的 PASS+NOTES 评论；合并时逐个比对 patch-id，`main` 与验证过的头 `4fce72e` 内容一致；`main` 上 198 个测试通过。
- 远端 `psa/*` 和 `mvp` 分支有意保留：原始 35 个提交只在那里，`decisions.tsv` 引用了它们的 SHA。

## 进行中：本地分支 `psa/ship-log`（基于 `main`，未推送）

| 提交 | 内容 | 状态 |
|---|---|---|
| `19ae0cc` | 决策记录：验证结论与合并过程 | 完成 |
| `917f031` | 状态目录路径过长时宿主启动前报清楚的错（先红后绿，测试 `host.test.ts` “路径太长”）；规格引用改为 `src/pi-runtime.mjs` | 完成，全量 199 个通过 |

剩下的步骤：

1. 用真实入口确认报错：`PSA_STATE_DIR=<一个超过 90 字节的路径> just host`，应打印“状态目录路径太长……”而不是 `listen EINVAL`。上个会话跑了但没看到输出。
2. 提交前检查：对 `main..psa/ship-log` 跑 `no-comments`（Comment Sicko），`deslop` 没安装，用内置 `simplify` 代替。
3. 在 `decisions.tsv` 记一行 followup 完成，然后推送 `psa/ship-log`，按 pstack Opening a PR 开 PR（标题如 `fix(host): fail fast when the socket path is too long`，正文含 Why / What changed / Scope / Verification，结尾加 Claude Code 生成标记）。仓库是公开的。
4. 使用者只要求开 PR。若要合并，按 Shipping：先派一个独立验证者在 PR 上留结论，再 squash 合并并读回。

## 未决（等使用者决定，不要自行改）

- 默认回退模型 `deepseek/deepseek-flash` 是按量计费；规格确认过“回退 DeepSeek 加每日上限”，验证者建议改默认值。
- 推断任务是否需要一个只读联网工具（只允许 GET）。
- 使用者规则不写 `来源:` 时适用所有非对话来源（当前默认）。
- 讨论过但未实施：自动化端到端测试，建议先做“真实宿主与 Worker 子进程 + 本地假模型 HTTP 服务”的确定性层，驱动客户端协议而不是 TUI。

## 运行注意

- 测试：`just test`（或 `node --import ./src/pi-runtime.mjs --test --test-timeout=30000 tests/*.test.ts tests/*.test.mjs`）。跑测试和提交分两条命令，先确认全绿再提交。
- 真实检查只用 `openai-codex/*`；临时状态目录要短（`mktemp -d /tmp/psa-XXXX`），否则 socket 超长。
- 决策记录脚本：`bash ~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/show-me-your-work/scripts/log.sh docs/pi-super-agent/decisions.tsv <phase> <decision> <why> <evidence> <result>`。
