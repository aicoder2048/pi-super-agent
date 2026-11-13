# us-market retirement plan

美股只留一个模块 stock-ta。它只管客观的交易数据和由它算出的信号，新闻、财报解读和宏观不进来。us-market 退役。
它的技术分析师不搬（研究组已有），盘面专家（行情分析师）搬进 stock-ta，带一个只读的分钟线工具和一个只读的报价工具（板块 ETF 按需查）。新加一个只读的下一次财报日工具，风险计划用它提示跳空风险。新闻研究员和财报解读不搬。专家队变成 6 位：结构形态、趋势动量、信号分诊、市场情绪、风险计划、盘面。
提醒只走一条路。stock-ta 的报价 feed 接过 us-market 的分档（个股 3/5/8%，SPY、QQQ 1.5/2/3%）、放量和大波动规则；你设的盯盘条件迁成 G3 提醒条件，一条不丢。
程序守的规则是：任何一次合并以后，main 部署出去都只有一套提醒在响，不会两套同时响，也不会一套都不响。所以接管提醒和关掉 us-market 在同一个 PR（R5）里，旧 Mac 上的切换在一次部署（R6）里做完。
PR 顺序是 R1 到 R7，依次叠在上一个之上。R1 到 R4 只加东西，没人用之前不改变任何提醒。R5 切换，R6 在旧 Mac 上部署（要你点头），R7 等旧 Mac 平稳跑过一个交易日后删掉旧代码。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并 PR。R1 到 R7 都停在 merge-ready，使用者说可以合并时，按 Shipping 从下往上合并。R5 改了 Telegram 上提醒的文字和网页左栏，要使用者看过截图和视频再合并。R6 的每一步写操作都在旧 Mac 上，只在使用者明确说「部署」以后做，之前只许只读查看。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Appendix E 的待定事项要先有答复，或者按写好的默认做法走。
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
  - [ ] R1 branches from `main` as `psa/rt-r1-day-move`。
  - [ ] R2 on R1 (`psa/rt-r2-desk`)。R3 on R2 (`psa/rt-r3-earnings`)。R4 on R3 (`psa/rt-r4-migrate`)。R5 on R4 (`psa/rt-r5-cutover`)。R6 on R5 (`psa/rt-r6-deploy`)。R7 on R6 (`psa/rt-r7-delete`)。
  - [ ] R7 不早于 R6 部署后第一个完整交易日收盘。
- [ ] Hold the file boundaries. R1 只碰 `src/modules/`、`docs/modules/examples/stock-ta/data/quotes/collection.json`、`tests/`、`docs/modules/evidence/`、`docs/modules/architecture/`、`docs/modules/module-user-guide.md`。R2、R3 只碰 `docs/modules/examples/stock-ta/`、`docs/modules/stock-ta.md`、`tests/`、`docs/modules/evidence/`。R4 只碰 `src/cli/`、`justfile`、`tests/`、`docs/modules/stock-ta.md`、`docs/modules/evidence/`。R5 碰 `docs/modules/examples/stock-ta/`、`modules/us-market/`（删）、`src/host/`、`src/web/`、`tests/`、`docs/`。R6 只碰 `docs/modules/stock-ta.md`、`docs/deploy/`、`docs/modules/evidence/`。R7 只删，碰 `src/sources/market/`、`src/worker/`、`src/kernel/`、`src/web/`、`src/cli/`、`tests/`、`demos/`、`justfile`、`docs/`。没有 PR 碰 `extensions/`、`.pi/` 和使用者未提交的文件。
- [ ] Hold the review gate. R5 changes an interaction (Telegram 提醒文字、网页左栏). 它等使用者在聊天里看过截图和视频再合并。R6 的写操作等使用者说「部署」。

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 以 `just test` 全绿、`node docs/modules/architecture/check.mjs` 全绿、改到 stock-ta 包时 `just module check docs/modules/examples/stock-ta` 为 ok 为准。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `deslop` 用内置 `simplify` 代替，`no-comments` 用 `pstack:comment-sicko` 代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`. 仓库没有 Bugbot，记一行 skip。
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. 叠放的 PR 合并父分支，不 force-push，`--force-with-lease` 也不用。
- [ ] 推送前查私人信息。仓库是公开的。diff 里不能出现家目录绝对路径、邮箱、机器名，旧 Mac 只写「旧 Mac」。证据里不写你盯盘条件的代码和数值，只写条数和种类。所有手动命令都设临时的 `PSA_STATE_DIR`，不碰本机的 `~/.pi-super-agent`。
- [ ] PR 正文用中文，`## Why` 开头写使用者的目标（一个美股模块，us-market 退役，提醒一条不丢），结尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。提交署名 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict. 审查者一个看正确性，一个看「只有一套提醒在响」这条规则，R4、R5 再加一个看迁移有没有丢条件、重跑会不会多出条件。
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 不合并，停在 merge-ready。使用者说合并时按 Shipping 从下往上 squash 合并，每个先比 patch-id 再跑测试。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本次在本机跑，每条 lane 用自己的临时状态目录。R6 的 lane 在旧 Mac 上跑。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 命令行 lane 设 `PSA_STATE_DIR=$(mktemp -d)` 后跑 `just ...`。宿主 lane 用 `tests/e2e/harness.ts` 的 `startHost`，假模型用 `tests/e2e/fake-model.ts`，真模型只用 `openai-codex/*`。stock-ta 包用 `cp -R` 装进临时状态目录的 `modules/`，再 `just module on stock-ta`。
- [ ] 不连网的 lane 用 fixtures 回放 Massive 快照、分钟聚合和 Finnhub 应答。真行情 lane 用宿主密钥文件里的 `POLYGON_API_KEY` 和 `FINNHUB_API_KEY`，只读。要盘中行情的 lane 在美东 9:30 到 16:20 跑，时段外脚本拒绝，加 `--off-hours` 才跑（和 G5 一样）。
- [ ] 回放器 `docs/modules/evidence/replay-day.ts`（R1 建，R5 扩充）按分钟把一整天的快照喂给被测的一边，时钟用假的。剧本在 `tests/fixtures/us-market-day/`，至少有：跳空直接到 8% 档、3 到 5 到 8 逐档上升再回落、SPY 到 1.6% 和 2.1%、开盘后 10 分钟内和收盘前 10 分钟内的放量、盘中的放量、提前收盘日、节假日（整天都是昨天的报价）、盘前盘后的成交。
- [ ] 输入只走 `just` 命令、宿主 socket 和网页。只读诊断是 `just modules`、对状态目录跑的 `sqlite3 -readonly`、宿主日志。R6 在旧 Mac 上只用 `ssh -o BatchMode=yes` 跑文档里写的命令和只读诊断。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. 命令行 lane 存 `<slug>.txt`。

## Teach G3 a day move against the previous close (R1)

**Depends on.** None. 从 `main` 开。

**Files.**

