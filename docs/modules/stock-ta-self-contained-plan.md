# stock-ta self-contained plan

让 stock-ta 不再依赖你本机的技术分析项目和它的两个数据库。装好以后，它在任何一台机器上都能用，包括跑服务的旧 Mac。
不复制源码。模块带一个小的 Python 子项目，用 uv 的 git 依赖装你私有仓库里的 `ta-trading`（`app/trading`），钉在一个提交上。
数据归模块自己。新的 `scan` feed 按 G5 的自选股每天收盘后跑一次 `ta scan`，同步日线和分红（含 QQQ、SPY），写进模块自己的数据目录，密钥用 G5 的 `MASSIVE_API_KEY`。
工具照旧只读、不联网，只是读的换成模块自己数据库的副本。全市场选股 `screen` 默认拿掉，理由见 Appendix B。
程序守的规则是：只有 `scan` feed 写技术分析数据库，而且它先写副本、成功后整个换上；工具只读克隆。
PR 顺序是 S1、S2、S3、S4，依次叠在上一个之上。S1 叠在 G5 上。

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
  - [ ] S2 on S1 (`psa/sc-s2-tools`). S3 on S2 (`psa/sc-s3-scan`). S4 on S3 (`psa/sc-s4-rollout`).
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
- [ ] 不连 Massive 的 lane 用假的 `ta`（一个 node 脚本，按子命令回放 JSON）。真行情 lane 用宿主密钥文件里的 `MASSIVE_API_KEY`，只读，在美东收盘 15 分钟以后跑。
- [ ] 输入只走 `just` 命令、宿主 socket 和网页。只读诊断是 `just modules`、对克隆跑的 `sqlite3 -readonly`、宿主日志。S4 在旧 Mac 上只用 `ssh -o BatchMode=yes` 跑文档里写的命令和只读诊断。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. 命令行 lane 存 `<slug>.txt`。

## Give module code its own files and a Python environment (S1)

**Depends on.** G5.

**Files.**

- [ ] Edit `src/modules/run-code.ts`。`codeProcess` 多给一个环境变量 `PSA_MODULE_DATA`，值是 `<stateDir>/modules-data/<模块>/`。
- [ ] Edit 调 `runModuleCode` 和 `runModuleCodeAsync` 的地方（`src/modules/feed-runner.ts`、`src/modules/gateway.ts`、`src/modules/validate.ts`），把模块的数据目录传下去。
- [ ] Edit `src/modules/manifest.ts`、`src/modules/validate.ts`。`feed.json` 加可选的 `limit`；包里可以有 `py/` 子项目。
- [ ] Create `src/cli/module-setup.ts`。Edit `src/cli/module.ts`，加 `just module setup <名字>`。
- [ ] Edit `src/cli/module-try.ts`，预演的临时状态目录接上真实的 `files/`。
- [ ] Edit `docs/modules/architecture/design.md` 第 2、3 节和 `docs/modules/module-user-guide.md`。
- [ ] Create `tests/module-files.test.ts`、`tests/module-setup.test.ts`。

**Build.**

- [ ] 每个工具和 feed 的进程都拿到 `PSA_MODULE_DATA`。模块代码只往其中的 `files/` 写。`data.db` 和 `knowledge/` 由宿主管，代码只读。宿主在模块打开时建好 `files/`。`just module purge` 本来就删整个目录，`files/` 跟着删。
- [ ] `just module check` 跑 feed 的 fixtures 时，给 handler 一个临时的 `PSA_MODULE_DATA`，跑完删掉。
- [ ] `feed.json` 的 `limit`（例如 `"5m"`，最多 `"10m"`）代替默认的 20 秒，调度器照这个时限停掉这一次调用。不写还是 20 秒。
- [ ] 包里有 `py/pyproject.toml` 时，检查要求同一目录有 `py/uv.lock`，缺一个就拒绝并说明。
- [ ] `just module setup <名字>` 跑 `uv sync --frozen --compile-bytecode --project <包>/py`，设 `UV_PROJECT_ENVIRONMENT=<数据目录>/files/venv`。环境不进包目录，包不被改动（实测见 Appendix A）。装完把 `uv.lock` 的 sha256 写进 `files/venv/.psa-lock`。重跑同一个锁文件什么都不变。找不到 `uv` 或 git 拿不到私有仓库时，一行说明怎么办，指向 `docs/modules/stock-ta.md`。
- [ ] `just module try` 的临时状态目录里，`files/` 是真实 `files/` 的克隆，`venv` 例外，是指向真实 `venv` 的符号链接。venv 里的脚本写死了绝对路径，所以不能复制。预演跑 feed 只写克隆，不碰真实数据。

