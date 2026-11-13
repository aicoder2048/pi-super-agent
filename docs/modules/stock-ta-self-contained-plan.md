# stock-ta self-contained plan

让 stock-ta 不再依赖你本机的技术分析项目和它的两个数据库。装好以后，它在任何一台机器上都能用，包括跑服务的旧 Mac。
不复制源码。模块带一个小的 Python 子项目，用 uv 的 git 依赖装你私有仓库里的 `ta-trading`（`app/trading`），钉在一个提交上。
数据归模块自己。新的 `scan` feed 按 G5 的自选股每天收盘后跑一次 `ta scan`，同步日线和分红（含 QQQ、SPY），写进模块自己的数据目录，密钥用 G5 的 `POLYGON_API_KEY`（Massive 报价接口的钥匙；`MASSIVE_S3_*` 是批量文件凭证，用不上），由 handler 以 `ta` 认的环境变量名 `MASSIVE_API_KEY` 传给它。
工具照旧只读、不联网，只是读的换成模块自己数据库的副本。全市场选股 `screen` 和日内 5 分钟信号（含 OR30）默认拿掉，理由见 Appendix B。
程序守的规则是：只有 `scan` feed 写技术分析数据库，而且它先写副本、成功后整个换上；工具只读克隆。
PR 顺序是 S1、S2、S3、S4，依次叠在上一个之上。S1 叠在 G5 上。S2 先让模块有自己的数据，工具还读 `TA_ROOT`；S3 再把工具切过去、拿掉 `TA_ROOT`。这样每个 PR 合并后 trunk 都能用。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. 使用者合并 PR。S1 到 S4 都停在 merge-ready，使用者说可以合并时，按 Shipping 从下往上合并。S4 里有几步要在旧 Mac 上由使用者亲手做（建 GitHub token、装 uv），owner 停下来等。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. 本计划在 G5 之后执行。Appendix E 里的待定事项要先有答复，或者按写好的默认做法走。
- [ ] Read these from trunk at program start. Re-read them at every tick. 本机 pstack 不在本仓库里，用插件缓存 `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/` 代替 `git show origin/main:`。
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/architect/SKILL.md`
  - [ ] Control skill `control-ui` 和 `control-cli` 未安装。命令行 lane 用脚本跑 `just` 命令并存输出，宿主 lane 用 `tests/e2e/harness.ts`，见 Appendix C。
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. 和 G 计划一样，由一个会话串行推进，每个 PR 收尾时在决策记录里记一行代替 tick。
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owner 用 `pstack:poteto-agent`。
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] S1 branches from G5 (`psa/mod-g5-quotes`) as `psa/sc-s1-files`. G1 到 G5 已经合并时，从 `main` 开。
  - [ ] S2 on S1 (`psa/sc-s2-scan`). S3 on S2 (`psa/sc-s3-tools`). S4 on S3 (`psa/sc-s4-rollout`).
- [ ] Hold the file boundaries. S1 只碰 `src/`、`tests/`、`justfile`、`docs/modules/architecture/`、`docs/modules/module-user-guide.md`、`docs/adr/`。S2、S3 只碰 `docs/modules/examples/stock-ta/`、`docs/modules/stock-ta.md`、`tests/`、`docs/modules/evidence/`。S4 只碰 `docs/modules/stock-ta.md` 和 `docs/modules/evidence/`。没有 PR 改技术分析仓库。技术分析项目的本地目录只读，不对它的真实数据库跑 `ta`。
- [ ] Hold the review gate. 本计划没有改界面的 PR。

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 以 `just test` 全绿和 `node docs/modules/architecture/check.mjs` 全绿为准。
- [ ] Run `/deslop` before each commit and `/no-comments` before review. `deslop` 用内置 `simplify` 代替，`no-comments` 用 `pstack:comment-sicko` 代替。
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`. 仓库没有 Bugbot，记一行 skip。
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. 叠放的 PR 合并父分支，不 force-push。
- [ ] 推送前查私人信息。仓库是公开的。diff 里不能出现家目录绝对路径、邮箱、机器名，旧 Mac 只写「旧 Mac」。所有手动命令都设临时的 `PSA_STATE_DIR`。

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict. 一个验证者跑 gates、十条 lane 和 perf。审查者读 diff，一个看正确性，一个看「只有 feed 写、先写副本再换上」这条规则。
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 不合并，停在 merge-ready。使用者说合并时按 Shipping 从下往上 squash 合并，每个先比 patch-id 再跑测试。

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. 本次在本机跑，每条 lane 用自己的临时状态目录。S4 的 lane 在旧 Mac 上跑。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 命令行 lane 设 `PSA_STATE_DIR=$(mktemp -d)` 后跑 `just ...`。宿主 lane 用 `tests/e2e/harness.ts` 的 `startHost`，假模型用 `tests/e2e/fake-model.ts`，真模型只用 `openai-codex/*`。
- [ ] 不连 Massive 的 lane 用假的 `ta`（一个 node 脚本，按子命令回放 JSON，把每次被调用记进一个日志文件；要写数据库的 lane 用 `node:sqlite` 往 `TA_DB_PATH` 写行）。真行情 lane 用宿主密钥文件里的 `POLYGON_API_KEY`，只读。第一次扫描用 `now` 补数（S2），所以真行情 lane 在上一个交易日收盘以后任何时候都能跑，不用等美东 16:15。
- [ ] 输入只走 `just` 命令、宿主 socket 和网页。只读诊断是 `just modules`、对克隆跑的 `sqlite3 -readonly`、宿主日志。S4 在旧 Mac 上只用 `ssh -o BatchMode=yes` 跑文档里写的命令和只读诊断。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. 命令行 lane 存 `<slug>.txt`。

## Give module code its own files and a Python environment (S1)

**Depends on.** G5.

**Files.**

- [x] Edit `src/modules/run-code.ts`。`codeProcess` 多给一个环境变量 `PSA_MODULE_DATA`，值是 `<stateDir>/modules-data/<模块>/`。
- [x] Edit 调 `runModuleCode` 和 `runModuleCodeAsync` 的地方（`src/modules/feed-runner.ts`、`src/modules/gateway.ts`、`src/modules/validate.ts`），把模块的数据目录传下去。
- [x] Edit `src/modules/manifest.ts`、`src/modules/validate.ts`、`src/host/live-modules.ts`。`feed.json` 加可选的 `limit`；包里可以有 `py/` 子项目，命令行检查和宿主装包时的检查都认它；`__pycache__` 不算进版本 digest（`allFiles`、`digestOf`）。
- [x] Edit `src/modules/scheduler.ts`、`src/host/host.ts`，模块关掉或宿主停下时杀掉还在跑的 feed 进程组。
- [x] Create `src/cli/module-setup.ts`。Edit `src/cli/module.ts`，加 `just module setup <名字>`。
- [x] Edit `src/cli/module-try.ts`，预演的临时状态目录接上真实的 `files/`。
- [x] Edit `docs/modules/architecture/design.md` 第 2、3 节和 `docs/modules/module-user-guide.md`。
- [x] Create `tests/module-files.test.ts`、`tests/module-setup.test.ts`。

**Build.**

