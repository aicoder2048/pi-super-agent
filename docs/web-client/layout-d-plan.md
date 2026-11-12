# 网页布局方案 D 计划

使用者的原话是「这个左侧栏目的设计，堆砌感太强，而右侧栏一直空着。需要做下整体的布局设计和重构。」他看过设计稿，选了方案 D（A+B 结合）。
桌面上三栏一直都在，哪一栏都不收起。左栏只放要你处理的事（待你处理、进行中），中间对话不变，右栏是带数字的标签页：今天、来源、模块、已完成。
点了任务，右栏最前面多出一个能关的「任务 #编号 ×」标签，关掉回到刚才那个标签。盯盘提醒来了，右栏自己切过去。
手机上用底部标签栏（待办、对话、概况），「概况」里顶上是同样四个分段。
程序守的规则是：右栏永远有内容，三栏宽度和选没选任务无关，对话区不变。
PR 顺序是 LD1（桌面布局），LD2（手机底部标签栏），LD2 叠在 LD1 上。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并全部 PR。LD1 和 LD2 都停在 merge-ready，等使用者看过截图和录像再点合并。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [x] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. 使用者看过设计稿、答完五个问题后让 owner 直接做到 merge-ready，计划写完不停。
- [ ] Read these from trunk at program start. Re-read them at every tick. 本机 pstack 不在本仓库里，用插件缓存 `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/` 代替 `git show origin/main:`。
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/tdd/SKILL.md`
  - [ ] Control skill `control-ui` 未安装。网页 lane 用仓库已有的 Playwright e2e harness（`tests/e2e/harness.ts`），见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 本次一个 owner 从头跑到尾，没有并行的 owner 要巡检，所以不开 `/loop`，每个 PR 收尾时在报告里记一行代替 tick。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. 一个 owner 在 worktree `../psa-mod` 里串行做 LD1 再做 LD2。
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] LD1 is first. It branches from `main` 0e1fc9a as `psa/layout-d`.
  - [ ] LD2 after LD1. It branches from `psa/layout-d` as `psa/layout-d-phone`.
- [ ] Hold the file boundaries. LD1 和 LD2 只碰 `src/web/`、`src/client/protocol.ts`、`src/host/host.ts`、`src/kernel/kernel.ts`（今天的提醒列表）、`tests/`、`docs/web-client/`。不碰 `extensions/`、`.pi/`、`docs/feeds/`、`docs/security/` 和使用者其他未提交的文件。
- [ ] Hold the review gate. LD1 and LD2 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 仓库没有全局 lint，以 `just test` 全绿和 `node docs/modules/architecture/check.mjs` 全绿为准。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `deslop` 未安装，用内置 `simplify` 代替。`no-comments` 用 `pstack:comment-sicko` 子任务代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`. 仓库没有 Bugbot，记一行 skip。
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. 叠放的 LD2 rebase 到 LD1。
- [ ] 推送前查私人信息。`git diff main... | rg -n '/Users/|@gmail|szou'` 没有输出。

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict. 本次 owner 自己在 head 上跑十条 lane 和 perf，审查由调用方的根会话做。
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 不合并。每个 PR 在干净结论后停在 merge-ready，交给使用者。restack 后 `git patch-id` 不变的 PR 保留原结论。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本次在本机跑，每个故事用 harness 自己的临时状态目录，不碰 `~/.pi-super-agent`。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 宿主用 `tests/e2e/harness.ts` 的 `story` 起，假模型是 `tests/e2e/fake-model.ts`，提醒用 `tests/e2e/alert-feed-preload.mjs` 往临时目录放文件触发。不请求任何真实模型或行情接口。
- [ ] 输入只走网页（Playwright 点击和输入）和临时目录里的提醒文件。只读诊断是宿主日志、`page-console.log` 和 `/events` 的帧。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. 本次十条 lane 是一个脚本，截图存 `PSA_LD_SHOTS` 指的目录（默认 `tests/e2e/.out/<pr-id>/`），跑的时候设成 `/tmp/swarm-<pr-id>/owner/`。

## 把左栏改成收件箱，右栏改成带数字的标签页 (LD1)

**Depends on.** None.

**Files.**