**You see.**

- [ ] 一个带 `py/`（依赖一个公开的小包）的样例模块打开后，`just module setup` 打印一行装好了，`modules-data/<模块>/files/venv/bin/` 里有可执行文件，包目录的 sha256 没变。
- [ ] 样例工具输出 `PSA_MODULE_DATA`，值是这个模块自己的数据目录。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/module-files.test.ts` 覆盖工具和 feed 拿到自己模块的目录、拿不到别的模块的、check 用临时目录、`limit` 生效和上限、try 的克隆加符号链接、purge 删掉 `files/`。`tests/module-setup.test.ts` 用一个假 `uv` 覆盖参数和 `UV_PROJECT_ENVIRONMENT`、`.psa-lock`、重跑不变、缺 `uv` 的说明、缺 `uv.lock` 时检查拒绝。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/s1-live.ts`。

- [ ] Lane 1. Regression lane against trunk. trunk 和 head 都打开 personal-tax 并调一次 `tax-bracket`。Save `s1-regression.txt`. Pass when 两边结果相同。
- [ ] Lane 2. 样例模块的工具打印 `PSA_MODULE_DATA`。Save `s1-env.txt`. Pass when 值是这个模块的数据目录，`files/` 已经建好。
- [ ] Lane 3. 两个模块各调一次。Save `s1-isolation.txt`. Pass when 各自拿到自己的目录。
- [ ] Lane 4. 真 `uv` 跑 `just module setup` 样例模块。Save `s1-setup.txt`. Pass when `files/venv` 建好，包目录 sha256 不变。
- [ ] Lane 5. 再跑一次 `just module setup`。Save `s1-setup-again.txt`. Pass when 什么都没变，两秒内结束。
- [ ] Lane 6. PATH 里没有 `uv` 时跑 setup。Save `s1-no-uv.txt`. Pass when 一行说明，退出码非零。
- [ ] Lane 7. feed 写 `"limit": "1m"`，handler 睡 30 秒。Save `s1-limit.txt`. Pass when 这一次成功，不在 20 秒时被停。
- [ ] Lane 8. `just module check` 跑带 fixtures 的 feed，handler 往 `files/` 写一个文件。Save `s1-check.txt`. Pass when ok，状态目录里没有这个文件。
- [ ] Lane 9. `just module try` 样例模块，预演里的 feed 往 `files/` 写。Save `s1-try.txt`. Pass when 真实 `files/` 不变，临时目录里的 `venv` 是符号链接。
- [ ] Lane 10. 关掉样例模块后 `just module purge`。Save `s1-purge.txt`. Pass when `files/` 和 `venv` 都没了。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 宿主启动到就绪的时间，和一次空工具调用的宿主侧时间。
- [ ] Probe. trunk 和 head 交替各 5 次 `startHost`，各 20 次空工具调用。
- [ ] Baseline. Record the trunk 启动中位数和空工具调用中位数 first.
- [ ] Rule. 启动比 trunk 慢 200 毫秒以上，或空工具调用慢 20 毫秒以上，就失败。

**Review gate.** None. S1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Point stock-ta's tools at its own pinned ta and its own data (S2)

**Depends on.** S1.

**Files.**

- [ ] Create `docs/modules/examples/stock-ta/py/pyproject.toml`、`py/uv.lock`。
- [ ] Edit `docs/modules/examples/stock-ta/ta.ts` 和每个 `tools/*/tool.json`（去掉 `"secrets": ["TA_ROOT"]`）。
- [ ] Delete `docs/modules/examples/stock-ta/tools/screen/`、`skills/ta-screen/`，Edit `agents/signal-triage.md` 的 `uses`。按 Appendix E 第 1 条，使用者要留就不删。
- [ ] Edit `docs/modules/stock-ta.md`、`docs/modules/examples/stock-ta/module.json`（`description` 不再说「你本机技术分析项目」）。
- [ ] Edit `tests/stock-ta.test.ts`。

