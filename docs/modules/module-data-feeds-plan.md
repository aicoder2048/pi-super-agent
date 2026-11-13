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
- [ ] 命令行 lane 设 `PSA_STATE_DIR=$(mktemp -d)` 后跑 `just ...`。宿主 lane 用 `tests/e2e/harness.ts` 的 `startHost`，假模型用 `tests/e2e/fake-model.ts`，真模型只用 `openai-codex/*`。行情 lane 用 `tests/helpers/market.ts` 的假 HTTP；G5 的真行情 lane 用宿主密钥文件里的 `POLYGON_API_KEY`，只读报价，不写任何外部东西。
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

- [x] 每个模块一个 `<stateDir>/modules-data/<名字>/data.db`。`collection.json` 里每类数据一张表，`record` 和 `series` 都是一行一条，列就是 `collection.json` 声明的字段（`series` 的 `key`、`at`、数值也是声明的字段，`watch` 指名用哪几个）。每行带 `from`（来源原件或 feed），原件放 `blobs/`。
- [x] 结构只增不减。加字段自动加列；`was` 改名把值搬到新名字并留别名；拿掉的字段不显示，值留着；改类型或单位拒绝，模块停在无效，旧版本继续服务。`was` 指向包里还在的名字、改名改到一个拿掉过但值还留着的名字、名字和存下的（或同一个包里的）只差大小写，检查都拒绝并写明原因。旧名字又声明成新的时，它的旧别名去掉。存下来的结构记在 `data.db` 里，和包里的声明比。宿主启动时给正在运行、没有待做迁移的模块补上缺的结构。
- [x] 一次迁移的所有结构调整和 `_structure` 的写入在同一个 SQLite 事务里，回滚就靠这个事务，不另拍快照。中途失败时连接带着没提交的事务关掉，改动全部撤回；宿主在事务里崩溃，留下的热日志在下次打开时由 SQLite 回滚，`data.db` 和迁移前一字不差。（最早的版本另拷一份快照、失败时拷回去，拷回去的半路宿主死掉会把唯一完整的一份删掉，所以去掉了。）`data.db` 读不了时检查和迁移给出原因，模块停在无效，宿主照常启动。迁移带只增的编号，迟到的旧结果被忽略。
- [x] `just module purge <名字>` 要再输入一次模块名才删这个模块的全部实例数据。不交互时写 `--confirm <名字>`。模块开着时拒绝，先 `just module off`。输完名字后在同一个写事务里再读一次开关和记录，这时开着也拒绝。

**You see.**

- [x] 把 personal-health 样例放进状态目录并打开，`modules-data/personal-health/data.db` 里出现五张表。
- [x] 给一类数据加一个字段存盘，两秒内表多一列，旧行这一列为空；改一个字段的单位，`just modules` 显示无效和原因，数据没变。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/instance-data.test.ts` 覆盖建表、加字段、改名别名、拿掉后再加回来值还在、改单位拒绝、迁移中途失败全部撤回、迟到结果被忽略、purge 要确认。用 `docs/modules/architecture/sample/update/` 的五个版本。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g1-live.ts`。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都打开 personal-tax 并调一次 `tax-bracket`。Save `g1-regression.txt`. Pass when 两边结果相同，head 多出 `data.db`。
- [x] Lane 2. 打开 personal-health。Save `g1-tables.txt`. Pass when `data.db` 有五张表，列和 `collection.json` 一致。
- [x] Lane 3. 存一个加字段的版本。Save `g1-add.txt`. Pass when 两秒内换上，多一列。
- [x] Lane 4. 存一个改名的版本（`was`）。Save `g1-rename.txt`. Pass when 旧值出现在新名字下。
- [x] Lane 5. 存一个拿掉字段的版本再加回来。Save `g1-remove.txt`. Pass when 值还在。
- [x] Lane 6. 存一个改单位的版本。Save `g1-unit.txt`. Pass when 无效带原因，旧版本服务，数据不变。
- [x] Lane 7. 迁移中途杀掉宿主再起。Save `g1-crash.txt`. Pass when 数据等于迁移前或新结构，不会半截。最早的脚本三次杀进程都落在 COMMIT 之后，没打到事务里面。现在三次都等 `data.db-journal` 出现（事务里面）再杀；单元测试「迁移事务里崩溃」两条另外覆盖（子进程在事务中 SIGKILL 自己，留下热日志，其中一条是停机时包又改成无效版本）。
- [x] Lane 8. 拿掉模块包再放回来。Save `g1-away.txt`. Pass when 数据原样接上。
- [x] Lane 9. `just module purge personal-health` 输错名字。Save `g1-purge-wrong.txt`. Pass when 拒绝，数据还在。
- [x] Lane 10. 输对名字。Save `g1-purge.txt`. Pass when `modules-data/personal-health` 不在了，模块包不受影响。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 宿主启动到就绪的时间，以及一次加字段迁移的时间，数据表里有 10 万行。trunk 没有迁移，迁移另给绝对预算。
- [x] Probe. trunk 和 head 交替各 5 次 `startHost`；迁移在 head 上量 5 次。
- [x] Baseline. Record the trunk 启动中位数 first.
- [x] Rule. 启动比 trunk 慢 200 毫秒以上，或 10 万行的迁移超过 2 秒，就失败。