- [x] 每个工具和 feed 的进程都拿到 `PSA_MODULE_DATA`。模块代码只往其中的 `files/` 写。`data.db` 和 `knowledge/` 由宿主管，代码只读。宿主每次调用模块代码前建好 `files/`（`run-code.ts`）。`just module purge` 本来就删整个目录，`files/` 跟着删。
- [x] 两条检查路径（`just module check`，和宿主在 `src/host/live-modules.ts` 里装新版本前的检查）跑用例和 feed 的 fixtures 时，都给代码一个临时的 `PSA_MODULE_DATA`，跑完删掉。fixture 里的假 `ta` 永远看不到真实的数据目录。临时 `files/` 里的 `venv-*` 是指向这个模块已装好的 venv 的符号链接，所以用 venv 的工具用例也能通过；还没装时，失败的用例那一行写着先跑 `just module setup <名字>`。
- [x] `feed.json` 的 `limit`（例如 `"5m"`，最多 `"10m"`）代替默认的 20 秒，调度器照这个时限停掉这一次调用。不写还是 20 秒。模块关掉（feed 不在模块表里了）或宿主停下时，调度器马上杀掉还在跑的调用的整个进程组，所以 purge 以后不会有进程把数据目录写回来，宿主退出也不留孤儿。
- [x] `py/` 是允许的非组件目录，两条检查路径都认。今天 `just module check` 对它报 `py: is not a component kind`（实测，Appendix A）。包里有 `py/pyproject.toml` 时，检查要求同一目录有 `py/uv.lock`，缺一个就拒绝并说明。`__pycache__` 不进版本 digest，否则 Python 跑一次就让宿主以为包变了。
- [x] venv 按锁文件分开放：`files/venv-<py/uv.lock 的 sha256 前 12 位>`。工具和 feed 用和**自己这份包副本**里 `py/uv.lock` 对得上的那个 venv，所以 `rev` 换了以后，钉在旧版本上的 ticket 照样能跑。
- [x] `just module setup <名字>` 跑 `uv sync --frozen --compile-bytecode --project <包>/py`，设 `UV_PROJECT_ENVIRONMENT=<数据目录>/files/venv-<12 位>`。环境不进包目录，包不被改动（实测见 Appendix A）。装完最后一步写 `venv-<12 位>/.psa-lock`，内容是完整的 sha256；没有这个文件的 venv 算没装完，下次 setup 重装。重跑同一个锁文件什么都不变。setup 删掉当前和上一个以外的 venv（按 `.psa-lock` 的修改时间）。找不到 `uv` 或 git 拿不到私有仓库时，一行说明怎么办，指向 `docs/modules/stock-ta.md`。
- [x] `just module try` 的临时状态目录里，`files/` 是真实 `files/` 的克隆，`venv-*` 例外，是指向真实 venv 的符号链接。venv 里的脚本写死了绝对路径，所以不能复制，也不能改名。预演跑 feed 只写克隆，不碰真实数据。

**You see.**

- [x] 一个带 `py/`（依赖一个公开的小包）的样例模块打开后，`just module setup` 打印一行装好了，`modules-data/<模块>/files/venv-<12 位>/bin/` 里有可执行文件，包目录的 sha256 没变，`just modules` 里它是有效的，没有 `py` 的报错。
- [x] 样例工具输出 `PSA_MODULE_DATA`，值是这个模块自己的数据目录。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/module-files.test.ts` 覆盖工具和 feed 拿到自己模块的目录、拿不到别的模块的、两条检查路径都用临时目录、两条检查路径都接受 `py/`、`__pycache__` 不改变 digest、`limit` 生效和上限、try 的克隆加符号链接、purge 删掉 `files/`。`tests/module-setup.test.ts` 用一个假 `uv` 覆盖参数、`UV_PROJECT_ENVIRONMENT` 是 `venv-<12 位>`、`.psa-lock` 最后写、重跑不变、半截 venv 被重装、只留当前和上一个、缺 `uv` 的说明、缺 `uv.lock` 时检查拒绝。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/s1-live.ts`。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都打开 personal-tax 并调一次 `tax-bracket`。Save `s1-regression.txt`. Pass when 两边结果相同。
- [x] Lane 2. 样例模块和另一个模块的工具各打印一次 `PSA_MODULE_DATA`。Save `s1-env.txt`. Pass when 各自拿到自己的数据目录，`files/` 已经建好。
- [x] Lane 3. 真 `uv` 跑 `just module setup` 样例模块。Save `s1-setup.txt`. Pass when `files/venv-<12 位>` 建好，`.psa-lock` 等于 `uv.lock` 的 sha256，包目录 sha256 不变。
- [x] Lane 4. 再跑一次 `just module setup`，然后在包的 `py/` 里放一个 `__pycache__/x.pyc`。Save `s1-setup-again.txt`. Pass when 什么都没变，两秒内结束，`just modules` 里的版本 digest 不变、不提示有新版本。
- [x] Lane 5. 改两次 `py/uv.lock`（换依赖的版本），每次都 setup。Save `s1-venv-retention.txt`. Pass when 第一次改完有两个 venv，第二次改完只剩当前和上一个。
- [x] Lane 6. PATH 里没有 `uv` 时跑 setup。Save `s1-no-uv.txt`. Pass when 一行说明，退出码非零。
- [x] Lane 7. feed 写 `"limit": "1m"`，handler 睡 30 秒。Save `s1-limit.txt`. Pass when 这一次成功，不在 20 秒时被停。
- [x] Lane 8. `just module check` 跑带 `py/` 和 fixtures 的样例模块，handler 往 `files/` 写一个文件。Save `s1-check.txt`. Pass when ok，没有 `py` 的报错，真实数据目录里没有这个文件。
- [x] Lane 9. 宿主运行中，把同一个样例模块放进模块目录，让宿主自己检查并装上。Save `s1-host-check.txt`. Pass when 宿主日志里这个版本检查通过，没有 `py: is not a component kind`，真实数据目录里没有 fixture 写的文件。
- [x] Lane 10. `just module try` 样例模块，预演里的 feed 往 `files/` 写；然后关掉模块、`just module purge`。Save `s1-try-purge.txt`. Pass when 预演后真实 `files/` 不变、临时目录里的 `venv-*` 是符号链接；purge 后 `files/` 和所有 venv 都没了。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 宿主启动到就绪的时间，和一次空工具调用的宿主侧时间。
- [x] Probe. trunk 和 head 交替各 5 次 `startHost`，各 20 次空工具调用。
- [x] Baseline. Record the trunk 启动中位数和空工具调用中位数 first.
- [x] Rule. 启动比 trunk 慢 200 毫秒以上，或空工具调用慢 20 毫秒以上，就失败。

2026-11-12 在 f613e6d 上通过：`tests/module-files.test.ts` 14 条、`tests/module-setup.test.ts` 8 条、`tests/modules-cli.test.ts` 加 1 条（try 的克隆加符号链接），每条先红后绿；`just test` 1664 条里只有已知偶发的「终端 Ctrl+C：Watchdog 不停别人启动的宿主」失败（基线 2ec205d 上也失败，单独重跑三次两次全过），`check.mjs` 全绿。十条 lane 全 PASS，输出在 `/tmp/swarm-s1/owner/s1-*.txt`；样例的 `py/` 依赖公开包 `six`，lane 3 到 5 用真 `uv` 从 PyPI 装，setup 0.4 秒，重跑 0.35 秒，换两次锁文件后只剩当前和上一个 venv。perf 启动 trunk 中位 395.4 ms、head 396.5 ms（各 5 次）；空工具调用 trunk 40.9 ms、head 40.8 ms、带 200 KB `uv.lock` 的包 41.1 ms（各 20 次，每次调用都算一遍锁文件的 sha256）。接缝选环境变量（`PSA_MODULE_DATA`、`PSA_MODULE_VENV`），不在输入里加字段，理由见 PR。

