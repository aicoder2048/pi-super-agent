# Module data and feeds plan

给模块框架补上设计第 7 节第 4、5 步里推迟的三件事：实例数据、通用提醒条件、连接器和 feed 调度器。
做完以后，任何新布局模块都能存自己的数据，能在数据上设提醒条件，能由 feed 定时拉取外面的数据。
验证实例是 stock-ta 拿到自己的行情：交易时段每 60 秒从 Massive 取一次自选股报价（Starter 套餐，延迟 15 分钟），存进自己的数据，你在报价上设的条件满足时直接提醒你。
程序守的规则仍是 design.md 第 2 节那张表。设、改、删提醒条件只认你本人发起的任务。us-market 不动，仍走旧加载器。
PR 顺序是 G1、G2、G3、G4、G5，依次叠在上一个之上。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并 PR。G1 到 G5 都停在 merge-ready，使用者说可以合并时，按 Shipping 从下往上合并。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [x] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. 使用者 2026-11-12 说「开始写计划」。计划写完直接开始 G1：开分支和 PR 都可以撤回，不合并，使用者随时可以叫停或改计划。
- [ ] Read these from trunk at program start. Re-read them at every tick. 本机 pstack 不在本仓库里，用插件缓存 `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/` 代替 `git show origin/main:`。
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/architect/SKILL.md`
  - [ ] Control skill `control-ui` 和 `control-cli` 未安装。命令行 lane 用脚本跑 `just` 命令并存输出，宿主 lane 用 `tests/e2e/harness.ts`，见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 本次由一个会话串行推进每个 PR，每个 PR 收尾时在决策记录里记一行代替 tick；语音播报另有每 15 分钟一次的定时任务。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owner 用 `pstack:poteto-agent`，读 `.audit/module-framework/owner-brief.md`。
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] G1 is first. It branches from `main` as `psa/mod-g1-data`.
  - [ ] G2 on G1 (`psa/mod-g2-data-tool`). G3 on G2 (`psa/mod-g3-watch`). G4 on G3 (`psa/mod-g4-feeds`). G5 on G4 (`psa/mod-g5-stock-quotes`).
- [ ] Hold the file boundaries. G1 到 G4 只碰 `src/`、`tests/`、`justfile`、`docs/modules/`、`docs/adr/`。G5 只碰 `docs/modules/examples/stock-ta/`、`docs/modules/stock-ta.md`、`tests/`、`docs/modules/evidence/`。没有 PR 碰 us-market 的旧代码路径（`src/sources/market/` 只读复用）、`extensions/`、`.pi/` 和使用者未提交的文件。
- [ ] Hold the review gate. 本计划没有改界面的 PR。模块页显示数据和提醒条件放到以后，在 F2c 合并之后另做。

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 以 `just test` 全绿和 `node docs/modules/architecture/check.mjs` 全绿为准。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `deslop` 用内置 `simplify` 代替，`no-comments` 用 `pstack:comment-sicko` 代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`. 仓库没有 Bugbot，记一行 skip。
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. 叠放的 PR rebase 到父分支。
- [ ] 推送前查私人信息。diff 里不能出现家目录绝对路径、邮箱和技术分析项目的绝对路径。所有手动命令都设临时的 `PSA_STATE_DIR`。

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict. 和上一个计划一样：一个验证者跑 gates、十条 lane 和 perf，审查者读 diff，一个看正确性，一个看是否符合 design.md。
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 不合并，停在 merge-ready。使用者说合并时按 Shipping 从下往上 squash 合并，每个先比 patch-id 再跑测试。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本次在本机跑，每条 lane 用自己的临时状态目录。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 命令行 lane 设 `PSA_STATE_DIR=$(mktemp -d)` 后跑 `just ...`。宿主 lane 用 `tests/e2e/harness.ts` 的 `startHost`，假模型用 `tests/e2e/fake-model.ts`，真模型只用 `openai-codex/*`。行情 lane 用 `tests/helpers/market.ts` 的假 HTTP；G5 的真行情 lane 用宿主密钥文件里的 `MASSIVE_API_KEY`，只读报价，不写任何外部东西。
- [ ] 输入只走 `just` 命令、宿主 socket、收件箱目录和网页。只读诊断是 `just modules`、`sqlite3 -readonly`、宿主日志。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. 命令行 lane 存 `<slug>.txt`。

