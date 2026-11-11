# Telegram 客户端计划

使用者想在手机上通过 Telegram 和白宫对话。宿主里跑一个机器人，作为网页和终端之外的第三个客户端，只用 Bot API 长轮询这种出站连接，家里的 Mac 不开端口。
规则是：只有 `config.json` 名单上的数字 id、在私聊里，才算使用者；陌生人和群消息在进入宿主之前就丢掉；bot token 只在宿主里，不进日志，不给 Worker。
PR 依次叠放：T1（文字收发和 ADR-0016）、T2（问题卡片变成按钮）、T3（滑动回复就是引用）。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并全部 PR。T1、T2、T3 都停在 merge-ready，等使用者说合并。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. 使用者 2026-11-11 睡前用 `/loop` 授权自主完成，这一条按授权视为已开始。
- [ ] Read these from trunk at program start. Re-read them at every tick. 本机 pstack 不在本仓库里，用插件缓存 `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/` 代替 `git show origin/main:`。
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/interrogate/SKILL.md`
  - [ ] Control skill `control-ui` 和 `control-cli` 未安装。live lane 用假的 Bot API 服务加 `tests/e2e/harness.ts` 驱动真宿主，见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 本次由使用者的 `/loop` 自定节奏，root 按子代理的完成通知推进，另设 30 分钟兜底。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] T1 is first. It branches from `main` as `psa/telegram-text`.
  - [ ] T2 after T1, on `psa/telegram-cards`.
  - [ ] T3 after T2, on `psa/telegram-quote`.
- [ ] Hold the file boundaries. T1 adds `src/host/telegram/`、`src/secrets.ts`，并改 `src/host/config.ts`、`src/host/wiring.ts`、`src/host/host.ts`、`src/sources/market/key.ts`、`docs/adr/`、`docs/deploy/telegram.md`、`docs/web-client/copy.md` 和对应测试。T2 改 `src/host/telegram/`、`src/host/host.ts`、`src/kernel/question.ts`、`src/host/web.ts`（`REFUSED_STATUS`）和测试。T3 改 `src/host/telegram/`、`src/host/host.ts`、`src/kernel/kernel.ts`（引用带 externalId）、`docs/adr/0011-*.md` 和测试。
- [ ] Hold the review gate. T1、T2、T3 都改变使用者在手机上的交互。They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 本仓库没有 lint 和 tsc，用 `just test` 代替。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `/deslop` 未安装，用逐行审 diff 代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. 本机禁止 force-push，需要时把 main 合并进分支，并核对树。

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 按 autopilot-stack，root 把 PR 停在 merge-ready，使用者说合并后 root 自下而上 squash 合并。Rebase 后 patch-id 不变时，上一次的结论仍然有效（`playbooks/shipping.md` 的 patch-id 规则）。T1 动了身份入口，合并前跑 `pstack/skills/interrogate/SKILL.md`。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本机没有这两个技能，每条 lane 在自己的 git worktree 里跑。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 起一个监听 127.0.0.1 的假 Bot API 服务，再用 `tests/e2e/harness.ts` 起临时状态目录的真宿主：假模型，`telegram.allowedUserIds` 写一个测试 id，`secretsFile` 里放一个格式正确的假 token，Bot API 地址指向假服务。
- [ ] 只通过假服务注入 update（私聊消息、按钮点击、滑动回复）、只通过网页和假服务记下的出站请求读结果。宿主日志和状态库只读。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## 让名单上的人在 Telegram 里说话，幕僚长回话 (T1)

**Depends on.** None. 从 `main` 开分支。

**Files.**

- [ ] Create `src/host/telegram/`.
- [ ] Create `src/secrets.ts`.
- [ ] Edit `src/sources/market/key.ts`.
- [ ] Edit `src/host/config.ts`.
- [ ] Edit `src/host/wiring.ts`.
- [ ] Edit `src/host/host.ts`.
- [ ] Create `docs/adr/0016-who-counts-as-the-user-on-an-im-client.md`.
- [ ] Create `docs/deploy/telegram.md`.
- [ ] Edit `docs/web-client/copy.md`.
- [ ] Create `tests/helpers/fake-telegram.ts`.
- [ ] Create `tests/telegram.test.ts`.
- [ ] Create `tests/e2e/telegram.e2e.ts`.

**Build.**

- [ ] `config.json` 加 `telegram.allowedUserIds`（正整数数组，空数组是设置模式）；token 名 `TELEGRAM_BOT_TOKEN`，经 `src/secrets.ts` 的 `readSecret` 读，先环境变量后 `secretsFile`。
- [ ] `BotApi` 独占 `BotToken`，报错不带网址；`baseUrl` 只能是官方地址或 `http://127.0.0.1:<port>`。
- [ ] 纯函数 `decide()` 处理名单、私聊、命令、转发；`TelegramStore` 在共用的 `state.db` 上建表，一张 `telegram_messages` 兼做发件箱；先提交、再写 offset，`externalId` 是 `tg:<botId>:<updateId>`。
- [ ] `TelegramClient.broadcast` 同步写发件箱、从不抛错；单个发送循环每秒最多一次，429 按 `retry_after` 等；401 只停用 Telegram。网页和终端打的话静默转发到 Telegram。
- [ ] ADR-0016 写明谁算使用者、对话会经过 Telegram 服务器、成员上限仍只在网页和终端回答、有 bash 的 Worker 能读到 token 这个已知风险。
- [ ] `docs/deploy/telegram.md` 写 BotFather 建机器人、用设置模式找到自己的 id、写配置、重启。

