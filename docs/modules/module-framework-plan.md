# Module framework plan

把 `docs/modules/architecture/design.md` 的模块 framework 落成代码，再用它做演示模块「股票技术分析」（`stock-ta`）。
做完以后，使用者把一个按新布局写的文件夹放进状态目录的 `modules/`，打开开关就能用，改文件存盘就生效，不用重启宿主。模块能带工具、知识、技能和专家团队。
程序守的规则是 design.md 第 2 节那张表（ADR-0003 的通用版）。模块代码每次调用一个新进程，不进宿主进程。
PR 顺序是 F1、F2a、F2b、F3、F4、F5、F6、D1、F2c，依次叠在上一个之上。数据、提醒条件、连接器和调度器推迟，旧加载器因此继续服务 toy-market 和 us-market。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并全部 PR。九个 PR 都停在 merge-ready，等使用者点合并。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [x] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. 使用者 2026-11-12 预先授权，计划写完不停，直接执行到全部 merge-ready（`docs/HANDOFF-2026-11-12.md`「无人值守时的默认做法」）。
- [ ] Read these from trunk at program start. Re-read them at every tick. 本机 pstack 不在本仓库里，用插件缓存 `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/` 代替 `git show origin/main:`。
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/architect/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/tdd/SKILL.md`
  - [ ] Control skill `control-ui` 和 `control-cli` 未安装。命令行 lane 用 `spawnSync` 跑 `just` 命令并存输出，网页 lane 用仓库已有的 Playwright e2e harness（`tests/e2e/harness.ts`），见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 本次由一个会话从头跑到尾，每个 PR 的 owner 是前台串行的子任务，没有要巡检的并行 owner，所以不开 `/loop`，每个 PR 收尾时在决策记录里记一行代替 tick。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owner 用 `pstack:poteto-agent`，在共用的 worktree `../psa-mod` 里串行工作，一次只有一个 owner 在写。
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] F1 is first. It branches from `main` as `psa/mod-f1-scan`.
  - [ ] F2a on F1 (`psa/mod-f2a-live`). F2b on F2a (`psa/mod-f2b-watch`). F3 on F2b (`psa/mod-f3-gateway`). F4 on F3 (`psa/mod-f4-knowledge`). F5 on F4 (`psa/mod-f5-templates`). F6 on F5 (`psa/mod-f6-builder`). D1 on F6 (`psa/mod-d1-stock-ta`). F2c on D1 (`psa/mod-f2c-page`).
  - [ ] F2c 只依赖 F2a，放在最上面是为了让改界面的 PR 等审时不挡别的 PR，也让模块页第一版能显示演示模块。
- [ ] Hold the file boundaries. F1 到 D1 只碰 `src/`、`modules/`、`tests/`、`justfile`、`docs/modules/`、`docs/adr/`。F2c 另外碰 `src/web/`、`tests/e2e/`。没有 PR 碰 `extensions/`、`.pi/`、`docs/feeds/`、`docs/security/` 和使用者其他未提交的文件，也不碰 `~/Python/Playground/TechnicalAnalysis` 里的任何文件。
- [ ] Hold the review gate. F2c changes an interaction. It waits for the operator's review in chat with screenshots and a video before merge. 其余 PR 只改命令行和宿主内部，不审界面。

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 仓库没有全局 lint，以 `just test` 全绿和 `node docs/modules/architecture/check.mjs`（含 `src/modules/` 的 tsc）全绿为准。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `deslop` 未安装，用内置 `simplify` 代替。`no-comments` 用 `pstack:comment-sicko` 子任务代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`. 仓库没有 Bugbot，记一行 skip。
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. 叠放的 PR rebase 到父分支。
- [ ] 推送前查私人信息。`git diff` 里不能出现 `/Users/szou`、邮箱和 `TechnicalAnalysis` 的绝对路径。

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict. 本次把 gates、十条 live lane 和 perf 交给一个验证者在同一个 head 上跑脚本，两个审查者各读 diff，一个看正确性，一个看是否符合 design.md。
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 不合并。每个 PR 在干净结论后停在 merge-ready，交给使用者。restack 后 `git patch-id` 不变的 PR 保留原结论。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本次在本机跑，每条 lane 用自己的临时状态目录，不碰 `~/.pi-super-agent`。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 命令行 lane 设 `PSA_STATE_DIR=$(mktemp -d)` 后跑 `just ...`。宿主 lane 用 `tests/e2e/harness.ts` 的 `startHost`，假模型用 `tests/e2e/fake-model.ts`，真模型 lane 只用 `openai-codex/*`。
- [ ] 输入只走 `just` 命令、宿主 socket 和网页。只读诊断是 `just modules`、`sqlite3 -readonly <stateDir>/state.db`、宿主日志。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. 命令行 lane 存 `<slug>.txt`。