**Review gate.** None. G1 is not review-gated.

2026-11-12 在 c69e412 上通过：`tests/instance-data.test.ts` 12 条，`just test` 1487 条全过，`check.mjs` 全绿；十条 lane 全 PASS，输出在 `/tmp/swarm-g1/owner/g1-*.txt`；perf 启动 trunk 中位 407 ms、head 408 ms，10 万行加字段迁移中位 6 ms（6.3 MB）。lane 7 用 200 万行，三次里两次在迁移中途 SIGKILL，重启后都是新结构、行数不变、快照不留。

2026-11-12 审计修复轮在 92a3e7e（已 rebase 到 main e8741fc）上通过：审计的八条加 gates 验证的第九条，十一条新单元测试先红后绿（`/tmp/swarm-g1/fix/red.txt`）；`tests/instance-data.test.ts` 22 条，`just test` 1511 条全过，`check.mjs` 全绿；十条 lane 全 PASS，输出在 `/tmp/swarm-g1/fix/g1-*.txt`，lane 7 三次都打中（两次在事务里面），重启后 200 万行都在、新结构、不留快照；perf 启动 trunk 中位 385 ms、head 388 ms，10 万行加字段迁移中位 5 ms。

2026-11-12 去快照修复在本提交上通过：验证者发现宿主在「快照拷回 data.db」的半路死掉，下次打开会删掉唯一完整的快照，data.db 从此读不了。复现测试先红（`database disk image is malformed`，`/tmp/swarm-g1/fix2/red.txt`），去掉快照、只靠 SQLite 事务回滚后转绿；新增「宿主在撤回改动前死掉」一条，失败迁移和事务里崩溃两条改成断言 `data.db` 和迁移前一字不差。`tests/instance-data.test.ts` 22 条，`just test` 1511 条全过，`check.mjs` 全绿；lane 6、7 PASS，lane 7 三次都在事务里杀掉，输出在 `/tmp/swarm-g1/fix2/g1-*.txt`。

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Let Workers read and write module data (G2)

**Depends on.** G1.

**Files.**

- [x] Edit `src/modules/gateway.ts`（`find` 认 `data` 请求）、`src/worker/extension.ts`、`src/worker/tools.ts`、`src/host/workers.ts`。
- [x] Edit `src/kernel/store.ts`（任务记「读过私密数据」）、`src/host/telegram/*`（私密任务的汇报只发一行）。
- [x] Create `tests/data-tool.test.ts`。

**Build.**

- [x] `data` 工具：`list`、`query`（条件、时间范围、条数）、`write`（`record` 按主键写，`series` 追加，带 `from`）。按那张表，读谁都可以，写不给推断任务。专家只够得到 `uses` 里列的 `data/<名字>`。
- [x] 每次调用在 `data.db` 的访问记录表里记一笔：谁、哪类数据、读还是写、几行。
- [x] 任务读过或写过 `private` 数据，就在任务上记一笔。这个任务的汇报和卡片在 Telegram 上只发一行「<模块标题> 有新内容，请在网页上查看」，网页和 TUI 照常完整显示。

**You see.**

- [x] personal-health 任务里 Worker 写一条检验指标再读出来，访问记录里有两笔；Telegram 上只有一行提示，网页上是完整汇报。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/data-tool.test.ts` 覆盖读写、别名读写、推断任务写被拒、`uses` 没列被拒、别的模块的数据查不到、访问记录、私密标记和 Telegram 一行规则。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g2-live.ts`，Worker 的调用由假模型回放，lane 10 用真模型。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都调一次 `knowledge`。Save `g2-regression.txt`. Pass when 结果相同。
- [x] Lane 2. 写一条 `series` 再查。Save `g2-write-read.txt`. Pass when 读回同一行，带 `from`。
- [x] Lane 3. 按改名前的旧字段名写。Save `g2-alias.txt`. Pass when 落到新名字下。
- [x] Lane 4. 推断任务写。Save `g2-infer.txt`. Pass when 拒绝。
- [x] Lane 5. 专家 `uses` 没列这类数据。Save `g2-uses.txt`. Pass when 拒绝。
- [x] Lane 6. 别的模块的任务读。Save `g2-other.txt`. Pass when 查不到。
- [x] Lane 7. 访问记录。Save `g2-log.txt`. Pass when 每次调用一笔。
- [x] Lane 8. 读过私密数据的任务汇报。Save `g2-private.txt`. Pass when Telegram 记录器只有一行提示，网页看板是完整汇报。
- [x] Lane 9. 只读过 `shareable` 数据的任务。Save `g2-shareable.txt`. Pass when Telegram 是完整汇报。
- [x] Lane 10. 真模型 `openai-codex/*` 让 Worker 记下一条体检指标。Save `g2-real.txt`. Pass when 数据库里有这一行。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 一次 `data` 查询（10 万行里按 key 和时间范围取 100 行）的宿主侧时间。trunk 没有这个工具，只给绝对预算。
- [x] Probe. 20 次查询，20 次写入。
- [x] Baseline. Record the trunk `knowledge` 查询中位数 first，作对照。
- [x] Rule. 查询或写入中位数超过 50 毫秒就失败。