## Store each module's instance data and migrate it safely (G1)

**Depends on.** None.

**Files.**

- [x] Create `src/modules/instance-data.ts`（`InstanceData` 的实现；`InstanceHandle` 并进 `InstanceData`，见 PR 的 Tradeoffs）。
- [x] Edit `src/host/live-modules.ts`，`migrate` 和 `purge-data` 两个效果不再是空操作。
- [x] Edit `src/cli/module.ts`，加 `just module purge <名字>`。
- [x] Edit `src/modules/registry.ts`，接口和实现对齐。
- [x] Create `tests/instance-data.test.ts`。

**Build.**

- [x] 每个模块一个 `<stateDir>/modules-data/<名字>/data.db`。`collection.json` 里每类数据一张表，`record` 一行一条，`series` 带 `key`、`at` 和数值。每行带 `from`（来源原件或 feed），原件放 `blobs/`。
- [x] 结构只增不减。加字段自动加列；`was` 改名把值搬到新名字并留别名；拿掉的字段不显示，值留着；改类型或单位拒绝，模块停在无效，旧版本继续服务。存下来的结构记在 `data.db` 里，和包里的声明比。
- [x] 迁移前先复制一份 `data.db` 当快照，失败就用快照恢复。迁移带只增的编号，迟到的旧结果被忽略。
- [x] `just module purge <名字>` 要再输入一次模块名才删这个模块的全部实例数据。不交互时写 `--confirm <名字>`。模块开着时拒绝，先 `just module off`。

**You see.**

- [x] 把 personal-health 样例放进状态目录并打开，`modules-data/personal-health/data.db` 里出现五张表。
- [x] 给一类数据加一个字段存盘，两秒内表多一列，旧行这一列为空；改一个字段的单位，`just modules` 显示无效和原因，数据没变。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/instance-data.test.ts` 覆盖建表、加字段、改名别名、拿掉后再加回来值还在、改单位拒绝、迁移中途失败恢复快照、迟到结果被忽略、purge 要确认。用 `docs/modules/architecture/sample/update/` 的五个版本。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g1-live.ts`。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都打开 personal-tax 并调一次 `tax-bracket`。Save `g1-regression.txt`. Pass when 两边结果相同，head 多出 `data.db`。
- [x] Lane 2. 打开 personal-health。Save `g1-tables.txt`. Pass when `data.db` 有五张表，列和 `collection.json` 一致。
- [x] Lane 3. 存一个加字段的版本。Save `g1-add.txt`. Pass when 两秒内换上，多一列。
- [x] Lane 4. 存一个改名的版本（`was`）。Save `g1-rename.txt`. Pass when 旧值出现在新名字下。
- [x] Lane 5. 存一个拿掉字段的版本再加回来。Save `g1-remove.txt`. Pass when 值还在。
- [x] Lane 6. 存一个改单位的版本。Save `g1-unit.txt`. Pass when 无效带原因，旧版本服务，数据不变。
- [x] Lane 7. 迁移中途杀掉宿主再起。Save `g1-crash.txt`. Pass when 数据等于快照或新结构，不会半截。
- [x] Lane 8. 拿掉模块包再放回来。Save `g1-away.txt`. Pass when 数据原样接上。
- [x] Lane 9. `just module purge personal-health` 输错名字。Save `g1-purge-wrong.txt`. Pass when 拒绝，数据还在。
- [x] Lane 10. 输对名字。Save `g1-purge.txt`. Pass when `modules-data/personal-health` 不在了，模块包不受影响。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 宿主启动到就绪的时间，以及一次加字段迁移的时间（含快照），数据表里有 10 万行。trunk 没有迁移，迁移另给绝对预算。
- [x] Probe. trunk 和 head 交替各 5 次 `startHost`；迁移在 head 上量 5 次。
- [x] Baseline. Record the trunk 启动中位数 first.
- [x] Rule. 启动比 trunk 慢 200 毫秒以上，或 10 万行的迁移超过 2 秒，就失败。