**You see.**

- [ ] 在手机上给机器人发「查一下 NVDA」，网页对话里出现这句话；幕僚长的回复同时出现在网页和 Telegram 里。陌生账号发的话哪里都看不到。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/telegram.test.ts` 先红后绿：`decide()` 的名单、群聊、转发、命令；配置校验；`BotApi` 报错不带 token、`baseUrl` 限制；同一个 update 重投不重复；断网时网页回复不重复、恢复后补发；429 暂停；401 停用但宿主照常；设置模式只回对方自己的 id；停机时中止长轮询。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 没有 Telegram，记下这一点；head 不配 `telegram` 时网页发话、收回复和 trunk 一样。Save `t1-regress.png`. Pass when 两边网页行为相同，日志里没有 Telegram 相关的行。
- [ ] Lane 2. 名单上的人私聊发一句。Save `t1-say.png`. Pass when 网页对话出现这句话，幕僚长的回复出现在假服务的 `sendMessage` 记录里。
- [ ] Lane 3. 陌生人和群聊各发一句。Save `t1-stranger.png`. Pass when 网页和状态库里都没有，日志里没有对方 id 和内容。
- [ ] Lane 4. 同一个 update 投两次。Save `t1-replay.png`. Pass when 对话里只有一行。
- [ ] Lane 5. 假服务对 `sendMessage` 连续返回 500 一分钟后恢复。Save `t1-outage.png`. Pass when 网页回复不重复，恢复后 Telegram 按顺序补到。
- [ ] Lane 6. 假服务返回 429 和 `retry_after`。Save `t1-429.png`. Pass when 发送循环按时暂停再继续，没有丢消息。
- [ ] Lane 7. 假服务对 `getMe` 返回 401。Save `t1-401.png`. Pass when 日志一行说明 Telegram 已停用，网页照常可用，日志里没有 token。
- [ ] Lane 8. `allowedUserIds` 为空，任何人发消息。Save `t1-setup.png`. Pass when 只回给对方它自己的 id，对话里什么也没有。
- [ ] Lane 9. 网页上发一句话。Save `t1-mirror.png`. Pass when Telegram 静默收到「你在网页或终端说：…」，不带通知。
- [ ] Lane 10. 宿主重启。Save `t1-restart.png`. Pass when 停机期间发的话重启后进入对话一次，未发出的回复补发一次。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk 没有 Telegram，所以量 head 上从假服务交出一条 update 到网页出现这行字的用时（毫秒），并对照 trunk 和 head 上网页发话到回复出现的用时。
- [ ] Probe. trunk 和 head 交替各五轮量网页发话；head 另外五轮量 Telegram 进来的话。
- [ ] Baseline. Record the trunk 网页发话中位数 first.
- [ ] Rule. head 网页发话中位数比 trunk 慢 20 毫秒以上，或 Telegram 进来的话中位数超过 1500 毫秒（含一次长轮询返回），即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3 and 9 screenshots into `tests/e2e/.out/review/T1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/T1-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者说合并后，root squash 合并。

## 把问题卡片变成 Telegram 按钮 (T2)

**Depends on.** T1.

**Files.**

- [ ] Edit `src/host/telegram/`.
- [ ] Edit `src/host/host.ts`.
- [ ] Edit `src/kernel/question.ts`.
- [ ] Edit `src/host/web.ts`.
- [ ] Edit `docs/web-client/copy.md`.
- [ ] Edit `tests/telegram.test.ts`.
- [ ] Edit `tests/e2e/telegram.e2e.ts`.

