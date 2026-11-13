# us-market retirement plan

美股只留一个模块 stock-ta。它只管客观的交易数据和由它算出的信号，新闻、财报解读和宏观不进来。us-market 退役。
起点是 2026-11-13 的状态。us-market 已经在旧 Mac 上关掉了，所以你唯一的一条盯盘条件现在不响，价格问题也没有美股看盘队来答。stock-ta 的 5% 大波动规则照旧响。
计划先补这两个缺口，再搬完、删掉 us-market 剩下的东西。盘面专家（行情分析师）搬进 stock-ta，带只读的报价、分钟线和下一次财报日工具。新闻研究员和财报解读不搬。专家队变成 6 位，结构形态、趋势动量、信号分诊、市场情绪、风险计划、盘面。
提醒只走 stock-ta 的报价 feed 一条路。档位只留个股 5% 和 8%、SPY 和 QQQ 2% 和 3%，不要 3% 档、指数 1.5% 档和放量。你的盯盘条件迁成 G3 的 `day-move` 条件。
程序守两条规则。旧 Mac 上任何时候最多只有一套提醒在响。你依赖的提醒不会悄悄消失，到档的那一行直接发到 Telegram，不经过幕僚长。
PR 顺序是 R2a、R1、R2b、R3、R5、R6、R7，依次叠放。原来的 R4 并进了 R1。R2a 和 R1 合并后各在旧 Mac 部署一次，R1 那次把你的盯盘条件迁过去。R6 是最后一次部署，删掉 `sources.us-market`。R7 删旧代码。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并 PR。七个 PR 都停在 merge-ready，使用者说可以合并时，按 Shipping 从下往上合并。R2a 改了价格问题的回答方式，R1 改了 Telegram 上提醒的文字，R5 改了档位提醒和网页，这三个要使用者看过截图和视频再合并。旧 Mac 上的每一步写操作，包括 R2a、R1 合并后的部署和 R6，都只在使用者明确说「部署」以后做，之前只许只读查看。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Appendix E 第 11 条要先有答复，或者按写好的默认做法走。
- [ ] Read these from trunk at program start. Re-read them at every tick. 本机 pstack 不在本仓库里，用插件缓存 `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/` 代替 `git show origin/main:`。
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/architect/SKILL.md`
  - [ ] Control skill `control-ui` 和 `control-cli` 未安装。命令行 lane 用脚本跑 `just` 命令并存输出，宿主 lane 用 `tests/e2e/harness.ts`，网页 lane 用仓库自己的 Playwright，见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 和 S 计划一样，由一个会话串行推进，每个 PR 收尾时在决策记录里记一行代替 tick。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owner 用 `pstack:poteto-agent`。
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] R2a branches from `main` as `psa/rt-r2a-quote`。它最急，因为 us-market 关掉以后价格问题没人快答。
  - [ ] R1 on R2a (`psa/rt-r1-day-move`)。R2b on R1 (`psa/rt-r2b-desk`)。R3 on R2b (`psa/rt-r3-earnings`)。R5 on R3 (`psa/rt-r5-cutover`)。R6 on R5 (`psa/rt-r6-deploy`)。R7 on R6 (`psa/rt-r7-delete`)。
  - [ ] R5 还依赖 #105（私密数据之后幕僚长在 Telegram 上只回一行）。#105 合并进 main 后，把 main 合并进 R5 的分支再验证。#105 没合并时 R5 停在 code-ready。
  - [ ] R7 不早于 R6 部署后第一个完整交易日收盘。
- [ ] Hold the file boundaries. R2a 只碰 `docs/modules/examples/stock-ta/`、`docs/modules/stock-ta.md`、`tests/`、`docs/modules/evidence/`。R1 只碰 `src/modules/`、`src/cli/`、`justfile`、`docs/modules/examples/stock-ta/data/quotes/`、`docs/modules/examples/stock-ta/feeds/quotes/`、`tests/`、`docs/modules/evidence/`、`docs/modules/architecture/`、`docs/modules/module-user-guide.md`、`docs/modules/stock-ta.md`。R2b、R3 只碰 `docs/modules/examples/stock-ta/`、`docs/modules/stock-ta.md`、`tests/`、`docs/modules/evidence/`。R5 碰 `docs/modules/examples/stock-ta/`、`modules/us-market/`（删）、`src/modules/feed-runner.ts`、`src/host/`、`src/web/`、`src/cli/migrate-us-market.ts`、`tests/`、`docs/`。R6 只碰 `docs/modules/stock-ta.md`、`docs/deploy/`、`docs/modules/evidence/`。R7 只删和搬，碰 `src/`、`tests/`、`demos/`、`justfile`、`docs/`、`GLOSSARY.md`。没有 PR 碰 `extensions/`、`.pi/` 和使用者未提交的文件。
- [ ] Hold the review gate. R2a、R1、R5 change an interaction（价格问题的回答、Telegram 提醒文字、档位提醒和网页）. 它们等使用者在聊天里看过截图和视频再合并。旧 Mac 上的写操作等使用者说「部署」。

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 以 `just test` 全绿、`node docs/modules/architecture/check.mjs` 全绿、改到 stock-ta 包时 `just module check docs/modules/examples/stock-ta` 为 ok 为准。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `deslop` 用内置 `simplify` 代替，`no-comments` 用 `pstack:comment-sicko` 代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`. 仓库没有 Bugbot，记一行 skip。
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. 叠放的 PR 合并父分支，不 force-push，`--force-with-lease` 也不用。
- [ ] 推送前查私人信息。仓库是公开的。diff 里不能出现家目录绝对路径、邮箱、机器名，旧 Mac 只写「旧 Mac」。证据里不写你盯盘条件的代码和数值，只写条数和种类。所有手动命令都设临时的 `PSA_STATE_DIR`，不碰本机的 `~/.pi-super-agent`。
- [ ] PR 正文用中文，`## Why` 开头写使用者的目标（一个美股模块，us-market 退役，你依赖的提醒一条不丢），结尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。提交署名 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict. 审查者一个看正确性，一个看「最多一套提醒、依赖的提醒不悄悄消失」这两条规则，R1、R5 再加一个看迁移有没有丢条件、重跑会不会多出条件、回退能不能起来。
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 不合并，停在 merge-ready。使用者说合并时按 Shipping 从下往上 squash 合并，每个先比 patch-id 再跑测试。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本次在本机跑，每条 lane 用自己的临时状态目录。R6 的 lane 在旧 Mac 上跑。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 命令行 lane 设 `PSA_STATE_DIR=$(mktemp -d)` 后跑 `just ...`。宿主 lane 用 `tests/e2e/harness.ts` 的 `startHost`，假模型用 `tests/e2e/fake-model.ts`，真模型只用 `openai-codex/*`。stock-ta 包用 `cp -R` 装进临时状态目录的 `modules/`，再 `just module on stock-ta`。
- [ ] 不连网的 lane 用 fixtures 回放 Massive 快照、分钟聚合和 Finnhub 应答。真行情 lane 用宿主密钥文件里的 `POLYGON_API_KEY` 和 `FINNHUB_API_KEY`，只读。要盘中行情的 lane 在美东 9:30 到 16:20 跑，时段外脚本拒绝，加 `--off-hours` 才跑（和 G5 一样）。
- [ ] 回放器 `docs/modules/evidence/replay-day.ts`（R1 建，R5 扩充）按分钟把一整天的快照喂给被测的一边，时钟用假的，经 R1 加进 feed 输入的 `now` 传给 handler。剧本在 `tests/fixtures/us-market-day/`，至少有这些：跳空直接到 8% 档、5 到 8 逐档上升再回落、4.996% 和 5.00%、开盘第一份快照里的盘前成交、SPY 到 1.6% 和 2.1%、提前收盘日、节假日（整天都是昨天的报价）、盘后的成交。
- [ ] 输入只走 `just` 命令、宿主 socket 和网页。只读诊断是 `just modules`、对状态目录跑的 `sqlite3 -readonly`、宿主日志。R6 在旧 Mac 上只用 `ssh -o BatchMode=yes` 跑文档里写的命令和只读诊断。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. 命令行 lane 存 `<slug>.txt`。

### Deploy to the old Mac, each time after you say 「部署」

R2a、R1、R6 合并后各部署一次。R2b、R3 跟着下一次部署走，你想早点用也可以单独部署。R5 合并后不单独部署，它就是 R6 部署的内容。步骤写在 `docs/modules/stock-ta.md` 的「旧 Mac 部署」一节，R2a 写好，R1 和 R6 补充。

- [ ] 只读预检，任何时候都能做。记下旧 Mac 的 SHA、`just modules` 的开关、stock-ta 的 `_conditions` 条数、自选股条数、`config.json` 的键、当天提醒行和触发的条数。
- [ ] 时间选在美东 16:20 以后或周末，切换中没有盘中行情。
- [ ] 备份 `config.json`，用 `sqlite3 .backup` 备份 `state.db` 和 `modules-data/stock-ta/data.db`。
- [ ] `git pull` 到 main，`cp -R docs/modules/examples/stock-ta` 到状态目录的 `modules/stock-ta`，`just module setup stock-ta`，按 H4 的 runbook 重启服务。
- [ ] 只在 R1 那次部署。`just migrate-us-market` 打印 1 行「新建 day-move」，种类和预检相同；再 `just migrate-us-market --apply`；再跑一次，打印「全部不变」。你的盯盘条件从这一刻起重新会响。
- [ ] `just notify` 发一行测试。你不用守着手机，事后在 `telegram_messages` 里查到这一行的 message_id 就算发出，你看到时回一句确认就行。
- [ ] 回退。恢复 `config.json` 和 `modules-data/stock-ta/data.db` 的备份（`state.db` 只在它出问题时恢复），`git checkout` 部署前的 SHA，从那个 SHA 重新 `cp -R` stock-ta 包，重启。回到 R1 以前的代码时必须恢复 `data.db`，因为旧代码遇到 `day-move` 条件会抛错（Appendix A）。`just migrate-us-market --undo` 只在新代码能启动时用。
- [ ] 2026-11-27 是提前收盘日（13:00 收盘）。那天收盘后只读查看，13:00 美东以后的报价没有写成 `quotes` 行，也没有提醒在 13:00 以后响。R1 那时还没部署的话，记一行，改到下一个提前收盘日 2026-12-24 查。