**Review gate.** None. G1 is not review-gated.

2026-11-12 在 c69e412 上通过：`tests/instance-data.test.ts` 12 条，`just test` 1487 条全过，`check.mjs` 全绿；十条 lane 全 PASS，输出在 `/tmp/swarm-g1/owner/g1-*.txt`；perf 启动 trunk 中位 407 ms、head 408 ms，10 万行加字段迁移中位 6 ms（6.3 MB）。lane 7 用 200 万行，三次里两次在迁移中途 SIGKILL，重启后都是新结构、行数不变、快照不留。

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Let Workers read and write module data (G2)

**Depends on.** G1.

**Files.**

- [ ] Edit `src/modules/gateway.ts`（`find` 认 `data` 请求）、`src/worker/extension.ts`、`src/worker/tools.ts`、`src/host/workers.ts`。
- [ ] Edit `src/kernel/store.ts`（任务记「读过私密数据」）、`src/host/telegram/*`（私密任务的汇报只发一行）。
- [ ] Create `tests/data-tool.test.ts`。

**Build.**

- [ ] `data` 工具：`list`、`query`（条件、时间范围、条数）、`write`（`record` 按主键写，`series` 追加，带 `from`）。按那张表，读谁都可以，写不给推断任务。专家只够得到 `uses` 里列的 `data/<名字>`。
- [ ] 每次调用在 `data.db` 的访问记录表里记一笔：谁、哪类数据、读还是写、几行。
- [ ] 任务读过或写过 `private` 数据，就在任务上记一笔。这个任务的汇报和卡片在 Telegram 上只发一行「<模块标题> 有新内容，请在网页上查看」，网页和 TUI 照常完整显示。

**You see.**

- [ ] personal-health 任务里 Worker 写一条检验指标再读出来，访问记录里有两笔；Telegram 上只有一行提示，网页上是完整汇报。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/data-tool.test.ts` 覆盖读写、别名读写、推断任务写被拒、`uses` 没列被拒、别的模块的数据查不到、访问记录、私密标记和 Telegram 一行规则。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g2-live.ts`，Worker 的调用由假模型回放，lane 10 用真模型。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都调一次 `knowledge`。Save `g2-regression.txt`. Pass when 结果相同。
- [ ] Lane 2. 写一条 `series` 再查。Save `g2-write-read.txt`. Pass when 读回同一行，带 `from`。
- [ ] Lane 3. 按改名前的旧字段名写。Save `g2-alias.txt`. Pass when 落到新名字下。
- [ ] Lane 4. 推断任务写。Save `g2-infer.txt`. Pass when 拒绝。
- [ ] Lane 5. 专家 `uses` 没列这类数据。Save `g2-uses.txt`. Pass when 拒绝。
- [ ] Lane 6. 别的模块的任务读。Save `g2-other.txt`. Pass when 查不到。
- [ ] Lane 7. 访问记录。Save `g2-log.txt`. Pass when 每次调用一笔。
- [ ] Lane 8. 读过私密数据的任务汇报。Save `g2-private.txt`. Pass when Telegram 记录器只有一行提示，网页看板是完整汇报。
- [ ] Lane 9. 只读过 `shareable` 数据的任务。Save `g2-shareable.txt`. Pass when Telegram 是完整汇报。
- [ ] Lane 10. 真模型 `openai-codex/*` 让 Worker 记下一条体检指标。Save `g2-real.txt`. Pass when 数据库里有这一行。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一次 `data` 查询（10 万行里按 key 和时间范围取 100 行）的宿主侧时间。trunk 没有这个工具，只给绝对预算。
- [ ] Probe. 20 次查询，20 次写入。
- [ ] Baseline. Record the trunk `knowledge` 查询中位数 first，作对照。
- [ ] Rule. 查询或写入中位数超过 50 毫秒就失败。