**Review gate.** None. G2 is not review-gated.

2026-11-12 在 691e39f 上通过（之后的 9006cf4 只删注释）：`tests/data-tool.test.ts` 18 条，`just test` 1530 条全过，`check.mjs` 全绿；十条 lane 全 PASS，输出在 `/tmp/swarm-g2/owner/g2-*.txt`，lane 10 用 `openai-codex/gpt-6.1-sol` 记下一条空腹血糖，`lab-results` 有这一行，from 是「使用者口述」；perf 10 万行按 item 和日期范围取 100 行，查询中位 3.2 ms（20 次，差 1.4 ms），单行写入中位 0.4 ms，trunk `knowledge` 检索中位 0.1 ms 作对照。lane 3 在 personal-health 里就地把 `lab` 改名为 `laboratory`，因为 health-lite 不在名册上，幕僚长开不了它的任务。

审查后的修正（2026-11-12）：网页上回答私密任务的问题，转到 Telegram 的那句回答也只发一行提示；`record` 按 id 从别的来源改几项，`from` 不变，改过的字段各自的来源记在 `sources`；`write` 没给 rows、op 不认识都拒绝；字段不能叫 `id`；访问记录也记被拒的调用和原因。

已定（2026-11-12）：幕僚长当前的会话里一旦有了私密数据（收到过私密任务或私密 feed 的卡片，或用 read 读过它们），它的每一句回复在 Telegram 上只发一行提示，网页照旧完整。清屏让幕僚长换一个全新的会话，Telegram 恢复完整回复，代价是它不记得清屏前聊过什么。理由见 design.md 第 5 节。

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Alert on any module's data (G3)

**Depends on.** G2.

**Files.**

- [x] Create `src/modules/watch.ts`（条件模型、纯函数计算、提醒文字）。注意已有 `src/modules/watch.ts` 是文件监视器，新文件取别的名字，例如 `src/modules/conditions.ts`。实际是 `src/modules/conditions.ts`。
- [x] Edit `src/modules/gateway.ts`（`find` 认 `watch` 请求）、`src/worker/extension.ts`、`src/worker/tools.ts`、`src/modules/instance-data.ts`（写入后计算条件）。
- [x] Create `tests/conditions.test.ts`。

**Build.**

- [x] 条件存在模块的 `data.db` 里：`id`、`key`、种类、参数、`setAt`、可选的 `basis`、说明。种类是 `above`、`below`、`rising-streak`、`falling-streak`、`change-pct`、`crosses-average`。
- [x] `watch` 工具：`list` 谁都能用；`set`、`remove` 只给只听过你本人的 request 任务（那张表的「替你做主」一行）。设完回一行程序拼出的回执。
- [x] 有新行写进写了 `watch` 的 `series` 时，宿主对这个 key 的条件算一遍。满足就经宿主行（ADR-0017）直接提醒你，不经过幕僚长。提醒文字由程序拼出，带数值、时间和这一行的来源。同一条件同一行只提醒一次（宿主行按条件编号加这一行的编号去重）。只有新数据提醒：写入前先记下这个 key 已存最新的时间，比它早的行是补录，只存不提醒；不早于它的行按时间逐行和前一行比（前一行可能是已存的，也可能是同一次写进来的），同一时间算新。这个 key 之前没有读数时，这次写入当作导入过去的读数，只算其中时间最新的行。
- [x] `private` 数据上的提醒在 Telegram 上只发一行提示。
- [x] 不改 us-market 的盯盘条件，它的纯函数只读复用（例如均线计算）。

**You see.**