## Scan new-layout packages and check them (F1)

**Depends on.** None.

**Files.**

- [ ] Create `src/modules/manifest.ts`, `src/modules/validate.ts`, `src/modules/lifecycle.ts`, `src/modules/protocol.ts`, `src/modules/registry.ts`，从 `docs/modules/architecture/sketch/` 搬过来。
- [ ] Create `src/cli/module.ts` 和 `justfile` 的 `module *args` recipe。
- [ ] Edit `src/modules.ts` 第 264 行附近，`"schema": 1` 的文件夹交给新扫描。
- [ ] Create `tests/module-scan.test.ts`，把 `sketch/*.test.ts` 搬成 `tests/module-validate.test.ts`、`tests/module-lifecycle.test.ts`、`tests/module-protocol.test.ts`。
- [ ] Edit `docs/modules/architecture/check.mjs`，改成检查 `src/modules/`。Delete `docs/modules/architecture/sketch/`。
- [ ] Edit the four stale docs that say PR #27 is unmerged (`current-state.md` 列出的位置)。
- [ ] Create `docs/modules/module-framework-plan.md`（本文件）。

**Build.**

- [ ] `scanPackage` 和 `summary` 从 `src/modules/validate.ts` 导出。`Modules.load` 读到 `"schema": 1` 时调 `scanPackage`，结果收进 `Modules.packages`（有效或无效带原因），不抛错，宿主照常启动。
- [ ] `just module check <目录>` 打印一行 `ok <名字>@<版本> | ...` 或每个问题一行，退出码 0 或 1。

**You see.**