**Review gate.** None. G2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Alert on any module's data (G3)

**Depends on.** G2.

**Files.**

- [ ] Create `src/modules/watch.ts`（条件模型、纯函数计算、提醒文字）。注意已有 `src/modules/watch.ts` 是文件监视器，新文件取别的名字，例如 `src/modules/conditions.ts`。
- [ ] Edit `src/modules/gateway.ts`（`find` 认 `watch` 请求）、`src/worker/extension.ts`、`src/worker/tools.ts`、`src/modules/instance-data.ts`（写入后计算条件）。
- [ ] Create `tests/conditions.test.ts`。

**Build.**

- [ ] 条件存在模块的 `data.db` 里：`id`、`key`、种类、参数、`setAt`、可选的 `basis`、说明。种类是 `above`、`below`、`rising-streak`、`falling-streak`、`change-pct`、`crosses-average`。
- [ ] `watch` 工具：`list` 谁都能用；`set`、`remove` 只给只听过你本人的 request 任务（那张表的「替你做主」一行）。设完回一行程序拼出的回执。
- [ ] 有新行写进写了 `watch` 的 `series` 时，宿主对这个 key 的条件算一遍。满足就经宿主行（ADR-0017）直接提醒你，不经过幕僚长。提醒文字由程序拼出，带数值、时间和这一行的来源。同一条件同一行只提醒一次（宿主行按条件编号加这一行的时间去重）。
- [ ] `private` 数据上的提醒在 Telegram 上只发一行提示。
- [ ] 不改 us-market 的盯盘条件，它的纯函数只读复用（例如均线计算）。

**You see.**

