# 宿主搬到家里的 Mac 计划

使用者想让宿主（计算和状态）跑在家里的 Mac 上，像私有云一样，在外面用手机或笔记本打开网页。老 Mac（Intel，macOS 12，Node 22）先彩排，Mac mini 到手后照做。
规则是不开公网端口：远程访问只走 Tailscale 私有网络，宿主仍然只监听 127.0.0.1。
PR 依次是 H1（Node 22 的 sqlite 截断）、H2（网页接受 Tailscale 转发来的请求）、H3（登录后自动启动）、H4（家用 Mac 部署手册）。H1、H2、H3 互不依赖，H4 在 H2 和 H3 之后。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并全部 PR。H1 到 H4 都停在 merge-ready，等使用者说合并。

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
  - [ ] Control skill `control-ui` 和 `control-cli` 未安装。网页 lane 用 Playwright 加 `tests/e2e/harness.ts`，命令行 lane 用 bash 直接跑，见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 使用者在会话中逐个 PR 推进时不开，交给无人值守时再开。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] H1, H2 and H3 are independent and first. All three branch from `main` as `psa/nul-strip`, `psa/web-hosts` and `psa/autostart`.
  - [ ] H4 after H2 and H3, on `psa/home-runbook`.
- [ ] Hold the file boundaries. H1 touches only `src/kernel/kernel.ts`、`src/kernel/store.ts`、`tests/kernel.test.ts`。H2 touches only `src/host/web.ts`、`src/host/config.ts`、`src/host/main.ts`、`docs/adr/`、`tests/web-gateway*`、`tests/config.test.ts`、`tests/e2e/`。H3 touches only `src/service/`、`justfile`、`tests/service.test.ts`。H4 touches only `docs/deploy/`。
- [ ] Hold the review gate. H2 changes an interaction（使用者从手机打开网页）。It waits for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 本仓库没有 lint 和 tsc，用 `just test` 代替。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `/deslop` 未安装，用 Comment Sicko 加 owner 逐行审 diff 代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. 本机禁止 force-push，需要 rebase 时改为把 main 合并进分支，并核对合并后的树和验证过的树一致。

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 按 autopilot-stack，root 把 PR 停在 merge-ready，使用者说合并后 root 执行 `gh pr merge --squash`。Rebase 后 patch-id 不变时，上一次的结论仍然有效（`playbooks/shipping.md` 的 patch-id 规则）。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本机没有这两个技能，每条 lane 在自己的 git worktree 里跑，`node_modules` 从已有 worktree 链接过来。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 用 `tests/e2e/harness.ts` 的 `startHost` 起一个临时状态目录的真宿主，模型换成 `tests/e2e/fake-model.ts`。网页 lane 需要模拟 Tailscale 时，在宿主前面起一个本地反向代理，把 `Host` 和 `Origin` 改成 `psa-home.example.ts.net` 那样的值。
- [ ] 只通过 Playwright 点击和输入、只通过 curl 发请求，只通过页面、HTTP 响应和宿主日志读结果。状态库只读。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## 写库前去掉 U+0000，让 Node 22 不截断文字 (H1)

**Depends on.** None.

**Files.**

- [ ] Edit `src/kernel/kernel.ts`.
- [ ] Edit `src/kernel/store.ts`.
- [ ] Edit `tests/kernel.test.ts`.

**Build.**

- [ ] 在 `Kernel` 的 `#run`、`#get`、`#all`（`kernel.ts:1317-1331`）里，把字符串参数中的 U+0000 去掉，再交给 `node:sqlite`。`store.ts:218-222` 的迁移写入也走同一个函数。查询参数也去，这样按 `external_id` 查找和写入时一致。

**You see.**