- [x] 在 personal-health 里对你说「空腹血糖高于 7 提醒我」，写进一条 7.4 的读数后，网页和 Telegram 记录器各出现一条提醒；Telegram 上是一行提示，因为这类数据是私密的。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/conditions.test.ts` 覆盖六种条件的触发和不触发边界、同一行只提醒一次、推断任务和读过 feed 的任务设条件被拒、`list` 都能用、私密数据的一行规则、提醒文字里的数值和时间来自这一行。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g3-live.ts`。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都给 us-market 设一个盯盘条件并用假行情触发。Save `g3-regression.txt`. Pass when 两边提醒相同。
- [x] Lane 2. `above` 触发。Save `g3-above.txt`. Pass when 网页出现提醒，带数值和时间。
- [x] Lane 3. `below` 不触发的边界值。Save `g3-below.txt`. Pass when 没有提醒。
- [x] Lane 4. `rising-streak` 三连涨。Save `g3-streak.txt`. Pass when 第三行写入时提醒一次。
- [x] Lane 5. `change-pct` 带 `basis`。Save `g3-change.txt`. Pass when 按 basis 算的涨跌幅提醒。
- [x] Lane 6. `crosses-average`。Save `g3-cross.txt`. Pass when 穿过均线那一行提醒。
- [x] Lane 7. 同一行写两次。Save `g3-dedupe.txt`. Pass when 只提醒一次。
- [x] Lane 8. 推断任务设条件。Save `g3-infer.txt`. Pass when 拒绝，条件表不变。
- [x] Lane 9. 私密数据上的提醒。Save `g3-private.txt`. Pass when Telegram 记录器只有一行提示。
- [x] Lane 10. 真模型 `openai-codex/*`，你说「空腹血糖高于 7 提醒我」。Save `g3-real.txt`. Pass when 条件表里有这一条，回执一行。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 写一行并算完这个 key 上 20 个条件的时间。trunk 没有这个功能，只给绝对预算。
- [x] Probe. 100 次写入。
- [x] Baseline. Record the G2 写入中位数 first.
- [x] Rule. 比 G2 的写入多出 20 毫秒以上就失败。

**Review gate.** None. G3 is not review-gated.

2026-11-12 在 0738d5b 上通过：`tests/conditions.test.ts` 17 条，`just test` 1556 条里只有 `tests/watchdog-main.test.ts` 的「终端 Ctrl+C：Watchdog 不停别人启动的宿主」偶发失败（基线 5317b9e 上 10 次里也失败 2 次，和本 PR 无关），`check.mjs` 全绿；十条 lane 全 PASS，输出在 `/tmp/swarm-g3/owner/g3-*.txt`。lane 10 用 `openai-codex/gpt-6.1-sol`：第一次只说「空腹血糖高于 7 提醒我」，Worker 先问单位、没有设（`g3-real-first-try.txt`），补上「单位 mmol/L，直接设」后条件表有这一条，回执一行。perf 10 万行、这个 key 上 20 个条件，100 次写入，三轮中位 0.74 到 0.81 ms，G2 同样写入 1.43 到 2.09 ms（G2 先跑，冷启动偏慢），最大 26 ms 是第一次写入时建索引。

2026-11-12 在 6a2cd64 上通过（修正轮）：一次写进同一个 key 的几行新读数时，以前只算时间最新的那一行，而且拿它和同一批里的前一行比，所以已存 6、一次写进 7.2 和 7.4（条件高于 7）不提醒，写进 8 和 6.5 也不提醒。现在写入前先记下这个 key 已存最新的时间，不早于它的行逐行算，两种情况都在 7.2 和 8 那一行提醒一次；比它早的行照样只存不提醒。`tests/conditions.test.ts` 27 条，`just test` 1573 条全过（第二次跑时只有已知偶发的「终端 Ctrl+C：Watchdog 不停别人启动的宿主」失败，单独重跑 8 条全过），`check.mjs` 全绿；十条 lane 全 PASS，输出在 `/tmp/swarm-g3/fix3/`。perf 10 万行、20 个条件、100 次写入，四轮中位 0.78 到 0.93 ms，G2 同样写入 1.30 到 2.56 ms。修正中途一版对 20 个条件各查了一次 key 的最新时间，中位涨到 1.9 ms 左右，按 key 去重后回到 1 ms 以内。

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Run module feeds on a schedule (G4)

**Depends on.** G3.

**Files.**

- [x] Create `src/modules/scheduler.ts`（调度器）、`src/modules/connectors/timer.ts`、`src/modules/connectors/inbox.ts`、`src/modules/feed-runner.ts`（每次调用一个进程跑 handler，复用 `run-code.ts`）。
- [x] Edit `src/host/live-modules.ts`（调度器跟着模块表启停）、`src/host/host.ts`、`src/host/wiring.ts`、`src/modules/validate.ts`（检查时用 fixtures 跑 handler）、`src/modules/rehearse.ts`（预演时连接器换成读 fixtures）。实际没改 `live-modules.ts` 和 `rehearse.ts`：调度器每一拍从 `live.current().feeds()` 读 feed 表（包的 feed 在 `src/modules.ts` 的 `packageModule` 里带上），开关一变下一拍就跟上；预演由 `src/cli/module-try.ts` 在临时 config.json 里写 `feedFixtures: true`。另改了 `src/kernel/`（触发上记 `private`）、`src/modules/instance-data.ts`（feed 的 id 去重和进度表）、`src/modules/run-code.ts`（`responses` 代替 fetch）。
- [x] Create `tests/scheduler.test.ts`、`tests/feed-runner.test.ts`。