2026-11-12 修复轮在 bd73c2e 上通过（合进 main d03b0d5 之后）：两条检查路径的临时 `files/` 链上已装好的 venv，没装时失败行写着先跑 `just module setup <名字>`（`tests/module-files.test.ts` 4 条，先红在 ENOENT）；模块关掉和宿主停下时调度器杀掉还在跑的 feed 进程组（`tests/scheduler.test.ts` 2 条，先红在数据目录被写回、宿主停下后进程还活着）。`just test` 1670 条全过，`check.mjs` 全绿。十条 lane 对 origin/main 全 PASS，输出在 `/tmp/swarm-s1/fix/s1-*.txt`（lane 10 第一次因临时目录太长、socket 路径超限失败，换短目录重跑通过）。perf 启动 trunk 中位 401.9 ms、head 400.0 ms（各 5 次）；空工具调用 trunk 42.0 ms、head 42.3 ms（各 20 次）。

**Review gate.** None. S1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Give stock-ta its pinned ta and its own daily scan (S2)

**Depends on.** S1.

**Files.**

- [x] Create `docs/modules/examples/stock-ta/py/pyproject.toml`、`py/uv.lock`。
- [x] Create `docs/modules/examples/stock-ta/feeds/scan/feed.json`、`feeds/scan/index.ts`、`feeds/scan/fixtures/`。
- [x] Create `docs/modules/examples/stock-ta/data/scan-runs/collection.json`。
- [x] Edit `docs/modules/stock-ta.md`，加 `just module setup stock-ta` 和 `scan` feed 两节。`TA_ROOT` 那一步这次不动。
- [x] Create `tests/stock-ta-scan.test.ts`。

**Build.**

- [x] 这个 PR 只加不减。工具照旧读 `TA_ROOT`，回答不变。模块多了自己的 `py/`、自己的 `scan` feed 和 `scan-runs`，把数据写进 `files/ta/ta.sqlite`。S3 才把工具切过去。
- [x] `py/pyproject.toml` 只依赖 `ta-trading`，`[tool.uv] package = false`，来源是 `{ git = "https://github.com/aicoder2048/TechnicalAnalysis", subdirectory = "app/trading", rev = "<40 位提交>" }`。用 HTTPS 不用 SSH，原因见 Appendix A。提交选技术分析仓库 `main` 上已推送的最新一个，写进 PR 正文。`uv lock` 生成锁文件。
- [x] `feeds/scan/feed.json` 写 `timer`，`every` 1 小时，不写 `when`，`limit` 5 分钟，`reads: ["watchlist"]`，`secrets: ["POLYGON_API_KEY"]`（handler 把它设成 `ta` 进程的 `MASSIVE_API_KEY`），`into: "scan-runs"`。不写 `when` 是因为日线扫描要等收盘后 15 分钟，`us-market-hours` 只到收盘后 20 分钟，一小时一拍会错过。handler 用的 `ta` 是和自己这份包副本的 `py/uv.lock` 对得上的 `files/venv-<12 位>/bin/ta`；fixture 用 `settings.ta` 指向 `feeds/scan/fake-ta.mjs`，用 `settings.now` 固定时间。
- [x] 提前返回。cursor 记最近一次换上了库的扫描的交易日和当时的标的列表。这一拍的美东日期和标的列表都和 cursor 一样时，handler 直接返回，不起 `ta`。不这样的话，16:15 到 24:00 ET 每小时一次，一天要跑约 8 次完整扫描（按时间表推算）。标的列表也算进去，是为了改了自选股当天下一拍就生效。部分标的出错的那次也移动 cursor，出错的标的第二个交易日重试，免得一只退市的股票让每一拍都整轮重扫。
- [x] 准备副本。先删掉残留的 `ta.sqlite.next`、`ta.sqlite.next-journal`、`ta.sqlite.next.scan.lock`。残留的回滚日志会在打开时把新副本悄悄回滚（实测 5000 行，应为 7000 行，`integrity_check` 仍是 ok，Appendix A）。然后把 `files/ta/ta.sqlite` 克隆成 `ta.sqlite.next`，没有旧库就从空库开始。
- [x] 跑扫描。输入是 `{"mode":"daily","symbols":<标的>,"now":<时间>}`。标的是 G5 `watchlist` 里 `ta` 认的代码的前 30 只，再总是加上 QQQ、SPY，自选股是空的也加。空的标的列表会「成功」，但 0 根日线、没有基准（实测）。超过 30 只时只扫前 30 只，在 `scan-runs` 那一行说明。`ta` 不认的代码（按技术分析仓库 c9e7536 的 `normalize_symbol`：1 到 10 个字母，可带一个点和 1 到 2 个字母，`-` 当成 `.`）一只就会让 `ta scan` 整次退出码 1，所以 handler 先按同一条规则筛掉，在那一行点名，`BRK-B` 写成 `BRK.B` 传。30 只的上限不变，断网时可能超时，超时也存「失败」行（见下）。算术：计划时实测断网约 8.4 秒一只（3 只加 QQQ、SPY 共 42 秒），审查时实测约 12 秒一只，修复时用真 `ta` 复测 3 个标的 36 秒；32 乘 12 约 384 秒，超过 270 秒的扫描时限，所以 30 只全满又断网时这一行写超时，不是逐个 `MARKET_UNAVAILABLE`。不为此降低上限：有网时 12 个标的第一次扫描 22 秒（lane 10 实测），上限卡的是断网，而断网时两种行都是「失败」，下一拍再试。
- [x] 第一次补数。数据库是空的时，传 `now` = 上一个交易日收盘加 16 分钟，第一拍就有数据，不用等到当天 16:15 ET（周末装的话要等到周一）。`ta scan` 接受 `now`（实测）。上一个交易日从 `ta calendar` 取，返回字段由 owner 实现时核对。库已经存在时，每一拍都传这一拍自己的时间当 `now`。
- [x] 判断成败只看 `ta scan` 输出的 JSON，不看退出码。断网和跳过的退出码都是 0（实测）。
  - [x] 跳过（不是交易日或还没到时间）：删掉副本，不存行，不换库，不动 cursor。
  - [x] 每个标的都出错（例如断网时全是 `MARKET_UNAVAILABLE`）：算失败，删掉副本，旧库不动，存一行带错误原因的 `scan-runs`。
  - [x] 部分标的出错：把副本改名成 `ta.sqlite` 换上，那一行列出哪些标的出错、原因是什么。
  - [x] 进程退出码非零：删掉副本，旧库不动，日志一行。
  - [x] 超过 `scanSeconds`（270 秒）：停掉 `ta`，删掉副本，旧库不动，存一行「失败」，原因写超时，cursor 不动。`ta` 只在结束时输出一次 JSON，所以停掉时不知道扫到第几只。
- [x] `ta scan` 的日线扫描自己会补齐两年日线、分红，以及 QQQ、SPY 两个基准（读代码确认，见 Appendix A），handler 不另调同步命令。
- [x] `scan-runs` 每一行的 id 是交易日加开始时间，每次运行都不同。feed 存行用 `INSERT OR IGNORE`，id 重复的行只存第一次（实测），如果只用交易日做 id，当天第一次失败的那一行会一直留着。字段是交易日、开始时间、结果（换上、失败）、标的数、自选股是不是空的、有没有因为上限少扫、新信号数、出错的标的和原因。
- [x] 不发触发。新信号要不要叫醒领队，是 Appendix E 第 3 条，默认不叫。

**You see.**

