# 网页观感改版计划

使用者觉得网页全是文字，有点枯燥。设计稿已经确认（https://claude.ai/artifact/2UxShL71yFXg8Nm5kprBYk）。本计划把它做进网页，分五个 PR。
三栏布局、配色、明暗主题和现有的文字说法都不变，只加头像、图标、报价卡和小图。
报价卡和走势线只用助手和成员已经查到的数据，不为画图多查一次。
PR 顺序是 L1、L2、L3、L4、L5，依次叠在上一个之上。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并全部 PR。L1 到 L5 都停在 merge-ready，等使用者点合并。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick. 本机 pstack 不在本仓库里，用插件缓存 `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/` 代替 `git show origin/main:`。
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/architect/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/tdd/SKILL.md`
  - [ ] Control skill `control-ui` 未安装，live lane 用 Playwright（`tests/e2e/harness.ts` 起真宿主和无头浏览器）驱动，见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 使用者在会话中逐个 PR 推进时不开，交给无人值守时再开。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] L1 is first. It branches from `main` as `psa/look-avatars`.
  - [ ] L2 after L1, on `psa/look-steps`.
  - [ ] L3 after L2, on `psa/look-sources`.
  - [ ] L4 after L3, on `psa/look-quote-data`.
  - [ ] L5 after L4, on `psa/look-quote-card`.
- [ ] Hold the file boundaries. 五个 PR 都改 `src/web/app.mjs`、`src/web/view.mjs` 和 `src/web/index.html`，所以按顺序叠放，不并行写。宿主和内核的改动只在 L2（`src/host/dispatch.ts`、`src/host/workers.ts`）、L3（`src/kernel/kernel.ts`、`src/host/host.ts`、`src/client/protocol.ts`）和 L4（`src/kernel/store.ts`、`src/kernel/kernel.ts`、`src/host/workers.ts`）。
- [ ] Hold the review gate. L1 到 L5 都改变使用者看到的界面。They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 本仓库没有 lint 和 tsc，用 `just test` 代替。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `/deslop` 未安装，用 Comment Sicko 加 owner 逐行审 diff 代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 按 autopilot-stack，root 把 PR 停在 merge-ready，使用者自下而上合并。Rebase 后 patch-id 不变时，上一次的结论仍然有效（`playbooks/shipping.md` 的 patch-id 规则）。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本机没有这两个技能，每条 lane 在自己的 git worktree 里跑。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 用 `tests/e2e/harness.ts` 的 `startHost` 起一个临时状态目录的真宿主，模型换成 `tests/e2e/fake-model.ts`，行情接口用 L4 加的 fetch 替身预加载。等网页能连上。
- [ ] 只通过 Playwright 点击和输入，只通过页面读结果。宿主日志和状态库只读。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## 给助手、领队和成员加头像 (L1)

**Depends on.** None. 从 `main` 开分支。

**Files.**

- [ ] Edit `src/web/view.mjs`.
- [ ] Edit `src/web/app.mjs`.
- [ ] Edit `src/web/index.html`.
- [ ] Edit `tests/web.test.ts`.
- [ ] Create `tests/e2e/avatars.e2e.ts`.

**Build.**

- [ ] 在 `view.mjs` 加纯函数 `avatarOf(row)`，返回首字、形状（单个助手圆形，领队方形加冠标）和颜色（沿用 `helperTint`）。
- [ ] 加 `memberAvatars(titles)`，取职称首字，颜色按职称散列取色，首字相同时取前两字。
- [ ] 卡片头部、助手条小卡和执行过程头部都换成同一个头像。助手条保留现有的在岗圆点。
- [ ] 团队任务的卡片底部画叠放的成员头像，后面是现有的 `teamWork` 文案。

**You see.**

- [ ] 截图里同一个任务在卡片、助手条和执行过程头部是同一个首字、同一个颜色。领队是方形加冠标，对话助手是圆形。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/web.test.ts` 加 `avatarOf` 和 `memberAvatars` 的用例：单个助手、领队、模块已删的领队、首字相同的两位成员。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 和 head 各开一个对话任务。trunk 没有头像，记下这一点，只核对 head 的卡片头部。Save `l1-regress.png`. Pass when head 的卡片头部有圆形头像且标题、名字一字不差。
- [ ] Lane 2. 开一个团队任务。Save `l1-leader.png`. Pass when 卡片头像是方形加冠标。
- [ ] Lane 3. 团队任务派给两位成员。Save `l1-members.png`. Pass when 卡片底部叠着两个成员头像，后面写「派给」和两个职称。
- [ ] Lane 4. 同一任务看三处。Save `l1-same-tint.png`. Pass when 卡片、助手条、执行过程头部的头像颜色和首字一致。
- [ ] Lane 5. 切到亮色主题。Save `l1-light.png`. Pass when 头像文字和底色的对比度不低于 4.5 比 1。
- [ ] Lane 6. 手机宽度 390 像素。Save `l1-phone.png`. Pass when 页面没有横向滚动，头像不挤压标题。
- [ ] Lane 7. 领队独自完成的任务。Save `l1-solo.png`. Pass when 卡片底部只有「领队独自完成」，没有成员头像。
- [ ] Lane 8. 模块被删后重启宿主。Save `l1-orphan.png`. Pass when 领队头像仍在，名字写「领队 #N」。
- [ ] Lane 9. 读屏检查。Save `l1-a11y.png`. Pass when 每个头像都是 `aria-hidden`，旁边的名字文字仍可读。
- [ ] Lane 10. 十二个在岗任务。Save `l1-strip.png`. Pass when 助手条换行，每枚小卡都有头像和在岗圆点。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 收到一帧看板后左栏重画用时（毫秒），50 张卡片。
- [ ] Probe. 在 trunk 和 head 交替跑五轮，用 Playwright 的 `performance.now()` 包住 `renderLeft`。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 中位数比 trunk 慢 5 毫秒以上即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3 and 4 screenshots into `tests/e2e/.out/review/L1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/L1-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者在 PR 页面点合并。

## 给执行过程加图标和派活分支 (L2)

**Depends on.** L1.

**Files.**

- [ ] Edit `src/host/dispatch.ts`.
- [ ] Edit `src/client/board-format.mjs`.
- [ ] Edit `src/web/view.mjs`.
- [ ] Edit `src/web/app.mjs`.
- [ ] Edit `src/web/index.html`.
- [ ] Edit `tests/dispatch.test.ts`.
- [ ] Edit `tests/web.test.ts`.

**Build.**

- [ ] `TOOL_STEP` 每种工具加一个图标名，`index.html` 里用 `<template>` 放线条图标。
- [ ] `DispatchDesk.live()` 的每条派活加 `runningMs` 和 `limitMs`，派活结束的 `DispatchOutcome` 也加 `limitMs`，刷新后已结束的分支仍能画出来。
- [ ] 一轮里并行的派活画成几条并列的分支：成员头像、状态、已用时间和时限。进度条只在进行中显示，按已用时间除以时限，悬停写明「按时限折算，不是完成度」。

**You see.**

- [ ] 执行过程里每一步左边是图标。派给两位成员时出现两条并列分支，各有头像、状态和「已用 38 秒 · 时限 15 分钟」。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/dispatch.test.ts` 加用例：`live()` 带出 `runningMs` 和 `limitMs`，能写文件的成员时限是 60 分钟。`tests/web.test.ts` 加分支的状态和文案用例。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都打开同一个查价任务的执行过程。Save `l2-regress.png`. Pass when head 的步骤数和标题与 trunk 相同，只多了图标。
- [ ] Lane 2. 派给两位成员。Save `l2-lanes.png`. Pass when 出现两条并列分支，各有头像和状态。
- [ ] Lane 3. 成员进行中。Save `l2-progress.png`. Pass when 进度条写「已用 N 秒 · 时限 15 分钟」。
- [ ] Lane 4. 两位都完成后刷新页面。Save `l2-reload.png`. Pass when 两条分支仍在，写「完成」和用时。
- [ ] Lane 5. 成员超时。Save `l2-timeout.png`. Pass when 那条分支写「超时」，进度条消失。
- [ ] Lane 6. 能写文件的成员。Save `l2-coding.png`. Pass when 时限写 60 分钟。
- [ ] Lane 7. 每种工具各调一次。Save `l2-icons.png`. Pass when 每一步都有图标，没有空白占位。
- [ ] Lane 8. 亮色主题。Save `l2-light.png`. Pass when 图标和状态文字对比度不低于 4.5 比 1。
- [ ] Lane 9. 手机宽度。Save `l2-phone.png`. Pass when 分支竖排，没有横向滚动。
- [ ] Lane 10. 读屏检查。Save `l2-a11y.png`. Pass when 图标都是 `aria-hidden`，进度条有文字说明。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 打开一个有 40 步、4 次派活的执行过程的渲染用时（毫秒）。
- [ ] Probe. trunk 和 head 交替各五轮，Playwright 量点击卡片到右栏画完的时间。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 中位数比 trunk 慢 20 毫秒以上即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3 and 7 screenshots into `tests/e2e/.out/review/L2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/L2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者在 L1 合并后点合并。

## 把计数改成大数字，来源加小柱图 (L3)

**Depends on.** L2.

**Files.**

- [ ] Edit `src/kernel/kernel.ts`.
- [ ] Edit `src/host/host.ts`.
- [ ] Edit `src/client/protocol.ts`.
- [ ] Edit `src/web/view.mjs`.
- [ ] Edit `src/web/app.mjs`.
- [ ] Edit `src/web/index.html`.
- [ ] Edit `tests/kernel.test.ts`.
- [ ] Edit `tests/web.test.ts`.

**Build.**

- [ ] 内核加 `triggerCountsByHourToday()`，在现有索引 `triggers_today` 上按来源和小时分组。
- [ ] `TodayCounts` 加 `bySourceHour`，看板帧和快照都带上。
- [ ] 「待你处理」和「进行中」改成两个大数字。每个关注的来源旁画今日按小时的小柱图，长说明收进悬停提示。

**You see.**

- [ ] 左栏顶部两个大数字。美股行情旁有一条小柱图，柱数和今日小时数一致。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/kernel.test.ts` 加用例：跨午夜的触发不计入今天，对话和 watchdog 来源不计。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 各投 3 条 toy-market 触发。Save `l3-regress.png`. Pass when 两边「今日来源消息」数字相同，head 多一条小柱图。
- [ ] Lane 2. 有一个待处理问题。Save `l3-big.png`. Pass when 「待你处理」大数字是 1。
- [ ] Lane 3. 分三个小时投触发（假时钟）。Save `l3-bars.png`. Pass when 小柱图有三根柱。
- [ ] Lane 4. 新触发到达。Save `l3-live.png`. Pass when 不刷新页面，柱高就更新。
- [ ] Lane 5. 跨过纽约午夜。Save `l3-midnight.png`. Pass when 柱图清零。
- [ ] Lane 6. 没有任何触发的来源。Save `l3-empty.png`. Pass when 柱图是一条灰线，不报错。
- [ ] Lane 7. 悬停来源。Save `l3-tooltip.png`. Pass when 提示里是原来的完整说明。
- [ ] Lane 8. 亮色主题。Save `l3-light.png`. Pass when 大数字和柱图对比度达标。
- [ ] Lane 9. 手机宽度。Save `l3-phone.png`. Pass when 两个大数字并排，没有横向滚动。
- [ ] Lane 10. 读屏检查。Save `l3-a11y.png`. Pass when 柱图有 `aria-label` 写明各小时条数。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 宿主生成一帧看板的用时（毫秒），状态库里有 5000 条今日触发。
- [ ] Probe. trunk 和 head 交替各五轮，在 `#boardState` 前后计时。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 中位数比 trunk 慢 3 毫秒以上即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3 and 9 screenshots into `tests/e2e/.out/review/L3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/L3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者在 L2 合并后点合并。

## 记下任务查到的行情，卡片加迷你报价 (L4)

**Depends on.** L3.

**Files.**

- [ ] Edit `src/kernel/store.ts`.
- [ ] Edit `src/kernel/kernel.ts`.
- [ ] Edit `src/kernel/types.ts`.
- [ ] Edit `src/host/workers.ts`.
- [ ] Edit `src/web/view.mjs`.
- [ ] Edit `src/web/app.mjs`.
- [ ] Create `tests/e2e/fake-market.mjs`.
- [ ] Edit `tests/lookup.test.ts`.
- [ ] Edit `tests/kernel.test.ts`.

**Build.**

- [ ] 新表 `ticket_market(ticket_id, symbol, ...)`，只存摘要。每个代码存最新一条报价（价格、前收盘、涨跌幅、报价时间、是否延迟），当天的分钟或小时 K 线降采样到 48 个点，再加最后一次 `session` 的交易时段。类型叫 `MarketDigest`，避开已有的 `Quote`（引用）。
- [ ] `WorkerExecutor.handleRequest` 的 `worker.lookup` 在拿到结果后记一份，助手和成员查的都算，记完主动推一帧看板。
- [ ] 看板行加 `market`，行情任务的卡片加一行迷你报价：代码、价格、涨跌（颜色加 ▲▼）、有当日 K 线时画走势线。
- [ ] 涨跌颜色默认红涨绿跌，跟设计稿一致。

**You see.**

- [ ] 「NVDA 现在多少钱」的卡片里有一行 NVDA 170.48 ▼4.58%。助手查过当日 K 线时有走势线，没查过就没有线。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/lookup.test.ts` 加用例：查报价后看板行带摘要，查日线不画走势线，查失败不记，宿主重启后摘要还在。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都问「NVDA 现在多少钱」，行情接口用 fetch 替身。Save `l4-regress.png`. Pass when 两边回复文字一致，head 卡片多一行迷你报价。
- [ ] Lane 2. 下跌的报价。Save `l4-down.png`. Pass when 显示 ▼ 和绿色。
- [ ] Lane 3. 上涨的报价。Save `l4-up.png`. Pass when 显示 ▲ 和红色。
- [ ] Lane 4. 助手查了当日分钟线。Save `l4-line.png`. Pass when 有走势线，终点等于报价。
- [ ] Lane 5. 只查了日线。Save `l4-noline.png`. Pass when 没有走势线。
- [ ] Lane 6. 查三只股票。Save `l4-three.png`. Pass when 卡片最多显示两只，写「另 1 只」。
- [ ] Lane 7. 重启宿主后。Save `l4-restart.png`. Pass when 迷你报价还在。
- [ ] Lane 8. 成员查的报价。Save `l4-member.png`. Pass when 也记在这个任务上。
- [ ] Lane 9. 行情接口报错。Save `l4-error.png`. Pass when 卡片不显示迷你报价，不显示错误数字。
- [ ] Lane 10. 手机宽度。Save `l4-phone.png`. Pass when 迷你报价一行放得下，没有横向滚动。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一次 `worker.lookup`（报价）从请求到返回的用时（毫秒），和一帧看板的生成用时。
- [ ] Probe. trunk 和 head 交替各二十次，fetch 替身固定延迟 50 毫秒。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. lookup 中位数慢 5 毫秒以上，或看板帧慢 3 毫秒以上即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 4 and 5 screenshots into `tests/e2e/.out/review/L4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/L4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者在 L3 合并后点合并。

## 在幕僚长的回复下画报价卡 (L5)

**Depends on.** L4.

**Files.**

- [ ] Edit `src/web/view.mjs`.
- [ ] Edit `src/web/app.mjs`.
- [ ] Edit `src/web/index.html`.
- [ ] Edit `tests/web.test.ts`.
- [ ] Create `tests/e2e/market-card.e2e.ts`.

**Build.**

- [ ] 加纯函数 `marketCardLine(view)`，仿照 `choicesInConversation`，为每个有行情摘要的任务找它最后一条幕僚长回复。
- [ ] 回复下面留一个可重新填充的位置（像 `.choices[data-line]`），每帧看板到达时由 `renderMarketCards` 重画。
- [ ] 卡片内容：代码、大号价格、涨跌额和涨跌幅、当日走势、「延迟行情」标签、报价时间。只有助手查过 `session` 时才写交易时段，不自己推算。

**You see.**

- [ ] 截图里幕僚长那条「NVDA 最新可得报价为 170.48 美元…」下面有一张报价卡，价格和文字里的一致。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/web.test.ts` 加用例：卡片挂在最后一条回复下，没有行情摘要的任务不挂，直接回答（没有任务编号）不挂。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都问「NVDA 现在多少钱」。Save `l5-regress.png`. Pass when 两边气泡文字一致，head 下面多一张报价卡。
- [ ] Lane 2. 卡片和文字对得上。Save `l5-match.png`. Pass when 卡片价格和气泡里的价格相同。
- [ ] Lane 3. 回复先到、报价摘要后到。Save `l5-late.png`. Pass when 摘要到达后卡片补画上去。
- [ ] Lane 4. 同一任务追问一次。Save `l5-followup.png`. Pass when 卡片只挂在最后一条回复下。
- [ ] Lane 5. 不是行情的任务。Save `l5-none.png`. Pass when 没有报价卡。
- [ ] Lane 6. 查过 `session`。Save `l5-session.png`. Pass when 卡片写「已休市」。
- [ ] Lane 7. 没查 `session`。Save `l5-nosession.png`. Pass when 卡片不写交易时段。
- [ ] Lane 8. 清屏后再开。Save `l5-clear.png`. Pass when 清屏的行不再显示卡片，新回复照常挂卡。
- [ ] Lane 9. 亮色主题。Save `l5-light.png`. Pass when 价格和标签对比度达标。
- [ ] Lane 10. 手机宽度。Save `l5-phone.png`. Pass when 卡片竖排，没有横向滚动。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 对话里有 200 条消息、20 张报价卡时，一帧看板到达后的重画用时（毫秒）。
- [ ] Probe. trunk 和 head 交替各五轮，Playwright 量 `renderMarketCards` 和现有 `renderChoices` 的总时间。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 中位数比 trunk 慢 10 毫秒以上即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 6 screenshots into `tests/e2e/.out/review/L5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/L5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者在 L4 合并后点合并。

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

- 设计稿就是原型：https://claude.ai/artifact/2UxShL71yFXg8Nm5kprBYk ，使用者 2026-11-10 确认五处都做。
- 数据来源由代码核对确定，没有需要实验才能回答的问题。报价只有 `workers.ts` 的 `worker.lookup` 同时拿得到任务、操作和结果。幕僚长的回复行已经带着任务编号（`kernel.ts` 的 `#lines`）。按小时计数能走现有索引 `triggers_today`。
- 还没有证明的一点是，行情的 fetch 替身能不能用 `startHost` 的 `--import` 预加载接进 e2e。L4 先做这个，做不通时退回到 `tests/lookup.test.ts` 那样的假数据源单元测试。