**Build.**

- [ ] `py/pyproject.toml` 只依赖 `ta-trading`，`[tool.uv] package = false`，来源是 `{ git = "https://github.com/aicoder2048/TechnicalAnalysis", subdirectory = "app/trading", rev = "<40 位提交>" }`。用 HTTPS 不用 SSH，原因见 Appendix A。提交选技术分析仓库 `main` 上已推送的最新一个，写进 PR 正文。`uv lock` 生成锁文件。
- [ ] `ta.ts` 不再读 `TA_ROOT`。可执行文件是 `$PSA_MODULE_DATA/files/venv/bin/ta`，直接调用，不经过 `uv run`。实测两者启动时间一样（Appendix A），直接调用还省掉服务 PATH 里要有 `uv` 这个前提。
- [ ] 数据库是 `$PSA_MODULE_DATA/files/ta/ta.sqlite`。每次调用照旧先克隆到临时目录再跑，`TA_DB_PATH` 指向副本。`MASSIVE_BASE_URL` 照旧指向关着的端口，另设 `MASSIVE_API_KEY=offline`。这样缓存缺数据时，报错是「行情不可用」，不会掉进 `ta` 找项目根目录的错误（Appendix A 的 key-status 实验）。
- [ ] `note` 设 `TA_NOTES_DIR` 为临时目录，里面链接 `$PSA_MODULE_DATA/knowledge/*/` 下所有 `TA?? - *.md`。笔记靠 `just module import` 导入，导入步骤不变。没导入时说哪份没导入。
- [ ] 调用前比对包里 `py/uv.lock` 的 sha256 和 `files/venv/.psa-lock`。没有 venv 时说「先跑 just module setup stock-ta」。锁文件变了时说「包里钉的 ta 版本变了，重跑 just module setup stock-ta」。没有 `ta.sqlite` 时说「还没有数据，等 scan feed 第一次跑完（交易日收盘 15 分钟以后）」。
- [ ] `structure` 的 `now` 规则不变：取这个标的和 QQQ、SPY 最近一次同步分红的时间加一分钟。
- [ ] 文档的安装步骤改成复制包、`just module setup stock-ta`、导入笔记、打开。`TA_ROOT` 那一步删掉。

**You see.**

- [ ] 一台没有技术分析项目的机器上，装好并放进一份 `files/ta/ta.sqlite` 以后，问「NVDA 现在的支撑阻力和动量怎么样」，汇报和今天一样带数据时间和笔记出处。宿主密钥文件里没有 `TA_ROOT`。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta.test.ts` 的假 `uv` 换成放在 `files/venv/bin/ta` 的假 `ta`。覆盖每个工具调的子命令和参数、`TA_DB_PATH` 是副本、原库不变、关着的端口和 `offline` 密钥、没 venv、锁文件变了、没数据库、`note` 的链接目录、20 KB 裁剪。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/s2-live.ts`。lane 3 到 lane 9 用真 `ta`（`just module setup` 装的），数据库是 lane 2 的结果。