## Let stock-ta answer price questions itself (R2a)

**Depends on.** None. 从 `main` 开。

**Files.**

- [x] Create `docs/modules/examples/stock-ta/tools/quote/`（`tool.json`、`index.ts`、fixtures）。
- [x] Create `docs/modules/examples/stock-ta/massive.ts`。把 `feeds/quotes/index.ts` 的 `parseQuote` 和 `epochMs` 搬进来，Edit `feeds/quotes/index.ts` 改成 import 它，行为不变。
- [x] Create `docs/modules/examples/stock-ta/market-days.ts`，美股交易时段和提前收盘日表，照抄 `src/sources/market/session.ts`（模块代码不能 import 宿主的代码）。
- [x] Create `docs/modules/examples/stock-ta/skills/quick-quote/SKILL.md`。
- [x] Edit `docs/modules/examples/stock-ta/module.json` 的 `description`。
- [x] Edit `docs/modules/stock-ta.md`，写上 `quote` 工具、新闻问题怎么处理、「旧 Mac 部署」一节。
- [x] Edit `tests/stock-ta.test.ts`。Create `docs/modules/evidence/r2a-live.ts`。

**Build.**

- [x] `quote` 工具。输入 `symbols`（1 到 10 个代码，可以是自选股以外的股票和 ETF），一次快照请求，回每只的价格、昨收、相对昨收涨跌幅、当天量、数据时间，和按 `market-days.ts` 算出的时段标签（盘中、盘前、盘后、休市）。盘前盘后的价格照样回，带上标签，不拒绝。`secrets: ["POLYGON_API_KEY"]`，只读，18 秒内结束。
- [x] 技能 `quick-quote` 给领队。只问价格、涨跌、成交量的问题，领队自己调一次 `quote` 回答，不派活给专家。回答写价格、涨跌幅、数据时间、「延迟 15 分钟」和时段标签。问到为什么涨跌、要技术面时才派专家。
- [x] 同一个技能写新闻问题。股票技术分析不管新闻和财报解读。问题里有新闻或「为什么涨跌」那一半时，领队只报涨跌，不猜原因，不读网页，最后加一句「原因不在行情数据里，想知道原因可以问「NVDA 最新新闻」。」（代码换成问到的）。建议的接着问是只问新闻的问题，不会绕回 stock-ta（2026-11-13 审查后改：原来建议问「NVDA 为什么跌」，而问涨跌归 stock-ta，接着问会绕回来）。幕僚长有时把原因那一半另开成不属于任何领域的通用任务，那时原因从通用任务来（2026-11-13 改：混合问题实跑 9 次只有 1 次拆出通用任务，没拆时使用者只拿到涨跌和「原因尚未核实」，没有下一步，所以领队的汇报总要留这一句。幕僚长转到 Telegram 时 4 次里 4 次改写或删掉了这一句，网页卡片上看得到原句；让幕僚长照原样转述要改宿主提示词，单独 PR）。
- [x] `module.json` 的 `description` 改成「美股报价、涨跌、K 线和技术面：支撑阻力、形态、动量、信号、盈亏比；问涨跌都归这里，只问新闻和财报解读的不归这里」，让幕僚长把只问新闻的问题交给通用助手、把带涨跌的混合问题交给 stock-ta（`src/host/router.ts` 第 237 行，省略 domain 就由通用助手处理）。
- [x] 不改报价 feed 的行为，不改 `rules.md`。

**You see.**

- [x] 在 Telegram 上问「NVDA 现在多少」，25 秒内收到一句带价格、涨跌幅、数据时间和「延迟 15 分钟」的回答，网页上这个任务没有派活记录。
- [x] 问「NVDA 跌了多少，为什么跌」，回答里有跌幅；原因如果答了，不来自 stock-ta。网页上 stock-ta 任务的汇报最后有一句建议接着问「NVDA 最新新闻」，单独问这一句开出的任务不在 stock-ta 领域。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/stock-ta.test.ts` 新增：`quote` 解析（纳秒和毫秒时间戳、没有成交价时退到分钟收盘）、超过 10 个代码被拒、自选股以外的代码照查、时段标签（盘中、盘前、盘后、周末、节假日、提前收盘日 13:00 以后算盘后）、没有密钥一行说明、HTTP 错误一行说明。报价 feed 换用 `massive.ts` 后原有测试照旧通过。用 fixtures，不连网。每条先红后绿。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r2a-live.ts`。lane 1、8、9、10 用真模型，lane 8 用真行情。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都关掉 us-market、开着 stock-ta，用真模型问「NVDA 现在多少」。Save `r2a-regression.txt`. Pass when head 的领队调了 `quote`、没有派活、回答有价格和数据时间。trunk 没有 `quote`，记下 trunk 是怎么答的和用了多久，作为 perf 的基线。
- [x] Lane 2. fixtures 里盘中的 NVDA 快照，假模型照技能调 `quote`。Save `r2a-watchlist.txt`. Pass when 回价格、昨收、涨跌幅、数据时间和「盘中」。
- [x] Lane 3. 查 META 和 TSM，都不在 fixtures 的自选股里。Save `r2a-off-list.txt`. Pass when 两只都有报价。
- [x] Lane 4. fixtures 里 17:30 美东的盘后成交。Save `r2a-after-hours.txt`. Pass when 照样回价格，标签是「盘后」，不报错。
- [x] Lane 5. fixtures 里周六和节假日的快照。Save `r2a-closed.txt`. Pass when 标签是「休市」，价格是上一交易日收盘。
- [x] Lane 6. 查 11 个代码，再在没有 `POLYGON_API_KEY` 时查一次。Save `r2a-limits.txt`. Pass when 第一次拒绝并说明最多 10 个，第二次一行说明怎么加密钥，两次都不发请求。
- [x] Lane 7. 网页上打开 lane 1 的任务。Save `r2a-no-dispatch.png`. Pass when 任务里只有领队，没有专家的回合。
- [x] Lane 8. 真行情 `quote` 查 NVDA、SPY、QQQ、META、TSM。Save `r2a-real.txt`. Pass when 5 只都有价格、涨跌幅和标签，数据时间是最近的交易时段。
- [x] Lane 9. 真模型分别问「NVDA 最新新闻」和「NVDA 跌了多少，为什么跌」。Save `r2a-news.png`. Pass when 只问新闻的问题没有开在 stock-ta 领域；混合问题里 stock-ta 的回答有涨跌幅（带 %），自己不说原因；stock-ta 的汇报里有建议接着问的那一句；把那一句建议的问题单独拿到一个新宿主上问，开出的任务 domain 为空；原因如果答了，来自 domain 为空的任务；stock-ta 的任务没有读网页（`read_web_at` 为空，领队的 bash 里没有网址、curl、wget），混合问题没有派专家。Telegram 上的转述不算在内（幕僚长会改写这一句，见上面的新闻问题那条）。
- [x] Lane 10. 真模型在对话里说「从自选股去掉 AMZN 和 AAPL」（Appendix E 第 11 条）。Save `r2a-watchlist-edit.txt`. Pass when 任务开在 stock-ta，`watchlist` 里这两行写上了 `removedAt`，下一轮报价 feed 的请求里没有它们。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 从你发出价格问题到 Telegram 收到第一行回答的时间。trunk 和 head 都有这条路，trunk 没有 `quote`。另量一次 `quote` 调用的宿主侧时间。
- [ ] Probe. 真模型同一个问题，trunk 和 head 交替各 5 次。`quote` 调 20 次。部署到旧 Mac 后，从宿主日志和 `telegram_messages` 再算 3 次。
- [x] Baseline. Record the trunk 中位数 first.
- [x] Rule. head 中位数超过 25 秒，或比 trunk 慢，就失败。`quote` 中位数超过 3 秒，或任何一次超过 18 秒，就失败。旧 Mac 上中位数超过 25 秒就记成阻碍，回到这个 PR 修。

2026-11-13 在 psa/rt-r2a-quote 上通过：`just test` 1743/1743，`check.mjs` 全绿，`just module check` ok。lane 1 到 8 和 10 PASS（lane 7 在合入 main 96d3db8 后的 head 上重跑）。perf 真模型 trunk 和 head 交替各 5 次，trunk 中位数 24.9 s，head 18.0 s；`quote` 真行情 20 次中位数 313 ms，最慢 492 ms。旧 Mac 上的 3 次等部署后再算。lane 9 的标准 2026-11-13 改过，见上面 Build 第三条。按改后的标准在 head 上重跑一次没过：这次领队没照 quick-quote 做，派了趋势与动量，自己读了 NVIDIA 官网公告，汇报里写了可能的原因，也没有「单独问」那一句；同一个技能之前 4 次领队都只报涨跌并留了这一句。 评审图 `r2a-review-no-dispatch.png`、`r2a-review-news.png`、`r2a-review-web.png` 和 60 秒视频 `r2a-review.mp4` 已放进 `docs/modules/evidence/`；Telegram 截图还没有，录像脚本在网页上提问，消息不经过假 Telegram。

2026-11-13 在 ec5bdd8 上通过：lane 9 加了两条结构检查（stock-ta 任务没读网页、混合问题没派专家），在上次失败的那次运行留下的状态上重判是 FAIL，在其余 21 次运行上是 ok。quick-quote 写明问「为什么涨跌」不派专家。lane 9 在 head 上连跑 3 次都 PASS：3 次都没派专家、没读网页、没说原因、有「单独问」那一句；lane 7 重跑 PASS。`just test` 1743/1743。领队本身仍有 `web_get` 和 `bash`，模块包关不掉，要关得改宿主，见 PR 评论。