- [ ] `just module check docs/modules/architecture/sample/personal-tax` 打印 `ok personal-tax@0.1.0 | knowledge=0 data=1 tools=1 ...`。
- [ ] 状态目录 `modules/` 里放一个坏的新布局包，`just host` 照常启动，`just modules` 把它列成「无效」并写出原因。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/module-scan.test.ts` 新增「schema 1 的坏包不阻止加载」「schema 1 的好包出现在 packages 里」「旧布局模块行为不变」。Run `just test`.
- [ ] 搬过来的 17 条草图测试在 `tests/` 下通过。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/f1-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都跑 `just modules`，状态目录只有仓库自带的三个模块。Save `f1-regression.txt`. Pass when 两边输出逐字相同。
- [ ] Lane 2. `just module check` 检查 personal-health 样例。Save `f1-health.txt`. Pass when 输出 `ok personal-health@0.1.0` 且 digest 和 check.mjs 记录的一致。
- [ ] Lane 3. 检查 13 个坏包。Save `f1-broken.txt`. Pass when 每个都退出码 1，原因和 `sample/broken/<名字>/expected.txt` 一致。
- [ ] Lane 4. 状态目录放一个坏的 schema 1 包后启动宿主。Save `f1-boot-bad.txt`. Pass when 宿主就绪，日志里有一行这个包无效的原因。
- [ ] Lane 5. 状态目录放 personal-tax 样例后跑 `just modules`。Save `f1-list.txt`. Pass when 列出它是新布局、有效、已停用。
- [ ] Lane 6. 新布局包和旧布局模块同名。Save `f1-dup.txt`. Pass when 报重名，宿主拒绝启动的行为和今天两个旧模块同名时一样。
- [ ] Lane 7. `just module check` 一个不存在的目录。Save `f1-missing.txt`. Pass when 一行原因，退出码 1。
- [ ] Lane 8. 拼错 `module.json` 的键。Save `f1-typo.txt`. Pass when 输出 `unknown key "descripton"`。
- [ ] Lane 9. 带失败用例的工具。Save `f1-case.txt`. Pass when 指出用例名和期望值。
- [ ] Lane 10. `node docs/modules/architecture/check.mjs`。Save `f1-check.txt`. Pass when 全部 ok。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 宿主从启动到就绪的时间，状态目录里有仓库三个模块加两个样例包。
- [ ] Probe. trunk 和 head 交替各跑 5 次 `tests/e2e/harness.ts` 的 `startHost`，取中位数。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 比 trunk 慢 200 毫秒以上就失败。

**Review gate.** None. F1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Make the module table swappable and switch modules live (F2a)

**Depends on.** F1.

**Files.**

- [ ] Create `src/modules/live.ts`（`LiveRegistry`、驱动器、副本目录 `module-store/`）。
- [ ] Edit `src/kernel/kernel.ts`，`domains` 选项改成函数。Edit `src/kernel/store.ts`，加模块记录表和 `tickets.module_digest` 列。
- [ ] Edit `src/host/host.ts`、`src/host/wiring.ts`、`src/host/workers.ts`、`src/host/pi-worker.ts`，改握 `LiveRegistry`，技能和专家从任务钉住的副本读。
- [ ] Edit `src/cli/module.ts`，加 `on` 和 `off`。
- [ ] Create `tests/module-live.test.ts`。

**Build.**

- [ ] `LiveRegistry.current()` 返回不可变快照，`publish` 一次赋值换表。驱动器按 `lifecycle.ts` 的 `transition` 走，`pending` 动作存在 state.db，崩溃后接着做。
- [ ] 开关存在模块记录里。宿主第一次启动时从 `config.json` 的 `modules` 导入一次，旧布局里默认打开的模块导入成开。`just module on|off <名字>` 写记录，运行中的宿主两秒内生效。
- [ ] 任务开出时记下模块摘要，技能、专家定义从 `module-store/<名字>/<摘要>/` 读。没有任务钉着的旧副本回收。

**You see.**

- [ ] 宿主运行时 `just module on personal-tax`，`just modules` 两秒内显示「运行中」，不用重启。
- [ ] 正在跑的任务在模块文件改了以后仍用开始时的技能。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/module-live.test.ts` 覆盖换表原子性、开关运行中生效、任务钉版本、崩溃后接着做 `pending`、旧副本回收、config.json 导入只做一次。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/f2a-live.ts`，宿主用假模型。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都用假模型跑一次 pi-pi 领域的任务。Save `f2a-regression.txt`. Pass when 两边任务都属于 pi-pi 且完成。
- [ ] Lane 2. 运行中打开一个新布局模块。Save `f2a-on.txt`. Pass when 两秒内状态变成运行中，宿主进程号不变。
- [ ] Lane 3. 运行中关掉它。Save `f2a-off.txt`. Pass when 两秒内变成已停用，新任务不再分到它。
- [ ] Lane 4. 任务开出后改技能文件。Save `f2a-pin.txt`. Pass when 任务读到的是旧技能，副本目录里有两个摘要。
- [ ] Lane 5. 任务结束后。Save `f2a-gc.txt`. Pass when 旧摘要的副本被回收。
- [ ] Lane 6. 驱动器做到一半杀掉宿主再起。Save `f2a-crash.txt`. Pass when 重启后 `pending` 做完，状态正确。
- [ ] Lane 7. `config.json` 里关掉 toy-market 后首次启动。Save `f2a-import.txt`. Pass when 记录里 toy-market 关，pi-pi 和 us-market 开。
- [ ] Lane 8. 再改 `config.json` 后重启。Save `f2a-import-once.txt`. Pass when 记录不变，日志提示开关改由 `just module` 管。
- [ ] Lane 9. 包不在时关掉开关，包放回来。Save `f2a-away.txt`. Pass when 仍是关。
- [ ] Lane 10. 宿主没运行时 `just module on`。Save `f2a-offline.txt`. Pass when 记录写入，下次启动生效。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 宿主启动到就绪的时间，以及开出一个任务的时间（新增复制副本的开销）。trunk 没有换表，换表本身另给绝对预算。
- [ ] Probe. trunk 和 head 交替各 5 次，`startHost` 就绪时间和 `drop` 到任务出现的时间。换表用 `performance.now()` 量 `publish` 100 次。
- [ ] Baseline. Record the trunk 两个中位数 first.
- [ ] Rule. 启动或开任务比 trunk 慢 200 毫秒以上就失败。一次换表超过 50 毫秒就失败。

**Review gate.** None. F2a is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Pick up saved edits and tell the Router the current roster (F2b)

**Depends on.** F2a.

**Files.**

- [ ] Create `src/modules/watch.ts`（`fs.watch` 递归监视，去抖）。
- [ ] Edit `src/host/router.ts` 的 `#flush` 和 `routerSystemPrompt`，Edit `src/host/wiring.ts`。
- [ ] Edit `modules/pi-pi/module.json`，转换成新布局。
- [ ] Create `tests/module-watch.test.ts`，Edit `tests/router-prompt.test.ts`。

**Build.**

- [ ] 监视器看到包变了就算新摘要，交给驱动器检查。通过就换上并留一条收据（改了哪些文件），没通过旧版本继续服务。
- [ ] 系统提示词只留固定文字。模块表摘要变了以后，下一次给幕僚长的输入前带一段当前名单和规则全文。
- [ ] pi-pi 加 `"schema": 1` 和 `"version"`，由新扫描加载，行为不变。

**You see.**