- [ ] Lane 1. Regression lane against trunk. trunk 用 `TA_ROOT` 指向一个只放了克隆数据库的临时目录，head 把同一份克隆放进 `files/ta/`，都调 `structure` 查 NVDA。Save `s2-regression.txt`. Pass when 两边 `levels` 和 `momentum` 相同。
- [ ] Lane 2. 在临时状态目录里 `just module setup stock-ta`，用真 GitHub 凭据。Save `s2-setup.txt`. Pass when `files/venv/bin/ta` 存在，`.psa-lock` 等于包里 `uv.lock` 的 sha256。
- [ ] Lane 3. `prices` 查 NVDA、QQQ。Save `s2-prices.txt`. Pass when 有价格和数据时间，`files/ta/ta.sqlite` 的 sha256 调用前后相同。
- [ ] Lane 4. `signals` 和 `conditions` 查 NVDA。Save `s2-signals.txt`. Pass when 结果和 lane 1 那份数据一致。
- [ ] Lane 5. `rules` 查一个 rule_id。Save `s2-rules.txt`. Pass when 返回定义和出处。
- [ ] Lane 6. 导入 TA02 后 `note` 查 `TA02#用法二：背离是 MACD 最核心的信号`。Save `s2-note.txt`. Pass when 返回这一节原文，没有 `path`。
- [ ] Lane 7. 没导入就查 `note`。Save `s2-note-missing.txt`. Pass when 一行说明哪份没导入。
- [ ] Lane 8. 删掉 `files/venv` 再调。Save `s2-no-venv.txt`. Pass when 「先跑 just module setup stock-ta」。
- [ ] Lane 9. 改包里 `uv.lock` 一个字节再调。Save `s2-lock-changed.txt`. Pass when 「重跑 just module setup stock-ta」。
- [ ] Lane 10. 真模型 `openai-codex/*` 问「NVDA 现在的支撑阻力和动量怎么样」。Save `s2-real-ask.txt`. Pass when 领队派给结构与形态和趋势与动量，汇报带数据时间，宿主密钥文件里没有 `TA_ROOT`。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一次 `structure` 工具调用的总时间，含克隆、起 `ta`、读结果。
- [ ] Probe. trunk（`uv run --no-sync`）和 head（直接调 venv 里的 `ta`）交替各 10 次，同一份克隆数据，先各跑一次热身。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 中位数比 trunk 慢 100 毫秒以上就失败。

**Review gate.** None. S2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends it to the base-branch stack and the operator lands it bottom-up.

## Sync history and run the daily scan from the module's own feed (S3)

**Depends on.** S2.

**Files.**

- [ ] Create `docs/modules/examples/stock-ta/feeds/scan/feed.json`、`feeds/scan/index.ts`、`feeds/scan/fixtures/`。
- [ ] Create `docs/modules/examples/stock-ta/data/scan-runs/collection.json`。
- [ ] Edit `docs/modules/examples/stock-ta/agents/*.md`（`uses` 加 `data/scan-runs`）、`skills/principle-freshness/SKILL.md`、`docs/modules/stock-ta.md`。
- [ ] Create `tests/stock-ta-scan.test.ts`。

**Build.**

- [ ] `feeds/scan/feed.json` 写 `timer`，`every` 1 小时，不写 `when`，`limit` 5 分钟，`reads: ["watchlist"]`，`secrets: ["MASSIVE_API_KEY"]`，`into: "scan-runs"`。不写 `when` 是因为日线扫描要等收盘后 15 分钟，`us-market-hours` 只到收盘后 20 分钟，一小时一拍会错过。不是交易日或还没到时间，`ta` 自己说跳过，一次只花起进程的时间。
- [ ] handler 先把 `files/ta/ta.sqlite` 克隆成 `files/ta/ta.sqlite.next`。没有旧库就从空库开始。然后对副本跑 `ta scan`，输入是 `{"mode":"daily","symbols":<自选股>}`，自选股来自 G5 的 `watchlist`。成功后把副本改名成 `ta.sqlite`。失败或超时就删掉副本，旧库不动。下一次运行看到残留的 `.next` 就覆盖，所以中途崩溃也能接着跑。
- [ ] `ta scan` 的日线扫描自己会补齐两年日线、分红，以及 QQQ、SPY 两个基准（读代码确认，见 Appendix A），handler 不另调同步命令。
- [ ] 跑完存一行 `scan-runs`，内容是扫描日期（做 id）、开始时间、标的数、新信号数、出错的标的和原因。跳过的那几次不存。
- [ ] 不发触发。新信号要不要叫醒领队，是 Appendix E 第 3 条，默认不叫。
- [ ] fixtures 用假的 `ta`：`fixtures/fake-ta.mjs` 按输入回放一份扫描结果，fixture 的 `settings.ta` 指向它。真实运行时 `settings.ta` 不写，用 venv 里的 `ta`。
- [ ] `principle-freshness` 技能加一句，先用 `scan-runs` 看最近一次扫描是哪天、有没有出错。

**You see.**