- [ ] Edit `src/modules/protocol.ts`。`Condition` 加 `day-move`，`Watch` 加可选的 `change`（行里「相对昨收的涨跌幅」那一列的名字）。
- [ ] Edit `src/modules/conditions.ts`，加 `day-move` 的 spec（解析、说明、判断、提醒文字）。
- [ ] Edit `src/modules/instance-data.ts`，`day-move` 按美东交易日和方向去重。
- [ ] Edit `src/modules/validate.ts`，`watch.change` 必须是这个 collection 里的数字字段。
- [ ] Edit `docs/modules/examples/stock-ta/data/quotes/collection.json`，`watch` 加 `"change": "changePct"`。这是 R1 唯一碰 stock-ta 包的地方，R1 的文件边界放宽到这一个文件。
- [ ] Edit `docs/modules/architecture/design.md` 第 2 节和 `docs/modules/module-user-guide.md`，写上 `day-move`。
- [ ] Edit `tests/conditions.test.ts`、`tests/stock-ta-quotes.test.ts`。
- [ ] Create `docs/modules/evidence/replay-day.ts`、`docs/modules/evidence/r1-live.ts`、`tests/fixtures/us-market-day/`。

**Build.**

- [ ] `{ when: "day-move", atLeast, direction }`，`atLeast` 0.1 到 100（和旧盯盘条件的 `pct` 同一个范围），`direction` 是 up、down、either，默认 either。判断读行里 `watch.change` 那一列，不读价格，所以和昨收比，不和上一分钟比。没有 `watch.change` 的 collection 设这种条件时拒绝并说明。
- [ ] 去重和旧盯盘条件一样：同一条条件、同一个美东交易日、同一个方向只提醒一次。提醒行的 externalId 是 `<条件 id>:<美东日期>:<up|down>`，不是现在的 `<条件 id>:<行 id>`，所以价格在线上线下来回穿也不会重复提醒。
- [ ] 提醒文字由 `alertText` 拼，`happened` 写成「相对昨收涨了 5.31%，到了你设的涨 5% 提醒线」，方向和旧盯盘条件的说法一致。`describe` 写成「当天相对昨收涨跌到 5%」。
- [ ] 回放器 `replay-day.ts` 第一版只喂 stock-ta 这一边：按分钟把剧本里的快照交给报价 feed 的 handler，再把行写进临时状态目录，收集提醒行。R5 再加 us-market 那一边。

**You see.**