- [x] 打开 stock-ta 后的第一拍（一小时内），`scan-runs` 出现一行。`files/ta/ta.sqlite` 里每只自选股约 500 根日线，QQQ、SPY 也在，数据时间是上一个交易日收盘。工具这时还读 `TA_ROOT`，回答和以前一样。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/stock-ta-scan.test.ts` 用假 `ta` 覆盖：传的是自选股加 QQQ、SPY、空自选股也带基准并在行里说明、超过 30 只只扫前 30 只并说明、全部成功换上、部分出错换上并列出、全部出错不换并存错误行、断网（退出码 0、全是 `MARKET_UNAVAILABLE`）同上、跳过不换不存行、退出码非零时旧库一字不差、残留的 `.next`、`-journal`、`.scan.lock` 先被删掉、同一天两次运行存两行、cursor 命中时不起 `ta`、改自选股当天下一拍重扫、空库第一次传上一个收盘加 16 分钟的 `now`、用的是自己包副本锁文件对应的 venv、缺密钥时一行说明、`ta` 不认的代码（「腾讯」「NVDA US」「$NVDA」「0700.HK」、11 个字母）被筛掉并点名而 `BRK.B` 照扫、超时存「失败」行。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/s2-live.ts`。lane 3 到 lane 9 用假 `ta`。lane 2 和 lane 10 用真 GitHub 凭据、真 Massive、真 `ta`；靠 `now` 补数，上一个交易日收盘以后任何时候都能跑，不需要真实的收盘时间窗。

- [x] Lane 1. Regression lane against trunk. trunk 和 head 都用 `TA_ROOT` 指向同一个临时目录（技术分析项目 `app/trading` 的符号链接，加一份数据库克隆），调 `structure` 查 NVDA。Save `s2-regression.txt`. Pass when 两边 `levels` 和 `momentum` 相同，head 多一个 `scan` feed。
- [x] Lane 2. 在临时状态目录里 `just module setup stock-ta`。Save `s2-setup.txt`. Pass when `files/venv-<12 位>/bin/ta` 存在，`.psa-lock` 等于包里 `uv.lock` 的 sha256，输出里没有 token。
- [x] Lane 3. `just module check` stock-ta。Save `s2-check.txt`. Pass when ok，假 `ta` 跑过，真实数据目录不变。
- [x] Lane 4. 断网：假 `ta` 对每个标的回 `MARKET_UNAVAILABLE`，退出码 0。Save `s2-network-down.txt`. Pass when 旧 `ta.sqlite` 的 sha256 不变，没有 `.next`，`scan-runs` 一行带错误原因。
- [x] Lane 5. 跳过：假 `ta` 回「跳过」。Save `s2-skipped.txt`. Pass when 不换库，不存行，cursor 不变。
- [x] Lane 6. 残留：先放一份 `ta.sqlite.next` 和一份能回滚它的 `ta.sqlite.next-journal`，假 `ta` 用 `node:sqlite` 写 7000 行。Save `s2-leftover-journal.txt`. Pass when 换上的库正好 7000 行，残留文件都没了。
- [x] Lane 7. 假 `ta` 睡过 `limit`。Save `s2-timeout.txt`. Pass when 这一次被停，`scan-runs` 一行「失败」写着超时，旧库不变，没有 `.next`，下一拍照常。
- [x] Lane 8. 同一个 `settings.now` 先跑一轮成功，再跑一拍，然后往自选股加 AMD 再跑一拍。Save `s2-second-tick.txt`. Pass when 第二拍假 `ta` 的调用日志没有新增、没有新行；第三拍起了 `ta`，标的里有 AMD。
- [x] Lane 9. 自选股是空的，跑一拍。Save `s2-empty-watchlist.txt`. Pass when 假 `ta` 收到的标的是 QQQ、SPY，`scan-runs` 那一行写明自选股是空的。
- [x] Lane 10. 空数据目录，自选股 10 只，真行情第一拍。Save `s2-backfill.txt`. Pass when 5 分钟内结束，传的 `now` 是上一个交易日收盘加 16 分钟，12 个标的（含 QQQ、SPY）各约 500 根日线，`scan-runs` 一行；记下时间、行数和请求数。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. trunk 没有这个 feed。只给绝对预算：第一次扫描（10 只加 QQQ、SPY）的总时间，日常一次扫描的总时间，克隆加改名的时间，cursor 命中时一拍的时间。
- [x] Probe. lane 10 的第一次扫描一次。日常扫描是 lane 10 之后清掉 cursor、用同一个 `now` 连跑 3 次，没有新的一天数据，量的是一次扫描的固定开销；有新一天数据的增量在 S4 的真实拍里记。克隆加改名在 5 MB 的库上量 20 次。cursor 命中的一拍量 10 次。
- [x] Baseline. Record the 第一次扫描的时间和 Massive 请求数 first。按代码估算是 36 个请求左右，见 Appendix A。
- [x] Rule. 第一次扫描超过 120 秒，或日常扫描中位数超过 20 秒，或克隆加改名超过 200 毫秒，或 cursor 命中的一拍中位数超过 2 秒，就失败。四个预算都是推断，不是量出来的。

**Review gate.** None. S2 is not review-gated.

2026-11-12 在 e90608d 上通过：`tests/stock-ta-scan.test.ts` 18 条，先全红（没有 `scan` feed）；之后对每条规则做一次变异（不看出错就换上、分红提醒算出错、不删残留、不看 cursor、不补数、不带基准、不设上限、id 只用交易日、跳过当成扫描、从不换上、失败也动 cursor、不传密钥、缺密钥不说明、超时不报），15 个变异各有测试变红，输出在 `/tmp/swarm-s2/owner/mutations.txt`。`just test` 1688 条里只有 S1 的「模块关掉时正在跑的 feed 进程组被杀掉」在全量里失败一次，单独重跑三次全过；`check.mjs` 全绿。十条 lane 全 PASS，输出在 `/tmp/swarm-s2/owner/s2-*.txt`。lane 10 在美东周四 22:31（收盘后，off-hours）跑真 Massive：上一个交易日收盘加 16 分钟是 2026-11-12T21:16:00Z，`ta` 的 scans 表记的正是这个时间；12 个标的各 502 根日线，36 个请求，22 秒结束。perf：第一次扫描 22.1 秒、36 个请求；没有新一天数据的日常扫描中位 8.9 秒（三次 8.9/8.9/9.0，0 个请求，都是本地计算）；5.3 MB 的库克隆加改名中位 2.3 毫秒；cursor 命中一拍中位 56 毫秒，不起 `ta`。核对结果：`ta calendar` 不直接给上一个交易日，`{"date"}` 一次答一天，handler 从今天往回查，最多 10 天。和计划不同的地方：fixture 用的假 `ta` 放在 `feeds/scan/fake-ta.mjs`，因为 `fixtures/` 只能放 JSON；`settings` 多了 `baseUrl`（和 quotes 一样，lane 10 靠它数请求）和 `scanSeconds`（270，所有 `ta` 调用共用一个期限，留 30 秒给宿主的 5 分钟 `limit`）。第一次补数会把两年里的历史信号都算成新信号（实测 7050 条），只记在 `scan-runs`，不发提醒。

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Point stock-ta's tools at its own data and drop TA_ROOT (S3)

**Depends on.** S2.

**Files.**