**Build.**

- [x] 调度器跟着 `LiveRegistry`：模块打开，它的 feed 排上；关掉或拿掉，立刻停。来源名是 `<模块>/<feed>`。
- [x] 两个连接器。`timer` 按 `every` 到点调用；`inbox` 读 `<stateDir>/inbox/<模块>/<feed>/` 下新放进来的 JSON 文件，处理完挪走。
- [x] `feed.json` 加一个可选的 `"when": "us-market-hours"`，由调度器判断，复用 `src/sources/market/session.ts` 的交易时段规则（开盘到收盘加 20 分钟，给延迟数据留时间）。不在时段内不调用。
- [x] handler 是「输入到输出」的函数：输入连接器给的内容、feed.json 里写的 `settings`、上次的进度（`ask` 的回答还没有地方存，也不合并进来）；输出要存的行、要发的触发、新的进度。存行（进 `into`，触发 G3 的条件计算）、发触发（经内核 `submitTrigger`，按 `id` 去重，`ignore` 过滤）、存进度（存在模块的 `data.db`）都由宿主做。
- [x] `just module check` 用 `feeds/<feed>/fixtures/` 跑一遍 handler，fixtures 替换网络请求；`just module try` 里连接器换成读 fixtures。
- [x] 不建限速队列。us-market 的旧 feed 不动。

**You see.**

- [x] 一个只有 `timer` 和一句 `notice` 的模块打开后，到点幕僚长收到触发并开任务；关掉模块后不再触发。
- [x] 往收件箱目录丢一个 JSON 文件，几秒内进了对应的数据，文件被挪走。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/scheduler.test.ts` 覆盖跟着开关启停、交易时段判断（假时钟，盘前、盘中、收盘后 20 分钟内、周末）、同一批内容跑两次不重复、`ignore`、进度在崩溃后接上、handler 超时只算这一次失败。`tests/feed-runner.test.ts` 覆盖 fixtures 替换网络请求。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g4-live.ts`，时钟和网络都用假的。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都跑 us-market 的旧 feed 一轮（假行情）。Save `g4-regression.txt`. Pass when 两边触发相同。
- [x] Lane 2. `timer` 加 `notice`。Save `g4-timer.txt`. Pass when 到点出现触发和任务。
- [x] Lane 3. 关掉模块。Save `g4-off.txt`. Pass when 下一个点不再调用。
- [x] Lane 4. `when: us-market-hours` 在周末。Save `g4-weekend.txt`. Pass when 不调用。
- [x] Lane 5. handler 存行进 `into`。Save `g4-into.txt`. Pass when 数据里有这些行，带 `from` 是 `<模块>/<feed>`。
- [x] Lane 6. 存的行满足一个条件。Save `g4-alert.txt`. Pass when 出现提醒。
- [x] Lane 7. 同一批内容跑两次。Save `g4-dedupe.txt`. Pass when 行和触发都不重复。
- [x] Lane 8. `inbox` 丢文件。Save `g4-inbox.txt`. Pass when 进数据，文件挪走。
- [x] Lane 9. handler 抛错或超时。Save `g4-fail.txt`. Pass when 这一次失败有日志，下一个点照常调用，宿主不受影响。
- [x] Lane 10. `just module check` 带 fixtures 的包。Save `g4-check.txt`. Pass when 跑过 handler，输出 ok。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 宿主启动到就绪的时间（状态目录里有 5 个各带 2 个 feed 的模块），以及一次 handler 调用的宿主侧总时间。
- [x] Probe. trunk 和 head 交替各 5 次 `startHost`；handler 调用 20 次。
- [x] Baseline. Record the trunk 启动中位数 first.
- [x] Rule. 启动比 trunk 慢 200 毫秒以上，或一次空 handler 调用超过 150 毫秒，就失败。

**Review gate.** None. G4 is not review-gated.

2026-11-12 在 8a2cb5e 上通过：`tests/scheduler.test.ts` 12 条、`tests/feed-runner.test.ts` 3 条、`tests/wiring.test.ts` 和 `tests/config.test.ts` 各加 1 条；`just test` 1575 条全过，`check.mjs` 7 项 ok。十条 lane 全 PASS，输出在 `/tmp/swarm-g4/owner/g4-*.txt`。lane 6 的条件用「高于 7」：G3 的水平条件只在跨进去的那一行提醒，第一次用「高于 5」时 6.3 已经在线上，7.2 不算跨入，没有提醒，是 lane 写错了。perf 两轮：启动到网址 trunk 中位 397.8 和 448.7 ms，head 415.2 和 440.7 ms，差 +17.4 和 -8.0 ms（第一轮 head 有一次 965 ms，第二轮没再出现）；空 handler 一次调用中位 77.3 和 44.4 ms，几乎全是起 node 进程。fixtures 格式：`feeds/<feed>/fixtures/<样例>.json` 是 `{ "input": FeedInput 的一部分, "responses": { "<完整网址>": 应答 } }`，`input.settings` 和 `input.rows` 逐个键合并在宿主给的上面（`reads` 的每个集合没给就是空列），`responses` 按完整网址代替 `fetch`，没给的网址这一次失败并说出网址。

