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
  - [ ] W4 after W3.
- [ ] Hold the file boundaries. W1 to W3 touch only `src/host/`, `src/web/`, `src/client/board-format.mjs`, `src/client/board.ts`, `tests/`, `justfile`, `docs/`. W1 起加入 `src/client/` 两个文件，让 TUI 和网页共用看板格式，见决策记录。 W4 adds `package.json`, `tests/e2e/`, and `justfile`.
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

**Depends on.** W3.

**Files.**

- [ ] Create `package.json`.
- [ ] Create `tests/e2e/web.e2e.ts`.
- [ ] Create `tests/e2e/fake-model.ts`.
- [ ] Edit `justfile`.

**Build.**

- [ ] 本地假模型 HTTP 服务按脚本回放 Router 和 Worker 的回复，宿主和 Worker 子进程都是真的。
- [ ] Playwright 测试走完整故事：页面投递触发，看板出现任务，点开看 Worker 过程，Router 在对话里回复。
- [ ] 同一套测试覆盖页面 DOM 层：宿主在同一状态目录重启后自己回到已连接，换过 token 后显示链接失效，对话和看板里的 HTML 原样显示不执行，宿主卡死时离开已连接。W1 的变异审计证明这几条目前没有自动测试。
- [ ] `just e2e` 运行它。`just test` 不依赖浏览器，保持现状。

**You see.**

- [ ] `just e2e` 打印每一步的通过结果，失败时保存截图和页面日志。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 故意让假模型返回错误回复，`just e2e` 失败并指出步骤。恢复后通过。Run `just e2e` and `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 没有 `just e2e`，记录这一点。在 head 上跑 `just test`。Save `w4-regression.png`. Pass when 测试数和 trunk 一样且全绿。
- [ ] Lane 2. 干净 clone 后跑 `just e2e`。Save `w4-clean-clone.png`. Pass when 自动装好依赖并通过。
- [ ] Lane 3. 连跑 `just e2e` 20 次。Save `w4-repeat.png`. Pass when 20 次全过。
- [ ] Lane 4. 让假模型的 Router 回复错误。Save `w4-wrong-reply.png`. Pass when 测试失败并指出「Router 回复」这一步。
- [ ] Lane 5. 让 Worker 子进程崩溃。Save `w4-worker-crash.png`. Pass when 测试失败并保存截图和日志。
- [ ] Lane 6. 让端口被占用。Save `w4-port-busy.png`. Pass when 测试换端口或给出清楚的错误。
- [ ] Lane 7. 机器负载高时跑（同时跑 `just test`）。Save `w4-under-load.png`. Pass when 仍然通过。
- [ ] Lane 8. 检查跑完后的进程和临时目录。Save `w4-cleanup.png`. Pass when 没有残留宿主或 Worker 进程，临时目录已删除。
- [ ] Lane 9. 检查假模型收到的请求。Save `w4-no-real-model.png`. Pass when 测试过程中没有请求真实模型的网络流量。
- [ ] Lane 10. 打开失败报告。Save `w4-report.png`. Pass when 报告含失败步骤的截图和页面控制台日志。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk 和 head 都量 `just test` 的总耗时。head 另量 `just e2e` 的总耗时。
- [ ] Probe. 交替在 trunk 和 head 上各跑 5 次。
- [ ] Baseline. Record the trunk `just test` median first.
- [ ] Rule. head 的 `just test` 中位数比 trunk 慢 5% 以上算失败。`just e2e` 中位数超过 60 秒算失败。

**Review gate.** None. W4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者合并。

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.
- [ ] 全部合并后删除本文件。

## Appendix A. Prototype evidence

推送方式用 SSE，不用 WebSocket。Node 26.5 只有 WebSocket 客户端，服务端要自己写帧协议或引入 `ws` 依赖。SSE 原型用 `node:http`，94 毫秒收到 3 条事件。原型在本次会话的 scratchpad `sse-proto/sse.mjs`，是一次性的，没有提交。

尚未证明的事项是假模型能否同时驱动 Router 和 Worker 子进程。W4 开工前用原型确认。

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
