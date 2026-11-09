# Web client plan

给 Super Agent 加一个浏览器客户端，让使用者在一个标签页里完成对话、看任务、看 Worker 过程和造测试数据，不再开三个终端窗口。
程序守的规则是 ADR-0003。网页只是宿主的又一个客户端，只有带启动 token 的本机浏览器能连上，宿主、内核和 Router 不改。
PR 顺序是 W1、W2、W3、W4，依次叠在上一个之上。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并全部 PR。W1 到 W4 都停在 merge-ready，等使用者点合并。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [x] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. 使用者 2026-11-08 说「写计划然后开始第一步」，只授权到 W1。
- [ ] Read these from trunk at program start. Re-read them at every tick. 本机 pstack 不在本仓库里，用插件缓存 `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/` 代替 `git show origin/main:`。
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/architect/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/tdd/SKILL.md`
  - [ ] Control skill `control-ui` 未安装，W1 到 W4 的 live lane 用 Playwright（`npx playwright`）驱动，见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 使用者在会话中逐个 PR 推进时不开，交给无人值守时再开。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] W1 is first. It branches from `main`.
  - [ ] W2 after W1, based on `psa/web-gateway`.
  - [ ] W3 after W2.
  - [ ] W5 after W4, stacked on `psa/e2e`. X1 branches from `main`.
  - [ ] T1 after W5, on `psa/teams` cut from `psa/helpers`; T2 on T1; T3 on T2. Design in ADR-0008. T1 到 T3 取代没有合并的 W6a 到 W6c（#30、#31、#32）。
  - [ ] W4 after W2 and the M1/F1 PRs, stacked on `psa/stable-token` (#24). W3 moved after W4, because it changes the page and waits for the user's review; W4 does not depend on it. 见决策记录 w4-order。
- [ ] Hold the file boundaries. W1 to W3 touch only `src/host/`, `src/web/`, `src/client/board-format.mjs`, `src/client/board.ts`, `tests/`, `justfile`, `docs/`. W1 起加入 `src/client/` 两个文件，让 TUI 和网页共用看板格式，见决策记录。 W4 adds `package.json`, `package-lock.json`, `.gitignore`, `tests/e2e/`, `demos/`, and `justfile`.
- [ ] Hold the review gate. W1, W2, W3 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge. W4 changes no interaction.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 本仓库没有 lint 和 typecheck 配置，以 `just test` 全绿为准。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `deslop` 未安装，用内置 `simplify` 代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 不合并。每个 PR 在干净结论后停在 merge-ready，交给使用者。restack 后 `git patch-id` 不变的 PR 保留原结论。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本机没有 cloud VM 和 `control-ui`，每个 lane 在本机独立的短状态目录里跑，用 Playwright 驱动浏览器。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 建状态目录 `D=$(mktemp -d /tmp/psa-XXXX)`，写 `config.json` 只用 `openai-codex/*` 模型，给每个 lane 不同的 `webPort`。运行 `PSA_STATE_DIR=$D just host`，等日志出现 `[host] 网页 http://127.0.0.1:<port>/?token=`。
- [ ] 只经 Playwright 打开日志里的网址并操作页面。造数据用 `PSA_STATE_DIR=$D just drop`、`just say`。只读诊断用 `just log` 和 `curl -i`。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Serve a read-only page from the host (W1)

**Depends on.** None.

**Files.**

- [x] Create `src/host/web.ts`.
- [x] Create `src/web/index.html`.
- [x] Edit `src/host/host.ts`.
- [x] Edit `src/host/config.ts`.
- [x] Create `tests/web.test.ts`.
- [x] Create `docs/adr/0004-web-client-on-localhost-with-a-token.md`.

**Build.**

- [x] 宿主启动时在 `127.0.0.1` 上开 HTTP 网关，端口取 `config.json` 的 `webPort`（默认 4517），每次启动生成新 token，日志打印带 token 的网址。
- [x] 网关校验 token 和 `Host` 头，推送用 SSE。先发 `snapshot`，之后转发 `user`、`reply`、`board`，和 Unix socket 客户端收到的消息相同。
- [x] 页面左边显示对话，右边显示看板（阶段、标题、依据、模型、用量、耗时），断线时显示「未连接」并自动重连。

**You see.**

- [x] 宿主日志出现 `[host] 网页 http://127.0.0.1:4517/?token=...`，打开后看到最近对话和看板。`just say 你好` 后页面一秒内出现这句话和之后的 Router 回复。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/web.test.ts` 覆盖：无 token 或错 token 返回 401，`Host` 头不是本机返回 403，SSE 先收到 snapshot，`host.say()` 后收到 `user`，看板变化后收到 `board`，`host.stop()` 关闭网关。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. trunk 没有网页，记录这一点。在 head 上用 `just client` 发一句话，确认 TUI 照常工作，同时网页也显示这句话。Save `w1-regression.png`. Pass when TUI 和网页都显示这句话和 Router 回复。脚本用 `say` 命令行代替 TUI，判定只看命令行收到回复。真 TUI 与网页同时收到同一句话由规格审计在 tmux 里手动跑过。
- [x] Lane 2. 打开日志里的网址。Save `w1-first-load.png`. Pass when 页面显示最近对话和看板，状态是「已连接」。脚本用的是空状态目录，只验证了已连接和看板存在。重连后补齐对话由 SIGSTOP 探测验证。
- [x] Lane 3. 去掉网址里的 token 再打开。Save `w1-no-token.png`. Pass when 返回 401，页面不显示任何对话内容。
- [x] Lane 4. 用 `curl -H 'Host: evil.example:4517'` 带正确 token 请求。Save `w1-bad-host.png`. Pass when 返回 403。
- [x] Lane 5. 页面打开时运行 `just say 你好`。Save `w1-live-say.png`. Pass when 一秒内出现「你> 你好」，之后出现 Router 回复。
- [x] Lane 6. 用 `just drop` 投递一条会建任务的触发。Save `w1-board-update.png`. Pass when 看板出现新任务，阶段随任务推进变化。外部投递按 ADR-0003 不能建任务，脚本改用使用者发话，判定只看卡片数增加，阶段变化只在截图里可见。
- [x] Lane 7. 页面打开时停掉宿主，再启动。Save `w1-reconnect.png`. Pass when 停掉后显示「未连接」，宿主重启并换新 token 后页面提示 token 失效，用新网址打开后恢复。
- [x] Lane 8. 同时开两个标签页。Save `w1-two-tabs.png`. Pass when 两个标签页显示相同的对话和看板。
- [x] Lane 9. 投递正文含 `<script>alert(1)</script>` 和换行的触发。Save `w1-escape.png`. Pass when 页面原样显示文字，不执行脚本，不弹框。
- [x] Lane 10. 端口被占用时启动宿主。Save `w1-port-busy.png`. Pass when 宿主打印一行说明端口被占用并退出，不留下半启动状态。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. trunk 和 head 都量 `host.say()` 到 Unix socket 客户端收到 `user` 的延迟。head 另量到 SSE 客户端收到 `user` 的延迟。
- [x] Probe. 一个脚本交替在 trunk 和 head 上启动测试宿主，各发 200 句，记录每句的两种延迟。
- [x] Baseline. Record the trunk socket p50 and p95 first.
- [x] Rule. head 的 socket p95 比 trunk 慢 2 毫秒以上算失败。SSE p95 超过 50 毫秒算失败。

**Review gate.** The operator reviews before merge.

- [x] Copy lane 2, 5, 6 screenshots into `docs/web-client/media/w1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `docs/web-client/media/w1-review.mp4`. 已录 webm 留在本地，不进仓库，见决策记录。
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者合并。

## Talk to the Router and watch a Worker from the page (W2)

**Depends on.** W1.

**Files.**

- [x] Edit `src/host/web.ts`.
- [x] Edit `src/web/index.html`.
- [x] Edit `tests/web.test.ts`.
- [x] Edit `src/web/app.mjs`.
- [x] Edit `src/web/view.mjs`.
- [x] Edit `src/host/host.ts`.
- [x] Create `docs/web-client/media/w2-layout-<variant>.png`. 布局在 Claude Design 画布上，见下一条。

**Build.**

- [x] 先定完整界面的布局，再写代码。按 `pstack/skills/poteto-mode/playbooks/prototype.md`，用 Artifact 工具的 Design 类型做两到三个布局方案，覆盖 W1 到 W3 的全部元素（对话、看板、底部输入框、Worker 过程侧栏、测试工具面板），放在一个可切换的原型里。目标是使用者一眼看出现在在干什么，结果不乱。使用者选定一个方案后，W2 按它实现，W3 沿用。
  - [x] 三个方案和选定的 A2 在画布 https://claude.ai/artifact/HUaH5gAKbLfXvvsNYA2Zo3 上。使用者选 A 的三栏布局，要浅色和深色两套主题，要求少一点技术味、讲清它和普通聊天软件的区别。结果记进 `docs/web-client/decisions.tsv`。
- [x] 按 A2 重做页面。顶部写明「你的 24 小时助理」和已运行多久。左栏依次是「待你处理」「进行中」「关注的来源」和「今日来源消息」。中间是对话和输入框。右栏是「执行过程」。用语按 `docs/web-client/copy.md`。浅色和深色跟随系统，也能手动切换。
- [x] 界面用产品化的说法。Router 就叫 Super Agent，Worker 叫「助手」。依据写成「你的请求」「规则触发」「主动发现」。任务编号、模型、用量只在右栏底部小字出现。
- [x] 宿主在快照里多给三样数据：启动时间（算运行时长，重启后显示「已重启，进行中的任务已恢复」），各模块的来源和规则（「关注的来源」），今天的触发计数和去向（「今日来源消息」）。
- [x] 任务卡显示最近一次汇报，不做进度条。进行中的任务有「停止」按钮，按下只在输入框里填好「停止任务「标题」」，由使用者发出。
- [x] `POST /say` 调 `onSay`，返回 `triggerId`。所有 POST 要求 token 加同源 `Origin`，防跨站请求。
- [x] 点任务，右栏打开「执行过程」，先显示历史，再实时追加。步骤写成大白话，原始工具调用可以展开看。一个连接同时只看一个任务，和 `/watch` 一致。
- [x] 页面底部输入框发话，发出后显示「已送达」或超时提示，规则和 TUI 的确认超时相同。

**You see.**

- [x] 在页面输入「帮我读一下 example.com 的网页标题」，对话里出现这句话和 Super Agent 的回复，左栏「进行中」出现这件事。点它，右栏实时显示助手每一步。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/web.test.ts` 加：POST `/say` 缺 token 401，跨源 `Origin` 403，正确请求返回 `triggerId` 并广播 `user`。查看任务先收到历史再收到实时消息，切换任务后不再收到旧任务的消息。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. 在 trunk（含 W1）和 head 上都用 `just say` 发同一句话。Save `w2-regression.png`. Pass when 两边网页都显示这句话和回复。
- [x] Lane 2. 在页面输入框发一句话。Save `w2-say.png`. Pass when 对话出现这句话，显示「已送达」，之后出现回复。
- [x] Lane 3. 发一句会建 Worker 任务的话，点看板上的新任务。Save `w2-watch.png`. Pass when 侧栏显示历史，并实时追加工具调用。
- [x] Lane 4. 查看中切到另一个任务。Save `w2-switch.png`. Pass when 侧栏只显示新任务的消息。
- [x] Lane 5. 从另一个本机端口的页面用 `fetch` 向 `/say` 发 POST。Save `w2-csrf.png`. Pass when 返回 403，对话没有新增。
- [x] Lane 6. 发空白输入。Save `w2-empty.png`. Pass when 不发出，不新增对话。
- [x] Lane 7. 暂停宿主进程（`kill -STOP`）后发话。Save `w2-ack-timeout.png`. Pass when 页面显示没送达的提示，恢复后对话里能看到或提示重发。
- [x] Lane 8. 网页和 TUI 同时在线，各发一句。Save `w2-mixed-clients.png`. Pass when 两边都按顺序显示两句话。
- [x] Lane 9. 查看一个已结束的任务。Save `w2-closed-ticket.png`. Pass when 侧栏显示完整历史，没有报错。
- [x] Lane 10. 发一句含 HTML 和 2000 字的话。Save `w2-long-text.png`. Pass when 原样显示，页面不卡，布局不撑破。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. trunk（含 W1）和 head 都量 `just say` 到页面显示的延迟。head 另量页面 POST `/say` 到收到 `ack` 的延迟。
- [x] Probe. Playwright 脚本交替在 trunk 和 head 上各发 50 句并读取页面时间戳。
- [x] Baseline. Record the trunk p95 first.
- [x] Rule. head 的 `just say` 路径 p95 比 trunk 慢 20 毫秒以上算失败。POST 到 ack 的 p95 超过 100 毫秒算失败。

**Review gate.** The operator reviews before merge.

- [x] Copy lane 2, 3, 4 screenshots into `docs/web-client/media/w2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `docs/web-client/media/w2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者合并。

## Add a test tools panel to the page (W3)

**Depends on.** W2.

**Files.**

- [ ] Edit `src/host/web.ts`.
- [ ] Edit `src/web/index.html`.
- [ ] Edit `tests/web.test.ts`.
- [ ] Edit `justfile`.

**Build.**

- [ ] 只有 `PSA_DEV=1` 时网关提供 `POST /dev/drop`、`POST /dev/toy-feed`、`GET /dev/log`，直接调用现有的 `dropTrigger` 和 `kernel.triggerLog`，不复制逻辑。
- [ ] 页面加「测试工具」面板，表单投递触发、发假行情，表格显示触发日志。没开 `PSA_DEV` 时面板不出现，接口返回 404。
- [ ] `justfile` 加 `just web`，以开发模式启动宿主并打开浏览器。

**You see.**

- [ ] `just web` 打开页面，在测试工具面板填「来源 test，线程 t1，正文 行情异常」，看板出现新任务，触发日志多一行。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/web.test.ts` 加：没开 `PSA_DEV` 时 `/dev/*` 返回 404，开了以后 drop 写入投递目录并进入触发日志，toy-feed 产生行情触发，参数缺失返回 400。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk（含 W2）和 head 上都用 `just drop` 投递同一条触发。Save `w3-regression.png`. Pass when 两边看板都出现任务。
- [ ] Lane 2. 用面板投递一条触发。Save `w3-drop.png`. Pass when 看板出现任务，触发日志多一行。
- [ ] Lane 3. 用面板发一条假行情。Save `w3-toy-feed.png`. Pass when 触发日志出现 toy-market 来源的一行。
- [ ] Lane 4. 不带 `PSA_DEV` 启动。Save `w3-no-dev.png`. Pass when 页面没有测试工具面板，`curl` 调 `/dev/drop` 返回 404。
- [ ] Lane 5. 面板正文留空提交。Save `w3-missing-field.png`. Pass when 页面提示缺少正文，投递目录没有新文件。
- [ ] Lane 6. 连续投递 20 条。Save `w3-burst.png`. Pass when 触发日志有 20 行，看板没有重复任务。
- [ ] Lane 7. 投递同一线程的两条触发。Save `w3-same-thread.png`. Pass when 第二条进入同一任务或按现有规则处理，和 `just drop` 行为一致。
- [ ] Lane 8. 触发日志表格。Save `w3-log-table.png`. Pass when 内容和 `just log` 一致。
- [ ] Lane 9. 跨源页面 POST `/dev/drop`。Save `w3-csrf.png`. Pass when 返回 403。
- [ ] Lane 10. 运行 `just web`。Save `w3-just-web.png`. Pass when 浏览器自动打开已连接的页面，测试工具面板可见。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk（含 W2）和 head 都量 `just drop` 到看板出现任务的时间。head 另量面板投递到看板出现任务的时间。
- [ ] Probe. 交替在 trunk 和 head 上各投递 30 条，读取页面看板时间戳。
- [ ] Baseline. Record the trunk p95 first.
- [ ] Rule. 面板投递的 p95 比 `just drop` 慢 200 毫秒以上算失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 8 screenshots into `docs/web-client/media/w3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `docs/web-client/media/w3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者合并。

## Run an end-to-end browser test against a fake model (W4)

**Depends on.** W2 and the M1/F1 stack (base `psa/stable-token`).

**Files.**

- [x] Create `package.json` and `package-lock.json` (only devDependency `playwright-core@1.59.1`, matching the cached chromium-1217).
- [x] Create `tests/e2e/fake-model.ts`, `tests/e2e/harness.ts`, `tests/e2e/story.e2e.ts`, `tests/e2e/dom.e2e.ts`.
- [x] Create `demos/` (demo 1 to 5 and their README, moved from the scratchpad and built on the harness).
- [x] Edit `.gitignore` and `justfile` (`e2e`, `demo`, `demo-market`).

**Build.**

- [x] 本地假模型 HTTP 服务按脚本回放 Router 和 Worker 的回复，宿主和 Worker 子进程都是真的。
- [x] Playwright 测试走完整故事：页面投递触发，看板出现任务，点开看 Worker 过程，Router 在对话里回复。
- [x] 同一套测试覆盖页面 DOM 层：宿主在同一状态目录重启后自己回到已连接（token 保持不变），`web-token-rotate` 换过 token 后显示链接失效，对话和看板里的 HTML 原样显示不执行，宿主卡死（SIGSTOP）时用 `page.clock` 快进离开已连接、SIGCONT 后回来。W1 的变异审计证明这几条目前没有自动测试。
- [x] 演示 1 到 5 进仓库：`just demo [名字]` 用有界面的浏览器和真实 openai-codex 模型，`just demo-market` 需要行情密钥；只按自己记录的进程组停进程。
- [x] `just e2e` 运行它。`just test` 不依赖浏览器，保持现状。

**You see.**

- [ ] `just e2e` 打印每一步的通过结果，失败时保存截图和页面日志。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] 故意让假模型返回错误回复，`just e2e` 失败并指出步骤。恢复后通过。Run `just e2e` and `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. trunk 没有 `just e2e`，记录这一点。在 head 上跑 `just test`。Save `w4-regression.png`. Pass when 测试数和 trunk 一样且全绿。
- [x] Lane 2. 干净 clone 后跑 `just e2e`。Save `w4-clean-clone.png`. Pass when 自动装好依赖并通过。
- [x] Lane 3. 连跑 `just e2e` 20 次。Save `w4-repeat.png`. Pass when 20 次全过。
- [x] Lane 4. 让假模型的 Router 回复错误。Save `w4-wrong-reply.png`. Pass when 测试失败并指出「Router 回复」这一步。
- [x] Lane 5. 让 Worker 子进程崩溃。Save `w4-worker-crash.png`. Pass when 测试失败并保存截图和日志。
- [x] Lane 6. 让端口被占用。Save `w4-port-busy.png`. Pass when 测试换端口或给出清楚的错误。
- [x] Lane 7. 机器负载高时跑（同时跑 `just test`）。Save `w4-under-load.png`. Pass when 仍然通过。
- [x] Lane 8. 检查跑完后的进程和临时目录。Save `w4-cleanup.png`. Pass when 没有残留宿主或 Worker 进程，临时目录已删除。
- [x] Lane 9. 检查假模型收到的请求。Save `w4-no-real-model.png`. Pass when 测试过程中没有请求真实模型的网络流量。
- [x] Lane 10. 打开失败报告。Save `w4-report.png`. Pass when 报告含失败步骤的截图和页面控制台日志。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. trunk 和 head 都量 `just test` 的总耗时。head 另量 `just e2e` 的总耗时。
- [x] Probe. 交替在 trunk 和 head 上各跑 5 次。
- [x] Baseline. Record the trunk `just test` median first.
- [x] Rule. head 的 `just test` 中位数比 trunk 慢 5% 以上算失败。`just e2e` 中位数超过 60 秒算失败。

**Review gate.** None. W4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者合并。

## Show the helpers working, and fill the window (W5)

**Depends on.** W4 (stacked on `psa/e2e`; the new page checks run in `just e2e`).

**Why.** 使用者 2026-11-09 试用后指出：看不到有几个助手在工作，界面上看不出助手存在过（起止时间、名字、token 用量、当前状态）；页面底部有一条空白。内核早已记录每个任务的 `startedAt`、`closedAt`/`stoppedAt`、`workerState`、`model`、`fellBack`、`toolCalls`、`tokensIn`/`tokensOut`，看板消息也带着大部分字段，只是页面没显示。

**Decisions (使用者选定).**

- [ ] 命名 = 角色名 + 个性化名字，显示为「青檀 · 行情助手 #2」。角色按任务来源：使用者的话 → 对话助手；行情来源（us-market、toy-market 这类 feed）触发的规则 → 行情助手；其他规则 → 规则助手；幕僚长主动发现 → 观察助手。`#N` 按角色、按纽约日期从 1 递增。名字取自约 60 个手选的 2 到 4 字词（如 青檀、观澜、知微、拾遗、远山、听松、墨衡、照夜、栖云、砚秋、闻溪），有品味、不用「小林」式人名；同一时刻在岗的助手不重名；名字、角色和序号在建任务时定下并存进状态库，重启不变。
- [ ] 位置 = 页头下方一条助手条：每个在岗助手一枚小卡（●运行中 / ◐空闲 / ○排队），写名字、角色序号、已用时、token；点它在右栏打开该任务的执行过程。条尾写「今日 N 位 · X tokens」。没有在岗助手时只留今日合计。

**Files.**

- [x] Edit `src/kernel/kernel.ts`, `src/kernel/types.ts` (tickets 加 helper_name、helper_role、helper_seq 三列，迁移旧库；DashboardRow 带上它们和 `startedAt`、`endedAt`、`workerState`)。
- [x] Create `src/kernel/helper-names.ts`（名字池与分配，纯函数）。
- [x] Edit `src/client/protocol.ts`, `src/host/host.ts`（看板带今日助手合计）。
- [x] Edit `src/web/index.html`, `src/web/app.mjs`, `src/web/view.mjs`, `src/client/board-format.mjs`（TUI 卡片也写助手名）。
- [x] Edit `docs/web-client/copy.md`（助手条、执行过程头部的用词）。
- [x] Edit `tests/kernel*.test.ts`, `tests/web.test.ts`, `tests/e2e/*.e2e.ts`。

**Build.**

- [x] 内核：建任务时分配角色、当日序号和名字；同一时刻在岗（未关闭且 worker 不是 none）的助手不重名，池用完时名字后加「·二」这类后缀；旧库迁移后已有任务按创建顺序补齐。
- [x] 看板：每行带助手名、角色、序号、`workerState`、`startedAt`、结束时间（closedAt 或 stoppedAt）、token；整体带「今日助手数、今日 token 合计」。
- [x] 页面：页头下助手条；任务卡片和执行过程头部写助手全名；执行过程头部加一行生命周期「开始 HH:MM · 结束 HH:MM 或 进行中 · 用时 · 模型（回退时注明）· 工具 N 次 · token 入/出」。
- [x] 页面高度：三栏恰好占满窗口，各栏自己滚动，整页不滚动、底部不留白（实测根因：对话气泡里读屏用的 `.sr` 绝对定位、没有定位祖先，落在窗口下方撑高整页；网格行高不是原因，见 decisions.tsv）。
- [x] 文案进 `docs/web-client/copy.md`，主语仍只用 幕僚长、助手、你。
- [x] 对话里你的每句话下面一行去向，取自这条触发记下的去向（triggers 表的 disposition 和 disposition_detail）：开了新任务写「已开新任务「标题」 · 助手全名」，交给已有任务写「已交给 助手全名（标题）」，幕僚长只回复没开任务写「幕僚长直接回答」，还在处理写「幕僚长处理中」，幕僚长判断不用处理写「幕僚长判断无需处理」。点这一行在右栏打开那个任务的执行过程。宿主在快照和每次看板推送里带上最近对话的去向，页面不刷新也会更新。原因：使用者 2026-11-09 发现幕僚长把「看下黄仁勋听证会的新闻」交给已有的 NVDA 新闻任务时，对话里没有任何回应，开新任务时却有。
- [x] 助手条小卡只留状态点（● ◐ ○），去掉扳手图标。

**You see.**

- [ ] 让幕僚长同时办两件事，页头出现两枚小卡，各写名字、角色序号、用时和 token；完成后小卡消失，「今日 N 位」加一；点小卡右栏打开对应执行过程，头部写生命周期。窗口拉高拉低，页面都不出现整页滚动和底部空白。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 名字分配：确定性、在岗不重名、池用完加后缀、序号按角色按纽约日期递增、迁移补齐。看板字段。view.mjs 渲染助手条和生命周期行。e2e：两个任务时出现两枚小卡、点小卡打开执行过程、`document.scrollingElement.scrollHeight === innerHeight`（长执行过程下）。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe, as one Playwright script on a real host with real openai-codex models.

- [ ] Lane 1. 同时提两件事。Save `w5-two-helpers.png`. Pass when 页头两枚小卡，名字不同，状态和用时在走。
- [ ] Lane 2. 行情触发开任务（toy-feed）。Save `w5-market-helper.png`. Pass when 角色写「行情助手」。
- [ ] Lane 3. 任务完成。Save `w5-done.png`. Pass when 小卡消失，今日合计加一，token 合计等于各任务之和。
- [ ] Lane 4. 点小卡。Save `w5-open-how.png`. Pass when 右栏打开该任务，生命周期行完整。
- [ ] Lane 5. 宿主重启。Save `w5-restart.png`. Pass when 名字、角色、序号不变。
- [ ] Lane 6. 旧状态库（W4 之前的 state.db 副本）启动。Save `w5-migrate.png`. Pass when 迁移成功，旧任务有名字。
- [ ] Lane 7. 长执行过程，窗口 1440×900 和 1440×1400。Save `w5-full-height.png`. Pass when 整页不滚动、无底部空白。
- [ ] Lane 8. 窄屏 390 宽。Save `w5-narrow.png`. Pass when 助手条换行或横向滚动，不撑破页面。
- [ ] Lane 9. 深色和浅色主题。Save `w5-themes.png`. Pass when 两套主题对比度足够。
- [ ] Lane 10. 九个在岗助手（maxWorkers 调大）。Save `w5-many.png`. Pass when 名字不重复，助手条不溢出页头。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 50 个任务时看板消息的字节数和页面渲染一次看板的耗时。
- [ ] Probe. trunk 和 head 各量 5 次。
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. head 中位数比 trunk 多 20% 以上算失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 4, 7 screenshots into `docs/web-client/media/w5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of two helpers working and finishing. Keep it local as webm, as in W1.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] 使用者合并。

## Stop cleanly on Ctrl+C (X1)

**Depends on.** main（独立小 PR）。

**Why.** 使用者 2026-11-09 报告：`just host` 按 Ctrl+C 后只看到「收到 SIGINT，正在停止」和 just 的 `error: interrupted by SIGINT`，看不出是否停好。代码里宿主会停止并以 0 退出，但没有「已停止」一行；Worker（`pi --mode rpc`）和宿主同在终端的前台进程组，Ctrl+C 会直接打到 Worker，可能在宿主有序停止前就把它杀掉，任务被记成「Worker 意外退出」。另有 Pi 恢复会话时打印的 `Warning: No project session found…` 噪音。

**Files.**

- [ ] Edit `src/host/pi-worker.ts`、`src/host/main.ts`、`src/watchdog/main.ts`（如需要）、`justfile`、`tests/host-main.test.ts`、`tests/pi-worker*.test.ts`。

**Build.**

- [ ] 先写会失败的测试复现：给宿主进程组发 SIGINT（模拟终端），断言 Worker 不是被信号直接杀死、任务状态是停止而不是失败、宿主打印「已停止」并以 0 退出。
- [ ] Worker 放进自己的进程组（或忽略终端 SIGINT），只由宿主停止。
- [ ] 停止完成后打印「已停止」；第二次 Ctrl+C 立即退出并说明。
- [ ] `just host`、`just watchdog` 按 Ctrl+C 不再出现 just 的 error 行（若 just 本身无法避免，记录原因和替代命令）。
- [ ] 不再把 Pi 的 `No project session found` 警告转给使用者。

**You see.**

- [ ] `just host` 有一个任务在跑时按 Ctrl+C：打印「收到 SIGINT，正在停止」和「已停止」，回到提示符，没有 error 行。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 进程组 SIGINT 复现测试先红后绿；全量测试通过。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. `just host` 空闲时 Ctrl+C。Save `x1-idle.png`. Pass when 「已停止」、退出码 0、无 error 行。
- [ ] Lane 2. 有任务在跑时 Ctrl+C。Save `x1-busy.png`. Pass when 任务记为停止或可恢复，不是失败。
- [ ] Lane 3. 停止后再启动。Save `x1-resume.png`. Pass when 被打断的任务恢复继续。
- [ ] Lane 4. 连按两次 Ctrl+C。Save `x1-double.png`. Pass when 立即退出并说明，无残留进程。
- [ ] Lane 5. `just watchdog` 下 Ctrl+C。Save `x1-watchdog.png`. Pass when Watchdog 和宿主都停，无残留。
- [ ] Lane 6. SIGTERM（kill）。Save `x1-sigterm.png`. Pass when 同 lane 2。
- [ ] Lane 7. 停止时 Worker 正在跑后台命令。Save `x1-bg.png`. Pass when 后台命令被停掉，无残留。
- [ ] Lane 8. 检查进程。Save `x1-procs.png`. Pass when 没有宿主、Worker、pi 残留进程。
- [ ] Lane 9. 日志。Save `x1-log.png`. Pass when 没有 `No project session found` 警告。
- [ ] Lane 10. `just client` 连着时宿主 Ctrl+C。Save `x1-client.png`. Pass when 客户端说明宿主已停止，不崩。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 从 Ctrl+C 到宿主退出的耗时。
- [ ] Probe. 有一个任务在跑，量 5 次。
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. head 中位数超过 5 秒算失败。

**Review gate.** None. X1 does not change the page.

**Merge.**

- [ ] 使用者合并。

## Give every ticket a team (T1)

**Depends on.** W5 (branch `psa/teams`, cut from `psa/helpers`). Design is in `docs/adr/0008-a-helper-can-grow-into-an-agent-team.md`（使用者 2026-11-09 批准）。取代 W6a（#30）。

**Files.**

- [x] Create `src/teams.ts`（加载与校验成员定义和 `teams.yaml`；从 `psa/roles` 的 `src/roles.ts` 搬来改名）和 `agents/general.md`（内置成员「通用助手」）。 证据：1d28b02、c0ebfc7、5b77648。
- [x] Edit `src/modules.ts`（模块的 `agents/`、`teams.yaml`、规则的 `团队：` 行）、`src/host/config.ts`（状态目录的 `agents/` 和 `teams.yaml`）、`src/host/wiring.ts`。 证据：caf8d83（`团队：` 行）、41869a0（`wiring.ts`）。`modules.ts` 和 `config.ts` 不用认 `agents/` 和 `teams.yaml`：名册把模块目录和状态目录都当成根目录自己读，所以 `config.ts` 没有改动。
- [x] Edit `src/host/router.ts`（团队名册进幕僚长提示词，`open_ticket` 加 `team`）、`src/kernel/kernel.ts`、`src/kernel/store.ts`、`src/kernel/types.ts`（`tickets.team`、规则钉死的团队由内核校验）。 证据：fd83e97、6d2ed22、fb98796。
- [x] Edit `src/host/pi-worker.ts`、`src/host/workers.ts`（任务的团队交给助手进程，T2 用）。 证据：8f622bd，`PSA_TEAM`。
- [x] Edit `src/kernel/helper-names.ts`（两字名和四字名分成两个池，四字池补到 24 个以上）、`src/client/board-format.mjs`（团队任务显示「四字名 · 团队名 #N」，页面和 TUI 共用）、`src/client/protocol.ts`。 证据：1432237、3151237。`protocol.ts` 没有改动：助手身份随 `DashboardRow.helper` 到页面，协议不用加字段。
- [x] Edit tests（`tests/teams.test.ts` 新建，及 kernel、modules、wiring 相关测试）。 证据：`tests/teams.test.ts`、`tests/helper-names.test.ts`、`tests/router-prompt.test.ts`、`tests/e2e/teams.e2e.ts` 新建；kernel、modules、wiring、host、host-main、pi-worker-env、web、client 各有新增。

**Build.**

- [x] 成员定义按 ADR-0008：`name`、`title`、`description`、`tools`、`skills`、`model`，正文是系统提示词。没有 `consult` 字段，没有牵头角色。 证据：`tests/teams.test.ts`「成员文件：frontmatter 是 name、title…」「成员文件写错的字段报错并列出可写的字段；consult 不是字段」；c0ebfc7。
- [x] `teams.yaml` 一个团队三样：名字、`description`（给幕僚长看的一句话）、`members`。只解析这一种两层结构，不为它加依赖；格式不对时报出文件和行号。 证据：`tests/teams.test.ts`「teams.yaml：每个团队一个名字…」和 15 条「teams.yaml 格式不对时报出文件和行号」；1d28b02、df58abb、5b77648。
- [x] 成员和团队各有三处来源（内置、模块、状态目录），同名启动即报错，一行写出两个文件；团队名单里有不存在的成员也报错。 证据：`tests/teams.test.ts`「成员和团队来自内置、模块、状态目录三处…」「两处定义了同名成员…」「两处定义了同名团队…」「团队名单里有不存在的成员…」；5b77648。入口：`tests/host-main.test.ts` 三条；41869a0。
- [x] 内置只有「通用助手」和只含它的默认团队。 证据：`tests/teams.test.ts`「内置只有成员「通用助手」和只含它的默认团队；不存在的目录跳过」；5b77648。默认团队叫「默认」，写在代码里。
- [x] 幕僚长的提示词多一份团队名册（团队名和说明），不列成员；`open_ticket` 的 `team` 可省略，省略为默认团队；不存在的团队名拒绝该决定并说明。 证据：`tests/router-prompt.test.ts` 三条；`tests/wiring.test.ts`「真实接线：模块目录和状态目录里的团队进了内核的团队簿和幕僚长的提示词…」；`tests/kernel.test.ts`「每个任务都有团队…」「不存在的团队名：拒绝这个决定…」；fd83e97、6d2ed22、41869a0。
- [x] `rules.md` 支持 `团队：<name>`；启动时校验团队存在；按该规则开的任务必须用它，幕僚长填了别的由内核改回并记一行日志；例外：填的团队不存在时拒绝这个决定，不改回。 证据：`tests/modules.test.ts`「规则的「团队：」行…」；`tests/teams.test.ts`「规则写的团队不存在…」；`tests/kernel.test.ts` 四条「规则钉死团队…」；`tests/host.test.ts`「规则钉死的团队被幕僚长填错时，内核改回的那一行写进宿主日志」；caf8d83、5b77648、6d2ed22、8f622bd。
- [x] `tickets.team` 持久化；旧任务没有团队，读出来按默认团队，不做迁移。 证据：`tests/kernel.test.ts`「任务的团队存在状态库里：重启后不变…」「旧状态库的任务没有团队…」；6d2ed22。
- [x] 成员的 `model` 过计费检查（提供方必须是使用者已配置的之一，`anthropic/*` 和 Claude 模型拒绝）；`skills` 按真实路径必须在成员文件所在目录内。 证据：`tests/teams.test.ts` 两条「成员的模型过计费检查…」和三条「成员的技能目录…」；`tests/wiring.test.ts`「真实接线：成员的模型只能用 router 或 worker 的提供方…」；c0ebfc7、41869a0。
- [x] 默认团队的任务沿用 W5 的显示名「两字名 · 行情助手 #N」。带成员的团队的任务从四字池取名，显示「四字名 · 团队名 #N」，#N 按团队在纽约同一天里数。名字在开任务时按团队定下，之后不变。两个池各自轮转，用完后同样加「·二」。 证据：`tests/helper-names.test.ts` 三条；`tests/kernel.test.ts`「带成员的团队的任务取四字名…」「团队任务的序号按团队在纽约同一天里数…」「两个名字池各自轮转…」「名字在开任务时按团队定下，之后不变…」；`tests/web.test.ts`「页面：团队任务的小卡…」；`tests/client.test.ts`「看板：团队任务的卡片…」；1432237、fb98796、3151237。

**You see.**

- [x] 在状态目录放一个「新闻队」（一位新闻研究员），问「看下黄仁勋听证会的新闻」，助手条和任务卡上是「高山流水 · 新闻队 #1」这样的四字名；问别的事，任务是默认团队，仍是「青檀 · 对话助手 #1」这样的两字名。 证据：`tests/e2e/teams.e2e.ts`（真实宿主、助手进程和页面，假模型）；038ed8a。真实模型下的同一幕留给 Verify, live 的 lane 2 和 lane 3。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] 加载与同名冲突、`teams.yaml` 解析和报错、名单里的成员必须存在、团队名册进幕僚长提示词、`team` 校验和默认值、规则钉死团队、计费检查、技能路径检查、旧任务按默认团队、重启后团队不变、两个名字池和团队任务的显示名。 证据：以上各条列出的测试；`just test` 514 条通过、`just e2e` 58 条通过（e431993，含 t1-fix 一轮），见 decisions.tsv 的 t1 各行。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. 没有任何自定义成员和团队。Save `t1-default.png`. Pass when 每个任务是默认团队，页面和行为与 W5 相同（卡片上仍是「行情助手」）。
- [ ] Lane 2. 状态目录放「新闻队」，问新闻。Save `t1-pick.png`. Pass when 幕僚长开的任务团队是新闻队，助手显示「四字名 · 新闻队 #1」。
- [ ] Lane 3. 同一配置下问股价。Save `t1-no-pick.png`. Pass when 任务是默认团队，助手是两字名。
- [ ] Lane 4. 规则写「团队：新闻队」，toy-feed 触发。Save `t1-rule-team.png`. Pass when 任务团队是新闻队。
- [ ] Lane 5. 幕僚长提示词。Save `t1-roster.png`. Pass when 名册只有团队名和说明，没有成员名。
- [ ] Lane 6. 同名成员两处定义。Save `t1-conflict.png`. Pass when 启动报一行错并退出。
- [ ] Lane 7. 成员 `model: deepseek/...`。Save `t1-billing.png`. Pass when 启动报错。
- [ ] Lane 8. `teams.yaml` 名单里写了不存在的成员。Save `t1-missing-member.png`. Pass when 启动报错并写出团队和成员名。
- [ ] Lane 9. 开两个任务后重启。Save `t1-restart.png`. Pass when 两个任务的团队和名字不变。
- [ ] Lane 10. 用 W5 的状态目录（任务没有团队）启动。Save `t1-old-tickets.png`. Pass when 旧任务正常显示，按默认团队继续。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 幕僚长第一轮的输入 token（团队名册增加的开销）。
- [ ] Probe. 0 个和 10 个自定义团队各量 5 次。
- [ ] Baseline. Record the 0-team median first.
- [ ] Rule. 10 个团队时中位数增加超过 1000 token 算失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, 4 screenshots into `docs/web-client/media/t1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a team ticket and a single-helper ticket side by side. Keep it local as webm, as in W1.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] 使用者合并。

## Let a helper dispatch its team (T2)

**Depends on.** T1 (stacked on it). 取代 W6b（#31）。

**Files.**

- [ ] Edit `src/worker/extension.ts`、`src/worker/tools.ts`（`dispatch_agent` 工具；带上 38ccc66 的修正，只在有请求等待时持有宿主 socket）。
- [ ] Create `src/host/dispatch.ts`（从 `psa/consult` 的 `src/host/consult.ts` 搬来改名：起成员进程、并行、时限、槽位和排队、用量记账、进程组清理），edit `src/host/workers.ts`、`src/host/pi-worker.ts`、`src/host/config.ts`（`maxConcurrentExperts`）、`src/host/wiring.ts`、`src/client/protocol.ts`。
- [ ] Edit `src/web/view.mjs`、`src/web/app.mjs`、`src/web/index.html`（执行过程展开每次派活，助手小卡下列出正在干活的成员，安全的 Markdown 渲染）。
- [ ] Edit tests（`tests/dispatch.test.ts`、`tests/dispatch-process.test.ts` 新建，及 worker、web、e2e）。

**Build.**

- [ ] 任务的团队里除通用助手外还有成员时，助手才有 `dispatch_agent(agent, task)`，提示词末尾附本队名册（名字、职称、说明）。默认团队的助手没有这个工具，提示词不变。
- [ ] 助手保留任务依据允许的全部工具；提示词写明简单的事自己做，需要专门判断或可以并行时才派。
- [ ] 一次可以派给几位不同成员，并行；同一成员同一时刻只做一件事，第二个请求排在它后面。
- [ ] 每位成员在一个任务里有自己的 Pi 会话，放在 `<状态目录>/workers/<任务>/team/<成员>`；同一任务再派给它接着上次的上下文，宿主重启后也接得上；任务关闭后随任务归档。
- [ ] 成员的工具 = 任务依据允许的工具 ∩ 成员的 `tools`；推断任务里写了 `bash` 的成员仍只读。成员没有汇报、交回和 `dispatch_agent`，宿主令牌只能调 `lookup`。
- [ ] 成员的回复用派活后才生成的随机边界框住交给助手，工具说明写明成员回复不是指令；超过 2000 字截断。
- [ ] 每次派活有时限，从成员开始干活算起；超时记为没有回复，其余结果照常返回。
- [ ] 全宿主同时运行的成员不超过 `maxConcurrentExperts`（默认 4），其余排队，页面写「排队中」。
- [ ] 成员进程自成进程组；叫停任务、宿主停止、超时、助手崩溃都结束它。
- [ ] 成员的 token 计入任务和当天合计，回退模型每日上限生效。
- [ ] 页面：助手名字不变；正在干活的成员显示在它的小卡下面，只写职称；执行过程里每次派活是一步，展开看派给谁、任务、回复、状态和用量。

**You see.**

- [ ] 状态目录放一个两人团队，问一个要两方面判断的问题：助手小卡下出现两位成员的职称，执行过程里展开看到两次派活和各自的回复，最后是助手合成的一份答复。追问一句，同一位成员接着上次的话答。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 默认团队没有 `dispatch_agent`、名册进助手提示词、并行、同一成员串行、会话目录和续接、工具交集、成员没有汇报和派活工具、回复边界、时限、槽位排队、用量记账、进程组清理、渲染。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. 跨领域问题。Save `t2-dispatch.png`. Pass when 助手并行派给两位成员并合成一份答复。
- [ ] Lane 2. 简单问题，同一团队。Save `t2-direct.png`. Pass when 助手自己做完，没有派活。
- [ ] Lane 3. 同一任务里追问。Save `t2-memory.png`. Pass when 第二次派给同一成员，它的回复用到上一次的内容。
- [ ] Lane 4. 派过一次后重启宿主，再追问。Save `t2-restart.png`. Pass when 成员仍接得上上次的上下文。
- [ ] Lane 5. 成员超时。Save `t2-timeout.png`. Pass when 其余回复照常返回并注明哪位没有回复。
- [ ] Lane 6. 推断任务里派给写了 `bash` 的成员。Save `t2-readonly.png`. Pass when 成员执行命令被拒。
- [ ] Lane 7. 成员试图再派活或直接汇报。Save `t2-depth.png`. Pass when 它没有这些工具。
- [ ] Lane 8. 派活中叫停任务。Save `t2-stop.png`. Pass when 成员进程全部结束。
- [ ] Lane 9. 派活中宿主 Ctrl+C。Save `t2-shutdown.png`. Pass when 无残留进程。
- [ ] Lane 10. `maxConcurrentExperts` 设 2，一次派四位。Save `t2-queue.png`. Pass when 两位在跑、两位写「排队中」，助手条和执行过程不溢出，任务 token 含四位的用量。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 派给两位成员的总耗时。
- [ ] Probe. 同一组两件事：两位成员各自单独跑一次取较慢者，再并行跑一次，各量 5 次。
- [ ] Baseline. Record the median of the slower single-member run first.
- [ ] Rule. 并行中位数超过较慢单人中位数的 110% 算失败（说明成员在排队，没有并行）。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 3, 10 screenshots into `docs/web-client/media/t2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a helper dispatching two members. Keep it local as webm, as in W1.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] 使用者合并。

## Ship the 看盘队 and the pi-pi team (T3)

**Depends on.** T2 (stacked on it). 取代 W6c（#32）。指标和财报查询（`lookup indicators`、`lookup earnings`）在 PR #26（`psa/market-data`），本分支先 cherry-pick 它的提交，#26 合并后 rebase 去重。

**Files.**

- [ ] Cherry-pick PR #26 的提交（`git log origin/main..origin/psa/market-data`）。
- [ ] Create `modules/us-market/agents/market-analyst.md`（行情分析师）、`technical-analyst.md`（技术分析师）、`news-researcher.md`（新闻研究员）、`earnings-reader.md`（财报解读），从 `psa/market-experts` 的 `modules/us-market/roles/` 搬来；create `modules/us-market/teams.yaml`（看盘队）。
- [ ] Create `modules/pi-pi/module.json`（没有来源）、`modules/pi-pi/agents/`（`psa/market-experts` 上已补中文 `title` 的九位专家）和 `modules/pi-pi/teams.yaml`（pi-pi 队）。不导入 `pi-orchestrator`，不改 `.pi/agents`。
- [ ] Edit `modules/us-market/rules.md`（big-move 写「团队：看盘队」）。现有来源里没有财报触发，不加财报周规则。
- [ ] Create `tests/first-teams.test.ts`、`tests/e2e/teams.e2e.ts`，edit `tests/modules.test.ts`。

**Build.**

- [ ] 四位看盘成员各有清楚的职责、最小的工具白名单、汇报格式（结论、证据、来源和时间），行情一律写报价时间。技术分析师只引用 `lookup indicators` 的数字，标出 `lastBar.partial`；财报解读读 `lookup earnings`。
- [ ] 成员先用 `lookup`；新闻研究员最多读 3 页；回复不超过 600 字。
- [ ] 看盘队的说明让幕僚长在行情、个股、财报、相关新闻的问题上选它；原来写在 `roles/deputy.md` 里的要点（一般派两三位、冲突明写、报价写时间和来源、大波动先派行情分析师和技术分析师）改放进看盘模块的技能，助手读得到。
- [ ] pi-pi 队的说明让幕僚长在「怎么写 Pi 扩展、主题、技能、配置」的问题上选它。

**You see.**

- [ ] 行情大波动时任务是看盘队，助手派给行情分析师和技术分析师；问财报时派给财报解读；问 Pi 扩展怎么写，任务是 pi-pi 队。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 所有成员文件和两份 `teams.yaml` 通过加载校验；规则钉的团队存在；卸掉模块后它的团队和成员一起消失。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. 行情大波动（真实行情或 toy-feed）。Save `t3-market.png`. Pass when 任务是看盘队，助手派给行情分析师并给出报价时间。
- [ ] Lane 2. 新闻问题。Save `t3-news.png`. Pass when 派给新闻研究员并核对日期来源。
- [ ] Lane 3. 财报问题。Save `t3-earnings.png`. Pass when 派给财报解读。
- [ ] Lane 4. 跨领域问题。Save `t3-two.png`. Pass when 助手并行派给其中两位并写明冲突。
- [ ] Lane 5. 问 Pi 扩展怎么写。Save `t3-pi-pi.png`. Pass when 任务是 pi-pi 队，助手派给扩展专家。
- [ ] Lane 6. 只问一个股价。Save `t3-direct.png`. Pass when 看盘队的助手自己用 `lookup` 查完，没有派活。
- [ ] Lane 7. 关掉 us-market 模块。Save `t3-no-module.png`. Pass when 看盘队从幕僚长的名册消失，启动不报错。
- [ ] Lane 8. 推断任务里助手派给行情分析师。Save `t3-inference.png`. Pass when 两者都只读。
- [ ] Lane 9. 汇报格式。Save `t3-format.png`. Pass when 每位成员的回复都有结论、证据、来源和时间。
- [ ] Lane 10. 深浅主题截图。Save `t3-themes.png`. Pass when 显示正确。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 助手第一轮的输入 token（本队名册增加的开销）。
- [ ] Probe. 默认团队和 pi-pi 队（九位成员）的助手各量 5 次。
- [ ] Baseline. Record the default-team median first.
- [ ] Rule. 增加超过 1500 token 算失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 4, 5 screenshots into `docs/web-client/media/t3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the 看盘队 at work. Keep it local as webm, as in W1.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] 使用者合并。
- [ ] T1 到 T3 的 PR 都开出来以后：把 #33（`psa/brand`）restack 到 T3 上，再关闭 #30、#31、#32。

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.
- [ ] 全部合并后删除本文件。

## Appendix A. Prototype evidence

推送方式用 SSE，不用 WebSocket。Node 26.5 只有 WebSocket 客户端，服务端要自己写帧协议或引入 `ws` 依赖。SSE 原型用 `node:http`，94 毫秒收到 3 条事件。原型在本次会话的 scratchpad `sse-proto/sse.mjs`，是一次性的，没有提交。

假模型能同时驱动 Router 和 Worker 子进程，W4 两个 architect runner 都已用原型证明：临时 `PI_CODING_AGENT_DIR` 里的 `models.json` 定义 openai-completions 的本地 provider，宿主和 Worker 都读它，无需改产品代码（scratchpad `arena-w4/candidate-1/spike/`、`candidate-2/proto/`）。

## Appendix B. Alternatives rejected

- WebSocket。要新依赖或手写帧协议。浏览器到宿主的方向只有发话和查看，POST 足够。
- 独立网关进程，经 Unix socket 转发。多一个进程要启动和看护，还要把 socket 协议再翻译一遍。网关放在宿主进程里，直接复用 `HostServer` 的数据来源。
- 不加网页，只写端到端脚本。能减轻测试负担，但使用者自己用的时候还是三个窗口。
- 前端框架和构建链。页面只有对话、看板、侧栏、表单，原生 HTML 和 JS 够用，不引入构建步骤。

## Appendix C. Risks

- 开 TCP 端口后，本机其他进程和浏览器里的网页可能冒充使用者（ADR-0003）。W1 用每次启动新生成的 token、只监听 `127.0.0.1`、校验 `Host` 头。W2 起 POST 再校验 `Origin`。W1 写 ADR-0004 记录这个决定。
- token 出现在网址和宿主日志里。日志只在本机，可以接受，W1 的 ADR 写明。
- `control-ui` 未安装，live lane 用 Playwright 驱动。真实模型的回复每次不同，lane 的通过条件只看结构（出现回复、出现任务），不看措辞。
- W3 的投递必须走 `dropTrigger` 进投递目录，经过来源策略，绝不能走 `Host.say`，否则测试数据会变成使用者的授权。
- 快照里的耗时是快照时刻的值。页面要像 TUI 一样，对执行中的任务按收到时间在本地累加。
- `http.Server.close()` 会等 SSE 长连接。`Host.stop` 必须先断开所有连接，否则测试挂住、SIGINT 变慢。
- W4 第一次给仓库加 `package.json` 和 Playwright 依赖，`just test` 必须不受影响。

## Appendix D. Links and reading list

- `docs/adr/0001-headless-host.md`、`docs/adr/0003-authority-comes-only-from-the-user.md`。
- `src/host/server.ts`、`src/client/protocol.ts`、`extensions/super-agent.ts`，网页要和 TUI 客户端行为一致。
- W1 和 W2 跑 `pstack/skills/how/SKILL.md`。W1 的 token 方案跑 `pstack/skills/interrogate/SKILL.md`。
- 决策记录在 `docs/web-client/decisions.tsv`，格式按 `pstack/skills/show-me-your-work/SKILL.md`。