- [ ] Create `docs/web-client/layout-d-plan.md`（本文件），作为 LD1 的第一个提交。
- [ ] Edit `src/web/view.mjs`。加右栏状态和它的纯函数，加标签上的数字、今天的提醒、模块行。
- [ ] Edit `src/web/app.mjs` 和 `src/web/index.html`。左栏只画待你处理和进行中，右栏画标签和五个面板。
- [ ] Edit `src/client/protocol.ts`、`src/host/host.ts`、`src/kernel/kernel.ts`。看板带上今天的提醒（`alerts`）。
- [ ] Edit `tests/web.test.ts`，加右栏状态、标签数字、今天提醒的用例。
- [ ] Create `tests/e2e/layout.e2e.ts`（十条 lane、perf 和评审录像）。Edit 受布局影响的 e2e（`modules.e2e.ts`、`tripwire.e2e.ts`、`avatars.e2e.ts` 等）。

**Build.**

- [ ] 右栏状态 `Panel` 和 `panelStep(panel, event)`（`view.mjs`）。状态是 `{ showing, task, last, flash }`，事件是选标签、打开任务、关任务、来了提醒。打开任务时任务标签排在最前并切过去；切到别的标签任务标签留着；× 关掉回到最后看的那个标签；提醒属于某个任务就打开那个任务，否则切到「今天」并高亮这条提醒。
- [ ] 标签数字 `overviewTabs(view, panel)`（`view.mjs`）。今天 = 今日来源消息数 + 今日提醒数，来源 = 关注的来源数，模块 = 模块数，已完成 = 已完成任务数。任务标签写「任务 #<编号前 4 位>」。
- [ ] 看板加 `alerts`（今天的提醒，本地日，按先后），`Kernel.alertsToday()` 一条 SQL 取出。
- [ ] 左栏只剩「待你处理」和「进行中」，卡片紧凑（最新进展最多两行），选项按钮还在卡片上。
- [ ] 右栏五个面板。今天（今日来源消息、今日提醒）、来源（原来的关注的来源）、模块（一行一个带开关，「详情 ›」里是完整的模块卡）、已完成、任务（提问和选项、执行过程）。在岗助手一排不动。

**You see.**