- [x] Edit `docs/modules/examples/stock-ta/ta.ts`（去掉 `Command` 里的 `"screen"`、`market.sqlite` 那一支、带「技术分析项目」的报错）和每个 `tools/*/tool.json`（去掉 `"secrets": ["TA_ROOT"]`；`tools/signals/tool.json` 的周期去掉 `5m`）。
- [x] Delete `docs/modules/examples/stock-ta/tools/screen/`、`skills/ta-screen/`。按 Appendix E 第 1 条，使用者要留就不删。
- [x] Edit `agents/signal-triage.md`（`description`、正文、`uses` 里的 `screen` 和 `ta-screen`，OR30 延迟警告）、`agents/*.md`（`uses` 加 `data/scan-runs`）、`skills/principle-freshness/SKILL.md`（「技术分析项目」的说法，加 `scan-runs`）、`skills/ta-interpret/SKILL.md`（OR30 一节、5m 的说法）、`evals/nvda-structure.md`（准备步骤把 NVDA 放进自选股）。
- [x] Edit `docs/modules/stock-ta.md`、`docs/modules/examples/stock-ta/module.json`（`description` 不再说「你本机技术分析项目」）。
- [x] Edit `tests/stock-ta.test.ts`。

**Build.**

- [x] `ta.ts` 不再读 `TA_ROOT`。可执行文件是和自己这份包副本 `py/uv.lock` 对得上的 `$PSA_MODULE_DATA/files/venv-<12 位>/bin/ta`，直接调用，不经过 `uv run`。实测两者启动时间一样（Appendix A），直接调用还省掉服务 PATH 里要有 `uv` 这个前提。
- [x] 数据库是 `$PSA_MODULE_DATA/files/ta/ta.sqlite`。每次调用照旧先克隆到临时目录再跑，`TA_DB_PATH` 指向副本。`MASSIVE_BASE_URL` 照旧指向关着的端口，另设 `MASSIVE_API_KEY=offline`。这样缓存缺数据时，报错是「行情不可用」，不会掉进 `ta` 找项目根目录的错误（Appendix A 的 key-status 实验）。
- [x] `note` 设 `TA_NOTES_DIR` 为临时目录，里面链接 `$PSA_MODULE_DATA/knowledge/*/` 下所有 `TA?? - *.md`。笔记靠 `just module import` 导入，导入步骤不变。没导入时说哪份没导入。
- [x] 调用前找 venv。对应的 `venv-<12 位>/.psa-lock` 存在才用。一个 venv 都没有时说「先跑 just module setup stock-ta」。有别的 venv、没有这一个时说「包里钉的 ta 版本变了，重跑 just module setup stock-ta」。没有 `ta.sqlite` 时说「还没有数据，等 scan feed 第一次跑完（打开后一小时内）」。
- [x] `structure` 的 `now` 规则不变：取这个标的和 QQQ、SPY 最近一次同步分红的时间加一分钟。
- [x] 模块只扫日线。`screen`、日内 5 分钟信号和 OR30 都去掉，`docs/modules/stock-ta.md` 里列一节「你会少什么」，写明这三样和原因。工具、技能、Worker 的文字都不再提它们和「技术分析项目」，只有导入的笔记出处（`knowledge/*/source.json` 的 `origin`）和导入的笔记正文例外。
- [x] 文档的安装步骤改成复制包、`just module setup stock-ta`、导入笔记、打开、等第一拍扫描。`TA_ROOT` 那一步删掉。

**You see.**

- [x] 一台没有技术分析项目的机器上，装好、打开、第一拍扫描以后，问「NVDA 现在的支撑阻力和动量怎么样」，汇报和今天一样带数据时间和笔记出处。宿主密钥文件里没有 `TA_ROOT`，工具列表里没有 `screen`。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/stock-ta.test.ts` 的假 `uv` 换成放在 `files/venv-<12 位>/bin/ta` 的假 `ta`。覆盖每个工具调的子命令和参数、`TA_DB_PATH` 是副本、原库不变、关着的端口和 `offline` 密钥、没 venv、只有别的锁文件的 venv、没写完的 venv（没有 `.psa-lock`）、没数据库、`note` 的链接目录、20 KB 裁剪、没有 `screen` 工具、`signals` 不收 `5m`。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/s3-live.ts`。开头在临时状态目录里 `just module setup stock-ta`，再让 `scan` feed 用 `now` 补数跑一拍，lane 1 到 lane 8 都用这份数据库。没有 lane 需要真实的收盘时间窗。

- [x] Lane 1. Regression lane against trunk. trunk 用 `TA_ROOT` 指向一个临时目录（技术分析项目 `app/trading` 的符号链接，加这份数据库的克隆），head 读 `files/ta/`，都调 `structure` 查 NVDA。Save `s3-regression.txt`. Pass when 两边 `levels` 和 `momentum` 相同。
- [x] Lane 2. `prices` 查 NVDA、QQQ。Save `s3-prices.txt`. Pass when 有价格和数据时间，`files/ta/ta.sqlite` 的 sha256 调用前后相同。
- [x] Lane 3. `signals`、`conditions` 查 NVDA，`rules` 查一个 rule_id。Save `s3-signals-rules.txt`. Pass when 信号和状态与 lane 1 那份数据一致，规则返回定义和出处。
- [x] Lane 4. 导入 TA02 后 `note` 查 `TA02#用法二：背离是 MACD 最核心的信号`。Save `s3-note.txt`. Pass when 返回这一节原文，没有 `path`。
- [x] Lane 5. 没导入就查 `note`。Save `s3-note-missing.txt`. Pass when 一行说明哪份没导入。
- [x] Lane 6. 删掉所有 `files/venv-*` 再调。Save `s3-no-venv.txt`. Pass when 「先跑 just module setup stock-ta」。
- [x] Lane 7. 一个 Worker 钉在当前版本上时，改包里 `py/uv.lock` 让宿主装上新版本。Save `s3-lock-changed.txt`. Pass when 钉在旧版本的 ticket 调 `structure` 照常（用旧 venv）；新版本调用说「重跑 just module setup stock-ta」；setup 以后新版本照常，两个 venv 都在。
- [x] Lane 8. 扫描进行中连调 20 次 `prices`。Save `s3-concurrent.txt`. Pass when 20 次都成功，没有一次读到坏库。
- [x] Lane 9. `rg -n 'screen|ta-screen|技术分析项目|TA_ROOT' docs/modules/examples/stock-ta`，再 `rg -n '5m|OR30' docs/modules/examples/stock-ta`。Save `s3-cleanup.txt`. Pass when 只剩 `knowledge/*/source.json` 的 `origin` 行和导入的笔记正文。
- [x] Lane 10. 真模型 `openai-codex/*` 问「NVDA 现在的支撑阻力和动量怎么样，数据是哪天的」。Save `s3-real-ask.txt`. Pass when 领队派给结构与形态和趋势与动量，汇报带数据时间并引用 `scan-runs` 最近一行的日期，宿主密钥文件里没有 `TA_ROOT`。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. 一次 `structure` 工具调用的总时间，含克隆、起 `ta`、读结果。
- [x] Probe. trunk（`uv run --no-sync`）和 head（直接调 venv 里的 `ta`）交替各 10 次，同一份克隆数据，先各跑一次热身。
- [x] Baseline. Record the trunk 中位数 first.
- [x] Rule. head 中位数比 trunk 慢 100 毫秒以上就失败。

