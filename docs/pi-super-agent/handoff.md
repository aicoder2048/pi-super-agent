# 交接：Pi Super Agent MVP（2026-11-08）

新会话请先读：本文件、`~/.claude/projects/-Users-szou-Python-Playground-PiSuperAgent/memory/pstack-full-adherence.md`（必须走完整 pstack 流程）、`docs/pi-super-agent/figure-it-out.md` 的 Phase E。

## 已完成

- MVP 六个阶段加一轮 figure-it-out 审计整改，已作为 PR 栈 #4 到 #10 全部 squash 合并进 `main`（`519487b`）。
- 每个 PR 合并前都有独立验证者的 PASS+NOTES 评论；合并时逐个比对 patch-id，`main` 与验证过的头 `4fce72e` 内容一致；`main` 上 198 个测试通过。
- 远端 `psa/*` 和 `mvp` 分支有意保留：原始 35 个提交只在那里，`decisions.tsv` 引用了它们的 SHA。

## 跟进：`psa/ship-log`

- 决策记录补上了验证结论与合并过程。
- 状态目录路径过长时，宿主在动任何状态之前就报出清楚的错，不再是 `listen EINVAL`。测试 `host.test.ts` 覆盖了报错内容和“已有状态目录不被改动”两点，都是先红后绿；真实入口 `just host` 也确认过。
- 规格的测试先例改为指向 `src/pi-runtime.mjs`。
- 使用者规则必须写 `来源:` 才生效（分支 `psa/rule-sources`）。没写或列表为空的规则不进 Router 提示词、不能作依据，宿主启动时逐条打印一行说明。

## 未决（等使用者决定，不要自行改）

- 默认回退模型 `deepseek/deepseek-flash` 是按量计费；规格确认过“回退 DeepSeek 加每日上限”，验证者建议改默认值。
- 推断任务是否需要一个只读联网工具（只允许 GET）。
- 讨论过但未实施：自动化端到端测试，建议先做“真实宿主与 Worker 子进程 + 本地假模型 HTTP 服务”的确定性层，驱动客户端协议而不是 TUI。

## 运行注意

- 测试：`just test`（或 `node --import ./src/pi-runtime.mjs --test --test-timeout=30000 tests/*.test.ts tests/*.test.mjs`）。跑测试和提交分两条命令，先确认全绿再提交。
- 真实检查只用 `openai-codex/*`；临时状态目录要短（`mktemp -d /tmp/psa-XXXX`），否则 socket 超长。
- 决策记录脚本：`bash ~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/show-me-your-work/scripts/log.sh docs/pi-super-agent/decisions.tsv <phase> <decision> <why> <evidence> <result>`。