- [ ] 在 Node 22.23.4 下，引用「前\u0000面\u0007的…话\u0085完」得到「前面的[31m话完」，不再是「前」。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/kernel.test.ts` 加用例：触发正文、使用者的话、成员回复各带一个 U+0000，读回来去掉了它、后面的字都在；带 U+0000 的 `external_id` 写入后能按原值查到。在 Node 22.23.4 和 Node 26 下各跑一次 `just test`，先在 Node 22 下看到红。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 每条 lane 都用下载的 Node 22.23.4 跑宿主，另装 Pi 1.5.2。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都在网页里发一句带 U+0000 的话再引用它。Save `h1-regress.png`. Pass when trunk 的引用只剩第一个字（记在 trunk 名下），head 的引用是完整的句子。
- [ ] Lane 2. 不带控制字符的普通对话。Save `h1-plain.png`. Pass when 对话、卡片和引用的文字和 trunk 一字不差。
- [ ] Lane 3. 来源触发正文带 U+0000（toy-market 触发）。Save `h1-trigger.png`. Pass when 卡片和对话里的触发正文完整。
- [ ] Lane 4. 假模型的回复带 U+0000。Save `h1-reply.png`. Pass when 幕僚长的气泡完整，重启宿主后仍完整。
- [ ] Lane 5. 成员回复带 U+0000。Save `h1-member.png`. Pass when 派活明细里的回复完整。
- [ ] Lane 6. 任务标题带 U+0000。Save `h1-title.png`. Pass when 卡片标题完整，没有空标题。
- [ ] Lane 7. 带 U+0000 的 `external_id` 的触发投两次。Save `h1-dedupe.png`. Pass when 第二次被认作重复，没有新卡片。
- [ ] Lane 8. 用 Node 26 跑同样的 lane 3 和 lane 4。Save `h1-node26.png`. Pass when 结果和 Node 22 相同。
- [ ] Lane 9. 已有的状态库（trunk 写过的）升级到 head 后启动。Save `h1-upgrade.png`. Pass when 宿主正常启动，旧任务都在。
- [ ] Lane 10. 宿主日志。Save `h1-log.png`. Pass when 日志里没有 sqlite 报错和新的警告。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 内核连续写 5000 条触发的总用时（毫秒）。
- [ ] Probe. trunk 和 head 交替各五轮，在同一台机器、同一个 Node 22.23.4 下跑一段只用 `Kernel` 的脚本。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 中位数比 trunk 慢 5% 以上即不通过。

**Review gate.** None. H1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者说合并后，root squash 合并。

## 让网页接受 Tailscale 转发来的请求 (H2)

**Depends on.** None.

**Files.**

- [ ] Edit `src/host/web.ts`.
- [ ] Edit `src/host/config.ts`.
- [ ] Edit `src/host/main.ts`.
- [ ] Create `docs/adr/0014-the-web-page-answers-hosts-the-user-lists.md`.
- [ ] Edit `tests/config.test.ts`.
- [ ] Edit the web gateway unit tests under `tests/`.
- [ ] Create `tests/e2e/remote-host.e2e.ts`.

**Build.**

- [ ] 先做原型（Appendix A 第 1、2 条）。在老 Mac 上装 Tailscale，运行 `tailscale serve --bg 4517`，用 `curl -v` 看转发后的 `Host` 和 `Origin`，用手机 Safari 打开网页看 SSE 是否即时到达。结果记进决策记录，再动代码。
- [ ] `config.json` 加 `webHosts`，是一组主机名，例如 `["psa-home.example.ts.net"]`。`config.ts` 校验每一项是不带端口和路径的主机名，空数组和缺省都等于今天的行为。
- [ ] `web.ts` 的 `isLocalHost` 改成 `isAllowedHost`：除了 `127.0.0.1:<端口>` 和 `localhost:<端口>`，还接受 `webHosts` 里的主机名（不带端口，按 Tailscale 的 443 转发）。`#post` 的 `Origin` 检查对 `webHosts` 只接受 `https://<主机名>`。
- [ ] `main.ts` 在本机网址之外，为每个 `webHosts` 再打一行 `[host] 网页（远程） https://<主机名>/?token=…`。
- [ ] ADR-0014 记下：宿主仍只绑 127.0.0.1；远程访问交给使用者自己的 Tailscale；只认使用者写进配置的主机名，所以 DNS rebinding 仍被挡住；token 会进手机浏览器的历史记录，换 token 用 `just web-token-rotate`。

**You see.**

- [ ] 手机连上 tailnet，打开日志里的远程网址，看到和本机一样的网页，能发话、能收到回复。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 网关测试加用例：`webHosts` 为空时 `Host: x.ts.net` 得 403；列入后得 200；没列入的 ts.net 名字仍 403；`Origin: http://<列入的主机名>` 的 POST 得 403，`https://` 的得通过；带端口的 `webHosts` 配置被 `config.ts` 拒绝。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. Lane 1 到 9 用本地反向代理模拟 Tailscale；lane 10 是使用者在老 Mac 和手机上的真 Tailscale。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都在本机 `http://127.0.0.1:<端口>/?token=…` 打开网页、发一句话。Save `h2-regress.png`. Pass when 两边都能发能收，head 的本机行为不变。
- [ ] Lane 2. 代理把 `Host` 改成列入的主机名。Save `h2-allowed.png`. Pass when 网页打开，SSE 连上，状态写「在线」。
- [ ] Lane 3. 代理把 `Host` 改成没列入的主机名。Save `h2-denied.png`. Pass when 返回 403，页面拿不到任何数据。
- [ ] Lane 4. 经代理发话（POST，`Origin: https://<主机名>`）。Save `h2-say.png`. Pass when 话发出去，幕僚长回复出现。
- [ ] Lane 5. 经代理点问题卡片的按钮回答。Save `h2-answer.png`. Pass when 回答被接受，卡片关闭。
- [ ] Lane 6. 经代理打开执行过程，成员运行中。Save `h2-stream.png`. Pass when 步骤和派活分支在 2 秒内跟着更新。
- [ ] Lane 7. 错误或缺失的 token 经代理访问。Save `h2-token.png`. Pass when 401，没有数据。
- [ ] Lane 8. `webHosts` 写成带端口或带路径的值。Save `h2-config.png`. Pass when 宿主启动时报出具体是哪一项不合法，并退出。
- [ ] Lane 9. 手机宽度 390 像素经代理打开。Save `h2-phone.png`. Pass when 没有横向滚动，发话框可用。
- [ ] Lane 10. 使用者在老 Mac 上开 `tailscale serve`，手机连 tailnet 打开远程网址，发「查一下 NVDA 现在多少钱」。Save `h2-tailscale.png`. Pass when 回复和卡片在手机上出现，锁屏一分钟后解锁，页面自己重连。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 本机打开网页到 SSE 第一帧到达的用时（毫秒）。trunk 没有远程访问，所以另设经代理的绝对预算。
- [ ] Probe. trunk 和 head 交替各五轮，Playwright 量本机；head 再经代理量五轮。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 本机中位数比 trunk 慢 10 毫秒以上，或经代理的中位数超过 300 毫秒，即不通过。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 4 and 10 screenshots into `tests/e2e/.out/review/H2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `tests/e2e/.out/review/H2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者说合并后，root squash 合并。

## 登录后自动启动看门狗和宿主 (H3)

**Depends on.** None.

**Files.**

- [ ] Create `src/service/launch-agent.ts`.
- [ ] Edit `justfile`.
- [ ] Create `tests/service.test.ts`.

**Build.**

- [ ] 纯函数 `launchAgentPlist(input)` 生成 LaunchAgent 的 plist：`Label` 是 `com.pi-super-agent.watchdog`，`ProgramArguments` 是 node 的绝对路径加 `--import ./src/pi-runtime.mjs src/watchdog/main.ts`，`WorkingDirectory` 是仓库目录，`EnvironmentVariables` 带 `HOME`、`PATH`（把 node 所在目录放在最前，这样 `npm root -g` 能找到 Pi）和可选的 `PSA_STATE_DIR`，`RunAtLoad` 和 `KeepAlive` 都开，看门狗自己的输出写到 `<状态目录>/watchdog.log`。
- [ ] `just service-install` 用当前的 `node` 路径生成 plist，写到 `~/Library/LaunchAgents/`，再 `launchctl bootstrap gui/$UID`。`just service-uninstall` 先 `bootout` 再删文件。两个都能重复运行，结果一样。
- [ ] `just service-status` 打印 launchd 里的状态和 `heartbeat.json` 的时间。

**You see.**

- [ ] 运行 `just service-install` 后，不开终端，一分钟内日志里出现「[host] 已启动」；注销再登录后宿主自己回来。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/service.test.ts` 加用例：生成的 plist 过 `plutil -lint`；node 路径、仓库目录、`PATH` 第一项和状态目录都写对；路径里有空格和中文时仍是合法的 plist；没有 `PSA_STATE_DIR` 时不写这一项。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 会改动 launchd 的 lane 用独有的 `Label` 和临时状态目录，结束时一定 `bootout` 并删文件。

- [ ] Lane 1. Regression lane against trunk. trunk 没有自动启动，记下这一点；head 上 `just host` 和 `just watchdog` 的用法和日志不变。Save `h3-regress.png`. Pass when 两个命令在 head 上的输出和 trunk 一致。
- [ ] Lane 2. `just service-install` 后等心跳。Save `h3-install.png`. Pass when 60 秒内 `heartbeat.json` 更新，网页能打开。
- [ ] Lane 3. 连跑两次 `just service-install`。Save `h3-twice.png`. Pass when 只有一个看门狗、一个宿主在跑。
- [ ] Lane 4. `kill -9` 宿主。Save `h3-crash.png`. Pass when 看门狗在它的检查间隔加 `staleSeconds` 之内把宿主拉回来。
- [ ] Lane 5. `kill -9` 看门狗。Save `h3-keepalive.png`. Pass when launchd 把看门狗拉回来，宿主没有重复。
- [ ] Lane 6. 只给 launchd 的最小环境（`env -i` 加 plist 里的变量）手动跑 `ProgramArguments`。Save `h3-env.png`. Pass when 宿主找到 Pi，Worker 能启动。
- [ ] Lane 7. `just service-uninstall` 后。Save `h3-uninstall.png`. Pass when 看门狗和宿主都停了，plist 已删，再跑一次也不报错。
- [ ] Lane 8. 状态目录和仓库路径里带空格。Save `h3-spaces.png`. Pass when 安装和启动都正常。
- [ ] Lane 9. `just service-status`。Save `h3-status.png`. Pass when 正确显示运行中、停止和未安装三种状态。
- [ ] Lane 10. 使用者在老 Mac 上安装后重启电脑并自动登录。Save `h3-reboot.png`. Pass when 不碰终端，登录后两分钟内网页能打开。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk 没有这项功能，所以量 head 上从 `launchctl bootstrap` 到第一次心跳的用时（秒）作为绝对预算，并量 trunk 和 head 上 `just watchdog` 启动到第一次心跳的用时作对照。
- [ ] Probe. trunk 和 head 交替各五轮跑 `just watchdog`；head 另跑五轮 `just service-install` 再 `service-uninstall`。
- [ ] Baseline. Record the trunk `just watchdog` 中位数 first.
- [ ] Rule. head 的 `just watchdog` 中位数比 trunk 慢 2 秒以上，或 `bootstrap` 到心跳的中位数超过 30 秒，即不通过。

**Review gate.** None. H3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者说合并后，root squash 合并。

## 写家用 Mac 部署手册 (H4)

**Depends on.** H2 and H3.

**Files.**

- [ ] Create `docs/deploy/home-mac.md`.

**Build.**

- [ ] 按这次在老 Mac 上真实走过的步骤写：nvm 装 Node 22（macOS 13.5 以上可装 Node 24 或 26）、装 Pi 并 `/login` Codex、装 just、拉代码、`config.json` 的 `models` 和 `secretsFile`、`.env` 的变量名和 0600 权限、`just service-install`、装 Tailscale 和 `tailscale serve`、`webHosts`、手机打开远程网址、换 token、从老 Mac 把状态目录搬到 Mac mini（`location.json` 会改写会话路径）。
- [ ] 每一步写出预期看到的日志行或命令输出。

**You see.**

- [ ] 一个没看过这次对话的人，照手册能在一台干净的 Mac 上把宿主跑起来并从手机打开。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 手册里的每条命令都在 H2、H3 合并后的 main 上存在：脚本把手册中的 `just` 配方名和 `config.json` 字段名与 `justfile`、`src/host/config.ts` 对一遍。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 每条 lane 照手册的一个章节在临时用户目录里执行，只照字面做。

- [ ] Lane 1. Regression lane against trunk. trunk 没有这份手册，记下这一点；照 head 的手册从头做到「网页能打开」。Save `h4-regress.png`. Pass when 每一步的输出和手册写的预期一致。
- [ ] Lane 2. 「装 Node」一节。Save `h4-node.png`. Pass when `node -v` 和 sqlite 检查的输出与手册一致。
- [ ] Lane 3. 「配置」一节。Save `h4-config.png`. Pass when 日志出现「密钥来自 secretsFile」和三个 Codex 模型。
- [ ] Lane 4. 「自动启动」一节。Save `h4-service.png`. Pass when 心跳出现，和手册写的一致。
- [ ] Lane 5. 「远程访问」一节，用代理模拟。Save `h4-remote.png`. Pass when 远程网址能打开。
- [ ] Lane 6. 「换 token」一节。Save `h4-rotate.png`. Pass when 旧网址 401，新网址可用。
- [ ] Lane 7. 「搬家」一节，把状态目录复制到新路径。Save `h4-move.png`. Pass when 旧任务的执行过程在新路径下能打开。
- [ ] Lane 8. 「卸载」一节。Save `h4-uninstall.png`. Pass when 没有残留进程和 plist。
- [ ] Lane 9. 手册里所有 `.env`、token 示例。Save `h4-secrets.png`. Pass when 没有一个看起来像真密钥的值，也没有本机路径和人名。
- [ ] Lane 10. 使用者照手册在老 Mac 上从「自动启动」做到「手机打开」。Save `h4-operator.png`. Pass when 使用者不需要问任何问题就做完。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk 没有手册，所以量 head 上 lane 1 从第一条命令到网页打开的总用时（分钟），不含下载时间，作为绝对预算。
- [ ] Probe. lane 1 的执行者记下每一节开始和结束的时间，trunk 一侧记「无手册」。
- [ ] Baseline. Record the trunk 结果（无手册）first.
- [ ] Rule. 不含下载超过 20 分钟即不通过，说明手册步骤太多或有卡住的地方。

**Review gate.** None. H4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] 使用者说合并后，root squash 合并。

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

- 已证实（2026-11-10，老 Mac，Intel，macOS 12.7.6）：Node 22.23.4、Pi 1.5.2、just 1.59.0 能装；`just host` 启动，读到 `secretsFile` 里的行情密钥，`lookup quote TSLA` 用时 227 毫秒，网页正常。
- 已证实：Node 22 的 `node:sqlite` 在 U+0000 处截断字符串。本机用 Node 22.23.4 加 Pi 1.5.2 复现，`tests/kernel.test.ts:1793` 读回「前」。老 Mac 上同一个测试同样失败。
- 已证实：老 Mac 上全套 `just test` 另有两处失败（`host-main.test.ts` 整个文件超过 30 秒，`dispatch-process.test.ts:259` 的 3 秒无进展判定），时限放宽到 120 秒单独跑时 50/50 全过。归因是并行时 CPU 被占满，属于测试时限偏紧，不是产品问题。
- 已证实（读代码）：`web.ts:128` 在 token 之前检查 `Host`，`isLocalHost`（`web.ts:253-256`）只认 `127.0.0.1` 和 `localhost`；`#post`（`web.ts:155-156`）要求 `Origin` 以 `http://` 开头。所以任何经 `*.ts.net` 转发的请求今天都会 403。
- 未证实，H2 第一步要做：
  1. `tailscale serve` 转发时 `Host` 和 `Origin` 的确切值。本机的 Tailscale 只剩一个指向已删除 App 的脚本，没法在本机做原型。
  2. SSE 经 `tailscale serve` 到手机 Safari 是否即时到达、锁屏后能否自己重连。
- 未证实，H3 要做：nvm 装的 node 在 launchd 的最小环境下能否找到全局 Pi（`npm root -g`）。

## Appendix B. Alternatives rejected

- 宿主改绑 `0.0.0.0` 或 tailnet 地址：会让局域网里的设备也能连，违背 ADR-0004 只绑本机的初衷。Tailscale serve 在本机做 TLS 和转发，宿主不用改监听地址。
- 关掉 Host 检查：DNS rebinding 的防线就没了。改为只认使用者写进配置的主机名。
- 改写 `Host` 头的转发配置：要使用者记得给 Tailscale 加额外参数，忘了就是一片 403。配置一次 `webHosts` 更直接。
- 开公网端口或用 Cloudflare Tunnel：对话会经过第三方或暴露在公网上，使用者要的是私有云。
- LaunchDaemon：开机即运行，不用自动登录，但它以 root 或单独的用户跑，拿不到使用者 HOME 下的 Pi 登录凭据。先用 LaunchAgent 加自动登录。
- 为老 Mac 放宽 `just test` 的时限或并发：老 Mac 只是彩排，Mac mini 才是目标。手册里写一句单独重跑的办法即可。
- 把宿主要求的 Node 提到 24 以上：Monterey 装不上，老 Mac 就不能彩排了。H1 修掉唯一的差异更省事。

## Appendix C. Risks

- `control-ui` 和 `control-cli` 未安装（全部 PR）：网页 lane 用 Playwright 加 `tests/e2e/harness.ts`，命令行 lane 用 bash，owner 在报告里写明。
- 本机禁止 force-push（全部 PR）：rebase 改为合并 main，并核对树一致。
- 真 Tailscale 只能由使用者操作（H2 lane 10、H3 lane 10、H4 lane 10）：这三条 lane 等使用者在老 Mac 和手机上跑完才算过，root 提前把命令写好。
- token 进了手机浏览器的历史记录（H2）：ADR-0014 写明，并在手册里写换 token 的办法。
- LaunchAgent 需要自动登录（H3）：停电重启后没有自动登录，宿主不会回来。手册写明开自动登录，以及它的安全代价。
- `host.log` 没有轮转（H3）：长期运行会变大。先在手册里写清楚位置和手动清理办法，量大了再做轮转。
- 回退模型默认是按量付费的 DeepSeek（全部 PR）：手册要求在 `config.json` 里写明三个 Codex 模型。要不要改默认值，见下面的待定事项。
- 待使用者决定：没有 DeepSeek 额度时，回退模型怎么办。默认做法是手册要求写成 Codex，代码默认值不动。另一个选择是让回退变成可选，缺省就不回退。同一个 provider 当回退，在额度用完时没有用。

## Appendix D. Links and reading list

- 先读 `docs/adr/0004-web-client-on-localhost-with-a-token.md`、`docs/adr/0007-socket-clients-prove-they-are-the-users-front-end.md`、`docs/security/worker-token-theft-memo.md`。
- H2 改网关的安全边界，开工前跑 `pstack/skills/how/SKILL.md`，合并前跑 `pstack/skills/interrogate/SKILL.md`。H3 开工前跑 `how` 看 `src/watchdog/main.ts`。
- 决策记录按 `pstack/skills/show-me-your-work/SKILL.md`，放 `.audit/home-host.tsv`，不提交。