2026-11-13 在 1c7decd 上通过：审查后把汇报最后一句改成「原因不在行情数据里，想知道原因可以问「NVDA 最新新闻」。」，原来建议问「NVDA 为什么跌」会绕回 stock-ta。lane 9 加第 6 条检查：把汇报建议的问题单独拿到新宿主上问，开出的任务 domain 要为空。lane 9 连跑 2 次都 PASS，6 条检查全 ok，2 次建议的都是「NVDA 最新新闻」，单独问开出的任务 domain 为空、没派专家；lane 7 重跑 PASS。head 上价格问题 3 次 16.6、17.3、18.7 s，中位数 17.3 s。`quote` 连不上行情服务或回非 JSON 时改成一行中文。`just test` 1745/1745。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 7、9 screenshots into `docs/modules/evidence/r2a-review-<slug>.png`，再加一张 Telegram 上价格回答的截图 `r2a-review-telegram.png`。
- [x] Record a 30 to 60 second video of the change on a lane VM，问一个价格问题和一个混合问题。Save it as `docs/modules/evidence/r2a-review.mp4`。
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up. 合并后按「Deploy to the old Mac」部署，等你说「部署」。

## Teach G3 a day move and bring your 盯盘条件 back (R1)

**Depends on.** R2a.

**Files.**

- [x] Edit `src/modules/protocol.ts`。`Condition` 加 `day-move`，`Watch` 加可选的 `prevClose`（行里昨收那一列的名字）和 `label`（提醒时间后面的一句说明）。
- [x] Edit `src/modules/feed-runner.ts`，`feedInput` 加 `now`（宿主时钟的 ISO 时间）。
- [x] Edit `src/modules/conditions.ts`，加 `day-move` 的 spec，改 `alertText`。
- [x] Edit `src/modules/instance-data.ts`，`day-move` 按美东交易日、方向和阈值去重。
- [x] Edit `src/modules/validate.ts`，`watch.prevClose` 必须是这个 collection 里的数字字段。
- [x] Edit `docs/modules/examples/stock-ta/data/quotes/collection.json`（加 `prevClose` 字段，`watch` 加 `"prevClose": "prevClose"` 和 `"label": "延迟行情"`）和 `feeds/quotes/index.ts`（写 `prevClose`，丢掉不新鲜的报价）。
- [x] Create `src/cli/migrate-us-market.ts`。Edit `justfile`，加 `just migrate-us-market`。
- [x] Edit `docs/modules/architecture/design.md` 第 2 节、`docs/modules/module-user-guide.md`、`docs/modules/stock-ta.md`（「从 us-market 搬过来」一节）。
- [x] Edit `tests/conditions.test.ts`、`tests/stock-ta-quotes.test.ts`、`tests/feed-runner.test.ts`。Create `tests/migrate-us-market.test.ts`。
- [x] Create `docs/modules/evidence/replay-day.ts`、`docs/modules/evidence/r1-live.ts`、`tests/fixtures/us-market-day/`。

**Build.**

- [x] `feedInput` 加 `now`。handler 不再读自己的挂钟，回放器和测试用假时钟就能重现新鲜度、换日、节假日和提前收盘。
- [x] 报价 feed 每行写 `prevClose`，`changePct` 照旧两位小数只给人看。新鲜才写行，规则和旧的 `isFresh` 一样。数据时间要在 `now` 所在美东交易日的常规时段里（9:30 到 16:00，提前收盘日到 13:00，按 `market-days.ts`）。所以开盘第一份快照里的盘前成交、节假日里昨天的报价都不写行，G5 的 5% 规则也不会被它们触发。
- [x] `{ when: "day-move", atLeast, direction }`，`atLeast` 0.1 到 100（和旧盯盘条件的 `pct` 同一个范围），`direction` 是 up、down、either，默认 either。判断用行里的价格和 `watch.prevClose` 那一列算不取整的涨跌幅，不读两位小数的 `changePct`。4.996% 不到 5% 的线。没有 `watch.prevClose` 的 collection 设这种条件时拒绝并说明，没有 `prevClose` 的旧行跳过。
- [x] 去重和旧盯盘条件一样。提醒行的 externalId 是 `<条件 id>:<美东日期>:<up|down>:<atLeast>`。同一条件同一天同一方向只提醒一次，价格在线上线下来回穿也不重复；盘中把 5% 改成 3% 会按新阈值再提醒一次，和旧的 `firingId` 一样。
- [x] `alertText` 不再在正文里写模块名和「来自 <collection>」，Telegram 和网页的前缀 `提醒 · <模块名>：` 已经写了模块名。`watch.label` 有值时写在时间后面。`day-move` 的说法带上昨收。迁过来的条件在 Telegram 上是 `提醒 · 股票技术分析：NVDA 105.30，相对昨收 100.00 涨了 5.30%，到了你设的涨跌 5% 提醒线（11-12 10:05 美东，延迟行情）`。`describe` 写成「当天相对昨收涨跌到 5%」。
- [ ] `just migrate-us-market`。通过宿主 socket 工作，宿主要在运行，stock-ta 要开着。读 `state.db` 里 `source_user_data` 的 `us-market` 那一行（`{version, tripwires: [{symbol, condition, setAt}]}`）。
  - [x] 只搬 `day {pct, dir}`，变成 `day-move {atLeast: pct, direction: dir}`。遇到任何别的种类（cost、cross）就退出码非零，什么都不写，说明是哪一种、怎么处理（Appendix E 第 6 条）。
  - [x] 代码不在 stock-ta 自选股里，或者已经划掉，就退出码非零，什么都不写，说明先把它加回自选股。
  - [ ] 默认只打印一张表（种类、要变成的条件、结果是新建、不变或更新），不写。`--apply` 才写。条件 id 由内容定，`cnd_usm_<代码>_day`，重跑只补差。备注写「从盯盘条件搬来，原设于 <美东日期>」。写入走 `page` 权限，回执只在本机显示。`--undo` 只删 `cnd_usm_*`。
  - [x] 不改、不删 `source_user_data` 的 `us-market` 那一行（Appendix E 第 5 条）。
- [x] 回放器 `replay-day.ts` 第一版只喂 stock-ta 这一边：按分钟把剧本里的快照和假的 `now` 交给报价 feed 的 handler，再把行写进临时状态目录，收集提醒行。

**You see.**

- [x] 对 stock-ta 设「NVDA 当天涨跌 5%」以后，剧本里 NVDA 在 9:46 到 +4.996%、10:05 到 +5.3%、10:20 回到 +4.8%、10:40 再到 +5.6%，只有 10:05 一条提醒，文字和上面 Build 里的一样。
- [ ] 部署到旧 Mac、迁移以后，stock-ta 的 `_conditions` 有 1 行 `day-move`，你的盯盘条件从下一个交易日起重新会响。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/conditions.test.ts` 新增：解析（范围、方向、多余字段被拒）、没有 `watch.prevClose` 时拒绝、到线提醒、来回穿不重复、两个方向各一次、第二天重新开始、改阈值重新提醒、4.996% 不算 5%、刚好 5.00% 算、没有 `prevClose` 的行跳过、`alertText` 没有模块名和「来自」。每条先红后绿。Run `just test`.
- [x] `tests/feed-runner.test.ts` 新增 feed 输入里有 `now`。`tests/stock-ta-quotes.test.ts` 新增：行里有 `prevClose`、盘前成交和节假日的旧报价不写行、提前收盘日 13:00 以后不写行。Run `just test`.
- [x] `tests/migrate-us-market.test.ts` 覆盖：一条 day 变成一条 `day-move`、默认不写、重跑不变、参数变了就更新、`--undo` 只删自己建的、cost 或 cross 让 `--apply` 失败且什么都不写、代码不在自选股里时失败、宿主没运行或 stock-ta 关着时一行说明、`source_user_data` 没有 us-market 时打印「没有盯盘条件」。每条先红后绿。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r1-live.ts`。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都给 stock-ta 设一条 `above` 条件（NVDA 价格到 105）并回放同一个剧本。Save `r1-regression.txt`. Pass when 两边提醒的分钟和代码完全相同，文字只差 Build 里说的那两处。trunk 没有 `day-move`，这一点记下来，day-move 由 lane 2 到 7 把关。
- [x] Lane 2. 设 `day-move` 涨跌 5%，回放「5 到 8 逐档上升再回落再上升」，中途重启宿主。Save `r1-once.txt`. Pass when 一天只有一条提醒，时间是第一次到线那一分钟，重启后不再提醒。
- [x] Lane 3. 设 `direction: either`，回放「先涨 5% 后跌 5%」，再回放第二个交易日。Save `r1-both-ways.txt`. Pass when 第一天涨一条、跌一条，第二天又各有一条。
- [x] Lane 4. 回放「4.996% 再到 5.00%」。Save `r1-rounding.txt`. Pass when 4.996% 那一分钟不提醒，5.00% 那一分钟提醒一次。
- [x] Lane 5. 回放「开盘第一份快照是 9:15 的盘前成交，涨 6%」和「节假日整天是昨天的报价」。Save `r1-fresh.txt`. Pass when 两个剧本里那些报价都没写成行，没有提醒；第一份新鲜报价到线时才提醒。
- [x] Lane 6. 宿主运行中，通过对话让领队设「AMD 当天涨跌 5% 提醒我」，回放到 +5.2%，再让领队改成 3%（假模型照剧本调 `watch`）。Save `r1-chat-set.txt`. Pass when `_conditions` 多一行 `day-move`，回执写着「当天相对昨收涨跌到 5%」，改成 3% 后同一天按 3% 再提醒一次。
- [x] Lane 7. 往一个没有声明 `watch.prevClose` 的 series（lane 脚本里临时建的样例模块）设 `day-move`。Save `r1-no-prev-close.txt`. Pass when 拒绝，说明这个 collection 没有昨收这一列。
- [x] Lane 8. 提醒行经宿主发到假 Telegram，同一个剧本在 trunk 上用 `tripwire` 设同样的盯盘条件。Save `r1-telegram.png`. Pass when 新旧两条提醒并排截图；新的一行、前缀 `提醒 · 股票技术分析：` 只出现一次模块名、有昨收、有「延迟行情」、没有「来自 quotes」。
- [x] Lane 9. 临时状态目录先用 trunk 的 `tripwire` 工具设一条 day 盯盘条件，切到 head 跑 `just migrate-us-market`、`--apply`、再 `--apply`，然后回放剧本；另一个目录放一条 cost 和一条 cross。Save `r1-migrate.txt`. Pass when 第一个目录打印 1 行「新建」、`_conditions` 多一行 `cnd_usm_<代码>_day`、第二次「全部不变」、新条件在旧条件会响的同一分钟响一次；第二个目录退出码非零，什么都没写。
- [x] Lane 10. 回退演练。lane 9 迁移以后，按「Deploy to the old Mac」的回退步骤恢复 `data.db` 备份，切回 trunk 启动宿主。Save `r1-rollback.txt`. Pass when 宿主正常启动，`_conditions` 里没有 `day-move` 行；不恢复备份时 trunk 启动或判断条件报错（记下报错，证明这一步必须做）。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 报价 feed 写一轮 9 行（每只股票各有 3 条条件）时，handler 加宿主侧写入和判断条件的时间。
- [x] Probe. trunk 和 head 交替各 30 轮，trunk 用 `above`，head 用 `day-move`，条件数相同。另跑 `just migrate-us-market --apply` 5 次，每次新的临时目录。
- [x] Baseline. Record the trunk 中位数 first.
- [x] Rule. head 中位数比 trunk 慢 5 毫秒以上就失败。迁移中位数超过 3 秒就失败。