- [ ] 对 stock-ta 设「NVDA 当天涨跌 5%」以后，剧本里 NVDA 在 10:05 到 +5.3%、10:20 回到 +4.8%、10:40 再到 +5.6%，只有 10:05 一条提醒，文字是「股票技术分析 NVDA … 相对昨收涨了 5.3%，到了你设的涨跌 5% 提醒线（… 美东 …）」。
- [ ] 第二个交易日同样的走势再提醒一次。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/conditions.test.ts` 新增：解析（范围、方向、多余字段被拒）、没有 `watch.change` 时拒绝、到线提醒、来回穿不重复、两个方向各一次、第二天重新开始、刚好等于阈值（浮点误差）也算。每条先红后绿。Run `just test`.
- [ ] `tests/stock-ta-quotes.test.ts` 新增：quotes 的 `watch.change` 是 `changePct`，`just module check docs/modules/examples/stock-ta` 为 ok。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r1-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都给 stock-ta 设一条 `above` 条件（NVDA 价格到 170）并回放同一个剧本。Save `r1-regression.txt`. Pass when 两边的提醒行完全相同。trunk 没有 `day-move`，这一点记下来，day-move 由 lane 2 到 6 把关。
- [ ] Lane 2. 设 `day-move` 涨跌 5%，回放「逐档上升再回落再上升」。Save `r1-once.txt`. Pass when 一天只有一条提醒，时间是第一次到线那一分钟。
- [ ] Lane 3. 设 `direction: either`，回放「先涨 5% 后跌 5%」。Save `r1-both-ways.txt`. Pass when 涨一条、跌一条，共两条。
- [ ] Lane 4. 回放两个交易日。Save `r1-next-day.txt`. Pass when 第二天又提醒一次。
- [ ] Lane 5. 回放「跳空直接 +8%」。Save `r1-gap.txt`. Pass when 开盘第一行就提醒，文字里是 8% 左右的实际涨幅。
- [ ] Lane 6. 宿主运行中，通过对话让 stock-ta 的领队设「AMD 当天涨跌 3% 提醒我」（假模型照剧本调 `watch`）。Save `r1-chat-set.txt`. Pass when `_conditions` 里多一行 `day-move`，回执行写着「当天相对昨收涨跌到 3%」。
- [ ] Lane 7. 往一个没有声明 `watch.change` 的 series（lane 脚本里临时建的样例模块）设 `day-move`。Save `r1-no-change.txt`. Pass when 拒绝，说明这个 collection 没有涨跌幅这一列。
- [ ] Lane 8. 提醒行经宿主发到假 Telegram。Save `r1-telegram.txt`. Pass when 前缀是 `提醒 · 股票技术分析：`，一行，没有换行。
- [ ] Lane 9. 宿主重启后再回放同一天剩下的部分。Save `r1-restart.txt`. Pass when 重启前已提醒的不再提醒。
- [ ] Lane 10. `just module check docs/modules/examples/stock-ta` 和 `node docs/modules/architecture/check.mjs`。Save `r1-check.txt`. Pass when 两个都通过。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 报价 feed 写一轮 9 行（每只股票各有 3 条条件）时，宿主侧写入加判断条件的时间。
- [ ] Probe. trunk 和 head 交替各 30 轮，trunk 用 `above`，head 用 `day-move`，条件数相同。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 中位数比 trunk 慢 5 毫秒以上就失败。

**Review gate.** None. R1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Bring the 盘面 expert into stock-ta with intraday bars and quotes (R2)

**Depends on.** R1.

**Files.**

- [ ] Create `docs/modules/examples/stock-ta/agents/market-desk.md`（盘面）。
- [ ] Create `docs/modules/examples/stock-ta/tools/quote/`（`tool.json`、`index.ts`、fixtures）。
- [ ] Create `docs/modules/examples/stock-ta/tools/intraday/`（`tool.json`、`index.ts`、fixtures）。
- [ ] Create `docs/modules/examples/stock-ta/skills/market-desk/SKILL.md`。
- [ ] Create `docs/modules/examples/stock-ta/evals/market-desk.md`。
- [ ] Edit `docs/modules/stock-ta.md`，写上两个联网的只读工具和它们的请求量。
- [ ] Edit `tests/stock-ta.test.ts`。Create `docs/modules/evidence/r2-live.ts`。

**Build.**

- [ ] 盘面专家照搬 us-market 的 `market-analyst.md` 的职责和做法，去掉 `web_get` 和读报道那一步：判断这次波动是个股的，还是大盘、板块的。用一次 `quote` 同时查这只股票、SPY、QQQ 和一两只板块 ETF 或同板块代表，用差值说话；用 `intraday` 看当天走势里的跳空、急动时间、反弹、量集中在哪段。汇报写结论、证据、数据时间三段，不超过 600 字。`uses` 是 `quote`、`intraday`、`prices`、`note`。
- [ ] `quote` 工具：输入 `symbols`（1 到 10 个代码，可以是 ETF），一次快照请求，回每只的价格、相对昨收涨跌幅、当天量、数据时间。解析照抄 `feeds/quotes/index.ts` 的 `parseQuote`（模块代码不能 import 宿主的代码），抽成包里的 `massive.ts` 共用。`secrets: ["POLYGON_API_KEY"]`，只读，18 秒内结束。
- [ ] `intraday` 工具：输入 `symbol`、`span`（minute、hour）、可选 `from`、`to`（默认今天，最多回看 4 个交易日），`limit` 最多 500 根。请求 `/v2/aggs/ticker/{s}/range/1/{span}/{from}/{to}?adjusted=true&sort=desc&limit=`，和 `src/sources/market/client.ts` 的 `bars` 一样。回 K 线和分钟线的 VWAP。只读，18 秒内结束。
- [ ] 技能 `market-desk` 写 us-market-desk 里和数据有关的部分：K 线粒度怎么选、报价怎么写（数据时间、延迟 15 分钟）、同时最多两个联网工具调用。去掉 `lookup us-market`、盯盘条件和新闻那几节。
- [ ] 不改 `rules.md`，不改报价 feed。这一步只加人和工具，提醒不变。

**You see.**

- [ ] 网页上 stock-ta 的专家队显示 6 位，多了「盘面」。
- [ ] 问 stock-ta「NVDA 今天跌 4% 是它自己的事还是板块的事」，汇报里有 NVDA、SPY、QQQ、SMH 的涨跌幅和差值，有当天急跌的时间段，有数据时间。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta.test.ts` 新增：`quote` 解析（纳秒和毫秒时间戳、没有成交价时退到分钟收盘、超过 10 个代码被拒）、`intraday` 的地址和参数（回看超过 4 天被拒、`limit` 上限）、没有密钥时一行说明、HTTP 错误一行说明。用 fixtures，不连网。Run `just test`.
- [ ] `just module check docs/modules/examples/stock-ta` 为 ok。Run `just module check docs/modules/examples/stock-ta`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r2-live.ts`，lane 6 到 9 用真行情。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都回放 R1 的剧本，stock-ta 的提醒和触发。Save `r2-regression.txt`. Pass when 两边相同，说明加人加工具没有改提醒。
- [ ] Lane 2. `just modules` 和网页的模块面板。Save `r2-team.png`. Pass when stock-ta 有 6 位专家，盘面的工具是 `quote`、`intraday`、`prices`、`note`。
- [ ] Lane 3. 假模型让盘面越出 `uses` 调 `structure`。Save `r2-uses.txt`. Pass when 被拒，码是 `not-in-uses`。
- [ ] Lane 4. `quote` 用 fixtures 查 11 个代码。Save `r2-quote-cap.txt`. Pass when 拒绝，说明最多 10 个。
- [ ] Lane 5. 没有 `POLYGON_API_KEY` 时调 `quote` 和 `intraday`。Save `r2-no-key.txt`. Pass when 各一行说明怎么加密钥，不发请求。
- [ ] Lane 6. 真行情 `quote` 查 NVDA、SPY、QQQ、SMH、XLK。Save `r2-quote-real.txt`. Pass when 5 只都有价格和涨跌幅，数据时间是最近的交易时段。
- [ ] Lane 7. 真行情 `intraday` 查 NVDA 当天分钟线。Save `r2-intraday-real.txt`. Pass when 回 K 线，最新一根的时间离数据时间不超过 20 分钟，有 VWAP。
- [ ] Lane 8. 真模型 `openai-codex/*` 跑 `evals/market-desk.md`（「这次跌是个股还是板块」）。Save `r2-eval.txt`. Pass when 汇报有三段、有相对 SPY 和板块 ETF 的差值、有数据时间，没有新闻和财报的说法。
- [ ] Lane 9. 真模型问一个 S3 已有的技术面问题（「NVDA 的支撑在哪」）。Save `r2-old-question.txt`. Pass when 领队照旧派给结构形态，不派给盘面。
- [ ] Lane 10. 读 `docs/modules/stock-ta.md` 的工具一节。Save `r2-doc.txt`. Pass when 写明两个工具联网、只读、用哪个密钥、每次几个请求。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk 没有这两个工具。量 `quote`（5 个代码）和 `intraday`（一天分钟线）一次调用的宿主侧时间，以及盘面汇报任务从派活到交回的时间。另量报价 feed 一轮的时间，trunk 和 head 都有。
- [ ] Probe. 交易时段内两个工具各调 20 次，报价 feed trunk 和 head 交替各 10 轮。
- [ ] Baseline. Record the trunk 报价 feed 一轮的中位数 first.
- [ ] Rule. 报价 feed 比 trunk 慢 50 毫秒以上就失败。两个工具的中位数超过 3 秒、或任何一次超过 18 秒，就失败。

**Review gate.** None. R2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Give risk-plan the next earnings date (R3)

**Depends on.** R2.

**Files.**

- [ ] Create `docs/modules/examples/stock-ta/tools/earnings-date/`（`tool.json`、`index.ts`、fixtures）。
- [ ] Edit `docs/modules/examples/stock-ta/agents/risk-plan.md`，`uses` 加 `earnings-date`，写清什么时候提示跳空风险。
- [ ] Create `docs/modules/examples/stock-ta/evals/earnings-gap.md`。
- [ ] Edit `docs/modules/stock-ta.md`。Edit `tests/stock-ta.test.ts`。Create `docs/modules/evidence/r3-live.ts`。

**Build.**

- [ ] `earnings-date` 工具：输入 `symbol`。请求 Finnhub `/calendar/earnings?from=<今天>&to=<今天+120 天>&symbol=`，请求头 `X-Finnhub-Token`，解析照抄 `src/sources/market/finnhub.ts` 的 `parseCalendar`。回下一次财报的日期、盘前还是盘后、离今天几个交易日，没有就回「120 天内没有已公布的财报日」。不回预期、实际 EPS 和营收，不碰 `/stock/earnings`。`secrets: ["FINNHUB_API_KEY"]`，只读，18 秒内结束。
- [ ] 风险计划每次给计划都查一次。财报日在计划的持有期内，或在 10 个交易日内（Appendix E 第 7 条），计划里单独一行写「财报日 <日期>（盘前/盘后），持有过财报有跳空风险，止损可能按跳空价成交」。查不到时写「没查到财报日」，不编。
- [ ] 不加财报解读，不读新闻。模块的说明里写明它只管客观交易数据。

**You see.**

- [ ] 问 stock-ta「NVDA 在 170 进、160 止损、190 目标，怎么看」，风险计划的汇报里有一行财报日和跳空风险（财报在窗口内时），或者一行「下一次财报在 <日期>，不在持有期内」。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta.test.ts` 新增：日历解析（多条取最近的未来一条、今天盘后算今天、空列表）、交易日计数跳过周末、没有密钥一行说明、429 一行说明。用 fixtures。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r3-live.ts`，lane 5、6、8 用真接口。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都调 `risk-reward`（同样的进场、止损、目标）。Save `r3-regression.txt`. Pass when 结果相同。trunk 没有财报日工具，这一点记下来，由 lane 2 到 9 把关。
- [ ] Lane 2. fixtures 里财报在 3 个交易日后。Save `r3-near.txt`. Pass when 工具回日期、盘前或盘后、3。
- [ ] Lane 3. fixtures 里 120 天内没有财报。Save `r3-none.txt`. Pass when 回「120 天内没有已公布的财报日」。
- [ ] Lane 4. 没有 `FINNHUB_API_KEY`。Save `r3-no-key.txt`. Pass when 一行说明，不发请求。
- [ ] Lane 5. 真接口查 NVDA、AAPL、SPY。Save `r3-real.txt`. Pass when NVDA、AAPL 有日期，SPY 回没有财报日，不报错。
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

## Add a command that moves 盯盘条件 into G3 conditions (R4)

**Depends on.** R3.

**Files.**

- [ ] Create `src/cli/migrate-us-market.ts`。Edit `justfile`，加 `just migrate-us-market`。
- [ ] Create `tests/migrate-us-market.test.ts`。
- [ ] Edit `docs/modules/stock-ta.md`，加「从 us-market 搬过来」一节。
- [ ] Create `docs/modules/evidence/r4-live.ts`。

**Build.**

- [ ] 命令通过宿主 socket 工作，宿主要在运行，stock-ta 要开着。它读 `state.db` 里 `source_user_data` 的 `us-market` 那一行（`{version, tripwires: [{symbol, condition, setAt}]}`）和 us-market 当时在用的自选股（`config.json` 的 `sources.us-market.watchlist`，没有就是 `modules/us-market/module.json` 的默认值；R5 删掉这个文件以后，默认值写死在命令里）。
- [ ] 默认只打印，不写。打印一张表：每条盯盘条件的种类、要变成的 G3 条件、结果（新建、不变、更新、不搬）。表里不印成本价和股数。`--apply` 才写，`--undo` 删掉它建的条件。
- [ ] 对应关系。
  - [ ] `day {pct, dir}` 变成 `day-move {atLeast: pct, direction: dir}`。
  - [ ] `cost {pct, dir, basis, shares}` 变成 `change-pct {atLeast: pct, direction: dir, basis}`，`shares` 不搬（旧代码只在回执里用它）。成本价不能出现在发往 Telegram 的提醒行里，命令写入前用 `alertText` 拼一条样例检查，含成本价就停。
  - [ ] `cross {fast, slow}` 不搬（Appendix E 第 6 条）。表里写「不搬」，`--apply` 遇到它退出码非零，除非加 `--drop-cross`。
- [ ] 条件 id 由内容定，`cnd_usm_<代码>_<种类>`，所以重跑只补差：已有同样的就不变，参数不同就更新，没有就新建。备注写「从盯盘条件搬来，原设于 <美东日期>」。写入走 `page` 权限（G3 的 `user-authority`），每条有回执，回执只在本机显示。
- [ ] 盯盘条件里的代码和 us-market 的自选股，不在 stock-ta 自选股里的，追加一行，备注「从 us-market 搬来」。
- [ ] 不改、不删 `source_user_data` 的 `us-market` 那一行，留作记录（Appendix E 第 5 条）。

**You see.**

- [ ] 在一个有 3 条盯盘条件（day、cost、cross 各一）的临时状态目录里，`just migrate-us-market` 打印 3 行，`--apply --drop-cross` 后 stock-ta 多 2 条条件，再跑一次 `--apply` 打印「全部不变」。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/migrate-us-market.test.ts` 覆盖三种对应关系、默认不写、重跑不变、参数变了就更新、`--undo` 只删自己建的、`cross` 让 `--apply` 失败、成本价不出现在打印和提醒行、自选股只追加缺的、宿主没运行或 stock-ta 关着时一行说明、`source_user_data` 没有 us-market 时打印「没有盯盘条件」。每条先红后绿。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r4-live.ts`。临时状态目录先用 trunk 的 `tripwire` 工具设好盯盘条件，再切到 head 迁移。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都用 `tripwire` 工具设一条 day 盯盘条件并回放剧本。Save `r4-regression.txt`. Pass when 两边 us-market 的提醒相同。trunk 没有迁移命令，这一点记下来，由 lane 2 到 10 把关。
- [ ] Lane 2. 只有一条 day 盯盘条件（和旧 Mac 现在的形状一样），跑默认模式。Save `r4-dry.txt`. Pass when 打印一行「新建 day-move」，`_conditions` 还是空的。
- [ ] Lane 3. 同上加 `--apply`。Save `r4-apply.txt`. Pass when `_conditions` 有一行 `cnd_usm_<代码>_day`，参数和原条件相同，有一条回执行。
- [ ] Lane 4. 再跑一次 `--apply`。Save `r4-idempotent.txt`. Pass when 打印「全部不变」，`_conditions` 和回执行都没多。
- [ ] Lane 5. 迁移后关掉 us-market，回放剧本。Save `r4-fires.txt`. Pass when 新条件在旧条件会响的同一分钟响一次。
- [ ] Lane 6. 一条 cost 条件。Save `r4-cost.txt`. Pass when 搬成 `change-pct` 带 basis；打印、提醒行、假 Telegram 里都没有成本价。
- [ ] Lane 7. 一条 cross 条件，`--apply` 不加 `--drop-cross`。Save `r4-cross.txt`. Pass when 退出码非零，什么都没写，说明怎么处理。
- [ ] Lane 8. `--apply` 写到一半杀掉进程，再跑一次。Save `r4-crash.txt`. Pass when 第二次补齐，最后的条件和一次跑完的一样。
- [ ] Lane 9. `--undo`。Save `r4-undo.txt`. Pass when 只删 `cnd_usm_*`，你自己设的条件还在，追加的自选股行不删。
- [ ] Lane 10. 盯盘条件里有一只不在 stock-ta 自选股里的代码。Save `r4-watchlist.txt`. Pass when 自选股追加这一只，备注「从 us-market 搬来」，下一轮报价 feed 有它的报价。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk 没有这个命令。量 50 条盯盘条件（旧上限）的 `--apply` 时间，和宿主启动到就绪的时间（trunk 和 head 都有）。
- [ ] Probe. `--apply` 跑 5 次（每次新的临时目录）。宿主启动 trunk 和 head 交替各 5 次。
- [ ] Baseline. Record the trunk 启动中位数 first.
- [ ] Rule. `--apply` 中位数超过 3 秒就失败。启动比 trunk 慢 100 毫秒以上就失败。

**Review gate.** None. R4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Move us-market's alerts into stock-ta and switch us-market off (R5)

**Depends on.** R4.

**Files.**

- [ ] Edit `docs/modules/examples/stock-ta/feeds/quotes/feed.json`、`index.ts`、fixtures。Create `docs/modules/examples/stock-ta/market-days.ts`。
- [ ] Edit `docs/modules/examples/stock-ta/rules.md`、`skills/market-desk/SKILL.md`。
- [ ] Delete `modules/us-market/`。
- [ ] Edit `src/host/wiring.ts`（`sources.us-market` 的报错说明）。
- [ ] Edit `src/cli/migrate-us-market.ts`（自选股默认值写死）。
- [ ] Edit `tests/stock-ta-quotes.test.ts`、`tests/wiring.test.ts` 和因为 us-market 包不在而失败的测试（`tests/first-teams.test.ts`、`tests/modules.test.ts`、`tests/modules-cli.test.ts` 等），改成断言新的行为，不跳过。
- [ ] Create `tests/fixtures/us-market-day/expected.json`、`docs/modules/evidence/r5-parity.ts`、`docs/modules/evidence/r5-live.ts`。
- [ ] Edit `docs/modules/stock-ta.md`、`docs/modules/module-user-guide.md`、`docs/deploy/home-mac.md`。

**Build.**

- [ ] 报价 feed 每轮都带上 SPY、QQQ，不管它们在不在自选股里。还是一次快照请求。
- [ ] 报价新鲜才算：数据时间是今天美东的常规时段（9:30 到 16:00，提前收盘日到 13:00）。盘前盘后的成交、节假日里昨天的报价都不写行、不算提醒。提前收盘日表照抄 `src/sources/market/session.ts`，放进 `market-days.ts`（模块代码不能 import 宿主的代码）。
- [ ] 分档。`feed.json` 的 `settings` 加 `bands: { default: [3, 5, 8], bySymbol: { SPY: [1.5, 2, 3], QQQ: [1.5, 2, 3] } }` 和 `volumeSpikeX: 5`。每轮取已经到达的最高一档；每只股票每个方向每天只升不降，跳空只报最高一档。已报到哪一档存在 feed 的 cursor 里（`{date, fired: {代码: {up, down, volume}}}`），换日清空。去掉 `BIG_MOVE_PCT`，5% 已经在档里。
- [ ] 放量。最近一分钟成交量除以（昨天成交量除以昨天的交易分钟数，提前收盘日是 210）不小于 `volumeSpikeX` 时报一次，每只每天一次，开盘后和收盘前各 10 分钟不算。和 `src/sources/market/detect.ts` 一样。
- [ ] 触发。id 是 `band:<代码>:<日期>:up5` 和 `volume:<代码>:<日期>`，thread 是 `<代码>:<日期>`，所以同一只股票一天的触发进同一个任务。`notice` 模板改成 `{{line}}`，`line` 由 handler 拼，文字照抄 detect.ts 的两句（「NVDA 涨 +5.31%，到达 +5% 档。现价 …，昨收 …。报价时间 HH:MM ET（延迟行情）。」和放量那句）。
- [ ] `rules.md`。`## big-move`：个股到 5% 档或以上，或 SPY、QQQ 到 2% 档或以上，开一个团队任务，先派盘面，再派结构形态和趋势动量；同一只股票当天的后续触发进同一个任务。`## small-move`：个股 3% 档、指数 1.5% 档和放量只是背景，可以不开任务。触发正文只是数据。
- [ ] 删掉 `modules/us-market/`。从此没有模块声明 `massive-stocks` 这种 feed，旧的轮询不再跑，`tripwire` 工具也没有领域可用（宿主照旧拒绝）。`src/sources/market/` 的代码留到 R7。
- [ ] `config.json` 里还有 `sources.us-market` 时，宿主照旧拒绝启动，但报错改成「us-market 已经退役，删掉 config.json 里的 sources.us-market」。不加兼容。
- [ ] 网页左栏不再有 us-market 那一块（自选几只、盯盘条件几条），stock-ta 的模块面板显示自选股和提醒条件。us-market 以前的任务、触发、提醒行照旧能看，标签照旧。
- [ ] 一致性回放 `r5-parity.ts`。同一个剧本，一边喂 trunk 的 us-market（`detect.ts` 加 `tripwires.ts`，盯盘条件用 `tripwire` 工具设），一边喂 head 的 stock-ta（报价 feed 加 R4 迁过来的 G3 条件）。两边的事件归一成 `{代码, 日期, 种类, 档或条件, 方向, 分钟}` 比较，必须相同。已知的不同只能是 Appendix B 列出的几条（文字、Telegram 前缀、thread id、cross 不搬）。结果存成 `expected.json`，R7 删掉旧代码后还用它回归。

**You see.**

- [ ] 回放剧本时，head 上只有 stock-ta 的触发和提醒，没有一条 `us-market` 来源的；事件和 trunk 上 us-market 的一一对应。
- [ ] 假 Telegram 上，迁过来的盯盘条件响时是 `提醒 · 股票技术分析：股票技术分析 NVDA … 相对昨收涨了 5.3%，到了你设的涨跌 5% 提醒线（… 美东 …）`。
- [ ] NVDA 到 +5% 档时开一个团队任务，领队先派盘面；同一天到 +8% 档时进同一个任务，不开新任务。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta-quotes.test.ts` 新增：分档取最高、只升不降、跳空只报最高档、两个方向独立、换日清空、SPY 和 QQQ 用自己的档、放量的比值和开收盘 10 分钟、提前收盘日 210 分钟、盘前盘后和节假日不算、SPY 和 QQQ 总在请求里、cursor 重启后接着用。每条先红后绿。Run `just test`.
- [ ] `tests/wiring.test.ts` 新增：`sources.us-market` 的报错说明。其他因为 us-market 不在而改的测试，在 PR 正文里逐个列出改了什么断言。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r5-live.ts`，lane 9 用真行情。

- [ ] Lane 1. Regression lane against trunk. 一致性回放 `r5-parity.ts`，trunk 跑 us-market，head 跑 stock-ta，同一个剧本、同一份盯盘条件。Save `r5-parity.txt`. Pass when 归一后的事件完全相同，不同之处只有 Appendix B 列出的几条。
- [ ] Lane 2. head 宿主同时装着 stock-ta，回放剧本，查 `triggers` 和 `host_lines` 的来源。Save `r5-one-path.txt`. Pass when 没有一行来源是 `us-market`，每个事件只有一行。
- [ ] Lane 3. 剧本里 NVDA 到 +5% 再到 +8%，假模型照 `rules.md` 开任务。Save `r5-ticket.png`. Pass when 只开一个团队任务，领队第一个派的是盘面，+8% 的触发进了同一个任务。
- [ ] Lane 4. 剧本里 AAPL 到 +3% 档、有一次盘中放量。Save `r5-small.txt`. Pass when 两条触发都在，没有开任务。
- [ ] Lane 5. 剧本里 SPY 到 +1.6% 和 +2.1%，SPY 不在自选股里。Save `r5-spy.txt`. Pass when 1.5% 档一条背景触发，2% 档开任务。
- [ ] Lane 6. 节假日和提前收盘日两个剧本。Save `r5-calendar.txt`. Pass when 节假日没有任何触发；提前收盘日 13:00 以后的成交不算，第二天放量按 210 分钟算。
- [ ] Lane 7. 临时状态目录的 `config.json` 里留着 `sources.us-market`，启动宿主。Save `r5-config.txt`. Pass when 拒绝启动，报错写着删掉哪一项。删掉后启动正常。
- [ ] Lane 8. 网页。Save `r5-page.png`. Pass when 左栏没有 us-market 那一块，stock-ta 面板有自选股和提醒条件，以前 us-market 的任务点得开。
- [ ] Lane 9. 交易时段真行情跑 30 分钟，宿主只开 stock-ta。Save `r5-real.txt`. Pass when 每轮一次 Massive 请求，SPY、QQQ 有行，提醒和触发都按数据时间去重。
- [ ] Lane 10. 对话里让领队「给 TSLA 设个当天涨跌 4% 的提醒」。Save `r5-chat-set.png`. Pass when 设的是 stock-ta 的 `day-move`，没有调 `tripwire`，回执在网页上。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 报价 feed 一轮的时间（trunk 和 head 都有），每小时的 Massive 请求数（trunk 是 us-market 加 stock-ta 两路，head 只有 stock-ta），从数据写入到提醒行发出的时间。
- [ ] Probe. 回放同一个剧本，trunk 和 head 交替各 3 遍，每遍 390 轮。请求数用回放器的计数。
- [ ] Baseline. Record the trunk 一轮中位数和每小时请求数 first.
- [ ] Rule. 一轮中位数比 trunk 慢 20 毫秒以上就失败。head 每小时请求数多于 trunk 就失败。提醒行发出晚于数据写入 1 秒以上就失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3、5、8、10 screenshots into `docs/modules/evidence/r5-review-<slug>.png`，再加一张假 Telegram 上迁移后提醒和档位任务汇报的截图 `r5-review-telegram.png`。
- [ ] Record a 30 to 60 second video of the change on a lane VM，回放剧本、网页左栏、Telegram。Save it as `docs/modules/evidence/r5-review.mp4`。
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Switch the old Mac over in one deploy (R6)

**Depends on.** R5，合并进 main 以后。每一步写操作都要你先说「部署」。

**Files.**

- [ ] Edit `docs/modules/stock-ta.md`，加「旧 Mac 从 us-market 切换」的步骤和回退步骤。
- [ ] Edit `docs/deploy/home-mac.md`，删掉 us-market 的设置说明。
- [ ] Create `docs/modules/evidence/r6-old-mac.md`，记录每一步的输出（只写条数、种类、SHA，不写代码和数值）。

**Build.**

- [ ] 只读预检，任何时候都能做。记下旧 Mac 的 SHA、`just modules` 的开关、盯盘条件的条数和种类、stock-ta 自选股条数、`config.json` 的键、当天提醒行和触发的条数。2026-11-13 的预检见 Appendix A。
- [ ] 下面每一步等你说「部署」。时间选在美东 16:20 以后或周末，切换中没有盘中行情，所以不会漏提醒，也不会两套一起响。
  - [ ] 备份 `config.json`，用 `sqlite3 .backup` 备份 `state.db` 和 `modules-data/stock-ta/data.db`。
  - [ ] 从 `config.json` 删掉 `sources.us-market`。旧代码没有这一项也能跑（轮询回到每 60 秒），所以这一步先做。
  - [ ] `git pull` 到 main，`cp -R docs/modules/examples/stock-ta` 到状态目录的 `modules/stock-ta`，`just module setup stock-ta`，按 H4 的 runbook 重启服务。
  - [ ] `just migrate-us-market`，打印的条数和种类要和预检相同；再 `just migrate-us-market --apply`；再跑一次，打印「全部不变」。
  - [ ] `just notify` 发一行测试，手机上收到。
- [ ] 下一个交易日只读查看：提醒行和触发的来源只有 stock-ta，`us-market` 来源在部署之后没有新行。
- [ ] 回退。`just migrate-us-market --undo`，`git checkout` 部署前的 SHA，从那个 SHA 重新 `cp -R` stock-ta 包，恢复 `config.json` 备份，重启。us-market 的盯盘条件一直没动过，回退后照旧生效。

**You see.**

- [ ] 旧 Mac 上 `just modules` 没有 us-market，stock-ta 开着、版本是 R5 的包；stock-ta 的提醒条件条数等于预检的盯盘条件条数；网页左栏只有 stock-ta。
- [ ] 部署后第一个交易日，你手机上收到的提醒只有 `提醒 · 股票技术分析：` 开头的，档位任务的汇报来自 stock-ta 的专家队。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] R6 只改文档。在 R6 的 head 上跑一遍，确认文档里的每个 `just` 命令都在 `justfile` 里。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. lane 在旧 Mac 上跑，lane 1、2 只读、随时可跑，lane 3 到 10 在你说「部署」以后。

- [ ] Lane 1. Regression lane against trunk. 部署前在旧 Mac 现在的版本上只读记下当天的提醒和触发（预检）。trunk 是旧 Mac 现在跑的 SHA，head 是 main。Save `r6-before.txt`. Pass when 预检的每一项都有数。
- [ ] Lane 2. 部署前只读检查：`state.db` 里 us-market 的盯盘条件能读出来，种类只有 day、cost、cross 里的。Save `r6-shape.txt`. Pass when 能读出来，没有不认识的种类；有 cross 时停下来问你。
- [ ] Lane 3. 备份和删 `sources.us-market` 之后，旧代码重启。Save `r6-config.txt`. Pass when 服务正常，`just modules` 照旧。
- [ ] Lane 4. 拉代码、装包、setup、重启后 `just modules`。Save `r6-modules.txt`. Pass when 没有 us-market，stock-ta 开着，版本 digest 和 R5 的包一致。
- [ ] Lane 5. 迁移默认模式。Save `r6-dry.txt`. Pass when 条数和种类等于 lane 2。
- [ ] Lane 6. `--apply` 后再跑一次。Save `r6-apply.txt`. Pass when 第二次「全部不变」，`_conditions` 条数等于 lane 2 的条数。
- [ ] Lane 7. `just notify` 一行。Save `r6-notify.txt`. Pass when `telegram_messages` 里有这一行的 message_id，你确认手机收到。
- [ ] Lane 8. 网页截图。Save `r6-page.png`. Pass when 左栏只有 stock-ta，提醒条件里有迁来的条件，以前 us-market 的任务点得开。
- [ ] Lane 9. 部署后第一个交易日收盘后只读查看。Save `r6-first-day.txt`. Pass when 部署之后没有 `us-market` 来源的新行；有档位触发时来源是 `stock-ta/quotes`，任务开在 stock-ta 的专家队。
- [ ] Lane 10. 同一天对比：你的盯盘条件在那天的行情下该不该响，按 R5 的一致性规则用当天记录的报价算一遍。Save `r6-parity-day.txt`. Pass when 该响的都响了一次，不该响的没响。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 交易时段每小时的 Massive 请求数，和提醒从数据时间到 Telegram 发出的延迟。
- [ ] Probe. 宿主日志和 `telegram_messages`，部署前一个交易日和部署后第一个交易日各算一遍。
- [ ] Baseline. Record the 部署前那一天 first（us-market 每 300 秒加 stock-ta 每 60 秒）。
- [ ] Rule. 部署后每小时请求数多于部署前就失败。延迟中位数比部署前多 60 秒以上就失败。

**Review gate.** None. R6 is not review-gated. 它的写操作由你说「部署」放行，见上面 Build。

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Delete the us-market code once the old Mac has run clean (R7)

**Depends on.** R6，而且旧 Mac 在部署后跑完一个交易日，lane 9、10 通过。

**Files.**

- [ ] Create `src/modules/market-hours.ts`，从 `src/sources/market/session.ts` 搬过来 `inPollWindow` 和交易时段表。Edit `src/host/host.ts`、`src/modules/manifest.ts` 改 import。
- [ ] Delete `src/sources/market/`。
- [ ] Edit `src/sources/feeds.ts`、`src/host/wiring.ts`、`src/host/workers.ts`、`src/worker/extension.ts`、`src/worker/tools.ts`、`src/pi-worker.ts`、`src/kernel/`、`src/client/protocol.ts`、`src/web/`、`src/telegram/`，删掉 `massive-stocks`、`tripwire` 工具和 RPC、`lookup us-market`、`market` 角色、us-market 的左栏面板和 `盯盘提醒：` 前缀。
- [ ] Delete `src/cli/market-smoke.ts`、`demos/demo-5-market.mjs`，Edit `justfile`、`demos/README.md`。
- [ ] Delete `tests/market-*.test.ts`、`tests/tripwire-rpc.test.ts`、`tests/e2e/tripwire.e2e.ts`、`tests/helpers/market.ts`、`tests/e2e/market-offline-preload.mjs`。Edit 其他引用 us-market 的测试。
- [ ] Edit `GLOSSARY.md`、`docs/adr/0005`、`0009`、`0013`、`0017`（加一行「us-market 已在 R7 退役」，不改原文）、`docs/modules/` 里提到 us-market 的说明。

**Build.**

- [ ] 先搬再删。`us-market-hours` 这个 `when` 的名字不改，它说的是美股交易时段，不是模块。
- [ ] 删的东西不留开关、不留兼容层。数据库表结构不动（`helper_role` 的 CHECK 里留着 `market`），以前的行照旧能读。
- [ ] R5 的 `expected.json` 留着，`tests/stock-ta-quotes.test.ts` 用它回放 stock-ta 这一边，代替被删的一致性回放。
- [ ] `rg -n "us-market" src tests` 只剩 `us-market-hours` 和 `config.json` 的退役报错。
- [ ] 旧 Mac 之后跟上 main 时照 R6 的步骤拉代码、重启，同样等你说「部署」。R7 不改 stock-ta 包，不用重装包，也不用再迁移。

**You see.**

- [ ] `just test` 全绿，测试数比 R6 少，少的都是被删的 us-market 测试，PR 正文列出数目。
- [ ] 宿主、网页、Telegram 的行为和 R6 一样。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta-quotes.test.ts` 用 `expected.json` 回放，事件相同。`tests/market-hours.test.ts` 接过 `session.ts` 的测试。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/r7-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都回放 R5 的剧本，stock-ta 加迁来的条件。Save `r7-regression.txt`. Pass when 两边事件相同，也和 `expected.json` 相同。
- [ ] Lane 2. 周末和交易日的 `when: us-market-hours`。Save `r7-hours.txt`. Pass when 周末不调用，交易日开盘到收盘后 20 分钟调用，和 trunk 一样。
- [ ] Lane 3. `rg -n "us-market" src tests`。Save `r7-grep.txt`. Pass when 只剩 `us-market-hours` 和退役报错。
- [ ] Lane 4. 用 R6 之后的状态目录（带以前 us-market 的任务、触发、提醒行）启动 head。Save `r7-history.png`. Pass when 宿主启动，以前的任务在网页上点得开。
- [ ] Lane 5. 对话里说「给 NVDA 设个盯盘条件」。Save `r7-no-tripwire.txt`. Pass when 领队用 stock-ta 的 `watch` 设条件，工具列表里没有 `tripwire`。
- [ ] Lane 6. `config.json` 里有 `sources.us-market`。Save `r7-config.txt`. Pass when 拒绝启动，报错和 R5 一样。
- [ ] Lane 7. Telegram 前缀。Save `r7-telegram.txt`. Pass when stock-ta 的提醒前缀不变，宿主里找不到 `盯盘提醒：`。
- [ ] Lane 8. `just --list`。Save `r7-just.txt`. Pass when 没有 `market-smoke` 和 `demo-market`，有 `migrate-us-market`（留到 Appendix E 第 5 条定下来）。
- [ ] Lane 9. 真模型问一个盘面问题。Save `r7-desk.txt`. Pass when 盘面照旧用 `quote` 和 `intraday`，汇报和 R5 时一样有三段。
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

2026-11-13 写计划时只读查看，没有改任何东西。标「实测」的是在旧 Mac 上用 `ssh -o BatchMode=yes` 跑只读命令看到的（数据库都用 `sqlite3 -readonly`），标「读代码」的是在 main（1f88fc4）上读出来的。

**旧 Mac 现在的样子（实测）。** 跑的是 7129edd（S3），比 main 落后 S4 以后的提交。`config.json` 没有 `modules` 键，有 `sources.us-market.everySeconds: 300`。模块开关是 us-market 开、stock-ta 开、module-builder 开、pi-pi 开、toy-market 关。密钥文件里有 `POLYGON_API_KEY` 和 `FINNHUB_API_KEY`（只看了键名）。

**你的盯盘条件（实测，只看形状和条数）。** `state.db` 的 `source_user_data` 里只有 `us-market` 一行，`{version, tripwires}`，一共 1 条盯盘条件，种类是 day（字段 `kind`、`pct`、`dir`）。没有 cost，没有 cross。所以 R4 对你现在的数据只做一件事：一条 day 变成一条 `day-move`。

**两边的自选股（实测）。** us-market 用的是 `module.json` 里的默认 9 只（`config.json` 没有覆盖）。stock-ta 的 `watchlist` 有 9 行，都没划掉，和 us-market 的 9 只完全相同，SPY、QQQ 也在里面。所以 R4 不用追加自选股。

**提醒的历史（实测，只看条数）。** `triggers` 里 us-market 来源 17 条（开任务 3、转交 3、幕僚长忽略 11）。`host_lines` 里 us-market 来源有提醒 1 条、回执 3 条。`tickets` 里 us-market 领域 17 张。stock-ta 的 `_conditions` 是 0 行，`quotes` 是 0 行（S4 装好时已收盘，报价 feed 还没在盘中跑过）。

**现在已经有一处两套提醒一起响（读代码，推断）。** us-market 的 big-move 规则在个股到 5% 档时开任务；stock-ta 的报价 feed 在同一只自选股涨跌 5% 时也发触发，`rules.md` 也让幕僚长开任务。旧 Mac 上两个模块都开着，自选股又相同，所以从今天（2026-11-13）开盘起，一只自选股涨跌 5% 会开两张任务。这是 S4 装好以后就有的，不是本计划引入的；R6 部署以后消失。之前要不要先关掉一边，见 Appendix E 第 1 条。G5 的 lane 10a 也记过一次两模块都开时问题被派给美股看盘队。

**模块的触发文字能由代码拼（读代码）。** `src/modules/feed-runner.ts` 用 `fill(template, n.fields)` 填模板，所以模板写 `{{line}}`、handler 交回 `line`，分档和放量两种句子都能用一个 feed 发。feed 交回的 `cursor` 在行和触发存好以后才保存，R5 的「只升不降」放在 cursor 里可行。

**删掉 us-market 后 `config.json` 会让宿主起不来（读代码）。** `src/host/wiring.ts` 的 `feedSpecs` 遇到没人声明的 `sources.<名字>` 抛 `ConfigError`。所以 R6 先删这一项再换代码，R5 把报错说明写清楚。

**静默时段（读代码）。** 仓库里没有静默时段。us-market 和 stock-ta 都只在交易时段（开盘到收盘后 20 分钟，跳过周末）取行情，Telegram 不静音。所以「保留静默时段」没有东西可保留，见 Appendix E 第 4 条。

**还没证明的。** 迁过来的 cost 条件的提醒行不含成本价，只读代码判断过 `alertText` 只印行里的值和 `happened`，R4 的 lane 6 实测。节假日判断换成「报价日期不是今天就不算」以后和旧的「开盘 30 分钟后连续 5 轮没有新鲜报价」是不是同样不误报，R5 的 lane 6 实测。真实交易日上的一致性只有 R6 的 lane 10 能证明。

## Appendix B. Alternatives rejected

- **让 G3 条件读 `changePct` 当 `value`。** 报价的 `watch.value` 是价格，你在对话里设的「NVDA 到 170」要靠它。改成涨跌幅会让价格条件失效，所以 R1 加 `watch.change` 这一列，不换 `value`。
- **用 G3 条件表达分档和放量。** 分档是模块自带的默认规则，不是你设的条件；放量要和昨天的分钟均量比，G3 没有第二个字段。放在报价 feed 里和 G5 的 5% 规则同一个地方，最简单。
- **先在 stock-ta 加上分档，再另开一个 PR 关 us-market。** 中间那次合并部署出去，两套分档会一起响。所以 R5 一次做完。
- **宿主读到 `sources.us-market` 时跳过并警告。** 这是只为旧 Mac 一台机器留的兼容代码。R6 先删配置再换代码，就不需要它。
- **宿主启动时自动迁移盯盘条件。** 写你的数据的事不该在启动时悄悄发生。命令默认只打印，`--apply` 才写，重跑只补差，`--undo` 能撤。
- **cross 盯盘条件搬成 G3 的 `crosses-average`。** G3 的是按报价行（每分钟）算的均线，旧的是按日线收盘、盘中先报疑似、收盘后确认或撤回，不是一回事。你现在没有 cross 条件，stock-ta 的 `ta scan` 有均线交叉的规则，见 Appendix E 第 6 条。
- **保留新闻研究员和财报解读。** 你定的范围是只管客观交易数据。财报只留日期，给风险计划提示跳空。
- **一致性回放允许的不同。** 文字（盯盘条件的提醒改成 G3 的格式）、Telegram 前缀（`盯盘提醒：` 变成 `提醒 · 股票技术分析：`）、thread id（`thr_us-market:<代码>:<日期>` 变成 stock-ta 的 `<代码>:<日期>`）、cross 不搬。除此之外事件必须相同。

## Appendix C. Risks

- **切换时漏提醒或重复提醒（R5、R6）。** 部署只在收盘后或周末做；R6 先删配置、再换代码、再迁移，每一步都能回退；us-market 的盯盘条件原样留着，回退后照旧生效。
- **旧 Mac 现在就有两张 5% 任务（已存在）。** 见 Appendix A，R6 之后消失。
- **提前收盘日表有两份（R5 到 R7）。** 模块不能 import 宿主的代码，`market-days.ts` 是 `session.ts` 的副本。R7 搬到 `src/modules/market-hours.ts` 后还是两份，每年更新表时两处都改，`tests/stock-ta-quotes.test.ts` 比对两份相同。
- **一个密钥两路请求（R2、R5）。** 盘面的两个工具是按需请求，报价 feed 每 60 秒一次。Starter 套餐没有次数上限，R5 的 perf 要求总请求数不多于现在。
- **成本价外泄（R4）。** 你现在没有 cost 条件，但命令要对将来设的生效。lane 6 把关。
- **测试改动大（R5、R7）。** 20 多个测试文件引用 us-market。改测试只改断言，不跳过、不删能保护现在行为的测试，PR 正文逐个列出。
- **没有 control skill。** 网页 lane 用仓库自己的 Playwright，命令行 lane 用脚本，Telegram 用假 Telegram，只有 R6 的 lane 7 要你看手机。

## Appendix D. Links and reading list

- `modules/us-market/module.json`、`rules.md`、`agents/market-analyst.md`、`skills/us-market-desk/SKILL.md`。
- `src/sources/market/detect.ts`（分档、放量、新鲜度）、`session.ts`（交易时段、提前收盘）、`tripwires.ts`（三种盯盘条件、去重、文字）、`source.ts`（节假日、收盘结算、面板）、`client.ts`（快照和分钟聚合）、`finnhub.ts`（财报日历）。
- `docs/modules/examples/stock-ta/feeds/quotes/`、`data/quotes/collection.json`、`rules.md`、`agents/`、`tools/`、`watchlist.ts`。
- `src/modules/conditions.ts`、`instance-data.ts`、`protocol.ts`、`feed-runner.ts`，`src/host/host.ts` 的 `#postModuleAlert`，`src/host/wiring.ts` 的 `feedSpecs`。
- `docs/modules/module-data-feeds-plan.md` Appendix B 第 396 行、Appendix C 第 403 行（「转换 us-market 时再合并」）。`docs/modules/stock-ta-self-contained-plan.md`（S4 的旧 Mac 步骤）。
- `docs/adr/0017-a-source-can-speak-to-the-user-directly.md`。
- R1、R4、R5 的 owner 在实现前写两种接缝草图再选（`pstack/skills/architect/SKILL.md`，缩小版）：R1 是 `watch.change` 还是条件里写字段名，R4 是走宿主 socket 还是停宿主直接写库，R5 是 cursor 还是查已存的触发来判断「只升不降」。R5 合并前跑一次 `pstack/skills/interrogate/SKILL.md`，题目是「切换后有没有哪一种提醒少了或多了」。
- 决策记录在 `.audit/retire-us-market.tsv`，按 `pstack/skills/show-me-your-work/SKILL.md`，不提交。

## Appendix E. Decisions for the operator

每条都有默认做法。不回答就按默认走，回答了就按你说的改计划。

1. **现在两个模块都会为同一只股票的 5% 开任务，部署前要不要先关一边。** 默认不动，等 R6。要立刻消除，就在旧 Mac 上 `just module off us-market`（会同时停掉你的盯盘条件提醒）或去掉 stock-ta 的 5% 规则（要改包）。这一步是写操作，要你自己做或明确让我做。
2. **3% 档（指数 1.5% 档）留不留。** 默认留，和现在一样只当背景，不开任务。去掉的话只留 5/8 和 2/3。
3. **放量留不留。** 默认留，5 倍、每只每天一次、开收盘 10 分钟不算，只当背景。
4. **静默时段。** 现在没有，默认也不加。提醒只在交易时段响，Telegram 不静音。要加的话说时段，另开一个 PR。
5. **us-market 以前的任务、触发、提醒行、盯盘条件原始数据怎么办。** 默认全部留在 `state.db` 里只读，网页照旧能看，什么都不删；`just migrate-us-market` 保留到你说可以删。要清掉的话另开一个 PR 做一次性删除，先备份。
6. **cost 和 cross 两种盯盘条件以后还要不要。** 你现在一条都没有。默认 cost 搬成带成本价的 `change-pct`（提醒里不出现成本价），cross 不搬：均线交叉交给 stock-ta 的扫描规则，迁移遇到 cross 会停下来。要保留疑似、确认、撤回那一套的话，再加一个 PR 给 stock-ta 加一个按日线算的交叉条件。
7. **财报日离多近算跳空风险。** 默认在计划持有期内，或 10 个交易日内。
8. **盯盘条件提醒的文字。** 默认改成 G3 的格式，前缀 `提醒 · 股票技术分析：`，内容保留「相对昨收涨了 x%，到了你设的 y% 提醒线」。要保留旧前缀 `盯盘提醒：` 的话，R5 加一个模块级的前缀设置。
9. **报价多久取一次。** 旧 Mac 上 us-market 是 300 秒，stock-ta 是 60 秒。默认 60 秒（放量按一分钟算，300 秒会漏）。
10. **档位任务派给谁。** 默认先派盘面，再派结构形态和趋势动量；信号分诊、市场情绪、风险计划不自动派，你追问时再派。