2026-11-12 审计修复在 d963c72 上通过（已合入 G3 bb4a352）：检查和运行共用一个 `feedInput`，`reads` 的集合样例没给就是空列；inbox 逐个文件处理，坏文件单独进 rejected 并带 .error.txt，handler 失败的文件留到下一次；timer 或不带连接器的 handler 没写 every 时检查拒收；宿主检查、`just module check`、`just module try` 的密钥和运行时一样先看环境变量再看 secretsFile；日志行数只算真存下的。`just test` 1596 条全过，`check.mjs` 7 项 ok，十条 lane 全 PASS（`/tmp/swarm-g4/fix/g4-*.txt`），perf 启动中位 trunk 394.5 ms、head 402.9 ms，空 handler 中位 43.9 ms。

2026-11-12 第二轮审计修复（已合入 main e13a5e8）：宿主跑用例时读密钥出错（密钥值有空白、密钥文件跑着时被删）不再让宿主因未处理的 rejection 退出，模块记为无效，原因写着出错的话；`just module try` 的临时宿主也拿到 secretsFile，之前只有检查读它，密钥只在文件里的工具在临时宿主里用例不过；带 handler 的 inbox 文件连着失败 3 次挪进 rejected，.error.txt 写着最后一次的原因，成功一次就清零，次数记在宿主内存里，重启后重新数。`just test` 1604 条全过，`check.mjs` 全绿，十条 lane 全 PASS（`/tmp/swarm-g4/fix2/g4-*.txt`）。

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Give stock-ta its own delayed quotes and alerts (G5)

**Depends on.** G4.

**Files.**

- [x] Create `docs/modules/examples/stock-ta/data/watchlist/collection.json`、`data/quotes/collection.json`、`feeds/quotes/feed.json`、`feeds/quotes/index.ts`、`feeds/quotes/fixtures/`。
- [x] Edit `docs/modules/examples/stock-ta/agents/*.md`（`uses` 加 `data/quotes`、`data/watchlist`、`watch/quotes`）、`skills/`、`docs/modules/stock-ta.md`。另建 `rules.md`，改 `tests/e2e/modules.e2e.ts` 里模块卡的密钥一行。
- [x] Create `tests/stock-ta-quotes.test.ts`。

**Build.**

- [x] `watchlist`（`record`，`shareable`）：自选股和备注。Worker 能增删，改了下一轮 feed 就用新名单，不用重启。数据工具没有删行，划掉一只是给那一行写上 `removedAt`。
- [x] `quotes`（`series`，`shareable`，`watch` 指向 `symbol`、`price`、`at`）：每轮每只一行，带价格、涨跌幅、成交量和数据时间。
- [x] `feeds/quotes`：`timer`，`every` 60 秒，`when: us-market-hours`，`secrets: ["POLYGON_API_KEY"]`（使用者 2026-11-12 定：他的 REST 密钥就叫这个名字）。handler 一次快照请求取回整张自选股（Starter 套餐，延迟 15 分钟），按数据时间去重。没有密钥时不发请求，这一轮失败并记一行；fixtures 代替网络，排练和 `just module check` 拿到的是替身密钥，不需要真的。同一只股票有好几行时以最新的一行为准。
- [x] 专家能读 `quotes`，你本人能在 `quotes` 上设条件，例如「NVDA 跌破 170 提醒我」。提醒里的时间按美东写（使用者 2026-11-12 定），存的仍是 UTC。
- [x] 文档写明数据延迟 15 分钟、怎么设密钥、怎么改自选股。
- [x] 涨跌 5% 自动分析（使用者 2026-11-12 定）。自选股一只当天相对昨收涨跌达到 5%，handler 发一条 `notice`，id 是 `big-move:<代码>:<美东交易日>:<up|down>`，内核按 id 去重，所以同一只同一天同一方向只一次；线程和 id 相同，所以跌 5% 的任务还开着时，反过来涨 5% 也另开任务，不会落进前一个任务。`rules.md` 的 `big-move` 规则（`来源: stock-ta/quotes`）让幕僚长给技术分析研究组开任务，结构与形态和趋势与动量各看一遍，汇报带数据时间和出处，写明「这是技术分析，不是交易指令」。5% 是 `feeds/quotes/index.ts` 里的常量 `BIG_MOVE_PCT`，使用者以后可以要求改成设置。

**You see.**

