# option-ta P3-e 修复后真模型预演

日期：2026-11-17，美东约 16:00 到 20:45（收盘后）。代码：分支 `psa/option-ta-p3e-fix`，在第一次预演（[TRY-REPORT.md](TRY-REPORT.md)）之后做了 15 项修复。目的：修复后再跑 `just module try`，六道考题全部 PASS；没过的归因。

## 结论

- 修复后第 1 轮 5/6，挂在 earnings-before-expiry「Router 没有开任务」。原因是这道题和 csp-entry 问的是同一张 put（推断，见下）。把题换成 AAPL 之后，单跑 1 次、整轮 4 次，这道题 5 次都过，5 次都开了新任务。
- 换题后正式三轮：6/6、6/6、5/6。按题算 18 次里过 17 次。第 4 轮挂的是 csp-entry「没等到汇报」：全员会诊十分钟内没交汇报。另外单跑 csp-entry 1 次、补跑整轮 1 次（第 5 轮），都过，汇报分别在开任务后约 270 秒和 250 秒交出。这一次超时没有复现，查不到在哪一步慢，没有改包。
- 换题后共 26 次考题（单跑 2 次、整轮 4 次 × 6 题），每次 Router 都开了新任务。

## 环境

和第一次预演相同，只列不同处。

| 项 | 做法 |
|---|---|
| 代码 | worktree 在分支 `psa/option-ta-p3e-fix` 上，链主目录的 `node_modules` |
| 状态目录 | `mktemp -d`，权限 700；用完整个删掉 |
| 模型 | router `openai-codex/gpt-6.1-terra`，worker 和 fallback `openai-codex/gpt-6.1-sol`；起宿主前 grep 临时 `config.json`，`anthropic` 0 处 |
| 密钥 | `secretsFile` 是空文件；`POLYGON_API_KEY`、`FINNHUB_API_KEY` 两行经管道写进临时 `modules-data/stock-ta/.env` 和 `modules-data/option-ta/.env`（600），值不经屏幕 |
| 网页、Telegram | `webPort: 4597`，起之前没有监听；没有 `telegram` 段，外层宿主日志 0 处 Telegram |
| feed | `"feedFixtures": "rows-only"` |
| stock-ta | 复制包、`just module setup stock-ta`、合成夹具 `ta.sqlite`、`just module on stock-ta`，`just modules` 显示「运行中」 |
| 观察 | 预演进行中每 15 到 20 秒只读查一次预演临时目录的 `state.db`（`mode=ro`），记下触发的去向、任务和汇报的时间。没改 `module-try.ts`，没留副本 |

## earnings-before-expiry 为什么「Router 没有开任务」

修复后第 1 轮（[try-logs-2/round1.log](try-logs-2/round1.log)）这道题只有一行 `FAIL earnings-before-expiry：Router 没有开任务`，下面没有任何 Router 回复。其余五道题都有「我来……」一句。

`module try` 判题的方式（`src/cli/module-try.ts`）：

1. 发出考题，等宿主回 `ack` 拿到触发 id。
2. 按 `tickets.origin_trigger_id = 触发 id` 找新任务，最多等 180 秒。
3. 回复按 `reply_receipts.cause IN (触发 id, 任务 id)` 取。

既没有任务也没有回复，说明 Router 对这条触发既没有用 `reply` 回它，也没有用 `open_ticket` 为它开任务。Router 的 `route` 工具还有一种决定：`hand_over`，把触发转进已有任务。转交时触发的 `disposition` 是 `handed_over`，不产生新任务；之后的回复以那个已有任务为 cause。`module try` 不看 `disposition`，于是两样都落空，正好是这一行的样子。

当时的题面和前面的 csp-entry 问的是同一张合约：

- csp-entry：「NVDA 2026-12-18 到期、行权价 135 的 CSP 现在适合开吗？」
- earnings-before-expiry：「想卖 NVDA 2026-12-18 到期、行权价 135 的 put 收租，到期前会碰上财报吗？……」

考题在同一个 Router 会话里依次发出。csp-entry 的汇报刚讲过 NVDA 11/17 盘后财报，Router 把第二句当成同一张 put 的追问、转进 csp-entry 的任务，是说得通的。第一次预演里这道题写的是「12/18 到期的 put」，没写行权价，三轮都开了新任务（两轮开在 stock-ta）。修复里把题面补成完整合约，就和 csp-entry 撞上了。

这是推断：那一轮的临时目录已经删了，看不到 `triggers.disposition`。证据是排除法，加上换题后的结果：5 次里这道题的触发都是 `opened_ticket`，没有一次 `handed_over`（`try-logs-2/round{2,3,4,5}.triggers.txt`）。

修法（包）：题面换成别的标的，不和 csp-entry 共用合约。现在是「想卖 AAPL 2027-02-19 到期、行权价比现价低 10% 左右的 put 收租，到期前会碰上财报吗？碰上的话对这张 put 有什么影响？」。到期日离现在三个月，中间有一次财报（日历给 2027-01-27），过了 2026-12 题目也不失效。没改 description，没改领队技能。