**Build.**

- [ ] 看板上的每个问题在每个聊天里只发一张带按钮的卡片；点选、使用者插话或问题结束时编辑原消息；重启后不重发。
- [ ] 点按钮调用 `Host.answer(reportId, option, { from })`；成员上限的问题只发一条固定说明，`Host.answer` 对来自 IM 的成员上限点选返回新的拒绝原因 `not_here`。

**You see.**

- [ ] 助手问「查哪个城市？」时，手机上出现一张带两个按钮的卡片；点一下，网页上的卡片同时变成已回答，手机上的按钮消失。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/telegram.test.ts` 加用例：每个问题只发一张卡片；十个看板帧只编辑一次；点选走 `Host.answer`；伪造的成员上限按钮被拒且宿主返回 `not_here`；问题离开看板时卡片关闭；`callback_data` 不超过 64 字节。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 的网页点选卡片；head 在网页上点同一张卡片。Save `t2-regress.png`. Pass when 两边网页行为相同，head 的 Telegram 卡片跟着关闭。
- [ ] Lane 2. 助手提问。Save `t2-card.png`. Pass when 假服务收到一条带两个按钮的消息。
- [ ] Lane 3. 在 Telegram 点按钮。Save `t2-tap.png`. Pass when 网页对话出现「回答任务「…」：…」，卡片编辑成已回答。
- [ ] Lane 4. 同一个按钮点两次。Save `t2-twice.png`. Pass when 只答一次，第二次弹出提示。
- [ ] Lane 5. 先在网页点了另一个选项，再在 Telegram 点。Save `t2-chosen.png`. Pass when Telegram 那次被拒，提示已经选过。
- [ ] Lane 6. 成员上限的问题。Save `t2-cap.png`. Pass when Telegram 只收到一条说明，没有按钮；伪造的按钮回调被拒。
- [ ] Lane 7. 宿主重启。Save `t2-restart.png`. Pass when 没有重发卡片，点重启前的按钮仍然有效。
- [ ] Lane 8. 问题在网页上被回答后离开看板。Save `t2-close.png`. Pass when Telegram 的卡片编辑成已结束，按钮消失。
- [ ] Lane 9. 没有选项的问题。Save `t2-open.png`. Pass when 卡片没有按钮，写「直接打字回答。」。
- [ ] Lane 10. 使用者在 Telegram 直接打字回答。Save `t2-typed.png`. Pass when 卡片变成「已插话」，答案按普通的话交给幕僚长。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一帧看板到达后，Telegram 客户端同步处理（算卡片、写发件箱）的用时（毫秒），20 个待回答的问题。trunk 没有这一步，另量 trunk 和 head 上同一帧看板的总处理用时作对照。
- [ ] Probe. trunk 和 head 交替各五轮。
- [ ] Baseline. Record the trunk 看板处理中位数 first.
- [ ] Rule. head 看板处理中位数比 trunk 慢 5 毫秒以上，或 Telegram 同步处理超过 3 毫秒，即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3 and 6 screenshots into `tests/e2e/.out/review/T2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/T2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者在 T1 合并后说合并，root squash 合并。

## 让 Telegram 里的滑动回复变成引用 (T3)

**Depends on.** T2.

**Files.**

- [ ] Edit `src/host/telegram/`.
- [ ] Edit `src/host/host.ts`.
- [ ] Edit `src/kernel/kernel.ts`.
- [ ] Edit `docs/adr/0011-a-quote-is-context-not-the-users-words.md`.
- [ ] Edit `tests/telegram.test.ts`.
- [ ] Edit `tests/quote.test.ts`.

**Build.**

- [ ] 在 Telegram 里对一条消息滑动回复，按发件箱记下的映射找到对话行，调用 `Host.sayQuoting`（带 `externalId`）；找不到对应行时当普通的话发出。

**You see.**