2026-11-12 在 5faab06 上通过（之后只删了注释，修了 lane 3 的比较）：`tests/stock-ta.test.ts` 20 条、`tests/stock-ta-scan.test.ts` 加 1 条，先红后绿（红的输出在 `/tmp/swarm-s3/owner/red-1.txt`、`red-2.txt`、`red-3.txt`）。`just test` 1697 条全过（前一次 1696 条里只有 S2 记过的偶发失败「模块关掉时正在跑的 feed 进程组被杀掉」，单独重跑三次全过）；`check.mjs` 全绿。十条 lane 全 PASS，输出在 `/tmp/swarm-s3/owner/s3-*.txt`。开头的真扫描（NVDA、AMD 加 QQQ、SPY）12 个请求、12 秒，每只 502 根日线，数据到 2026-11-12。lane 1 trunk（`TA_ROOT` 加同一份库的克隆）和 head 的 `levels`、`momentum` 的 sha256 一样。lane 7 换锁文件以后，新副本说「包里钉的 ta 版本变了」，旧副本照常，setup 以后两个都照常、留两个 venv；这条 lane 按宿主给钉住的 ticket 传旧包副本的方式直接调工具，没有起宿主。lane 8 扫描进行中 8 次、之后 12 次 `prices` 都成功。lane 10 真模型 `openai-codex/gpt-6.1-terra`（Router）和 `gpt-6.1-sol`（Worker），领队派给结构与形态和趋势与动量，汇报写了 2026-11-12，Worker 读了 `scan-runs`。perf：`structure` 交替各 10 次，trunk 中位 1140 毫秒，head 中位 1115 毫秒，两边的时间都花在 `ta structure` 的计算上。和计划不同的地方：`rules` 和 `note` 不读数据库，第一次扫描前也能用；`signals` 和 `structure` 的周期都只收 `1d`、`1w`；`signals` 去掉 `ta` 的已读标记，因为第一次补数的历史信号全是未读；scan feed 和工具共用一个「venv 装好了」的判断，没有 `.psa-lock` 的 venv 两边都不用；scan feed 的 `limit` 写成 `300s`（同样 5 分钟），清理检查才只剩笔记出处；`evals/nvda-structure.md` 的前提写进题面开头一句，因为考题的 front matter 只认三个字段。还没做到的：`just module try` 只复制 `files/`，不复制 `knowledge/`，预演里 `note` 会说笔记没导入，要改得改 `src/cli/module-try.ts`，不在本 PR 的文件范围里。

**Review gate.** None. S3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Install stock-ta on the old Mac and write the runbook (S4)

**Depends on.** S3.

**Files.**

- [ ] Edit `docs/modules/stock-ta.md`，加「在另一台机器上装」一节。
- [ ] Create `docs/modules/evidence/s4-old-mac.md`（只记命令输出摘要，不写机器名和路径）。

**Build.**

- [ ] 文档写清旧 Mac 要的东西。旧 Mac 现在没有 `uv`，也没有 `gh`。它没有能访问 GitHub 的 SSH 密钥。登录钥匙串在终端里常是锁着的，`osxkeychain` 存凭据会被悄悄丢掉，所以改用 git 的 `store` helper（Appendix A）。
- [ ] 默认做法（Appendix E 第 2 条）。使用者在 GitHub 网页上建一个 fine-grained token，只给技术分析这一个仓库的 Contents 只读权限，设过期时间。在旧 Mac 上设 `git config --global credential.helper store`，`~/.git-credentials` 权限 600，第一次 `git ls-remote` 时填入 token。2026-11-12 使用者已做完，旧 Mac 读到 main c9e7536，不再问密码。凭据只在跑 `just module setup` 时用，宿主服务运行时不需要。
- [ ] 装 uv（官方安装脚本或 Homebrew）。`#91` 已经把装机时 PATH 里 `uv` 的目录写进服务 PATH，S3 起工具和 S2 的 feed 都直接调 venv，所以只有 setup 需要 `uv`。uv 会下载 Python 3.12。旧 Mac 是 Intel、macOS 12，numpy 和 pandas 都有 `macosx_10_13_x86_64` 的 wheel，不用编译。
- [ ] 复制包、`just module setup stock-ta`、密钥文件里确认有 `POLYGON_API_KEY`、把笔记文件拷过去并导入、`just module on stock-ta`、等第一拍扫描（`now` 补数，一小时内）。自选股超过 30 只时只扫前 30 只，`scan-runs` 里会说。
- [ ] 换钉的提交时，改 `py/pyproject.toml` 的 `rev`，跑 `uv lock`，提交。每台机器复制新包以后重跑 `just module setup stock-ta`。旧的 venv 留着，钉在旧版本上的 ticket 照常；工具在新版本没有 venv 时会提醒（S3）。

**You see.**

- [ ] 旧 Mac 上，打开 stock-ta 后一小时内 `scan-runs` 有一行。在手机上问「NVDA 现在的支撑阻力和动量怎么样」，汇报带最近一个交易日收盘的数据时间。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 文档里的每条命令在本机的临时状态目录里照抄跑一遍，输出存进 `/tmp/swarm-s4/doc-commands.txt`。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. lane 2 和 lane 3 要使用者亲手做，owner 等使用者说做完了再接着跑。lane 7 靠 `now` 补数，任何时候都能跑；lane 9 的「下一拍提前返回」也不需要收盘时间窗。

- [ ] Lane 1. Regression lane against trunk. trunk 上旧 Mac 没有 stock-ta。记下这一点，在旧 Mac 上跑 `just modules`，确认 us-market 照常。Save `s4-regression.txt`. Pass when 装之前和装之后 us-market 的状态相同。
- [ ] Lane 2. 使用者建 token、存进 `~/.git-credentials`。owner 跑 `git ls-remote https://github.com/aicoder2048/TechnicalAnalysis HEAD`。Save `s4-auth.txt`. Pass when 打印一个提交，没有要密码。
- [ ] Lane 3. 使用者装 uv。owner 跑 `uv --version`。Save `s4-uv.txt`. Pass when 有版本号。
- [ ] Lane 4. `just module setup stock-ta`。Save `s4-setup.txt`. Pass when 装好，记下用时和 `files/venv-<12 位>` 的大小。
- [ ] Lane 5. `just module check` 和 `just modules`。Save `s4-check.txt`. Pass when ok，stock-ta 有效。
- [ ] Lane 6. 导入 18 份笔记。Save `s4-import.txt`. Pass when `knowledge` 显示都导入了。
- [ ] Lane 7. 打开 stock-ta，等第一拍扫描。Save `s4-first-scan.txt`. Pass when `scan-runs` 一行，12 个标的有日线，记下用时。
- [ ] Lane 8. 旧 Mac 上调 `structure` 查 NVDA。Save `s4-structure.txt`. Pass when 有结果，数据时间是最近一个交易日收盘。
- [ ] Lane 9. 重启宿主服务。Save `s4-restart.txt`. Pass when stock-ta 仍然有效，下一拍按 cursor 提前返回、没有起 `ta`。
- [ ] Lane 10. 真模型从手机（Telegram）问 NVDA 的支撑阻力和动量。Save `s4-phone.txt`. Pass when 汇报带数据时间和笔记出处。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 旧 Mac 上一次 `structure` 调用的时间，`just module setup` 第一次的时间，第一次扫描的时间。trunk 上旧 Mac 没有这个模块，只给绝对预算。
- [ ] Probe. `structure` 先热身一次再连调 10 次；setup 和第一次扫描各一次。之后遇到的第一个有新数据的真实拍，记下增量扫描的时间。
- [ ] Baseline. Record the 本机同一份数据上 `structure` 的中位数 first（S3 的 perf 结果）。
- [ ] Rule. 旧 Mac 上 `structure` 中位数超过 3 秒，或 setup 超过 10 分钟，或第一次扫描超过 5 分钟（feed 的 `limit`），就失败。

**Review gate.** None. S4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