- [ ] 在 personal-health 里对你说「空腹血糖高于 7 提醒我」，写进一条 7.4 的读数后，网页和 Telegram 记录器各出现一条提醒；Telegram 上是一行提示，因为这类数据是私密的。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/conditions.test.ts` 覆盖六种条件的触发和不触发边界、同一行只提醒一次、推断任务和读过 feed 的任务设条件被拒、`list` 都能用、私密数据的一行规则、提醒文字里的数值和时间来自这一行。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g3-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都给 us-market 设一个盯盘条件并用假行情触发。Save `g3-regression.txt`. Pass when 两边提醒相同。
- [ ] Lane 2. `above` 触发。Save `g3-above.txt`. Pass when 网页出现提醒，带数值和时间。
- [ ] Lane 3. `below` 不触发的边界值。Save `g3-below.txt`. Pass when 没有提醒。
- [ ] Lane 4. `rising-streak` 三连涨。Save `g3-streak.txt`. Pass when 第三行写入时提醒一次。
- [ ] Lane 5. `change-pct` 带 `basis`。Save `g3-change.txt`. Pass when 按 basis 算的涨跌幅提醒。
- [ ] Lane 6. `crosses-average`。Save `g3-cross.txt`. Pass when 穿过均线那一行提醒。
- [ ] Lane 7. 同一行写两次。Save `g3-dedupe.txt`. Pass when 只提醒一次。
- [ ] Lane 8. 推断任务设条件。Save `g3-infer.txt`. Pass when 拒绝，条件表不变。
- [ ] Lane 9. 私密数据上的提醒。Save `g3-private.txt`. Pass when Telegram 记录器只有一行提示。
- [ ] Lane 10. 真模型 `openai-codex/*`，你说「空腹血糖高于 7 提醒我」。Save `g3-real.txt`. Pass when 条件表里有这一条，回执一行。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 写一行并算完这个 key 上 20 个条件的时间。trunk 没有这个功能，只给绝对预算。
- [ ] Probe. 100 次写入。
- [ ] Baseline. Record the G2 写入中位数 first.
- [ ] Rule. 比 G2 的写入多出 20 毫秒以上就失败。

**Review gate.** None. G3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Run module feeds on a schedule (G4)

**Depends on.** G3.

**Files.**

- [ ] Create `src/modules/scheduler.ts`（调度器）、`src/modules/connectors/timer.ts`、`src/modules/connectors/inbox.ts`、`src/modules/feed-runner.ts`（每次调用一个进程跑 handler，复用 `run-code.ts`）。
- [ ] Edit `src/host/live-modules.ts`（调度器跟着模块表启停）、`src/host/host.ts`、`src/host/wiring.ts`、`src/modules/validate.ts`（检查时用 fixtures 跑 handler）、`src/modules/rehearse.ts`（预演时连接器换成读 fixtures）。
- [ ] Create `tests/scheduler.test.ts`、`tests/feed-runner.test.ts`。

**Build.**

- [ ] 调度器跟着 `LiveRegistry`：模块打开，它的 feed 排上；关掉或拿掉，立刻停。来源名是 `<模块>/<feed>`。
- [ ] 两个连接器。`timer` 按 `every` 到点调用；`inbox` 读 `<stateDir>/inbox/<模块>/<feed>/` 下新放进来的 JSON 文件，处理完挪走。
- [ ] `feed.json` 加一个可选的 `"when": "us-market-hours"`，由调度器判断，复用 `src/sources/market/session.ts` 的交易时段规则（开盘到收盘加 20 分钟，给延迟数据留时间）。不在时段内不调用。
- [ ] handler 是「输入到输出」的函数：输入连接器给的内容、你填的设置、上次的进度；输出要存的行、要发的触发、新的进度。存行（进 `into`，触发 G3 的条件计算）、发触发（经内核 `submitTrigger`，按 `id` 去重，`ignore` 过滤）、存进度（存在模块的 `data.db`）都由宿主做。
- [ ] `just module check` 用 `feeds/<feed>/fixtures/` 跑一遍 handler，fixtures 替换网络请求；`just module try` 里连接器换成读 fixtures。
- [ ] 不建限速队列。us-market 的旧 feed 不动。

**You see.**

- [ ] 一个只有 `timer` 和一句 `notice` 的模块打开后，到点幕僚长收到触发并开任务；关掉模块后不再触发。
- [ ] 往收件箱目录丢一个 JSON 文件，几秒内进了对应的数据，文件被挪走。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/scheduler.test.ts` 覆盖跟着开关启停、交易时段判断（假时钟，盘前、盘中、收盘后 20 分钟内、周末）、同一批内容跑两次不重复、`ignore`、进度在崩溃后接上、handler 超时只算这一次失败。`tests/feed-runner.test.ts` 覆盖 fixtures 替换网络请求。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g4-live.ts`，时钟和网络都用假的。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都跑 us-market 的旧 feed 一轮（假行情）。Save `g4-regression.txt`. Pass when 两边触发相同。
- [ ] Lane 2. `timer` 加 `notice`。Save `g4-timer.txt`. Pass when 到点出现触发和任务。
- [ ] Lane 3. 关掉模块。Save `g4-off.txt`. Pass when 下一个点不再调用。
- [ ] Lane 4. `when: us-market-hours` 在周末。Save `g4-weekend.txt`. Pass when 不调用。
- [ ] Lane 5. handler 存行进 `into`。Save `g4-into.txt`. Pass when 数据里有这些行，带 `from` 是 `<模块>/<feed>`。
- [ ] Lane 6. 存的行满足一个条件。Save `g4-alert.txt`. Pass when 出现提醒。
- [ ] Lane 7. 同一批内容跑两次。Save `g4-dedupe.txt`. Pass when 行和触发都不重复。
- [ ] Lane 8. `inbox` 丢文件。Save `g4-inbox.txt`. Pass when 进数据，文件挪走。
- [ ] Lane 9. handler 抛错或超时。Save `g4-fail.txt`. Pass when 这一次失败有日志，下一个点照常调用，宿主不受影响。
- [ ] Lane 10. `just module check` 带 fixtures 的包。Save `g4-check.txt`. Pass when 跑过 handler，输出 ok。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 宿主启动到就绪的时间（状态目录里有 5 个各带 2 个 feed 的模块），以及一次 handler 调用的宿主侧总时间。
- [ ] Probe. trunk 和 head 交替各 5 次 `startHost`；handler 调用 20 次。
- [ ] Baseline. Record the trunk 启动中位数 first.
- [ ] Rule. 启动比 trunk 慢 200 毫秒以上，或一次空 handler 调用超过 150 毫秒，就失败。

**Review gate.** None. G4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Give stock-ta its own delayed quotes and alerts (G5)

**Depends on.** G4.

**Files.**

- [ ] Create `docs/modules/examples/stock-ta/data/watchlist/collection.json`、`data/quotes/collection.json`、`feeds/quotes/feed.json`、`feeds/quotes/index.ts`、`feeds/quotes/fixtures/`。
- [ ] Edit `docs/modules/examples/stock-ta/agents/*.md`（`uses` 加 `data/quotes`、`data/watchlist`、`watch/quotes`）、`skills/`、`docs/modules/stock-ta.md`。
- [ ] Create `tests/stock-ta-quotes.test.ts`。

**Build.**

- [ ] `watchlist`（`record`，`shareable`）：自选股和备注。Worker 能增删，改了下一轮 feed 就用新名单，不用重启。
- [ ] `quotes`（`series`，`shareable`，`watch` 指向 `symbol`、`price`、`at`）：每轮每只一行，带价格、涨跌幅、成交量和数据时间。
- [ ] `feeds/quotes`：`timer`，`every` 60 秒，`when: us-market-hours`，`secrets: ["MASSIVE_API_KEY"]`。handler 一次快照请求取回整张自选股（Starter 套餐，延迟 15 分钟），按数据时间去重。
- [ ] 专家能读 `quotes`，你本人能在 `quotes` 上设条件，例如「NVDA 跌破 170 提醒我」。
- [ ] 文档写明数据延迟 15 分钟、怎么设密钥、怎么改自选股。

**You see.**

- [ ] 交易时段打开 stock-ta，一分钟内 `quotes` 里有自选股的报价，数据时间比现在早约 15 分钟；你设的条件满足时，网页和手机上出现提醒。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta-quotes.test.ts` 用 fixtures 覆盖快照解析、同一数据时间不重复存、自选股改了下一轮生效、缺密钥时一行说明、接口出错时这一轮失败。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g5-live.ts`。lane 8 到 10 用真行情和真模型，必须在交易时段跑。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都调 stock-ta 的 `structure` 工具查 NVDA。Save `g5-regression.txt`. Pass when 结果相同。
- [ ] Lane 2. `just module check` stock-ta。Save `g5-check.txt`. Pass when ok，fixtures 跑过 handler。
- [ ] Lane 3. fixtures 驱动一轮 feed。Save `g5-fixture.txt`. Pass when `quotes` 里每只一行。
- [ ] Lane 4. 同一数据时间再来一轮。Save `g5-dedupe.txt`. Pass when 不重复。
- [ ] Lane 5. Worker 往自选股加 AAPL。Save `g5-watchlist.txt`. Pass when 下一轮报价里有 AAPL。
- [ ] Lane 6. 你设「NVDA 低于 fixtures 里的价格加 1」。Save `g5-alert.txt`. Pass when 下一轮出现提醒，带价格和数据时间。
- [ ] Lane 7. 缺密钥。Save `g5-nokey.txt`. Pass when 一行说明，宿主照常。
- [ ] Lane 8. 真行情，交易时段打开 stock-ta 等两轮。Save `g5-real-quotes.txt`. Pass when `quotes` 里有真实报价，数据时间比现在早 15 分钟左右。
- [ ] Lane 9. 真行情上设一个一定会触发的条件。Save `g5-real-alert.txt`. Pass when 网页和 Telegram 记录器出现提醒。
- [ ] Lane 10. 真模型 `openai-codex/*` 问「NVDA 现在多少，离 170 还有多远」。Save `g5-real-ask.txt`. Pass when 专家读了 `quotes`，回答带数据时间并说明延迟 15 分钟。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一轮报价 feed 的总时间（起进程、一次快照请求、存行、算条件）。
- [ ] Probe. 交易时段真行情 10 轮，记每轮时间；同时记 Massive 接口本身的耗时。
- [ ] Baseline. Record the 接口耗时中位数 first.
- [ ] Rule. 一轮总时间比接口耗时多出 300 毫秒以上，或任何一轮超过 10 秒，就失败。

**Review gate.** None. G5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

**us-market 的轮询。** 读代码确认：默认每 60 秒一次快照请求取整张自选股，只在美东 9:30 到 16:20 之间跑，老 Mac 上配置成 300 秒。12 秒是同一个密钥任意两次请求的最小间隔，给免费档用。使用者的套餐是 Starter，延迟 15 分钟，这一批不做限速队列。

**现有可复用的部分。** 宿主行（`host_lines`、`postHostLine`、按 `(source, external_id)` 去重、开机补发）可以原样给通用提醒用。`session.ts` 的交易时段判断可以原样给调度器用。`protocol.ts` 已有 `data`、`watch` 请求和那张表，`gateway.ts` 的 `useOf` 已经认 `data/<名字>`、`watch/<名字>`，`find` 还不认。`registry.ts` 的 `InstanceData`、`Scheduler` 只有接口。

**还没证明的。** 没有休市日表，沿用 us-market「开盘半小时没有当天报价就按休市处理」的做法；G4 的 lane 4 只测周末。

## Appendix B. Alternatives rejected

- **实例数据放进宿主的 `state.db`。** 快照和回滚要按表处理，删一个模块的数据也麻烦。每个模块一个文件更简单。
- **做 `http-poll` 连接器。** 报价请求要带密钥、要解析快照格式，一段 handler 更直接。等第二个纯声明的 HTTP 数据源出现再做。
- **按密钥名排队的限速器。** Starter 套餐不需要。以后换免费档或多个模块抢同一份额度时再加。
- **这一批转换 us-market。** 风险最大，要在休市时做；先让新路径在 stock-ta 上跑稳。
- **`rss` 连接器。** 不是验证必需的，列为以后。

## Appendix C. Risks

- **G1 的迁移。** 改错一次就丢使用者的数据。快照恢复和迟到结果忽略都要有测试，lane 7 杀进程验证。
- **G2 的私密规则。** 汇报、卡片、提醒三条路都要走同一个判断，漏一条就会把私密内容发到 Telegram。
- **G3 和旧盯盘条件并存。** 两套条件同时存在，一段时间内 us-market 用旧的，新模块用新的。转换 us-market 时再合并。
- **G4 的进程数。** 每次 handler 调用一个新进程，60 秒一轮没问题；以后有秒级 feed 时要重新看。
- **G5 依赖交易时段。** 真行情 lane 只能在美东 9:30 到 16:20 跑，错过就等下一个交易日。fixtures 驱动的 lane 不受影响。
- **没有 control skill。** 网页 lane 用仓库自己的 Playwright harness，命令行 lane 用脚本。

## Appendix D. Links and reading list

- `docs/modules/architecture/design.md` 第 2 节（数据 K2、提醒条件、那张表）、第 3 节（feed 和连接器）、第 4 节（改数据结构 H6、崩溃不丢动作）、第 5 节（数据分两级）。
- `docs/adr/0003-authority-comes-only-from-the-user.md`、`docs/adr/0017-a-source-can-speak-to-the-user-directly.md`。
- `src/sources/market/tripwires.ts`、`source.ts`、`session.ts`、`client.ts`，只读参考。
- `docs/modules/architecture/sample/personal-health/`、`sample/update/`。
- G1、G4 的 owner 在实现前各写两种接缝草图再选（`pstack/skills/architect/SKILL.md`，缩小版）。
- 决策记录在 `.audit/module-framework.tsv`，按 `pstack/skills/show-me-your-work/SKILL.md`，不提交。