**Review gate.** The operator reviews before merge.

- [x] Copy lane 8 screenshot（新旧提醒并排）into `docs/modules/evidence/r1-review-telegram.png`。
- [x] Record a 30 to 60 second video of the change on a lane VM，回放剧本、提醒到假 Telegram、迁移命令的三次输出。Save it as `docs/modules/evidence/r1-review.mp4`。
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up. 合并后按「Deploy to the old Mac」部署并迁移，等你说「部署」。

2026-11-13 在 psa/rt-r1-daymove 上通过：`just test` 全绿，`check.mjs` 全绿，`just module check` ok。`r1-live.ts` 十条 lane 都 PASS（输出在 `/tmp/swarm-r1/owner/`）。perf 交替各 30 轮，trunk 中位数 67.3 ms，head 68.1 ms，多 0.8 ms，一轮的时间几乎全是起 handler 进程；迁移 `--apply` 5 次中位数 370 ms。评审图 `r1-review-telegram.png` 和 36 秒视频 `r1-review.mp4` 在 `docs/modules/evidence/`。和上面写的不一样的三处，所以那两个框没勾：迁移命令直接读写状态目录（和 `just module import` 一样），不经宿主 socket，宿主开着关着都能跑，因为宿主每写一行报价都重新读条件；迁过来的条件不写备注，因为备注会出现在每一条提醒里，和 Build 里给的提醒文字对不上，来历由编号 `cnd_usm_` 看出；按使用者的决定，迁移默认同时从自选股划掉 AMZN、AAPL，`--keep-watchlist` 不动。提醒里的时间照旧写年份（`2026-11-12 10:05 美东`），和其他条件一致。

## Bring the 盘面 expert into stock-ta with intraday bars (R2b)

**Depends on.** R1.

**Files.**

- [x] Create `docs/modules/examples/stock-ta/agents/market-desk.md`（盘面）。
- [x] Create `docs/modules/examples/stock-ta/tools/intraday/`（`tool.json`、`index.ts`、fixtures）。
- [x] Create `docs/modules/examples/stock-ta/skills/market-desk/SKILL.md`。
- [x] Create `docs/modules/examples/stock-ta/evals/market-desk.md`。
- [x] Edit `docs/modules/stock-ta.md`，写上 `intraday` 和三路请求共用一个密钥。
- [x] Edit `tests/stock-ta.test.ts`。Create `docs/modules/evidence/r2b-live.ts`。

**Build.**

- [x] 盘面专家照搬 us-market 的 `market-analyst.md` 的职责和做法，去掉 `web_get` 和读报道那一步。它判断这次波动是个股的，还是大盘、板块的。用一次 `quote` 同时查这只股票、SPY、QQQ 和一两只板块 ETF 或同板块代表，用差值说话；用 `intraday` 看当天走势里的跳空、急动时间、反弹、量集中在哪段。汇报写结论、证据、数据时间三段，不超过 600 字。`uses` 是 `quote`、`intraday`、`prices`、`note`。
- [x] `intraday` 工具。输入 `symbol`、`span`（minute、hour）、可选 `from`、`to`（默认今天，最多回看 4 个交易日），`limit` 最多 500 根。请求 `/v2/aggs/ticker/{s}/range/1/{span}/{from}/{to}?adjusted=true&sort=desc&limit=`，和 `src/sources/market/client.ts` 的 `bars` 一样。回 K 线和分钟线的 VWAP。只读，18 秒内结束。
- [x] 技能 `market-desk` 写 us-market-desk 里和数据有关的部分：K 线粒度怎么选、报价怎么写（数据时间、延迟 15 分钟）、同时最多两个联网工具调用。去掉 `lookup us-market`、盯盘条件和新闻那几节。
- [x] 不改 `rules.md`，不改报价 feed。这一步只加人和工具，提醒不变。

**You see.**

- [x] 网页上 stock-ta 的专家队显示 6 位，多了「盘面」。
- [x] 问 stock-ta「NVDA 今天跌 4% 是它自己的事还是板块的事」，汇报里有 NVDA、SPY、QQQ、SMH 的涨跌幅和差值，有当天急跌的时间段，有数据时间。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/stock-ta.test.ts` 新增：`intraday` 的地址和参数、回看超过 4 天被拒、`limit` 上限、VWAP、没有密钥时一行说明、HTTP 错误和 429 一行说明。用 fixtures，不连网。Run `just test`.
- [x] `just module check docs/modules/examples/stock-ta` 为 ok。Run `just module check docs/modules/examples/stock-ta`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r2b-live.ts`，lane 6 到 9 用真行情。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都回放 R1 的剧本，看 stock-ta 的提醒和触发。Save `r2b-regression.txt`. Pass when 两边相同，说明加人加工具没有改提醒。
- [x] Lane 2. `just modules` 和网页的模块面板。Save `r2b-team.png`. Pass when stock-ta 有 6 位专家，盘面的工具是 `quote`、`intraday`、`prices`、`note`。
- [x] Lane 3. 假模型让盘面越出 `uses` 调 `structure`。Save `r2b-uses.txt`. Pass when 被拒，码是 `not-in-uses`。
- [x] Lane 4. `intraday` 用 fixtures 回看 5 个交易日、`limit` 600。Save `r2b-intraday-cap.txt`. Pass when 两次都拒绝并说明上限，不发请求。
- [x] Lane 5. 没有 `POLYGON_API_KEY` 时调 `intraday`。Save `r2b-no-key.txt`. Pass when 一行说明怎么加密钥，不发请求。
- [x] Lane 6. 真行情 `intraday` 查 NVDA 当天分钟线和 SPY 的小时线。Save `r2b-intraday-real.txt`. Pass when 回 K 线，最新一根的时间离数据时间不超过 20 分钟，分钟线有 VWAP。
- [x] Lane 7. 交易时段里报价 feed 照常每 60 秒跑，同时盘面连续做 3 道题。Save `r2b-shared-key.txt`. Pass when 报价 feed 没有漏轮，三路请求里 429 的次数是 0。
- [x] Lane 8. 真模型 `openai-codex/*` 跑 `evals/market-desk.md`（「这次跌是个股还是板块」）。Save `r2b-eval.txt`. Pass when 汇报有三段、有相对 SPY 和板块 ETF 的差值、有数据时间，没有新闻和财报的说法。
- [x] Lane 9. 真模型问一个 S3 已有的技术面问题（「NVDA 的支撑在哪」）。Save `r2b-old-question.txt`. Pass when 领队照旧派给结构形态，不派给盘面。
- [x] Lane 10. 读 `docs/modules/stock-ta.md` 的工具一节。Save `r2b-doc.txt`. Pass when 写明 `quote` 和 `intraday` 联网、只读、用哪个密钥、每次几个请求，以及报价 feed、这两个工具和扫描共用一个密钥。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. trunk 没有 `intraday`。量 `intraday`（一天分钟线）一次调用的宿主侧时间，以及盘面汇报任务从派活到交回的时间。另量报价 feed 一轮的时间和交易时段里每小时 429 的次数，trunk 和 head 都有。
- [x] Probe. 交易时段内 `intraday` 调 20 次，报价 feed trunk 和 head 交替各 10 轮，期间盘面做题。429 次数用宿主日志和工具的错误行数。
- [x] Baseline. Record the trunk 报价 feed 一轮的中位数和 429 次数 first.
- [x] Rule. 报价 feed 比 trunk 慢 50 毫秒以上就失败。`intraday` 中位数超过 3 秒、或任何一次超过 18 秒，就失败。head 的 429 次数多于 trunk 就失败。

**Evidence.** 2026-11-13 在 psa/rt-r2b-intraday 上，交易时段（美东 13:20 到 14:00）跑 `docs/modules/evidence/r2b-live.ts`，输出在 `/tmp/swarm-r2b/owner/`。`just test` 1879 个全过，`just module check` 为 ok（tools=9 skills=5 agents=6 evals=3）。

- 单元：`tests/stock-ta.test.ts` 新增 10 条，先红后绿（红：`tools/intraday/tool.json is missing`、`Cannot find module .../tools/intraday/index.ts`）。
- Lane 1 PASS：十个回放剧本 trunk 78e18e8 和 head 两边的提醒、触发、报价行数相同（条件编号是每次新的 UUID，比较前换掉）。replay-day.ts 补传 M3（#113）加的 `problem` 口，不补的话 trunk 上回放直接抛错。
- Lane 2 PASS：网页模块卡写「成员 6」，盘面的 uses 是 quote、intraday、prices、note。`just modules` 不列成员数，所以另跑 `just module check` 看 `agents=6`。
- Lane 3 到 5、10 PASS。Lane 6 PASS：NVDA 分钟线 500 根（04:50 到 13:09，含盘前），最新一根和报价数据时间差 1 分钟，每根有 VWAP。
- Lane 7 PASS：6.7 分钟里报价 feed 7 轮都成，最大间隔 60 秒，429 为 0。Lane 8 PASS（`just module try`，三道考题）。Lane 9 PASS：「NVDA 的支撑在哪」只派给结构与形态。
- Perf：`intraday` 20 次中位数 363 毫秒（355 到 376）；报价 feed 一轮 trunk 中位数 315 毫秒、head 307 毫秒，429 两边都是 0；盘面三道题从提问到任务空闲 73 到 195 秒，中位数 131 秒。
- 实跑看到的：领队有全部工具，lane 7 第一题里领队自己读了两页网页、给盘面的结论补了原因。成员读不了网页（`tools: read`）。这次只在 `ta-interpret` 里写了「领队不读网页、不补原因」，结构上的限制（宿主 `leadTools`）是另一件事。之后 lane 8、媒体那一题领队都没读网页。