- [ ] 1440 宽打开网页，三栏都在，左栏只有「待你处理」「进行中」，右栏停在「今天」，四个标签都带数字。
- [ ] 点一张卡，右栏最前面出现「任务 #xxxx ×」并切过去。切到「模块」再点 ×，停在「模块」；在任务标签上点 ×，回到点卡之前的标签。
- [ ] 放一条提醒，右栏一秒内切到「今天」，这条提醒高亮。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/web.test.ts` 加 `panelStep` 的用例（打开、切走后任务标签还在、× 回到上一个、提醒带任务和不带任务两种、重复打开同一个任务）、`overviewTabs` 的数字和任务标签、`todayAlerts` 的文案，先红后绿。Run `just test`.
- [ ] `tests/host.test.ts` 或 `tests/web.test.ts` 加看板帧带今天提醒的用例，先红后绿。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个 Playwright 脚本 `tests/e2e/layout.e2e.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 用同一组假模型脚本和模块包，各开一个带选项的受阻任务，在左栏卡片上点选项。trunk 没有标签页，记下这一点，只比较两边都有的行为。Save `ld1-regression.png`. Pass when 两边左栏卡片上都有选项按钮，点了都显示「已发送」，head 的右栏没选任务时不是空的。
- [ ] Lane 2. 1440 宽浅色，没选任务。Save `ld1-default-light-1440.png`. Pass when 左栏只有两段，右栏「今天」选中，四个标签的数字和看板一致，没有横向滚动。
- [ ] Lane 3. 点左栏受阻卡片。Save `ld1-task.png`. Pass when 右栏第一个标签是「任务 #xxxx」且选中，面板里有标题、提问、选项按钮和执行过程，左栏卡片描边。
- [ ] Lane 4. 任务标签不随切换消失。Save `ld1-task-stays.png`. Pass when 切到「模块」后任务标签还在；回到任务标签内容不变；在任务标签上点 × 回到「模块」，任务标签消失。
- [ ] Lane 5. 来了一条不属于任务的提醒。Save `ld1-alert.png`. Pass when 右栏在「来源」时放一条提醒，两秒内切到「今天」，这条提醒带高亮，「今天」的数字加 1，任务标签还在。
- [ ] Lane 6. 在任务标签里点选项。Save `ld1-answer.png`. Pass when 任务标签里和左栏卡片上的同一个选项都显示已选，幕僚长收到回答。
- [ ] Lane 7. 「模块」标签。Save `ld1-modules.png`. Pass when 一个模块一行带开关；点 stock-ta 的开关两秒内变成开；点「详情 ›」出现完整模块卡。
- [ ] Lane 8. 「来源」和「已完成」标签。Save `ld1-sources.png`、`ld1-done.png`. Pass when 来源行写今日提醒数；已完成列出做完的任务，点它打开任务标签，× 回到「已完成」。
- [ ] Lane 9. 1024 宽浅色和深色、1440 宽深色。Save `ld1-light-1024.png`、`ld1-dark-1024.png`、`ld1-dark-1440.png`. Pass when 三栏都在，对话区不窄于 400 像素，没有横向滚动，标签文字对比度不低于 4.5 比 1。
- [ ] Lane 10. 刷新和键盘。Save `ld1-keyboard.png`. Pass when 刷新后右栏回到「今天」；用 Tab 走到标签，方向键切换标签，`aria-selected` 跟着变。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 看板推送一次的字节数，和每次看板推送页面重画的脚本加排版耗时（Chrome `Performance.getMetrics` 的 `ScriptDuration` 加 `LayoutDuration`，按推送次数平均）。
- [ ] Probe. trunk 和 head 用同一组模块包和任务，交替各跑 5 轮，每轮切 10 次模块开关产生 20 次推送。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 每次推送的字节数比 trunk 多出超过「今天的提醒数 × 200 字节 + 50 字节」就失败；每次推送的重画耗时中位数超过 trunk 的 1.5 倍且多出 2 毫秒以上就失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 5 and 7 screenshots into `docs/web-client/evidence/ld1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `docs/web-client/evidence/ld1-review.webm`. 本机用 Playwright 录像。
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## 手机上用底部标签栏，概况里分四段 (LD2)

**Depends on.** LD1.

**Files.**

- [ ] Edit `src/web/index.html`（底部标签栏和窄屏样式）、`src/web/app.mjs`、`src/web/view.mjs`（手机当前屏的状态）。
- [ ] Edit `tests/web.test.ts`。Create `tests/e2e/layout-phone.e2e.ts`。

**Build.**

- [ ] 手机当前屏 `screen`（待办、对话、概况）放进同一个右栏状态，`panelStep` 加选屏事件。打开任务在手机上推进一屏任务详情，左上「‹ 返回」回到点之前的屏。
- [ ] 窄屏（不超过 760 像素）时一次只显示一屏，底部固定标签栏三项，「待办」带待你处理的数字；「概况」顶上是今天、来源、模块、已完成四段，跟桌面右栏同一套状态。
- [ ] 提醒来了，概况的分段照桌面规则切换，不把人从当前屏拉走，「概况」标签带一个提醒点。

**You see.**

- [ ] 390 宽打开网页，默认是「待办」，底部三个标签，「待办」上有数字。
- [ ] 点「概况」，顶上四段；点「模块」，一行一个带开关。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/web.test.ts` 加选屏、手机上打开和返回任务、提醒只切分段不切屏、提醒点在进入概况后消失的用例，先红后绿。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个 Playwright 脚本 `tests/e2e/layout-phone.e2e.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都用 390 宽打开同一个带受阻任务的状态。trunk 没有底部标签栏，记下这一点。Save `ld2-regression.png`. Pass when 两边都能在受阻卡片上点选项，head 有底部标签栏且没有横向滚动。
- [ ] Lane 2. 默认屏。Save `ld2-todo.png`. Pass when 显示「待办」，只有待你处理和进行中，「待办」标签上的数字等于待你处理数。
- [ ] Lane 3. 「对话」屏。Save `ld2-chat.png`. Pass when 对话和输入框占满一屏，发一句话后出现在对话里，输入框不被底栏挡住。
- [ ] Lane 4. 「概况」屏和四段。Save `ld2-overview.png`. Pass when 顶上四段，默认「今天」，切到「来源」「已完成」内容跟着变。
- [ ] Lane 5. 「概况 · 模块」的开关。Save `ld2-modules.png`. Pass when 点 stock-ta 的开关两秒内变成开。
- [ ] Lane 6. 点任务推进详情。Save `ld2-task.png`. Pass when 详情占满一屏，有提问、选项和执行过程，「‹ 返回」回到「待办」。
- [ ] Lane 7. 在「对话」屏时来了一条提醒。Save `ld2-alert.png`. Pass when 还停在「对话」，「概况」标签出现提醒点；点「概况」看到「今天」里这条提醒高亮，提醒点消失。
- [ ] Lane 8. 深色 390 宽。Save `ld2-dark.png`. Pass when 底栏和分段文字对比度不低于 4.5 比 1，没有横向滚动。
- [ ] Lane 9. 宽度在 390 和 1024 之间来回。Save `ld2-resize.png`. Pass when 1024 宽回到三栏，打开着的任务标签还在；回到 390 宽显示任务详情。
- [ ] Lane 10. 1440 宽桌面不受影响。Save `ld2-desktop.png`. Pass when 没有底部标签栏，三栏布局和 LD1 的截图一致。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 390 宽下每次看板推送页面重画的脚本加排版耗时，和切一次底部标签的耗时。
- [ ] Probe. LD1 head（trunk 一侧）和 LD2 head 用同一组模块包，交替各跑 5 轮，每轮切 10 次模块开关；LD2 另外每轮切 20 次底部标签。
- [ ] Baseline. Record the LD1 中位数 first.
- [ ] Rule. 每次推送的重画耗时中位数超过 LD1 的 1.5 倍且多出 2 毫秒以上就失败；切一次底部标签的中位数超过 16 毫秒就失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 4, 6 and 7 screenshots into `docs/web-client/evidence/ld2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `docs/web-client/evidence/ld2-review.webm`. 本机用 Playwright 录像，390 宽。
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