## Appendix B. Alternatives rejected

- 每帧看板都从会话文件里解析行情：文件可能有几兆，太重。
- 自己算交易时段：设计要求只用助手查过的数据，没查 `session` 就不写。
- 进度条按成员自报的完成度：成员不报告完成度，只能按时限折算，所以悬停写明。
- 五个 PR 并行：都改 `app.mjs`、`view.mjs` 和 `index.html`，并行会互相冲突。

## Appendix C. Risks

- `control-ui` 未安装（全部 PR）：live lane 用 Playwright 加 `tests/e2e/harness.ts`。owner 在报告里写明是这种方式。
- 聊天行只画一次（L5）：报价卡必须放在可重新填充的位置，否则摘要晚到时卡片永远不出现。
- `afterCommand` 在 lookup 结果回来之前就推了看板（L4）：记完摘要要主动再推一帧。
- 成员首字相同（L1）：取前两字区分。
- 红涨绿跌和国际习惯相反（L4、L5）：颜色之外一定带 ▲▼。

## Appendix D. Links and reading list

- 设计稿：https://claude.ai/artifact/2UxShL71yFXg8Nm5kprBYk
- 先读 `docs/web-client/copy.md`（界面文案）、`GLOSSARY.md`（领队、团队）、ADR-0004（网页只是客户端）。
- L2 和 L4 改宿主，开工前跑 `pstack/skills/how/SKILL.md`。L4 新增状态库表，合并前跑 `pstack/skills/interrogate/SKILL.md`。
- 决策记录按 `pstack/skills/show-me-your-work/SKILL.md`，放 `.audit/look-and-feel.tsv`，不提交。