**Review gate.** None. R2b is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Give risk-plan the next earnings date (R3)

**Depends on.** R2b.

**Files.**

- [ ] Create `docs/modules/examples/stock-ta/tools/earnings-date/`（`tool.json`、`index.ts`、fixtures）。
- [ ] Edit `docs/modules/examples/stock-ta/agents/risk-plan.md`，`uses` 加 `earnings-date`，写清什么时候提示跳空风险。
- [ ] Create `docs/modules/examples/stock-ta/evals/earnings-gap.md`。
- [ ] Edit `docs/modules/stock-ta.md`。Edit `tests/stock-ta.test.ts`。Create `docs/modules/evidence/r3-live.ts`。

**Build.**

- [ ] `earnings-date` 工具。输入 `symbol`。请求 Finnhub `/calendar/earnings?from=<今天>&to=<今天+120 天>&symbol=`，请求头 `X-Finnhub-Token`，解析照抄 `src/sources/market/finnhub.ts` 的 `parseCalendar`。回下一次财报的日期、盘前还是盘后、离今天几个交易日，没有就回「120 天内没有已公布的财报日」。不回预期、实际 EPS 和营收，不碰 `/stock/earnings`。`secrets: ["FINNHUB_API_KEY"]`，只读，18 秒内结束。
- [ ] 风险计划每次给计划都查一次。财报日在计划的持有期内，或在 10 个交易日内（Appendix E 第 7 条），计划里单独一行写「财报日 <日期>（盘前/盘后），持有过财报有跳空风险，止损可能按跳空价成交」。查不到时写「没查到财报日」，不编。
- [ ] 不加财报解读，不读新闻。模块的说明里写明它只管客观交易数据。

**You see.**

- [ ] 问 stock-ta「NVDA 在 170 进、160 止损、190 目标，怎么看」，风险计划的汇报里有一行财报日和跳空风险（财报在窗口内时），或者一行「下一次财报在 <日期>，不在持有期内」。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta.test.ts` 新增：日历解析（多条取最近的未来一条、今天盘后算今天、空列表）、交易日计数跳过周末和节假日、没有密钥一行说明、429 一行说明。用 fixtures。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r3-live.ts`，lane 5、6、8 用真接口。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都调 `risk-reward`（同样的进场、止损、目标）。Save `r3-regression.txt`. Pass when 结果相同。trunk 没有财报日工具，这一点记下来，由 lane 2 到 9 把关。
- [ ] Lane 2. fixtures 里财报在 3 个交易日后。Save `r3-near.txt`. Pass when 工具回日期、盘前或盘后、3。
- [ ] Lane 3. fixtures 里 120 天内没有财报。Save `r3-none.txt`. Pass when 回「120 天内没有已公布的财报日」。
- [ ] Lane 4. 没有 `FINNHUB_API_KEY`。Save `r3-no-key.txt`. Pass when 一行说明，不发请求。
- [ ] Lane 5. 真接口查 NVDA、MSFT、SPY。Save `r3-real.txt`. Pass when NVDA、MSFT 有日期，SPY 回没有财报日，不报错。
- [ ] Lane 6. 真模型跑 `evals/earnings-gap.md`。Save `r3-eval.txt`. Pass when 汇报里有财报日和跳空风险那一行，日期和 lane 5 的一致。
- [ ] Lane 7. 假模型让结构形态越出 `uses` 调 `earnings-date`。Save `r3-uses.txt`. Pass when 被拒，只有风险计划能用。
- [ ] Lane 8. 同一个代码连查 5 次。Save `r3-repeat.txt`. Pass when 5 次结果相同，没有 429。
- [ ] Lane 9. 读工具的输出 schema。Save `r3-schema.txt`. Pass when 没有 EPS、营收、预期这些字段。
- [ ] Lane 10. `just module check docs/modules/examples/stock-ta`。Save `r3-check.txt`. Pass when ok。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk 没有这个工具。量一次 `earnings-date` 调用的宿主侧时间，和风险计划一次汇报的输入 token 数（trunk 和 head 都有风险计划）。
- [ ] Probe. 工具调 20 次。风险计划同一道题 trunk 和 head 交替各 3 次。
- [ ] Baseline. Record the trunk 风险计划输入 token 中位数 first.
- [ ] Rule. 工具中位数超过 2 秒就失败。风险计划输入 token 比 trunk 多 15% 以上就失败。

**Review gate.** None. R3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Move the band alerts into stock-ta and delete the us-market package (R5)

**Depends on.** R3，和合并进 main 的 #105。

**Files.**

- [ ] Edit `docs/modules/examples/stock-ta/feeds/quotes/feed.json`、`index.ts`、fixtures。
- [ ] Edit `src/modules/feed-runner.ts`，handler 可以交回 `alerts`。
- [ ] Edit `docs/modules/examples/stock-ta/rules.md`、`skills/market-desk/SKILL.md`。
- [ ] Delete `modules/us-market/`。
- [ ] Edit `src/host/wiring.ts`（`sources.us-market` 的报错说明）、`src/host/host.ts` 和 `src/web/view.mjs`（stock-ta 卡片的两行）。
- [ ] Edit `src/cli/migrate-us-market.ts`，不再读 `modules/us-market/module.json`。
- [ ] Edit `tests/stock-ta-quotes.test.ts`、`tests/feed-runner.test.ts`、`tests/wiring.test.ts`、`tests/web.test.ts` 和因为 us-market 包不在而失败的测试（`tests/first-teams.test.ts`、`tests/modules.test.ts`、`tests/modules-cli.test.ts` 等），改成断言新的行为，不跳过。
- [ ] Create `tests/fixtures/us-market-day/expected.json`、`docs/modules/evidence/r5-parity.ts`、`docs/modules/evidence/r5-live.ts`。
- [ ] Edit `docs/modules/stock-ta.md`、`docs/modules/module-user-guide.md`、`docs/deploy/home-mac.md`、`docs/web-client/look-and-feel-plan.md`（L3、L4 的说明）。

**Build.**

- [ ] 报价 feed 每轮都带上 SPY、QQQ，不管它们在不在自选股里，还是一次快照请求。这是有意的新行为，列在 Appendix B 的已知不同里。
- [ ] 分档。`feed.json` 的 `settings` 加 `bands: { default: [5, 8], bySymbol: { SPY: [2, 3], QQQ: [2, 3] } }`。没有 3% 档、指数 1.5% 档，也没有放量（Appendix E 第 2、3 条）。每轮取已经到达的最高一档；每只股票每个方向每天只升不降，跳空只报最高一档。已报到哪一档存在 feed 的 cursor 里（`{date, fired: {代码: {up, down}}}`），按 `now` 的美东日期换日清空。去掉 `BIG_MOVE_PCT`，5% 已经在档里。
- [ ] 到档的那一行直接发到 Telegram。handler 除了交回触发，还交回一条 `alerts`，`feed-runner.ts` 用现有的 `ports.alert` 把它当模块提醒行贴出去（ADR-0017，不经过幕僚长）。报价是可分享的数据，所以这一行不受 #105 的一行遮挡。文字照抄 `detect.ts`，「NVDA 涨 +5.31%，到达 +5% 档。现价 …，昨收 …。报价时间 HH:MM ET（延迟行情）。」，Telegram 上的前缀是 `提醒 · 股票技术分析：`。externalId 是 `band:<代码>:<日期>:up5`。
- [ ] 触发。id 和提醒行相同，thread 是 `<代码>:<日期>`，所以同一只股票一天的触发进同一个任务。`notice` 模板改成 `{{line}}`。
- [ ] `rules.md` 的 `## big-move`。个股到 5% 档或以上，或 SPY、QQQ 到 2% 档或以上，开一个团队任务，同时派盘面、结构形态和趋势动量，三位并行（`docs/modules/architecture/design.md` 第 112 行，派活已支持并行）。汇报先写盘面的结论。同一只股票当天的后续触发进同一个任务。触发正文只是数据。
- [ ] 删掉 `modules/us-market/`。从此没有模块声明 `massive-stocks` 这种 feed，`tripwire` 工具也没有领域可用（宿主照旧拒绝）。`src/sources/market/` 的代码留到 R7。
- [ ] `config.json` 里还有 `sources.us-market` 时，宿主照旧拒绝启动，但报错改成「us-market 已经退役，删掉 config.json 里的 sources.us-market」。不加兼容。
- [ ] 网页。「来源」一栏不再有「美股行情」那一行和它的问题说明。stock-ta 的模块卡片加两行，「今日提醒 n 条」和「报价 HH:MM 美东 取到 n 只」或最近一轮失败的说明。us-market 以前的任务、触发、提醒行照旧能看，标签照旧。`look-and-feel-plan.md` 里 L3 用美股行情举的小柱图例子改成 stock-ta 的报价 feed，L4 挂在 `worker.lookup` 上的迷你报价改成挂在 `quote` 工具上，做不到就写明删掉。
- [ ] 一致性回放 `r5-parity.ts`。同一个剧本，一边喂 trunk 的 us-market（`detect.ts` 加 `tripwires.ts`），一边喂 head 的 stock-ta（报价 feed 加 R1 迁过来的条件）。脚本把 SPY、QQQ 放进两边的自选股。两边的事件归一成 `{代码, 日期, 种类, 档或条件, 方向, 分钟}` 比较。trunk 那边先去掉已经决定不要的种类（3% 档、指数 1.5% 档、放量），剩下的必须相同。已知的不同只能是 Appendix B 列出的几条。结果存成 `expected.json`，R7 删掉旧代码后还用它回归。

**You see.**