2026-11-12 在本机的临时目录里做的实验，没有碰技术分析项目的目录和数据库，数据库只读过 APFS 克隆。分两轮：写计划时的原型，和同一天对计划做的对抗审查（interrogate，两组审查者各自写探针跑）。下面标「实测」的是跑出来的，标「推断」的是算出来或读代码得出的。

**uv 能装私有仓库的子目录（实测）。** `git+ssh://git@github.com/aicoder2048/TechnicalAnalysis@<sha>#subdirectory=app/trading` 在本机失败，`Permission denied (publickey)`，因为本机的 SSH 密钥没登记在 GitHub 上。换成 `git+https://...` 后成功。uv 0.5.9 通过 git 的 `osxkeychain` 凭据拿到私有仓库，`uv add` 用了 4.4 秒，写出 `[tool.uv.sources] ta-trading = { git = "https://...", subdirectory = "app/trading", rev = "<sha>" }`。uv 缓存清空后 `uv sync --frozen` 用了 3 秒（本机已有 Python 3.12），缓存 101 MB，venv 74 MB。所以 S2 用 HTTPS 地址。审查时复核：钉在 c9e7536、venv 放在包外，热缓存 `uv sync` 0.49 秒，包目录不变，重跑什么都不写。

**venv 可以放在包外面（实测）。** 把包目录设成只读，`UV_PROJECT_ENVIRONMENT=<数据目录>/venv uv sync --frozen --project <包>/py` 成功，包目录每个文件的 sha256 都没变。

**装好的 `ta` 不需要技术分析项目（实测）。** 不设 `TA_ROOT`，只设 `TA_DB_PATH`、`TA_MARKET_DB_PATH`、`TA_NOTES_DIR`、`MASSIVE_API_KEY`、`MASSIVE_BASE_URL`，在空的临时目录里 `calendar`、`universe`、`prices`、`note`、`scan` 都正常，`ta.sqlite` 第一次打开时自动建表。代码里 `project_root()` 只在这些环境变量没设时才调用。例外是 `key-status`：没有 `MASSIVE_API_KEY` 时报 `PROJECT_ROOT_NOT_FOUND`，不是「没有密钥」。S3 给工具设 `MASSIVE_API_KEY=offline`，绕开这一处。不需要改技术分析仓库。审查时在 `env -i` 下复核：`rules`、`signals`、`conditions`、`scan` 都能跑，只写 `TA_DB_PATH` 和 `<db>.scan.lock` 两个文件。

**直接调 venv 里的 `ta` 和 `uv run` 一样快（实测）。** 交替各 7 次 `ta calendar`，直接调用中位 289 毫秒，`uv run --frozen --no-sync` 中位 293 毫秒。直接调用里有一次 8.1 秒，是装完后的第一次调用，推断是 Python 在编译字节码，所以 setup 带 `--compile-bytecode`。审查时复核：工具直接调 venv，不靠 PATH 和 HOME，所以 launchd 服务的环境够用。

**旧 Mac（实测，只读查看）。** macOS 12.7.6，Intel x86_64，git 2.37.1，凭据用 `osxkeychain`，钥匙串里没有 github.com 的凭据。`~/.ssh` 里只有 `authorized_keys`，没有 SSH 密钥，`known_hosts` 里也没有 github.com。没有 `gh`，没有 `uv`，有 node 和 just。锁文件里 numpy 2.5.4 和 pandas 3.1.1 都有 `cp312-macosx_10_13_x86_64` 的 wheel（审查时复核）。

**同步多大（推断，按代码估算，没有调 Massive）。** `ta scan` 的日线模式对每个标的取两年日线（`Scanner._window`），一次请求最多 50000 行，所以一页就够；另有一次 `validate_symbol` 和至少一次分红请求。日线模式还自动带上 QQQ、SPY（`_benchmarks`）。10 只自选股加两个基准是 12 个标的，第一次大约 36 个请求、6000 行日线、约 100 行分红。Massive 客户端没有限速，只在出错时退避重试。你本机现有的 `ta.sqlite` 是参照：18 个标的、9039 行日线、2530 行 5 分钟线，5 MB；日线扫描 11 次，平均 2.6 秒，最长 7.5 秒。第一次扫描的 120 秒预算是推断，S2 的 lane 10 实测。

**全市场数据（`screen` 用的 `market.sqlite`）。** 你本机这份是 419 MB：320 个交易日、3146114 行日线、11220 个标的、43077 行分红（实测）。从零同步要约 320 次全市场日线请求、12 页标的列表、44 页分红，再加约 2000 次市值查询，合计约 2400 个请求（推断）。这个量不适合放进一个每天跑的模块 feed，所以默认不做。

**对抗审查找到的问题（2026-11-12，实测，探针在本机临时目录，没有提交）。**

- 原来的顺序是 S2 先拿掉 `TA_ROOT`、S3 才给数据。只合并 S2 时，六个读数据的工具都没有数据可读。所以改成 S2 先加数据、S3 再切工具。
- 残留的回滚日志。`ta.sqlite.next` 旁边留着上一次崩溃的 `-journal` 时，克隆出的新副本在第一次打开时被回滚：探针写 7000 行，读回 5000 行，`integrity_check` 仍是 ok。所以先删残留再克隆。
- 退出码不可信。断网时每个标的都是 `MARKET_UNAVAILABLE`，跳过时什么都没扫，两种情况 `ta scan` 的退出码都是 0。所以只看输出的 JSON。
- 断网时每个标的约 8.4 秒：3 只自选股加 QQQ、SPY 用了 42 秒。30 只的上限由此推断，没有在 30 只上量过。
- 空的标的列表也「成功」：0 根日线，也不带 QQQ、SPY。所以总是把两个基准放进 `symbols`。
- feed 的行用 `INSERT OR IGNORE` 存，id 重复的第二行被丢掉。所以 `scan-runs` 的 id 带开始时间。
- `ta scan` 接受 `now`，传上一个交易日收盘加 16 分钟就能马上补数。
- `just module check` 对 `py/` 报 `py: is not a component kind`。所以 S1 要让两条检查路径都认 `py/`。
- 不提前返回的话，16:15 到 24:00 ET 一小时一拍，一天约 8 次完整扫描（推断，按时间表算）。
- 一个慢的 feed 不会挡住别的 feed（实测，复核计划原来的说法）。

**还没证明的。** 旧 Mac 上 fine-grained token 加 `store` helper 能不能让 uv 拿到私有仓库（git 本身已经可以），要等 S4 的 lane 2 和 lane 4。用 SSH 部署密钥加 `url.<base>.insteadOf` 改写地址这条路，没试过 uv 认不认。第一次扫描 120 秒、日常扫描 20 秒、cursor 命中 2 秒这几个预算，和 30 只的上限，都要等 S2 的 lane 10 和 perf 实测。`ta calendar` 能不能直接给出上一个交易日的收盘时间，由 S2 的 owner 核对。

## Appendix B. Alternatives rejected