- [ ] 手机上对幕僚长那句「NVDA 现在 170 美元」滑动回复「为什么跌」，网页上这句话带着引用条出现。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 加用例：滑动回复变引用；同一个 update 重投不重复；对卡片或找不到的消息滑动回复时当普通的话；`tests/quote.test.ts` 加带 `externalId` 的重复用例。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都在网页上引用一句再发话。Save `t3-regress.png`. Pass when 两边网页行为相同。
- [ ] Lane 2. 对幕僚长的回复滑动回复。Save `t3-quote.png`. Pass when 网页上的话带引用条，引用的是那条回复。
- [ ] Lane 3. 对自己说过的话滑动回复。Save `t3-self.png`. Pass when 引用的是自己那句。
- [ ] Lane 4. 对转发来的网页那句话滑动回复。Save `t3-mirror.png`. Pass when 引用的是网页上那句。
- [ ] Lane 5. 对问题卡片滑动回复。Save `t3-card.png`. Pass when 按普通的话处理，不报错。
- [ ] Lane 6. 对机器人的设置说明滑动回复。Save `t3-note.png`. Pass when 按普通的话处理。
- [ ] Lane 7. 同一个滑动回复的 update 投两次。Save `t3-replay.png`. Pass when 对话里只有一行。
- [ ] Lane 8. 对很早、已不在对话里的消息滑动回复。Save `t3-old.png`. Pass when 按普通的话发出，话没有丢。
- [ ] Lane 9. 清屏后对清屏前的回复滑动回复。Save `t3-cleared.png`. Pass when 引用仍然成立。
- [ ] Lane 10. 手机宽度打开网页看引用。Save `t3-phone.png`. Pass when 引用条完整，没有横向滚动。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一条滑动回复从 update 到网页出现的用时（毫秒），对照 T2 head 上普通的话。
- [ ] Probe. T2 head 和 T3 head 交替各五轮。
- [ ] Baseline. Record the T2 head 中位数 first.
- [ ] Rule. T3 中位数比 T2 慢 20 毫秒以上即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 4 and 8 screenshots into `tests/e2e/.out/review/T3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/T3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者在 T2 合并后说合并，root squash 合并。

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

- 设计依据是两份独立的 architect 设计稿和 root 的合成，存在本机 `.audit/telegram/`（不提交）。两份在结构上收敛：第三个客户端、纯函数过滤、发件箱、问题卡片是状态、宿主强制 ADR-0010。
- 已证实（读代码）：成员上限只能在网页和终端回答这一条，代码里没有强制，`Host.answer` 不区分客户端；回复广播一次就记为已送达；问题卡片只在看板帧里；`workerEnv` 已经会去掉 `TELEGRAM_BOT_TOKEN`。
- 未证实，要使用者在 T1 合并前做：真的 BotFather 机器人、手机私聊、`callback_data` 的 64 字节上限和 4096 字上限的计量单位。

## Appendix B. Alternatives rejected

- grammY 等库：Bot API 是普通 HTTPS，`fetch` 就够，不引入依赖。
- webhook：要公网入口，违背不开端口的规则。
- 把 offset 放 `source_cursors`：offset、聊天 id 和消息 id 都只对一个 bot 有效，换 bot 要一起清掉，放在 Telegram 自己的表里才清得干净。
- 失败时让 `#deliverReply` 抛错重试：网页和终端会收到重复的回复。
- 把长消息拆成多条：一行对应一个 message_id 是编辑和引用的前提，改为截断并提示去网页看全文。
- 聊天里发配对码登记使用者：名单只能由使用者改文件，和规则一样。

## Appendix C. Risks

- `control-ui` 和 `control-cli` 未安装（全部 PR）：live lane 用假的 Bot API 服务加 `tests/e2e/harness.ts`。
- 真 Telegram 只能由使用者验证（T1）：root 写好 BotFather 和设置模式的步骤，早上交给使用者。
- 有 bash 的 Worker 能读到 `secretsFile`，也就能读到 bot token（T1）：拿到 token 的人可以抢先轮询、读走之后的消息。ADR-0016 记下，Worker 沙箱必须覆盖。
- 对话经过 Telegram 服务器（T1）：ADR-0016 写明，写了 `telegram` 段就是同意。
- 本机禁止 force-push（全部 PR）：rebase 改为合并 main，并核对树。
- ADR 编号：0015 被进行中的成品目录 PR 占用，所以本计划用 0016。

## Appendix D. Links and reading list

- 先读 `GLOSSARY.md`（客户端、来源、渠道）、ADR-0004、0006、0007、0009、0010、0011，以及本机未提交的调研 `docs/multi-channel/research.md` 第 2、3.1、5 节。
- T1 改身份入口，合并前跑 `pstack/skills/interrogate/SKILL.md`。三个 PR 开工前都已有 `how`（`.audit/telegram/how.md`）。
- 决策记录按 `pstack/skills/show-me-your-work/SKILL.md`，放 `.audit/telegram.tsv`，不提交。