- [ ] 宿主运行时改 personal-tax 的 `rules.md` 存盘，`just modules` 两秒内显示新摘要，宿主日志有一行收据。
- [ ] 幕僚长下一次回复里能用上新加的模块。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/module-watch.test.ts` 覆盖新增、修改、删除、坏的修改保留旧版本、连续保存只换一次。`tests/router-prompt.test.ts` 覆盖名单只在摘要变化后带一次。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/f2b-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都问一个 pi-pi 的问题。Save `f2b-regression.txt`. Pass when 两边任务都属于 pi-pi，成员名单相同。
- [ ] Lane 2. 改技能文件存盘。Save `f2b-edit.txt`. Pass when 两秒内换上新摘要，收据列出这个文件。
- [ ] Lane 3. 存一个坏的 `module.json`。Save `f2b-bad.txt`. Pass when 状态写出原因，旧版本继续服务。
- [ ] Lane 4. 再改好。Save `f2b-fix.txt`. Pass when 换上新版本。
- [ ] Lane 5. 放进一个新模块文件夹。Save `f2b-add.txt`. Pass when 出现为已停用。
- [ ] Lane 6. 删掉模块文件夹。Save `f2b-remove.txt`. Pass when 状态变成包不在了，实例数据目录还在。
- [ ] Lane 7. 一秒内连存五次。Save `f2b-burst.txt`. Pass when 只换一次，摘要是最后一次。
- [ ] Lane 8. 名单变化后发一句话。Save `f2b-roster.txt`. Pass when 幕僚长收到的输入前面有一段名单，再发一句时没有。
- [ ] Lane 9. 用真模型 `openai-codex/*` 问新打开模块管的事。Save `f2b-real.txt`. Pass when 任务分到这个模块。
- [ ] Lane 10. pi-pi 转换后跑 `just module check modules/pi-pi`。Save `f2b-pipi.txt`. Pass when ok，成员数是 9。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 幕僚长每次输入的 token 数，以及存盘到换上的时间。
- [ ] Probe. trunk 和 head 交替各发 5 句同样的话，读 Pi 会话的 usage。存盘到收据的时间量 10 次。
- [ ] Baseline. Record the trunk token 中位数 first.
- [ ] Rule. 名单没变时 head 每次输入比 trunk 多 100 个 token 以上就失败。存盘到换上超过 2 秒就失败。

**Review gate.** None. F2b is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Let modules ship tools through one Gateway (F3)

**Depends on.** F2b.

**Files.**

- [ ] Create `src/modules/gateway.ts` 和 `src/modules/run-code.ts`（异步、每次调用一个进程）。
- [ ] Edit `src/worker/extension.ts`、`src/worker/tools.ts`、`src/host/workers.ts`、`src/host/host.ts`、`src/teams.ts`（成员加 `uses`）。
- [ ] Create `tests/gateway.test.ts`，Edit `tests/worker-extension.test.ts`。

**Build.**

- [ ] `Gateway.call(caller, request)` 只在任务所属模块、钉住的摘要里找能力，模块停用就拒绝，成员对照 `uses`，再按 `allowed` 那张表。
- [ ] `domain_tool` 交给启动器。进程的 cwd 是工具目录，环境只有 `PATH`、`HOME` 和 `tool.json` 写了名字的密钥，值用 `readSecret` 从宿主的密钥文件读。时限 20 秒。
- [ ] 成员有 `uses` 时宿主自动给它 `domain_tool`，它的 Pi 工具目录里列出模块的工具名和说明。

**You see.**

- [ ] 在 personal-tax 任务里，Worker 调 `domain_tool` 算出税额，访问记录里有一笔。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/gateway.test.ts` 覆盖别的模块的工具查不到、停用拒绝、`uses` 没列拒绝、推断任务调 `write` 工具拒绝、密钥只给写了名字的、进程超时只算这一次失败。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/f3-live.ts`，Worker 的工具调用由假模型回放。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都跑一次 us-market 的 `lookup`。Save `f3-regression.txt`. Pass when 两边结果相同。
- [ ] Lane 2. personal-tax 任务调 `tax-bracket`。Save `f3-call.txt`. Pass when 返回值和 `cases.json` 一致。
- [ ] Lane 3. pi-pi 任务调 `tax-bracket`。Save `f3-other.txt`. Pass when 拒绝，原因是不在本模块。
- [ ] Lane 4. 调用中关掉模块再调。Save `f3-disabled.txt`. Pass when 第二次拒绝。
- [ ] Lane 5. 成员 `uses` 没列这个工具。Save `f3-uses.txt`. Pass when 拒绝。
- [ ] Lane 6. 推断任务调 `effect: write` 的工具。Save `f3-infer.txt`. Pass when 拒绝。
- [ ] Lane 7. 工具读写了名字的密钥和没写名字的密钥。Save `f3-secret.txt`. Pass when 前者拿到，后者拿不到。
- [ ] Lane 8. 工具死循环。Save `f3-timeout.txt`. Pass when 20 秒后这次失败，宿主照常响应别的请求。
- [ ] Lane 9. 改工具代码存盘后新任务调用。Save `f3-hot.txt`. Pass when 用的是新代码，旧任务用旧代码。
- [ ] Lane 10. 用真模型 `openai-codex/*` 问一道需要算税的题。Save `f3-real.txt`. Pass when Worker 调了 `domain_tool` 且答案引用了结果。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一次 `domain_tool` 调用从 Worker 发出到收到的时间。trunk 没有这个工具，所以和 trunk 的 `lookup` 往返时间对照，另给绝对预算。
- [ ] Probe. 同一个宿主上交替调 20 次 `lookup` 和 20 次 `tax-bracket`。
- [ ] Baseline. Record the trunk `lookup` 中位数 first.
- [ ] Rule. `tax-bracket` 中位数超过 150 毫秒就失败。

**Review gate.** None. F3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Search module knowledge (F4)

**Depends on.** F3.

**Files.**

- [ ] Create `src/modules/knowledge.ts`（导入、切段、FTS5 索引、查询）。
- [ ] Edit `src/modules/gateway.ts`、`src/worker/extension.ts`、`src/worker/tools.ts`、`src/cli/module.ts`（加 `import`）。
- [ ] Create `tests/knowledge.test.ts`。

**Build.**

- [ ] 索引存在 `<stateDir>/modules-data/<名字>/index/knowledge.db`。`bundled` 的知识从包里建索引，`user-import` 的从 `modules-data/<名字>/knowledge/` 建。
- [ ] `just module import <名字> <知识名> <文件或目录>` 把全文复制进实例数据并重建索引。
- [ ] `knowledge` 工具按查询返回段落，每段带文档名、版本和章节。查询少于 3 个字时用 `LIKE`，否则用 trigram 的 `MATCH`。

**You see.**

- [ ] 在 personal-health 任务里问「肿瘤标志物」，Worker 的回复引用了文档名和章节。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/knowledge.test.ts` 覆盖按标题切段、两个字的中文词能查到、`user-import` 没导入时提示还没导入、别的模块的知识查不到、包更新后索引重建。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/f4-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 没有 `knowledge` 工具，记录这一点。head 上跑 F3 的 `tax-bracket` 调用。Save `f4-regression.txt`. Pass when 结果和 F3 一样。
- [ ] Lane 2. 查 `bundled` 知识里的三个字的词。Save `f4-three.txt`. Pass when 返回段落带章节。
- [ ] Lane 3. 查两个字的词。Save `f4-two.txt`. Pass when 返回段落。
- [ ] Lane 4. 查 `user-import` 知识但没导入。Save `f4-missing.txt`. Pass when 提示还没导入和导入命令。
- [ ] Lane 5. 导入后再查。Save `f4-import.txt`. Pass when 返回导入文件里的段落。
- [ ] Lane 6. 别的模块的任务查。Save `f4-other.txt`. Pass when 查不到。
- [ ] Lane 7. 改知识文件存盘。Save `f4-reindex.txt`. Pass when 新任务查到新内容。
- [ ] Lane 8. 成员 `uses` 没有 `knowledge`。Save `f4-uses.txt`. Pass when 拒绝。
- [ ] Lane 9. 没有结果的查询。Save `f4-empty.txt`. Pass when 返回空列表和一句说明。
- [ ] Lane 10. 用真模型 `openai-codex/*` 问一个知识里的问题。Save `f4-real.txt`. Pass when 回复引用了文档名。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一次 `knowledge` 查询的时间，以及一份 1000 行文档的建索引时间。trunk 没有这个功能，只给绝对预算。
- [ ] Probe. 导入 personal-health 的两份知识和一份 1000 行的合成文档，查 20 次，建索引 5 次。
- [ ] Baseline. Record the trunk 宿主启动时间 first，确认索引不拖慢启动。
- [ ] Rule. 查询中位数超过 50 毫秒，或建索引超过 2 秒，或启动比 trunk 慢 200 毫秒以上，就失败。

**Review gate.** None. F4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Start a module from a template and rehearse it (F5)

**Depends on.** F4.

**Files.**

- [ ] Create `modules/templates/notes/`、`modules/templates/team/`、`modules/templates/full/`（不被宿主加载）。
- [ ] Edit `src/cli/module.ts`（加 `new` 和 `try`），Delete `src/cli/module-new.ts` 和 `justfile` 的 `module-new` recipe。
- [ ] Create `src/modules/rehearse.ts`，Edit `tests/modules-cli.test.ts`。

**Build.**

- [ ] `just module new <名字> --template notes|team|full` 复制模板并改名，写进 `<stateDir>/modules/<名字>/`，生成的包通过检查，状态为已停用。
- [ ] `just module try <名字>` 起临时状态目录，把 `evals/` 的每道题当成任务跑，核对用到的能力和答案里该有的话，用 `config.json` 里 Worker 的模型，拒绝按量计费的 provider。

**You see.**

- [ ] `just module new demo --template team` 后 `just module check` 显示 ok。
- [ ] `just module try personal-tax` 打印每道考题的通过或失败和原因。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/modules-cli.test.ts` 覆盖三种模板都通过检查、重名拒绝、模板目录不被当成模块加载、`try` 用假模型时考题判定正确、按量计费的模型被拒绝。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/f5-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 跑 `just module-new demo`，head 跑 `just module new demo --template notes`。Save `f5-regression.txt`. Pass when 两边都生成模块，head 的通过新检查。
- [ ] Lane 2. `--template team`。Save `f5-team.txt`. Pass when 检查 ok，有专家和考题。
- [ ] Lane 3. `--template full`。Save `f5-full.txt`. Pass when 检查 ok，工具用例通过。
- [ ] Lane 4. 重名。Save `f5-dup.txt`. Pass when 拒绝，原目录不变。
- [ ] Lane 5. 宿主运行时新建。Save `f5-hot.txt`. Pass when 两秒内出现为已停用。
- [ ] Lane 6. `just module try personal-tax` 用假模型。Save `f5-try-fake.txt`. Pass when 考题通过。
- [ ] Lane 7. 考题要求的能力没被用到。Save `f5-try-fail.txt`. Pass when 判失败并写出没用到哪项。
- [ ] Lane 8. 配置成按量计费的模型。Save `f5-paid.txt`. Pass when 拒绝运行。
- [ ] Lane 9. 用真模型 `openai-codex/*` 跑 `just module try personal-tax`。Save `f5-try-real.txt`. Pass when 有通过或失败的判定和对话记录。
- [ ] Lane 10. `try` 结束后。Save `f5-clean.txt`. Pass when 临时状态目录删掉，使用者的状态目录没变。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `just module new` 的时间。trunk 是 `just module-new`。
- [ ] Probe. trunk 和 head 交替各 5 次。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 比 trunk 慢 1 秒以上就失败。

**Review gate.** None. F5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Ship the module-builder module (F6)

**Depends on.** F5.

**Files.**

- [ ] Create `modules/module-builder/`（`module.json`、`rules.md`、`skills/`、`agents/`、`evals/`）。
- [ ] Edit `docs/modules/module-user-guide.md`，加「用聊天做模块」一节。

**Build.**

- [ ] 一支团队（访谈、搭结构、整理知识、出考题、检查）和几份技能。专家有 `write`、`edit`、`bash`，在 `<stateDir>/modules/<名字>/` 里写文件，自己跑 `just module check` 和 `just module try`。新模块停在已停用。

**You see.**

- [ ] 对幕僚长说「帮我做一个记录读书笔记的模块」，几轮对话后状态目录里出现一个检查通过、已停用的模块。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/module-builder.test.ts` 覆盖包通过检查、专家的 `tools` 和 `uses` 合法、默认打开。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/f6-live.ts`，lane 9 和 10 用真模型。

- [ ] Lane 1. Regression lane against trunk. trunk 没有制作模块，记录这一点。head 上跑 `just modules`。Save `f6-regression.txt`. Pass when 其余模块的状态和 F5 相同。
- [ ] Lane 2. `just module check modules/module-builder`。Save `f6-check.txt`. Pass when ok。
- [ ] Lane 3. `just module try module-builder` 用假模型。Save `f6-try.txt`. Pass when 考题通过。
- [ ] Lane 4. 假模型回放「做一个读书笔记模块」。Save `f6-notes.txt`. Pass when 生成的包检查通过、已停用。
- [ ] Lane 5. 生成的包同名已存在。Save `f6-dup.txt`. Pass when 不覆盖，回复说明。
- [ ] Lane 6. 让它改已有模块加一份技能。Save `f6-edit.txt`. Pass when 存盘后换上新摘要。
- [ ] Lane 7. 它写坏一个文件。Save `f6-bad.txt`. Pass when 它读到检查结果并改好。
- [ ] Lane 8. 推断任务里调用它。Save `f6-infer.txt`. Pass when 不开出制作任务。
- [ ] Lane 9. 用真模型 `openai-codex/*` 做一个「家庭菜谱」模块。Save `f6-real.txt`. Pass when 包检查通过，有知识和技能。
- [ ] Lane 10. 打开 lane 9 做出的模块并问它一个问题。Save `f6-real-use.txt`. Pass when 任务分到这个模块。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 多一个模块后宿主启动时间。
- [ ] Probe. trunk 和 head 交替各 5 次 `startHost`。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 比 trunk 慢 200 毫秒以上就失败。

**Review gate.** None. F6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Ship the stock technical analysis demo module (D1)

**Depends on.** F6.

**Files.**

- [ ] Create `modules/stock-ta/`（`module.json`、`GLOSSARY.md`、`knowledge/`、`tools/`、`skills/`、`agents/`、`evals/`）。
- [ ] Create `docs/modules/stock-ta.md`，写怎么填 `TA_ROOT`、怎么导入知识。

**Build.**

- [ ] 知识只放出处，`"license": "user-import"`。全文由 `just module import stock-ta ...` 从使用者本机导入，不进仓库。
- [ ] 工具的 `index.ts` 起子进程调 `uv run --project $TA_ROOT/app/trading ta <子命令>`，只用只读子命令，默认断网并传缓存覆盖得到的 `now`，输出裁剪到 20 KB 以内。`TA_ROOT` 由使用者写进宿主密钥文件。另有一个纯计算工具算盈亏比和止损距离，带 `cases.json`。
- [ ] 技能搬 `principle-evidence`、`principle-freshness`，`ta-interpret` 和 `ta-screen` 去掉桌面界面部分。五位专家，团队名「技术分析研究组」。

**You see.**

- [ ] 打开 stock-ta 后问「NVDA 现在的支撑阻力和动量怎么样」，领队派给结构与形态和趋势与动量两位专家，汇报带数据时间和笔记出处。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta.test.ts` 覆盖包检查通过、纯计算工具用例、命令行工具在 `TA_ROOT` 没设时给出可读的错误、裁剪不超过 20 KB。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/d1-live.ts`，数据库只读，断网。

- [ ] Lane 1. Regression lane against trunk. trunk 没有 stock-ta，记录这一点。head 上问一个 us-market 的问题。Save `d1-regression.txt`. Pass when 仍分到 us-market。
- [ ] Lane 2. `just module check modules/stock-ta`。Save `d1-check.txt`. Pass when ok。
- [ ] Lane 3. 直接调 `structure` 工具查 NVDA。Save `d1-structure.txt`. Pass when 有支撑阻力和数据时间，输出不超过 20 KB。
- [ ] Lane 4. 调 `signals` 工具。Save `d1-signals.txt`. Pass when 返回信号列表。
- [ ] Lane 5. 调 `note` 工具。Save `d1-note.txt`. Pass when 返回笔记段落，不含使用者本机的绝对路径。
- [ ] Lane 6. 盈亏比工具。Save `d1-rr.txt`. Pass when 和用例一致。
- [ ] Lane 7. 导入知识后用 `knowledge` 查「背离」。Save `d1-knowledge.txt`. Pass when 返回 TA02 的段落。
- [ ] Lane 8. 跑前后对比技术分析项目的数据库。Save `d1-readonly.txt`. Pass when `ta.sqlite` 和 `market.sqlite` 的哈希不变。
- [ ] Lane 9. 用真模型 `openai-codex/*` 问 NVDA 的支撑阻力和动量。Save `d1-real.txt`. Pass when 领队派给至少两位专家，汇报带数据时间和出处。
- [ ] Lane 10. `just module try stock-ta` 用真模型。Save `d1-try.txt`. Pass when 每道考题有判定。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一次 `structure` 工具调用的总时间。trunk 没有这个工具，对照直接跑 `ta structure` 的时间。
- [ ] Probe. 交替各 10 次。
- [ ] Baseline. Record the 直接跑 `ta` 的中位数 first.
- [ ] Rule. 工具调用比直接跑 `ta` 慢 150 毫秒以上就失败。

**Review gate.** None. D1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Show modules and their switches on the page (F2c)

**Depends on.** D1.

**Files.**

- [ ] Edit `src/client/protocol.ts`（`BoardState` 加 `modules`）、`src/host/host.ts`、`src/host/web.ts`（加开关的 POST）、`src/web/view.mjs`、`src/web/app.mjs`。
- [ ] Create `tests/e2e/modules.e2e.ts`。

**Build.**

- [ ] 网页加「模块」一栏，每个模块一张卡，写状态和原因、版本、组成数、用到的密钥名字、还钉着旧版本的任务数、还没导入的知识，带开关按钮。

**You see.**

- [ ] 网页「模块」一栏里点 stock-ta 的开关，两秒内卡片变成「运行中」。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/web.test.ts` 覆盖开关的 POST 要 token、`BoardState.modules` 的内容。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个 e2e 脚本 `tests/e2e/modules.e2e.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都打开网页。Save `f2c-regression.png`. Pass when 其余各栏一样。
- [ ] Lane 2. 模块栏。Save `f2c-list.png`. Pass when 每个模块一张卡，状态正确。
- [ ] Lane 3. 点开关打开。Save `f2c-on.png`. Pass when 两秒内运行中。
- [ ] Lane 4. 点开关关掉。Save `f2c-off.png`. Pass when 两秒内已停用。
- [ ] Lane 5. 无效模块。Save `f2c-invalid.png`. Pass when 卡片写出哪个文件哪一处。
- [ ] Lane 6. 还没导入的知识。Save `f2c-import.png`. Pass when 卡片列出知识名和导入命令。
- [ ] Lane 7. 钉着旧版本的任务。Save `f2c-pinned.png`. Pass when 卡片显示数量。
- [ ] Lane 8. 窄屏 390 像素。Save `f2c-narrow.png`. Pass when 没有横向滚动。
- [ ] Lane 9. 深色主题。Save `f2c-dark.png`. Pass when 文字可读。
- [ ] Lane 10. 不带 token 的 POST。Save `f2c-token.txt`. Pass when 401。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 看板推送一次的字节数。
- [ ] Probe. trunk 和 head 各取 5 次推送。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. 每个模块多出的字节超过 1 KB 就失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3 and 5 screenshots into `docs/modules/evidence/f2c-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `docs/modules/evidence/f2c-review.mp4`. 本机用 Playwright 录像。
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

**Python 工具的两种做法。** 2026-11-12 在本机各跑 5 次 `structure`（NVDA，`now` 固定，断网）。薄的 `index.ts` 起子进程 1.10 到 1.14 秒，`uv run` 起 `index.py` 1.08 到 1.10 秒，直接跑 `ta` 1.06 到 1.08 秒。时间几乎全花在 `ta` 本身，两种做法差几十毫秒。选薄的 `index.ts`，framework 不加 `"runtime": "python"`。脚本留在会话临时目录，没有提交。

**文件监视。** `fs.watch(root, { recursive: true })` 在 macOS 和 Node 26.5 上约 10 毫秒收到子文件夹里的新增、修改、删除（`.audit/module-framework/proto-watch.mjs`，没有提交）。

**中文检索。** trigram 分词查不到两个字的词（「均线」查空，「强弱指」能查到），`LIKE` 能查到。F4 因此对少于 3 个字的查询用 `LIKE`。

**还没证明的。** 幕僚长每次输入前带名单的做法，Pi 会话能不能接受一段额外的自定义消息而不打乱上下文，F2b 的 lane 8 验证。

## Appendix B. Alternatives rejected

- **给 `tool.json` 加 `"runtime": "python"`。** 实测不省时间，还要改 framework。
- **每次输入都带名单和规则。** 会抵消 #50 到 #53 省下的 token。只在模块表摘要变了以后带一次。
- **并排的兄弟分支。** F3 以后都改 `host.ts` 和 `workers.ts`，并排会在合并时冲突，所以线性叠放。
- **把 `src/modules.ts` 改名成 `src/modules/index.ts`。** 要改 17 处导入，没有好处。旧加载器留到 us-market 转换时整个删掉。
- **再开一轮 arena 设计。** design.md 和草图已经合并并经过对抗审查。
- **知识全文进仓库。** 技术分析笔记不是使用者写的，仓库是公开的。

## Appendix C. Risks

- **F2a 改内核的 `domains`。** 测试里有很多地方传一张表，owner 在 `tests/helpers/fakes.ts` 的 `domainsOf` 里统一适配。
- **F2a 的开关导入。** pi-pi 在 F2b 转换成新布局时，不能因为「新发现的模块默认停用」而被关掉。F2a 的 lane 7 和 F2b 的 lane 1 盯着。
- **F2b 的名单注入。** Pi 会话能否接受额外的消息未经证明，见 Appendix A。
- **F3 的启动器。** 宿主里不能用 `spawnSync`，否则会卡住所有 Worker。lane 8 盯着。
- **D1 联网和写库。** `ta` 的 `bars` 和 `structure` 在缓存没覆盖时会联网写缓存。工具默认断网并传 `now`，lane 8 对比数据库哈希。
- **D1 的路径。** `TA_ROOT` 是使用者机器上的路径，放在宿主密钥文件里，不进包。
- **没有 control skill。** 网页 lane 用仓库自己的 Playwright harness，命令行 lane 用脚本。

## Appendix D. Links and reading list

- `docs/modules/architecture/design.md`，先读第 2、4、6、7 节。
- `docs/modules/architecture/current-state.md` 的最后一节，列出启动时冻结的所有东西。
- `.audit/module-framework/ta-survey.md`（本机，没有提交），技术分析项目的摸底。
- `pstack/skills/how/SKILL.md` 已由上一轮的 `current-state.md` 覆盖。F2a 和 F3 的 owner 在实现前各写两种接缝草图再选。`pstack/skills/interrogate/SKILL.md` 不再跑，设计已在 #79 审过。
- 决策记录在 `.audit/module-framework.tsv`，按 `pstack/skills/show-me-your-work/SKILL.md`，不提交。