- [ ] 交易日收盘 15 分钟以后，打开的 stock-ta 在一小时内出现一行 `scan-runs`。`files/ta/ta.sqlite` 里每只自选股约 500 根日线，QQQ、SPY 也在。之后问 NVDA 的支撑阻力，数据时间是今天收盘。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/stock-ta-scan.test.ts` 用假 `ta` 覆盖：传的是自选股、成功后换上、失败时旧库一字不差、残留 `.next` 被覆盖、跳过时不存行、`scan-runs` 的字段、改自选股下一次生效、缺密钥时一行说明。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. 十条 lane 写成一个脚本 `docs/modules/evidence/s3-live.ts`。lane 6 到 lane 10 用真 Massive 和真 `ta`，在交易日收盘 15 分钟以后跑。

- [ ] Lane 1. Regression lane against trunk. trunk 没有 `scan` feed。记下这一点，两边都跑 G5 的报价 feed 一轮（fixtures）。Save `s3-regression.txt`. Pass when 两边 `quotes` 相同，head 多一个 `scan` feed。
- [ ] Lane 2. `just module check` stock-ta。Save `s3-check.txt`. Pass when ok，假 `ta` 跑过。
- [ ] Lane 3. fixtures 驱动一轮。Save `s3-fixture.txt`. Pass when `scan-runs` 一行，`ta.sqlite` 换成新的。
- [ ] Lane 4. 假 `ta` 退出码 1。Save `s3-fail.txt`. Pass when 旧 `ta.sqlite` 的 sha256 不变，没有 `.next`，日志一行。
- [ ] Lane 5. 假 `ta` 睡过 `limit`。Save `s3-timeout.txt`. Pass when 这一次被停，旧库不变，下一拍照常。
- [ ] Lane 6. 空数据目录，自选股 10 只，真行情第一次扫描。Save `s3-backfill.txt`. Pass when 5 分钟内结束，12 个标的（含 QQQ、SPY）各约 500 根日线，记下时间、行数和请求数。
- [ ] Lane 7. 紧接着再跑一次。Save `s3-rerun.txt`. Pass when 新信号 0，日线行数不变，10 秒内结束。
- [ ] Lane 8. 扫描进行中连调 20 次 `prices`。Save `s3-concurrent.txt`. Pass when 20 次都成功，没有一次读到坏库。
- [ ] Lane 9. Worker 往自选股加 AMD，下一拍。Save `s3-watchlist.txt`. Pass when AMD 有约 500 根日线。
- [ ] Lane 10. 真模型 `openai-codex/*` 问「NVDA 的数据是哪天的」。Save `s3-real-ask.txt`. Pass when 回答引用 `scan-runs` 最近一行的日期。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. trunk 没有这个 feed。只给绝对预算：第一次扫描（10 只加 QQQ、SPY）的总时间，日常一次扫描的总时间，以及克隆加改名的时间。
- [ ] Probe. lane 6 的第一次扫描一次；日常扫描在之后的交易日跑 3 次；克隆加改名在 5 MB 的库上量 20 次。
- [ ] Baseline. Record the 第一次扫描的时间和 Massive 请求数 first。按代码估算是 36 个请求左右，见 Appendix A。
- [ ] Rule. 第一次扫描超过 120 秒，或日常扫描超过 20 秒，或克隆加改名超过 200 毫秒，就失败。

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

- [ ] 文档写清旧 Mac 要的东西。旧 Mac 现在没有 `uv`，也没有 `gh`。它没有能访问 GitHub 的 SSH 密钥，git 用 `osxkeychain` 存凭据（Appendix A）。
- [ ] 默认做法（Appendix E 第 2 条）。使用者在 GitHub 网页上建一个 fine-grained token，只给技术分析这一个仓库的 Contents 只读权限，设过期时间。在旧 Mac 的终端里用 `git credential-osxkeychain store` 存进钥匙串。凭据只在跑 `just module setup` 时用，宿主服务运行时不需要。
- [ ] 装 uv（官方安装脚本或 Homebrew）。`#91` 已经把装机时 PATH 里 `uv` 的目录写进服务 PATH，S2 起工具不再依赖它，所以只有 setup 需要。uv 会下载 Python 3.12。旧 Mac 是 Intel、macOS 12，numpy 和 pandas 都有 `macosx_10_13_x86_64` 的 wheel，不用编译。
- [ ] 复制包、`just module setup stock-ta`、密钥文件里确认有 `MASSIVE_API_KEY`、把笔记文件拷过去并导入、`just module on stock-ta`、等第一次扫描。
- [ ] 换钉的提交时，改 `py/pyproject.toml` 的 `rev`，跑 `uv lock`，提交。每台机器复制新包以后重跑 `just module setup stock-ta`。工具在锁文件变了时会提醒（S2）。

**You see.**

- [ ] 旧 Mac 上，收盘后一小时内 `scan-runs` 有一行。在手机上问「NVDA 现在的支撑阻力和动量怎么样」，汇报带今天收盘的数据时间。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 文档里的每条命令在本机的临时状态目录里照抄跑一遍，输出存进 `/tmp/swarm-s4/doc-commands.txt`。Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. lane 2 和 lane 3 要使用者亲手做，owner 等使用者说做完了再接着跑。

- [ ] Lane 1. Regression lane against trunk. trunk 上旧 Mac 没有 stock-ta。记下这一点，在旧 Mac 上跑 `just modules`，确认 us-market 照常。Save `s4-regression.txt`. Pass when 装之前和装之后 us-market 的状态相同。
- [ ] Lane 2. 使用者建 token、存进钥匙串。owner 跑 `git ls-remote https://github.com/aicoder2048/TechnicalAnalysis HEAD`。Save `s4-auth.txt`. Pass when 打印一个提交，没有要密码。
- [ ] Lane 3. 使用者装 uv。owner 跑 `uv --version`。Save `s4-uv.txt`. Pass when 有版本号。
- [ ] Lane 4. `just module setup stock-ta`。Save `s4-setup.txt`. Pass when 装好，记下用时和 `files/venv` 的大小。
- [ ] Lane 5. `just module check` 和 `just modules`。Save `s4-check.txt`. Pass when ok，stock-ta 有效。
- [ ] Lane 6. 导入 18 份笔记。Save `s4-import.txt`. Pass when `knowledge` 显示都导入了。
- [ ] Lane 7. 打开 stock-ta，等收盘后第一次扫描。Save `s4-first-scan.txt`. Pass when `scan-runs` 一行，12 个标的有日线，记下用时。
- [ ] Lane 8. 旧 Mac 上调 `structure` 查 NVDA。Save `s4-structure.txt`. Pass when 有结果，数据时间是当天收盘。
- [ ] Lane 9. 重启宿主服务。Save `s4-restart.txt`. Pass when stock-ta 仍然有效，下一拍扫描照常。
- [ ] Lane 10. 真模型从手机（Telegram）问 NVDA 的支撑阻力和动量。Save `s4-phone.txt`. Pass when 汇报带数据时间和笔记出处。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 旧 Mac 上一次 `structure` 调用的时间，`just module setup` 第一次的时间，第一次扫描的时间。trunk 上旧 Mac 没有这个模块，只给绝对预算。
- [ ] Probe. `structure` 先热身一次再连调 10 次；setup 和第一次扫描各一次。
- [ ] Baseline. Record the 本机同一份数据上 `structure` 的中位数 first（S2 的 perf 结果）。
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

2026-11-12 在本机的临时目录里做的实验，没有碰技术分析项目的目录和数据库，数据库只读过 APFS 克隆。

**uv 能装私有仓库的子目录。** `git+ssh://git@github.com/aicoder2048/TechnicalAnalysis@<sha>#subdirectory=app/trading` 在本机失败，`Permission denied (publickey)`，因为本机的 SSH 密钥没登记在 GitHub 上。换成 `git+https://...` 后成功。uv 0.5.9 通过 git 的 `osxkeychain` 凭据拿到私有仓库，`uv add` 用了 4.4 秒，写出 `[tool.uv.sources] ta-trading = { git = "https://...", subdirectory = "app/trading", rev = "<sha>" }`。uv 缓存清空后 `uv sync --frozen` 用了 3 秒（本机已有 Python 3.12），缓存 101 MB，venv 74 MB。所以 S2 用 HTTPS 地址。

**venv 可以放在包外面。** 把包目录设成只读，`UV_PROJECT_ENVIRONMENT=<数据目录>/venv uv sync --frozen --project <包>/py` 成功，包目录每个文件的 sha256 都没变。

**装好的 `ta` 不需要技术分析项目。** 不设 `TA_ROOT`，只设 `TA_DB_PATH`、`TA_MARKET_DB_PATH`、`TA_NOTES_DIR`、`MASSIVE_API_KEY`、`MASSIVE_BASE_URL`，在空的临时目录里 `calendar`、`universe`、`prices`、`note`、`scan` 都正常，`ta.sqlite` 第一次打开时自动建表。代码里 `project_root()` 只在这些环境变量没设时才调用。例外是 `key-status`：没有 `MASSIVE_API_KEY` 时报 `PROJECT_ROOT_NOT_FOUND`，不是「没有密钥」。S2 给工具设 `MASSIVE_API_KEY=offline`，绕开这一处。不需要改技术分析仓库。

**直接调 venv 里的 `ta` 和 `uv run` 一样快。** 交替各 7 次 `ta calendar`，直接调用中位 289 毫秒，`uv run --frozen --no-sync` 中位 293 毫秒。直接调用里有一次 8.1 秒，是装完后的第一次调用，推断是 Python 在编译字节码，所以 setup 带 `--compile-bytecode`。

**旧 Mac。** 只读查看。macOS 12.7.6，Intel x86_64，git 2.37.1，凭据用 `osxkeychain`，钥匙串里没有 github.com 的凭据。`~/.ssh` 里只有 `authorized_keys`，没有 SSH 密钥，`known_hosts` 里也没有 github.com。没有 `gh`，没有 `uv`，有 node 和 just。锁文件里 numpy 2.5.4 和 pandas 3.1.1 都有 `cp312-macosx_10_13_x86_64` 的 wheel。

**同步多大，按代码估算，没有调 Massive。** `ta scan` 的日线模式对每个标的取两年日线（`Scanner._window`），一次请求最多 50000 行，所以一页就够；另有一次 `validate_symbol` 和至少一次分红请求。日线模式还自动带上 QQQ、SPY（`_benchmarks`）。10 只自选股加两个基准是 12 个标的，第一次大约 36 个请求、6000 行日线、约 100 行分红。Massive 客户端没有限速，只在出错时退避重试。你本机现有的 `ta.sqlite` 是参照：18 个标的、9039 行日线、2530 行 5 分钟线，5 MB；日线扫描 11 次，平均 2.6 秒，最长 7.5 秒。第一次扫描的 120 秒预算是推断，S3 的 lane 6 实测。

**全市场数据（`screen` 用的 `market.sqlite`）。** 你本机这份是 419 MB：320 个交易日、3146114 行日线、11220 个标的、43077 行分红。从零同步要约 320 次全市场日线请求、12 页标的列表、44 页分红，再加约 2000 次市值查询，合计约 2400 个请求。这个量不适合放进一个每天跑的模块 feed，所以默认不做。

**还没证明的。** 旧 Mac 上 fine-grained token 加 `osxkeychain` 能不能让 uv 拿到私有仓库，要等 S4 的 lane 2 和 lane 4。用 SSH 部署密钥加 `url.<base>.insteadOf` 改写地址这条路，没试过 uv 认不认。

## Appendix B. Alternatives rejected

- **复制技术分析的源码进模块包。** 使用者 2026-11-12 否决。两份代码会分叉，公开仓库里也不该有私有源码。
- **git 依赖用 SSH 地址。** 本机的 SSH 密钥没登记在 GitHub 上，旧 Mac 没有 SSH 密钥，HTTPS 加钥匙串两台都能走通。
- **工具里用 `uv run`。** 服务的 PATH 里要有 `uv`，速度又没好处。setup 时用 uv，运行时直接调 venv。
- **venv 放在包目录里。** 包目录有文件监视，venv 里的几千个文件会触发重新加载，而且复制包时会带上。放在 `files/venv`，purge 时一起删。
- **工具直接读 feed 正在写的库。** 技术分析库是回滚日志模式。扫描写到一半时去克隆，可能拿到半截的库。改成副本加改名以后，读的人只会看到整份旧库或整份新库。
- **feed 写 `when: us-market-hours`。** 日线扫描要收盘后 15 分钟，那个窗口只到收盘后 20 分钟，一小时一拍会错过。由 `ta` 自己判断跳不跳，跳过的代价是起一次进程。
- **用 `ta` 自己的自选股表。** 会有两份自选股。用 G5 的 `watchlist`，扫描时传 `symbols`。
- **留着 `screen` 并同步全市场数据。** 419 MB、约 2400 个请求，旧 Mac 上还要每周刷新市值。没有它，信号、结构、盈亏比都照常。默认拿掉，Appendix E 第 1 条。
- **日内 5 分钟扫描。** 每 5 分钟起一次进程、每只每次一个请求。今天的问题都是日线问题，不做。以后要做就加一个 `every: 5m`、`when: us-market-hours` 的 feed。
- **改技术分析仓库让 `key-status` 在没有项目根目录时也报「没有密钥」。** 模块总是自己设密钥变量，不需要。想改的话，是技术分析仓库里一个单独的小 PR：`load_api_key` 找不到项目根目录时按「没有密钥」处理。另外 `backtest` 里 `os.environ.get(..., project_root() / ...)` 的默认值会提前算，同一个 PR 里可以一起改。本计划不做。

## Appendix C. Risks

- **S1 的 `PSA_MODULE_DATA`。** 模块代码本来就和宿主同一个系统用户，没有沙箱，这个变量不改变能读写什么（`current-state.md` 的 No Worker sandbox）。按「MVP 自用，安全从简」，不另加限制。
- **S2 的 GitHub 凭据。** setup 失败时报错可能带出仓库地址，不会带出 token。lane 2 的输出要查一遍再存。
- **S3 的副本加改名。** 改名要和原库在同一个文件系统，`files/ta/` 里建副本就满足。扫描超时被杀时，副本留着，下一次覆盖。
- **S3 的真行情 lane 依赖时间。** 只能在交易日收盘 15 分钟以后跑，错过就等下一个交易日。fixtures 的 lane 不受影响。
- **S4 依赖使用者亲手操作。** 建 token、装 uv 要使用者做。钥匙串在 SSH 会话里可能是锁着的，所以存凭据和第一次 setup 都在旧 Mac 的本地终端里做。
- **钉的版本过时。** 技术分析仓库修了规则，模块不会自动跟上。换提交是一次 PR 加每台机器一次 setup。
- **没有 control skill。** 网页 lane 用仓库自己的 Playwright harness，命令行 lane 用脚本。

## Appendix D. Links and reading list

- `docs/modules/stock-ta.md`，现在的安装步骤和工具的保证。
- `docs/modules/examples/stock-ta/ta.ts`，克隆、关着的端口、`structure` 的 `now` 规则。
- `docs/modules/module-data-feeds-plan.md`（G4、G5），feed 的 handler、fixtures、`reads`、调度器不重叠同一个 feed。
- `docs/modules/architecture/design.md` 第 2、3 节，模块代码的环境和 feed。
- 技术分析仓库 `app/trading` 的 `ta/cli.py`（环境变量和子命令）、`ta/scanner.py`（`_window`、`_benchmarks`、`_skip_details`）、`ta/market.py`（请求和分页）、`ta/models.py`（`project_root`）。只读。
- S1 的 owner 在实现前写两种接缝草图再选（`pstack/skills/architect/SKILL.md`，缩小版）：环境变量，还是给代码的输入里加一个字段。
- 决策记录在 `.audit/stock-ta-self-contained.tsv`，按 `pstack/skills/show-me-your-work/SKILL.md`，不提交。

## Appendix E. Decisions for the operator

每条都有默认做法。不回答就按默认走，回答了就按你说的改计划。

1. **`screen`（全市场选股）留不留。** 默认拿掉工具和 `ta-screen` 技能。要留，就再加一个 S5：每周一次的全市场同步 feed，约 420 MB、约 2400 个请求，旧 Mac 上要多久没量过。
2. **旧 Mac 用什么凭据拿私有仓库。** 默认是 fine-grained token，只给这一个仓库的只读权限，存在旧 Mac 的钥匙串里。另一条路是旧 Mac 生成一个 SSH 部署密钥，登记成这个仓库的只读部署密钥，再用 git 的 `insteadOf` 把 HTTPS 地址改成 SSH。这条路不过期，但 uv 认不认没试过。
3. **扫描出新信号时要不要叫醒领队。** 默认不叫，信号只在你问的时候查。要叫的话，`scan` feed 加一个 `notice`，每个新信号发一个触发，和技术分析应用的提醒一样。
4. **钉哪个提交。** 默认是 S2 开工时技术分析仓库 `main` 上已推送的最新提交（今天是 `c9e7536`）。你有还没推送的规则改动的话，先推送。