- [ ] 交易时段打开 stock-ta，一分钟内 `quotes` 里有自选股的报价，数据时间比现在早约 15 分钟；你设的条件满足时，网页和手机上出现提醒。
- [x] 自选股里一只当天跌到 5%，幕僚长自己给技术分析研究组开一个任务，结构与形态和趋势与动量各看一遍，汇报写数据时间、延迟 15 分钟、出处，并说明不是交易指令；同一天再跌也不再开，反过来涨 5% 另开一个。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/stock-ta-quotes.test.ts` 用 fixtures 覆盖快照解析、同一数据时间不重复存、自选股改了下一轮生效、同一只两行以最新一行为准、缺密钥时不发请求只记一行、没有密钥也能排练样例、接口出错时这一轮失败、提醒时间按美东写，以及涨跌 5% 的触发 id、线程和正文、规则把任务交给技术分析研究组。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/g5-live.ts`，`lanes` 跑 1 到 7 和 11，`real` 跑 10b，`market` 跑 8、9、10a 和 perf。lane 8、9、10a 和 perf 用真行情，在交易时段跑；时段外脚本直接拒绝，加 `--off-hours` 才跑（使用者 2026-11-12 定）。`--off-hours` 只在宿主进程里把 feed 的 `when` 闸门打开两轮，`feed.json` 仍是 `when: us-market-hours`；Massive 时段外回最后一笔成交，lane 8 改查数据时间是不是最近的一笔真实成交，不查延迟 15 分钟。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都调 stock-ta 的 `structure` 工具查 NVDA。Save `g5-regression.txt`. Pass when 结果相同。
- [x] Lane 2. `just module check` stock-ta。Save `g5-check.txt`. Pass when ok，fixtures 跑过 handler。
- [x] Lane 3. fixtures 驱动一轮 feed。Save `g5-fixture.txt`. Pass when `quotes` 里每只一行。
- [x] Lane 4. 同一数据时间再来一轮。Save `g5-dedupe.txt`. Pass when 不重复。
- [x] Lane 5. Worker 往自选股加 AAPL。Save `g5-watchlist.txt`. Pass when 下一轮报价里有 AAPL。
- [x] Lane 6. 你设「NVDA 低于 fixtures 里的价格加 1」。Save `g5-alert.txt`. Pass when 下一轮出现提醒，带价格和按美东写的数据时间。
- [x] Lane 7. 缺密钥。Save `g5-nokey.txt`. Pass when 那一轮不发请求，一行说明，宿主照常。
- [x] Lane 8. 真行情，交易时段打开 stock-ta 等两轮。Save `g5-real-quotes.txt`. Pass when `quotes` 里有真实报价，数据时间比现在早 15 分钟左右。off-hours，2026-11-12 22:11 美东：两轮都跑了，NVDA、AAPL、AMD 三行，数据时间 19:59 美东（盘后最后一分钟），第二轮按数据时间去重存 0 行。
- [ ] 盘中数据时间约早 15 分钟。交易时段跑 `market`（不加 `--off-hours`）时确认。
- [x] Lane 9. 真行情上设一个一定会触发的条件。Save `g5-real-alert.txt`. Pass when 网页和 Telegram 记录器出现提醒。off-hours，2026-11-12 22:11 美东：`host_lines` 和 Telegram 记录器都有「NVDA 167.8351，高于 0.01（2026-11-12 19:59 美东，来自 stock-ta/quotes）」。
- [x] Lane 10a. 真模型 `openai-codex/*` 问「NVDA 现在多少，离 170 还有多远」。Save `g5-real-ask.txt`. Pass when 专家读了 `quotes`，回答带数据时间并说明延迟 15 分钟。off-hours，2026-11-12 22:12 美东：stock-ta 的请求任务读了 `quotes`，回答 167.8351、比 170 低 2.1649，写了数据时间和延迟 15 分钟。第一次 FAIL：宿主同时开着 us-market，幕僚长把这个问题交给了美股看盘队；脚本改成 market lane 的宿主关掉 us-market 后 PASS。回答的时间写成 UTC 和北京时间，没写美东，也没说是盘后价。
- [x] Lane 10b. 真模型 `openai-codex/*`，stock-ta 用 fixtures 模式（NVDA 跌 5.2%）。Save `g5-real-big-move.txt`. Pass when 幕僚长按规则 `stock-ta/big-move` 开任务，派给结构与形态和趋势与动量，汇报带数据时间、延迟 15 分钟和「不是交易指令」。
- [x] Lane 11. 假模型，假 Massive 依次给 NVDA 跌 5.2%、同一天跌 5.68%、涨 5.00%。Save `g5-big-move.txt`. Pass when 第一轮正好一条触发和一个规则任务，第二轮没有新触发和任务；跌 5% 的任务还开着（Worker 提了问题在等回答），涨 5% 另有一条触发交给幕僚长、另开一个任务，任务领域是 stock-ta，队是技术分析研究组。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 一轮报价 feed 的总时间（起进程、一次快照请求、存行、算条件）。
- [x] Probe. 交易时段真行情 10 轮，记每轮时间；同时记 Massive 接口本身的耗时。off-hours，2026-11-12 22:08 美东：handler 经本地转发取数，每轮的总时间和它自己那次请求一起记。
- [x] Baseline. Record the 接口耗时中位数 first. 接口中位数 96 毫秒（67 到 246）。
- [x] Rule. 一轮总时间比接口耗时多出 300 毫秒以上，或任何一轮超过 10 秒，就失败。PASS：每轮总时间中位数 203 毫秒，最长 328 毫秒；比接口多出 82 到 110 毫秒（中位数 107）。多出的部分很稳，是起 handler 子进程；波动全在接口耗时，第一轮 246 毫秒是转发到 Massive 的新连接。第 2 到 10 轮同一数据时间去重，存 0 行，盘中每轮存 3 行会稍多一点。机器负载 6 到 10（18 核）。