- **复制技术分析的源码进模块包。** 使用者 2026-11-12 否决。两份代码会分叉，公开仓库里也不该有私有源码。
- **S2 拿掉 `TA_ROOT`、S3 再给数据（原来的顺序）。** 两个 PR 之间 trunk 是坏的，审查时实测六个工具没有数据。现在 S2 只加不减，S3 再切。
- **git 依赖用 SSH 地址。** 本机的 SSH 密钥没登记在 GitHub 上，旧 Mac 没有 SSH 密钥，HTTPS 加 git 凭据两台都能走通。
- **工具里用 `uv run`。** 服务的 PATH 里要有 `uv`，速度又没好处。setup 时用 uv，运行时直接调 venv。
- **venv 放在包目录里。** 包目录有文件监视，venv 里的几千个文件会触发重新加载，而且复制包时会带上。放在 `files/venv-<12 位>`，purge 时一起删。
- **只有一个 `files/venv`，靠 `.psa-lock` 比对。** `rev` 一换，setup 就把 venv 换成新版本，钉在旧版本上的 ticket 会用错版本或报错。改成每个锁文件一个 venv，留当前和上一个。
- **工具直接读 feed 正在写的库。** 技术分析库是回滚日志模式。扫描写到一半时去克隆，可能拿到半截的库。改成副本加改名以后，读的人只会看到整份旧库或整份新库。
- **按 `ta scan` 的退出码判断成败。** 断网和跳过都是 0，断网那次会把一份没有新数据的副本换上去。
- **`scan-runs` 只用交易日做 id。** id 重复的行只存第一次，当天第一次失败的那一行会一直留着。
- **每一拍都起 `ta`，让它自己判断跳不跳。** 收盘后到午夜一天约 8 次完整扫描。改成 cursor 命中就提前返回。
- **feed 写 `when: us-market-hours`。** 日线扫描要收盘后 15 分钟，那个窗口只到收盘后 20 分钟，一小时一拍会错过。
- **等到当天 16:15 ET 才有第一份数据。** 周末装的话要等到周一。第一次传上一个交易日收盘加 16 分钟的 `now` 补数。
- **用 `ta` 自己的自选股表。** 会有两份自选股。用 G5 的 `watchlist`，扫描时传 `symbols`。
- **留着 `screen` 并同步全市场数据。** 419 MB、约 2400 个请求，旧 Mac 上还要每周刷新市值。没有它，信号、结构、盈亏比都照常。默认拿掉，Appendix E 第 1 条。
- **日内 5 分钟扫描。** 每 5 分钟起一次进程、每只每次一个请求。今天的问题都是日线问题，不做。代价是 5 分钟信号和 OR30 一起没了，S3 在文档里写明。以后要做就加一个 `every: 5m`、`when: us-market-hours` 的 feed，Appendix E 第 5 条。
- **改技术分析仓库让 `key-status` 在没有项目根目录时也报「没有密钥」。** 模块总是自己设密钥变量，不需要。想改的话，是技术分析仓库里一个单独的小 PR：`load_api_key` 找不到项目根目录时按「没有密钥」处理。另外 `backtest` 里 `os.environ.get(..., project_root() / ...)` 的默认值会提前算，同一个 PR 里可以一起改。本计划不做。

## Appendix C. Risks

- **S1 的 `PSA_MODULE_DATA`。** 模块代码本来就和宿主同一个系统用户，没有沙箱，这个变量不改变能读写什么（`current-state.md` 的 No Worker sandbox）。按「MVP 自用，安全从简」，不另加限制。
- **S1 的 venv 占地方。** 一个 venv 74 MB（实测），留两个约 150 MB。setup 删掉更老的；钉在两个版本以前的 ticket 这时会报「重跑 setup」，推断这种 ticket 很少。
- **S2 的 GitHub 凭据。** setup 失败时报错可能带出仓库地址，不会带出 token。lane 2 的输出要查一遍再存。
- **S2 的副本加改名。** 改名要和原库在同一个文件系统，`files/ta/` 里建副本就满足。扫描超时被杀时，副本和日志可能留着，下一次先删再克隆（lane 6）。
- **S2 的 cursor 规则。** 部分标的出错也移动 cursor，出错的标的要到下一个交易日才重试。`scan-runs` 那一行会列出来，`principle-freshness` 让 Worker 先看这一行（S3）。
- **S2 的 30 只上限。** 由断网时的每只用时推断。lane 10 只量 10 只；自选股真的超过 30 只时，要再量一次再改上限。
- **S2、S3 的真行情 lane。** 靠 `now` 补数，不再等收盘时间窗。有新一天数据的增量扫描只在 S4 的真实拍里记一次。
- **S3 让使用者少了东西。** `screen`、5 分钟信号、OR30 都没了。文档写明，Appendix E 第 1 条和第 5 条可以要回来。
- **S4 依赖使用者亲手操作。** 建 token、装 uv 要使用者做。旧 Mac 的登录钥匙串在终端里是锁着的（`security add-internet-password` 报 User interaction is not allowed），所以凭据存进 `~/.git-credentials`，ssh 会话里也能用。
- **钉的版本过时。** 技术分析仓库修了规则，模块不会自动跟上。换提交是一次 PR 加每台机器一次 setup。
- **没有 control skill。** 网页 lane 用仓库自己的 Playwright harness，命令行 lane 用脚本。

## Appendix D. Links and reading list

- `docs/modules/stock-ta.md`，现在的安装步骤和工具的保证。
- `docs/modules/examples/stock-ta/ta.ts`，克隆、关着的端口、`structure` 的 `now` 规则。
- `docs/modules/module-data-feeds-plan.md`（G4、G5），feed 的 handler、fixtures、`reads`、cursor、调度器不重叠同一个 feed。
- `src/modules/protocol.ts` 的 `FeedInput` 和 `Collected`（cursor 只在行存好以后才保存），`src/modules/validate.ts` 的 `allFiles`、`digestOf` 和组件目录检查，`src/host/live-modules.ts` 的装包检查。
- `docs/modules/architecture/design.md` 第 2、3 节，模块代码的环境和 feed。
- 技术分析仓库 `app/trading` 的 `ta/cli.py`（环境变量和子命令）、`ta/scanner.py`（`_window`、`_benchmarks`、`_skip_details`）、`ta/market.py`（请求和分页）、`ta/models.py`（`project_root`）。只读。
- S1 的 owner 在实现前写两种接缝草图再选（`pstack/skills/architect/SKILL.md`，缩小版）：环境变量，还是给代码的输入里加一个字段。
- 决策记录在 `.audit/stock-ta-self-contained.tsv`，按 `pstack/skills/show-me-your-work/SKILL.md`，不提交。

## Appendix E. Decisions for the operator

每条都有默认做法。不回答就按默认走，回答了就按你说的改计划。

1. **`screen`（全市场选股）留不留。** 默认在 S3 拿掉工具和 `ta-screen` 技能。要留，就再加一个 S5：每周一次的全市场同步 feed，约 420 MB、约 2400 个请求，旧 Mac 上要多久没量过。
2. **旧 Mac 用什么凭据拿私有仓库。** 已定：fine-grained token，只给这一个仓库的只读权限，90 天过期，存在旧 Mac 的 `~/.git-credentials`（权限 600）。另一条路是旧 Mac 生成一个 SSH 部署密钥，登记成这个仓库的只读部署密钥，再用 git 的 `insteadOf` 把 HTTPS 地址改成 SSH。这条路不过期，但 uv 认不认没试过。
3. **扫描出新信号时要不要叫醒领队。** 默认不叫，信号只在你问的时候查。要叫的话，`scan` feed 加一个 `notice`，每个新信号发一个触发，和技术分析应用的提醒一样。
4. **钉哪个提交。** 默认是 S2 开工时技术分析仓库 `main` 上已推送的最新提交（今天是 `c9e7536`）。你有还没推送的规则改动的话，先推送。
5. **日内 5 分钟信号和 OR30 要不要。** 默认不要，模块只扫日线，S3 删掉相关的说法。要的话，再加一个 `every: 5m`、`when: us-market-hours` 的 feed，每 5 分钟每只一个请求。