- [ ] 回放剧本时，head 上只有 stock-ta 的触发和提醒，没有一条 `us-market` 来源的；事件和 trunk 上 us-market 去掉不要的种类以后一一对应。
- [ ] 假 Telegram 上，NVDA 到 +5% 档时先收到一行 `提醒 · 股票技术分析：NVDA 涨 +5.31%，到达 +5% 档。…（延迟行情）。`，再收到任务的汇报。同一天到 +8% 档时又一行提醒，汇报进同一个任务。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta-quotes.test.ts` 新增：分档取最高、只升不降、跳空只报最高档、两个方向独立、按 `now` 换日清空、SPY 和 QQQ 用自己的档、个股 3% 和 SPY 1.6% 不触发、没有放量、SPY 和 QQQ 总在请求里、cursor 重启后接着用、每次到档都交回一条 `alerts`。每条先红后绿。Run `just test`.
- [ ] `tests/feed-runner.test.ts` 新增 handler 交回的 `alerts` 经 `ports.alert` 贴出、同一个 externalId 只贴一次。`tests/wiring.test.ts` 新增 `sources.us-market` 的报错说明。`tests/web.test.ts` 新增 stock-ta 卡片的两行。其他因为 us-market 不在而改的测试，在 PR 正文里逐个列出改了什么断言。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r5-live.ts`，lane 3、9 用真模型，lane 9 用真行情。

- [ ] Lane 1. Regression lane against trunk. 一致性回放 `r5-parity.ts`，trunk 跑 us-market，head 跑 stock-ta，同一个剧本、同一份盯盘条件，SPY、QQQ 在自选股里。Save `r5-parity.txt`. Pass when 去掉不要的种类后，归一的事件完全相同，不同之处只有 Appendix B 列出的几条。
- [ ] Lane 2. head 宿主回放剧本，查 `triggers` 和 `host_lines` 的来源。Save `r5-one-path.txt`. Pass when 没有一行来源是 `us-market`，每个到档事件正好一条触发和一行提醒。
- [ ] Lane 3. 剧本里 NVDA 到 +5% 再到 +8%，真模型照 `rules.md` 开任务。Save `r5-ticket.png`. Pass when 只开一个团队任务，盘面、结构形态、趋势动量在同一轮里派出，+8% 的触发进了同一个任务。
- [ ] Lane 4. 先让一个私密模块的任务读过私密数据（和 #105 的 `private-reply-live.ts` 一样），再回放 NVDA 到 +5%。Save `r5-private-first.png`. Pass when 假 Telegram 收到完整的到档那一行；幕僚长的回复照 #105 只有一行提示。
- [ ] Lane 5. 剧本里 SPY 到 +1.6% 和 +2.1%，SPY 不在自选股里。Save `r5-spy.txt`. Pass when 1.6% 没有任何触发和提醒；2.1% 有一行提醒、开一个任务。
- [ ] Lane 6. 节假日和 2026-11-27 提前收盘日两个剧本。Save `r5-calendar.txt`. Pass when 节假日没有任何触发；提前收盘日 13:00 以后的成交不写行、不触发。
- [ ] Lane 7. 临时状态目录的 `config.json` 里留着 `sources.us-market`，启动宿主。Save `r5-config.txt`. Pass when 拒绝启动，报错写着删掉哪一项。删掉后启动正常。
- [ ] Lane 8. 网页的「来源」和「模块」两栏。Save `r5-page.png`. Pass when 「来源」里没有「美股行情」那一行，stock-ta 卡片有「今日提醒」和报价那两行，以前 us-market 的任务点得开。
- [ ] Lane 9. 交易时段真行情跑 30 分钟，宿主只开 stock-ta。Save `r5-real.txt`. Pass when 每轮一次 Massive 请求，SPY、QQQ 有行，429 是 0，提醒和触发都按数据时间去重。
- [ ] Lane 10. 对话里让领队「给 TSLA 设个当天涨跌 4% 的提醒」。Save `r5-chat-set.png`. Pass when 设的是 stock-ta 的 `day-move`，没有调 `tripwire`，回执在网页上。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 报价 feed 一轮的时间（trunk 和 head 都有）；每小时的 Massive 请求数和 429 次数；从到档那一轮到 Telegram 收到提醒行的时间；从触发到 Telegram 收到第一行汇报的时间。
- [ ] Probe. 回放同一个剧本，trunk 和 head 交替各 3 遍，每遍 390 轮，请求数用回放器的计数。到档的两段时间用 lane 3 的真模型各跑 5 次。
- [ ] Baseline. Record the trunk 一轮中位数、每小时请求数，和旧 Mac 上 us-market 从触发到第一行汇报的中位数 first（对抗审查 B 量过约 2 分钟，开工时重量）。
- [ ] Rule. 一轮中位数比 trunk 慢 20 毫秒以上就失败。head 每小时请求数多于 trunk 就失败。提醒行晚于那一轮 1 秒以上就失败。到第一行汇报的中位数比基线慢就失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3、4、8、10 screenshots into `docs/modules/evidence/r5-review-<slug>.png`，再加一张假 Telegram 上到档提醒和汇报的截图 `r5-review-telegram.png`。
- [ ] Record a 30 to 60 second video of the change on a lane VM，回放剧本、Telegram 上的提醒行和汇报、网页的两栏。Save it as `docs/modules/evidence/r5-review.mp4`。
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Remove us-market from the old Mac's config and deploy R5 (R6)

**Depends on.** R5，合并进 main 以后。每一步写操作都要你先说「部署」。

**Files.**

- [ ] Edit `docs/modules/stock-ta.md` 的「旧 Mac 部署」一节，加删 `sources.us-market` 这一步。
- [ ] Edit `docs/deploy/home-mac.md`，删掉 us-market 的设置说明。
- [ ] Create `docs/modules/evidence/r6-old-mac.md`，记录每一步的输出（只写条数、种类、SHA，不写代码和数值）。

**Build.**

- [ ] us-market 在 2026-11-13 已经关掉了，你的盯盘条件在 R1 部署时已经迁过去。R6 不关模块，也不迁移，只删配置、换代码。
- [ ] 时间定在 R5 合并后的第一个周六，美东上午。例如 R5 在 2026-11-18 合并，就是 2026-11-21。周末没有行情，切换中不会漏提醒，也不会两套一起响。
- [ ] 按「Deploy to the old Mac」做，只在 `git pull` 之前多一步，从 `config.json` 删掉 `sources.us-market`。旧代码没有这一项也能跑（轮询回到默认的每 60 秒，读代码），所以这一步先做。
- [ ] 部署后查 stock-ta 的 `_conditions` 还是 R1 迁来的那 1 行 `day-move`。
- [ ] 回退照「Deploy to the old Mac」的回退步骤。R6 之前的代码已经认识 `day-move`，所以这里不需要 `--undo`。
- [ ] 下一个交易日只读查看：提醒行和触发的来源只有 stock-ta，`us-market` 来源在部署之后没有新行。

**You see.**

- [ ] 旧 Mac 上 `just modules` 没有 us-market，stock-ta 开着、版本是 R5 的包；`config.json` 没有 `sources`；网页「来源」里没有「美股行情」。
- [ ] 部署后第一个交易日，到档时手机先收到 `提醒 · 股票技术分析：` 开头的一行，再收到 stock-ta 专家队的汇报。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] R6 只改文档。在 R6 的 head 上跑一遍，确认文档里的每个 `just` 命令都在 `justfile` 里。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. lane 在旧 Mac 上跑，lane 1、2 只读、随时可跑，lane 3 到 8 在你说「部署」以后，lane 9、10 在部署后第一个交易日收盘后。

- [ ] Lane 1. Regression lane against trunk. 部署前在旧 Mac 现在的版本上只读记下当天的提醒和触发（预检）。trunk 是旧 Mac 现在跑的 SHA，head 是 main。Save `r6-before.txt`. Pass when 预检的每一项都有数。
- [ ] Lane 2. 部署前只读检查 `config.json` 只多 `sources.us-market` 这一项，us-market 开关是关，`_conditions` 有 1 行 `day-move`。Save `r6-shape.txt`. Pass when 三项都对；对不上就停下来问你。
- [ ] Lane 3. 备份和删 `sources.us-market` 之后，旧代码重启。Save `r6-config.txt`. Pass when 服务正常，`just modules` 照旧。
- [ ] Lane 4. 拉代码、装包、setup、重启后 `just modules`。Save `r6-modules.txt`. Pass when 没有 us-market，stock-ta 开着，版本 digest 和 R5 的包一致。
- [ ] Lane 5. 部署后读 `_conditions`。Save `r6-conditions.txt`. Pass when 条数和种类等于 lane 2。
- [ ] Lane 6. 读状态目录里 `modules/stock-ta/feeds/quotes/feed.json`。Save `r6-feed.txt`. Pass when 档位是个股 5、8 和 SPY、QQQ 2、3，没有放量设置，`every` 是 60s。
- [ ] Lane 7. `just notify` 一行。Save `r6-notify.txt`. Pass when `telegram_messages` 里有这一行的 message_id。你看到后回一句确认，不用当场。
- [ ] Lane 8. 网页截图。Save `r6-page.png`. Pass when 「来源」没有「美股行情」，stock-ta 卡片有「今日提醒」和报价两行，以前 us-market 的任务点得开。
- [ ] Lane 9. 部署后第一个交易日收盘后只读查看。Save `r6-first-day.txt`. Pass when 部署之后没有 `us-market` 来源的新行；有到档时来源是 `stock-ta/quotes`，提醒行在任务汇报之前发出。
- [ ] Lane 10. 同一天对比。你的盯盘条件和档位在那天的行情下该不该响，按 R5 的一致性规则用当天记录的报价算一遍。Save `r6-parity-day.txt`. Pass when 该响的都响了一次，不该响的没响。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 交易时段每小时的 Massive 请求数，和提醒从数据时间到 Telegram 发出的延迟。
- [ ] Probe. 宿主日志和 `telegram_messages`，部署前一个交易日和部署后第一个交易日各算一遍。
- [ ] Baseline. Record the 部署前那一天 first（us-market 已关，只有 stock-ta 每 60 秒）。
- [ ] Rule. 部署后每小时请求数多于部署前就失败。延迟中位数比部署前多 60 秒以上就失败。

**Review gate.** None. R6 is not review-gated. 它的写操作由你说「部署」放行，见上面 Build。

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Delete the us-market code once the old Mac has run clean (R7)

**Depends on.** R6，而且旧 Mac 在部署后跑完一个交易日，R6 的 lane 9、10 通过。

**Files.**