建议（宿主，不在本 PR）：`module try` 没找到新任务时，读这条触发的 `disposition`，打印「Router 转交给了 tkt_…」或「Router 忽略了：理由」，回复也按转交目标的任务 id 取。这次要靠推断，就是因为日志里缺这一行。

## 结果

| 考题 | 修复后第 1 轮 | 换题后单跑 | 第 2 轮 | 第 3 轮 | 第 4 轮 | 第 5 轮（补跑） |
|---|---|---|---|---|---|---|
| chain-put-quote | PASS | | PASS | PASS | PASS | PASS |
| csp-entry | PASS | PASS（单跑） | PASS | PASS | FAIL：没等到汇报 | PASS |
| diagonal-roll | PASS | | PASS | PASS | PASS | PASS |
| earnings-before-expiry | FAIL：Router 没有开任务 | PASS（单跑） | PASS | PASS | PASS | PASS |
| record-fill | PASS | | PASS | PASS | PASS | PASS |
| watchlist-add | PASS | | PASS | PASS | PASS | PASS |
| 合计 | 5/6 | | 6/6 | 6/6 | 5/6 | 6/6 |
| 用时 | 508 秒 | | 558 秒 | 614 秒 | 1111 秒 | 886 秒 |

正式三轮是第 2 到第 4 轮，中间不改任何东西。第 5 轮是为了看 csp-entry 的时间线补跑的，同样没改东西。

日志：

- `try-logs-2/round1.log`：修复后第 1 轮（换题前）。
- `try-logs-2/earnings-only-1.log`：换题后只跑财报题。
- `try-logs-2/round2.log` 到 `round5.log`：整轮输出；`round{2..5}.triggers.txt` 是每道题触发的去向和题面开头。
- `try-logs-2/csp-only-1.log`、`csp-only-1.timeline.txt`，`round5.timeline.txt`：任务和汇报的时间线（每 15 到 20 秒一次快照，只留有变化的行）。

临时路径都换成了 `<预演临时目录>` 或 `<临时路径>`。

## csp-entry 第 4 轮超时

`module try` 开任务后最多等 600 秒汇报。第 4 轮 csp-entry 开了任务（`round4.triggers.txt` 第 2 行 `opened_ticket`），Router 回了「我来评估……」，600 秒内没有非 progress 的汇报。整轮因此多了约 10 分钟（1111 秒）。

另外三次 csp-entry 的时间线：

| 运行 | 开任务到交汇报 | 会诊成员 | 领队工具调用 | 领队输入 token |
|---|---|---|---|---|
| 单跑（`csp-only-1.timeline.txt`） | 约 270 秒 | 方向与价位、波动率与事件、策略计算、会诊反方 | 13 | 236k |
| 第 5 轮（`round5.timeline.txt`） | 约 250 秒（第 81 秒看到任务，第 330 秒交汇报） | 同上 | 11 | 218k |
| 第 2、3 轮 | 没记时间线，整轮 558、614 秒，推不出超时 | | | |

四个成员是依次加进来的（单跑在第 77 秒有前三个，第 173 秒加上反方）。第 4 轮慢在哪里看不到：那一轮只记了触发去向，没记任务时间线，临时目录也已经删了。没有 `run_asks`（单跑和第 5 轮都是 0 行），不是卡在等批准。这次没有找到包的问题，也就没有明确的修法，没有改包。

如果它再出现，有两条路，都没做：

- 宿主：`module try` 超时的时候打印任务当时的状态（Worker 在跑还是空闲、调了几次工具、成员都是谁）。只有日志里有这一行，下一次才查得出来。
- 包：csp-entry 是唯一一道全员会诊的题，用时离 600 秒的上限只有一倍余量。可以在领队技能里给会诊设一个轮数上限。没有证据说明这一次是会诊轮数多造成的，所以不改。

## 其他观察

- **汇报里带临时路径。** csp-entry 的汇报末尾还会写「完整报告：<临时路径>/output/docs/analysis/….md」（`csp-only-1.log`）。第一次预演就记过，没改。
- **record-fill 稳了。** 5 次都调了 `record`，汇报照抄 fill_id，第 5 轮写明「年份按今年理解」。第一次预演里的追问年份没再出现。
- **diagonal-roll 稳了。** 5 次都用 `strategy`，净收 190。
- **考题仍有日期绑定。** chain-put-quote、csp-entry、diagonal-roll、record-fill 写的是 2026-12-18 到期。过了那天要换题，第一次预演已经记过。
- **财报题会多跑一会儿。** 第 5 轮这道题约 190 秒（第 387 到 579 秒），领队调了 14 次工具，叫了「波动率与事件」专家，还读了 Apple 投资者关系页去核实日期。