**设计稿。** 现状和方案 A、B、C、D 的整页稿（1440 宽、390 宽，浅色和深色）是一次性的 HTML，在会话临时目录，没有提交。使用者选了 D，并回答了五个问题：标签放右栏；在岗助手一排保留；提醒来了右栏自动切换（属于任务就开任务标签，否则切「今天」并高亮）；任务标签切走后留着，直到点 ×；手机用底部标签栏。

**提醒和任务的关系。** 读代码确认，盯盘提醒（ADR-0017 的 alert）由来源直接贴给使用者，不经过幕僚长，也不开任务，提醒行上没有任务编号。所以「提醒属于某个任务」这一支今天没有来源会走到，`panelStep` 按提醒带的任务编号处理并有单元测试，网页上的提醒都走「切到今天并高亮」。

**还没证明的。** 1024 宽时对话区还有多宽，LD1 的 lane 9 量。

## Appendix B. Alternatives rejected

- **标签放左栏（设计稿里「对比：标签放左栏」）。** 右栏又回到竖着堆，来源或模块一多就要滚动。使用者选了右栏。
- **右栏按需收起（方案 B）。** 收起时对话区宽度会变，模块开关不总在主页面上。
- **把「今天」的提醒从对话行里在页面上筛出来。** 清屏以后和对话只保留最近若干行以后会少算，所以由宿主在看板里带上今天的提醒。
- **提醒来了只在「今天」上加数字，不切换。** 设计稿原来是这样画的，使用者改成自动切换。

## Appendix C. Risks

- **现有 e2e 依赖左栏结构。** 二十来个 e2e 用 `#left .card`、`#done`、`.watch`、`.card.module` 找元素。LD1 让待你处理和进行中仍在 `#left`，`#done`、`#how`、`#steps` 这些 id 搬到右栏面板里保留，只改需要先点标签的几个 e2e。owner 跑全量 `just e2e` 确认。
- **Control skill 未安装。** 用 `tests/e2e/harness.ts` 的 Playwright 代替 `control-ui`，lane 和录像都在本机无头 Chromium 里跑。
- **看板变大。** 今天的提醒每条一行，一天最多几十条（同一来源同一 `externalId` 只存一次）。LD1 的 perf 守住每条 200 字节以内。
- **窄屏断点。** LD1 保留现有 900 像素以下的竖排，LD2 换成底部标签栏，断点定在 760 像素，900 到 760 之间仍是三栏。LD2 的 lane 9 看来回切换。

## Appendix D. Links and reading list

- `docs/web-client/look-and-feel-plan.md`，之前的观感改版，配色、头像和文字说法不变。
- `docs/web-client/copy.md`，界面用语规范。
- `docs/adr/0017-a-source-can-speak-to-the-user-directly.md`，提醒和收据。
- 两个 PR 都不跑 `pstack/skills/how/SKILL.md` 和 `pstack/skills/interrogate/SKILL.md`，布局已经由使用者在设计稿上定了。决策记录写在每个 PR 的报告里。