- [ ] Create `src/modules/market-hours.ts`，从 `src/sources/market/session.ts` 搬过来 `inPollWindow` 和交易时段表。Edit `src/host/host.ts`、`src/modules/manifest.ts` 改 import。
- [ ] Delete `src/sources/market/`。
- [ ] Edit `src/sources/feeds.ts`、`src/host/wiring.ts`、`src/host/workers.ts`、`src/host/router.ts`、`src/host/pi-worker.ts`、`src/host/host.ts`、`src/teams.ts`、`src/worker/extension.ts`、`src/worker/tools.ts`、`src/kernel/`、`src/client/protocol.ts`、`src/client/board-format.mjs`、`src/web/`，删掉 `massive-stocks`、`tripwire` 工具和 RPC、`lookup us-market`、`market` 角色、幕僚长提示里管盯盘条件的那一行、us-market 的来源面板和 `盯盘提醒` 标签。
- [ ] Delete `src/cli/migrate-us-market.ts`、`tests/migrate-us-market.test.ts`、`src/cli/market-smoke.ts`、`demos/demo-5-market.mjs`。Edit `justfile`、`demos/README.md`。
- [ ] Delete `tests/market-*.test.ts`、`tests/tripwire-rpc.test.ts`、`tests/e2e/tripwire.e2e.ts`、`tests/helpers/market.ts`、`tests/e2e/market-offline-preload.mjs`。Edit 其他引用 us-market 的测试。
- [ ] Edit `GLOSSARY.md`、`docs/adr/0005`、`0009`、`0013`、`0017`（加一行「us-market 已在 R7 退役」，不改原文）、`docs/modules/` 里提到 us-market 的说明。

**Build.**

- [ ] 先搬再删。`us-market-hours` 这个 `when` 的名字不改，它说的是美股交易时段，不是模块。
- [ ] 删的东西不留开关、不留兼容层。数据库表结构不动（`helper_role` 的 CHECK 里留着 `market`），以前的行照旧能读，`source_user_data` 的 us-market 那一行原样留着（Appendix E 第 5 条）。
- [ ] 迁移命令的活在 R1 部署时做完了，跟旧代码一起删。
- [ ] R5 的 `expected.json` 留着，`tests/stock-ta-quotes.test.ts` 用它回放 stock-ta 这一边，代替被删的一致性回放。
- [ ] `rg -n "us-market" src tests` 只剩 `us-market-hours` 和 `config.json` 的退役报错。
- [ ] 旧 Mac 之后跟上 main 时照「Deploy to the old Mac」拉代码、重启，同样等你说「部署」。R7 不改 stock-ta 包，不用重装包。

**You see.**