**Review gate.** None. G5 is not review-gated.

2026-11-12 在 b0ef8ad 上通过：`tests/stock-ta-quotes.test.ts` 8 条，`just test` 1583 条全过，`check.mjs` 7 项 ok，`tests/e2e/modules.e2e.ts` 全过。lane 1 到 7、10b、11 全 PASS，输出在 `/tmp/swarm-g5/owner/g5-*.txt`。lane 10b 第一次 FAIL：两位专家都派了、数据时间和延迟都写了，但摘要没有写不是交易指令；规则改成「摘要里原样写一句」后重跑 PASS（之后只删了注释）。lane 8、9、10a 和 perf 等交易时段跑：`G5_SECRETS=<宿主密钥 .env> node --import ./src/pi-runtime.mjs docs/modules/evidence/g5-live.ts market /tmp/swarm-g5/owner`。

2026-11-12 修复轮在 704b409 上通过：审计（PR #97）的四点都改了。线程改成和 id 一样的 `big-move:<代码>:<美东日期>:<up|down>`；密钥名改成 `POLYGON_API_KEY`（使用者定），没有密钥不发请求；fixtures 排练和 `just module check` 用替身密钥；提醒里的时间按美东写；同一只两行以最新一行为准。红灯先行，见 `/tmp/swarm-g5/fix/red-quotes.txt` 和 `red-fixture-and-alert.txt`。`tests/stock-ta-quotes.test.ts` 13 条，`just test` 1616 条全过，`check.mjs` 全 ok，`tests/e2e/modules.e2e.ts` 12 条全过，`just module check` 不带密钥 ok。lane 1 到 7、11、10b 全 PASS，输出在 `/tmp/swarm-g5/fix/`；lane 11 让第一个大跌任务开着（Worker 提了问题），涨 5% 仍另开任务。lane 10b 前两次 FAIL 是 Router 调 openai-codex 时 `fetch failed`（网络），第三次 PASS。lane 8、9、10a 和 perf 仍等交易时段。

2026-11-12 第二轮修复（复核 4c8d21b 的问题）：换美东时间原来写在框架的 `alertText` 里，所有模块带时区的时刻都被改成美东，西海岸使用者的个人读数也会显示成美东。现在 `watch` 多一个可选的 `zone`（IANA 时区名，检查时拒收不认识的名字，坏包 `watch-unknown-zone`），只有写了 `zone` 的数据才换算并标时区，`America/New_York` 标「美东」；只有 stock-ta 的 `quotes` 写了。提醒文字去掉套着的括号，写成「（2026-11-09 09:47 美东，来自 stock-ta/quotes）」。红灯先行，见 `/tmp/swarm-g5/fix2/red.log`。`just test` 1617 条全过，`check.mjs` 全 ok（坏包 14 个），`just module check` stock-ta 不带密钥 ok，lane 1 到 7、11 全 PASS，输出在 `/tmp/swarm-g5/fix2/out/`。

2026-11-12 时段外跑真行情（使用者定：不等开盘）：`G5_SECRETS=<宿主密钥 .env> node --import ./src/pi-runtime.mjs docs/modules/evidence/g5-live.ts market --off-hours /tmp/swarm-g5/offhours`。lane 8、9、10a 和 perf 全 PASS，输出在 `/tmp/swarm-g5/offhours/`（perf 出自第一次运行，在 `run1/`；lane 8、9、10a 出自第三次运行，在 `run3/`）。AMD 当天涨 5.43%，真数据上自己开了一个 `stock-ta/big-move` 任务，第二轮同一 id 的触发没有再开任务。三次运行一共约 17 次 Massive 请求，其中 2 次是 us-market 查 NVDA 报价（关掉 us-market 之前）。不加 `--off-hours` 时脚本在时段外照样拒绝。还差盘中数据时间约早 15 分钟这一项。

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