- [ ] `just test` 全绿，测试数比 R6 少，少的都是被删的 us-market 测试，PR 正文列出数目。
- [ ] 宿主、网页、Telegram 的行为和 R6 一样。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta-quotes.test.ts` 用 `expected.json` 回放，事件相同。`tests/market-hours.test.ts` 接过 `session.ts` 的测试，并比对 `market-hours.ts` 和 stock-ta 的 `market-days.ts` 两份提前收盘日表相同。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r7-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都回放 R5 的剧本，stock-ta 加迁来的条件。Save `r7-regression.txt`. Pass when 两边事件相同，也和 `expected.json` 相同。
- [ ] Lane 2. 周末和交易日的 `when: us-market-hours`。Save `r7-hours.txt`. Pass when 周末不调用，交易日开盘到收盘后 20 分钟调用，和 trunk 一样。
- [ ] Lane 3. `rg -n "us-market" src tests`。Save `r7-grep.txt`. Pass when 只剩 `us-market-hours` 和退役报错。
- [ ] Lane 4. 用 R6 之后的状态目录（带以前 us-market 的任务、触发、提醒行）启动 head。Save `r7-history.png`. Pass when 宿主启动，以前的任务在网页上点得开。
- [ ] Lane 5. 对话里说「给 NVDA 设个盯盘条件」。Save `r7-no-tripwire.txt`. Pass when 领队用 stock-ta 的 `watch` 设条件，工具列表里没有 `tripwire`。
- [ ] Lane 6. `config.json` 里有 `sources.us-market`。Save `r7-config.txt`. Pass when 拒绝启动，报错和 R5 一样。
- [ ] Lane 7. Telegram 前缀。Save `r7-telegram.txt`. Pass when stock-ta 的提醒前缀不变，宿主和客户端里找不到 `盯盘提醒`。
- [ ] Lane 8. `just --list`。Save `r7-just.txt`. Pass when 没有 `market-smoke`、`demo-market` 和 `migrate-us-market`。
- [ ] Lane 9. 真模型问一个盘面问题和一个价格问题。Save `r7-desk.txt`. Pass when 盘面照旧用 `quote` 和 `intraday`，汇报有三段；价格问题领队自己用 `quote` 答。
- [ ] Lane 10. `just module check docs/modules/examples/stock-ta` 和 `node docs/modules/architecture/check.mjs`。Save `r7-check.txt`. Pass when 都通过。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 宿主启动到就绪的时间，和 `just test` 的总时间。
- [ ] Probe. 宿主启动 trunk 和 head 交替各 5 次，`just test` 各 2 次。
- [ ] Baseline. Record the trunk 两个中位数 first.
- [ ] Rule. head 启动比 trunk 慢就失败（只删不加，不该变慢）。`just test` 比 trunk 慢就失败。

**Review gate.** None. R7 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

标「实测」的是跑过命令看到的。旧 Mac 上只用 `ssh -o BatchMode=yes` 跑只读命令，数据库都用 `sqlite3 -readonly`。标「读代码」的是在 main（1f88fc4）上读出来的。标「推断」的没有跑过。

### 2026-11-13 写计划时

**旧 Mac 当时的样子（实测）。** 跑的是 7129edd（S3），比 main 落后 S4 以后的提交。`config.json` 没有 `modules` 键，有 `sources.us-market.everySeconds: 300`。模块开关是 us-market 开、stock-ta 开、module-builder 开、pi-pi 开、toy-market 关。密钥文件里有 `POLYGON_API_KEY` 和 `FINNHUB_API_KEY`（只看了键名）。

**你的盯盘条件（实测，只看形状和条数）。** `state.db` 的 `source_user_data` 里只有 `us-market` 一行，`{version, tripwires}`，一共 1 条盯盘条件，种类是 day（字段 `kind`、`pct`、`dir`）。没有 cost，没有 cross。所以迁移只做一件事，一条 day 变成一条 `day-move`。

**两边的自选股（实测）。** us-market 用的是 `module.json` 里的默认 9 只（`config.json` 没有覆盖）。stock-ta 的 `watchlist` 有 9 行，都没划掉，和 us-market 的 9 只完全相同，SPY、QQQ 也在里面。

**模块的触发文字能由代码拼（读代码）。** `src/modules/feed-runner.ts` 用 `fill(template, n.fields)` 填模板，所以模板写 `{{line}}`、handler 交回 `line` 就行。feed 交回的 `cursor` 在行和触发存好以后才保存，「只升不降」放在 cursor 里可行。同一个文件已经把条件提醒经 `ports.alert` 贴成模块提醒行，R5 的 `alerts` 走同一个口。

**静默时段（读代码）。** 仓库里没有静默时段。us-market 和 stock-ta 都只在交易时段（开盘到收盘后 20 分钟，跳过周末）取行情，Telegram 不静音。

### 2026-11-13 关掉 us-market 以后（实测）

协调会话按你的指示在旧 Mac 上关掉了 us-market。`module_records` 里 us-market 的开关是 0，状态是 disabled；stock-ta、module-builder、pi-pi 开着。旧 Mac 还在 7129edd。所以两套 5% 任务同时开的问题已经没有了，代价是你的盯盘条件和美股看盘队的价格问答从这时起停了，R2a 和 R1 的部署补上。

### 2026-11-13 对抗审查（interrogate）

两位审查者读了这份计划的上一版（PR #108 的 efd0064）。审查者 A 看技术，在 main 的副本上跑了探针脚本；审查者 B 看使用体验。探针脚本不在仓库里，下面写的是它们的输出。

- **R1 按上一版写会提早响（实测）。** 同一个剧本，trunk 的 `tripwire`（day 5%）在 10:05 响。按上一版写的 `day-move`（读两位小数的 `changePct`、不看新鲜度）在 9:30 就响了，因为开盘第一份快照里是 9:15 的盘前成交（+6%）；去掉那一份后又在 9:46 响，因为 4.996% 被取整成 5.00。所以 R1 改成用 `prevClose` 算不取整的涨跌幅，并只写新鲜的报价。
- **feed 输入里没有时钟（实测）。** handler 收到的键只有 `items`、`cursor`、`watchedKeys`、`settings`、`rows`，子进程里的 `new Date()` 是真时间。所以 R1 给 feed 输入加 `now`，回放和测试才能用假时钟。
- **提前收盘后 210 分钟落在第二天（实测）。** `sessionAt` 在 2026-11-27 给 `previousSessionMinutes` 390，在 2026-11-30 给 210。上一版单元测试写反了。放量已经不要，这个数只影响旧代码；提前收盘日 13:00 收盘这一点 R1 和 R5 都测，2026-11-27 在旧 Mac 上实查。
- **R1 以前的代码遇到 `day-move` 会抛错（实测）。** 在 main 上对 `{ when: "day-move" }` 调条件的 `need` 和 `describe`，都是 `TypeError: Cannot read properties of undefined (reading 'need')`。所以回到 R1 以前必须恢复 `data.db` 备份，不能只靠 `--undo`。
- **留着 `sources.us-market` 但没有 us-market 包时宿主起不来（实测）。** 报错是「config.json：sources.us-market 不是可配置的来源，可配置：（没有）」。R5 改报错说明，R6 先删这一项。
- **cost 搬成 `change-pct` 行为不同（实测）。** G3 的 `change-pct` 在第一行就已经超过成本线时立刻提醒，旧的 cost 不提醒。你没有 cost 条件，也决定不要 cost，所以迁移不搬它。
- **到档的消息会被 #105 遮住（读代码）。** #105 让幕僚长在任何任务读过私密数据以后，在 Telegram 上的每句回复都只发一行提示。到档以后的汇报经过幕僚长，所以只有到档那一行作为模块提醒行直接发（ADR-0017），你才看得到。R5 依赖 #105。
- **不要的种类以前从没开过任务（实测，旧 Mac 的 `triggers`）。** us-market 一共 17 条触发。个股 3% 档和指数 1.5% 档 5 条，都被幕僚长忽略。放量 8 条，6 条被忽略，2 条转进了更高一档已经开的任务。开任务的 3 条都是 5% 以上的个股档或 2% 的指数档，还有 1 条指数 3% 档转进了已开的任务。所以去掉 3% 档、1.5% 档和放量，你在 Telegram 上看到的东西不会少。
- **11-12 去掉 AMZN、AAPL 没成（实测加推断）。** 那天的请求「从自选股移除 AMZN 和 AAPL」开在 us-market 领域，任务停在 idle。us-market 的自选股写在 `modules/us-market/module.json` 里（读代码），对话改不了，这是推断的原因。stock-ta 的自选股是模块数据，有 `removedAt` 字段，R2a 的 lane 10 实测领队能不能改。
- **到档以后多久收到第一行汇报（审查者 B 报告，本次没复测）。** 旧 Mac 上 us-market 从触发到 Telegram 第一行汇报的中位数约 2 分钟。R5 的 perf 基线开工时重量。

**还没证明的。** 「报价日期不是今天就不写行」和旧的「开盘 30 分钟后连续 5 轮没有新鲜报价」是不是同样不误报，R1 的 lane 5 和 R5 的 lane 6 实测。领队用 `quote` 回答价格问题在旧 Mac 上能不能做到 25 秒内，R2a 部署后实测。真实交易日上的一致性只有 R6 的 lane 10 能证明。

## Appendix B. Alternatives rejected

- **`day-move` 读两位小数的 `changePct`。** 4.996% 会被当成 5%，开盘第一份快照里的盘前成交也会让它提早响（Appendix A）。所以 R1 存 `prevClose`，自己算不取整的涨跌幅。
- **让 G3 条件读 `changePct` 当 `value`。** 报价的 `watch.value` 是价格，你在对话里设的「NVDA 到 170」要靠它。所以 R1 加 `watch.prevClose`，不换 `value`。
- **等到 R6 才部署一次。** us-market 已经关了，你的盯盘条件要停好几个星期。所以 R2a 和 R1 合并后各部署一次。
- **单独一个迁移 PR（原来的 R4）。** 你只有 1 条 day 盯盘条件，cost 和 cross 都不要，迁移只剩一种对应关系，并进 R1。
- **让你在对话里重新设一遍盯盘条件，不写迁移命令。** 要你记得原来的数值，再说一遍。命令读的是存着的原值，重跑只补差，不会悄悄丢。
- **到档以后只靠幕僚长转述。** #105 合并后，用过私密模块的幕僚长在 Telegram 上只回一行，到档的消息就看不到了。所以到档那一行直接发。
- **先派盘面，盘面交回再派结构形态和趋势动量。** 汇报要多等一轮专家。三位并行派，汇报先写盘面。
- **用 G3 条件表达分档。** 分档是模块自带的默认规则，不是你设的条件。放在报价 feed 里，和 G5 的 5% 规则同一个地方，最简单。
- **宿主读到 `sources.us-market` 时跳过并警告。** 这是只为旧 Mac 一台机器留的兼容代码。R6 先删配置再换代码，就不需要它。
- **宿主启动时自动迁移盯盘条件。** 写你的数据的事不该在启动时悄悄发生。命令默认只打印，`--apply` 才写，重跑只补差。
- **保留新闻研究员和财报解读。** 你定的范围是只管客观交易数据。财报只留日期，给风险计划提示跳空。新闻问题交给通用助手，或者领队明说不管。
- **一致性回放允许的不同。** 盯盘条件的提醒文字改成 G3 的格式（Telegram 前缀 `盯盘提醒` 变成 `提醒 · 股票技术分析`，正文去掉模块名和「来自」）。thread id 从 `thr_us-market:<代码>:<日期>` 变成 stock-ta 的 `<代码>:<日期>`。SPY、QQQ 每轮都取，旧的只取自选股，所以回放脚本把它们放进两边的自选股。3% 档、指数 1.5% 档和放量不要了，比较前从 trunk 那边去掉。除此之外事件必须相同。

## Appendix C. Risks

- **你的盯盘条件现在不响（已存在，到 R1 部署为止）。** 2026-11-13 关掉 us-market 后开始。R2a、R1 排在最前，R1 合并后马上部署并迁移。stock-ta 的 5% 规则这期间照旧响。
- **价格问题现在要等专家（已存在，到 R2a 部署为止）。** R2a 最先做。
- **R5 等 #105（R5）。** #105 没合并时 R5 停在 code-ready，不影响 R6 以前已经部署的东西。
- **回退到 R1 以前起不来（R1 的部署）。** 旧代码遇到 `day-move` 会抛错，回退步骤先恢复 `data.db` 备份。R1 的 lane 10 演练过一遍。
- **提前收盘日（R1 到 R7）。** 新鲜度和档位都按 13:00 收盘算，2026-11-27 在旧 Mac 上实查。`market-days.ts` 是 `session.ts` 的副本，R7 以后还是两份，每年更新表时两处都改，`tests/market-hours.test.ts` 比对两份相同。
- **一个密钥三路请求（R2a、R2b、R5）。** `quote`、`intraday` 是按需请求，报价 feed 每 60 秒一次，S2 的每日扫描也用这个密钥。Starter 套餐没有次数上限，R2b、R5 的 perf 记 429 次数。
- **新闻问题落空（R2a）。** 领域里没有新闻了。幕僚长按模块说明把只问新闻的问题交给通用助手，混合问题里 stock-ta 的领队只报涨跌，加一句建议接着问「NVDA 最新新闻」；幕僚长有时把原因另开成通用任务。R2a 的 lane 9 把关。
- **测试改动大（R5、R7）。** 20 多个测试文件引用 us-market。改测试只改断言，不跳过、不删能保护现在行为的测试，PR 正文逐个列出。
- **没有 control skill。** 网页 lane 用仓库自己的 Playwright，命令行 lane 用脚本，Telegram 用假 Telegram。旧 Mac 上的手机确认从 `telegram_messages` 事后查，不用你守着。

## Appendix D. Links and reading list

- `modules/us-market/module.json`、`rules.md`、`agents/market-analyst.md`、`skills/us-market-desk/SKILL.md`。
- `src/sources/market/detect.ts`（分档、新鲜度 `isFresh`）、`session.ts`（交易时段、提前收盘）、`tripwires.ts`（盯盘条件、`firingId`、文字）、`source.ts`（节假日、来源面板）、`client.ts`（快照和分钟聚合）、`finnhub.ts`（财报日历）。
- `docs/modules/examples/stock-ta/feeds/quotes/`、`data/quotes/collection.json`、`data/watchlist/collection.json`、`rules.md`、`agents/`、`tools/`、`watchlist.ts`。
- `src/modules/conditions.ts`（`alertText`）、`instance-data.ts`、`protocol.ts`、`feed-runner.ts`（`feedInput`、`ports.alert`），`src/host/host.ts` 的 `#postModuleAlert`，`src/host/wiring.ts` 的 `feedSpecs`，`src/host/router.ts` 第 237 行（没有领域的任务交给通用助手），`src/client/board-format.mjs` 的 `hostLineLabel`，`src/web/view.mjs` 的 `moduleCard`。
- #105（私密数据之后幕僚长在 Telegram 上只回一行）。`docs/adr/0017-a-source-can-speak-to-the-user-directly.md`。
- `docs/web-client/look-and-feel-plan.md` 的 L3、L4。`docs/modules/stock-ta-self-contained-plan.md`（S4 的旧 Mac 步骤）。
- R1、R5 的 owner 在实现前写两种接缝草图再选（`pstack/skills/architect/SKILL.md`，缩小版）。R1 是存 `prevClose` 还是存不取整的涨跌幅，`now` 是 ISO 文字还是毫秒数。R5 是 handler 交回 `alerts`，还是 feed-runner 按 `notice` 自动贴一行。对抗审查已在 2026-11-13 做过（Appendix A），R5 合并前再跑一次 `pstack/skills/interrogate/SKILL.md`，题目是「切换后有没有哪一种你依赖的提醒少了或多了」。
- 决策记录在 `.audit/retire-us-market.tsv`，按 `pstack/skills/show-me-your-work/SKILL.md`，不提交。

## Appendix E. Decisions for the operator

第 1 到 10 条你在 2026-11-13 定了，计划已经照着改。只有第 11 条还要你答，不答就按默认做。

1. **us-market 已经关掉。** 2026-11-13 由协调会话按你的指示在旧 Mac 上关的。你的盯盘条件暂停到 R1 部署并迁移；stock-ta 的 5% 大波动规则照旧响。R6 不再关模块，只删配置和代码。
2. **不要 3% 档和指数 1.5% 档。** 档位只留个股 5% 和 8%、SPY 和 QQQ 2% 和 3%。
3. **不要放量提醒。**
4. **不加静默时段。**
5. **us-market 以前的任务、触发、提醒行和盯盘条件原始数据原样留着，什么都不做。** 网页照旧能看。迁移命令在 R7 跟旧代码一起删。
6. **不要 cost 和 cross。** 你一条都没有。迁移只搬 day，遇到别的种类就停下，什么都不写。
7. **跳空风险的窗口是计划的持有期，或 10 个交易日内。**
8. **提醒前缀是 `提醒 · 股票技术分析：`。** 正文不再重复模块名，保留昨收和「延迟行情」，去掉「来自 quotes」。
9. **报价每 60 秒取一次。**
10. **到档开任务时，盘面、结构形态、趋势动量三位并行派，汇报先写盘面。** 信号分诊、市场情绪、风险计划不自动派，你追问时再派。
11. **要不要从自选股里去掉 AMZN 和 AAPL。** 你 11-12 试过，那次请求被交给了 us-market，没改成（Appendix A）。默认去掉。R2a 的 lane 10 先证明 stock-ta 的领队能在对话里改自选股；R2a 部署以后，你在对话里说一句「从自选股去掉 AMZN 和 AAPL」就行，这是改你的数据，由你自己说，或者明确让我替你说。
