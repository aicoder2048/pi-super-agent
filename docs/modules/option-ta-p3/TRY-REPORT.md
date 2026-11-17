# option-ta P3-e 真模型预演

日期：2026-11-17，美东 15:18 到 15:57（盘中）。代码：main `29e2dff2`（P3-a 到 P3-d 都已合并）。目的：用真模型跑 `just module try`，看六道考题能不能全部 PASS，记录失败原因。操作员只发命令、记录、归因，不改包；整包复查另外在做，修复之后统一改。

## 结论

- 三轮都没有全过：5/6、3/6、5/6。按题算 18 次里过 13 次。
- 三道题三轮都过：chain-put-quote（真联网查 Massive）、csp-entry（全员会诊）、watchlist-add。
- 三道题不稳：
  - record-fill 挂 2/3。领队对「11/17」「12/18」没写年份的日期先问使用者，不调 `record`，汇报 blocked。另跑两次只含这道题的预演，一过一挂，挂的那次 Router 转述的问题是「成交日 11/17 和到期日 12/18 分别是哪一年？」。归包（领队技能没说缺年份怎么办）。
  - earnings-before-expiry 挂 2/3。Router 把题派给了 stock-ta，不是 option-ta。归包（两个模块的 description 在「财报」上撞车，考题措辞也偏向 stock-ta）。
  - diagonal-roll 挂 1/3。领队用 bash 跑 Python 算净收，没调 `strategy`。数是对的（190）。归模型随机性，领队技能的约束不够硬。
- 没有一处是环境问题：stock-ta 三轮都在预演里打开，五个外部工具在 csp-entry 里都调到过，option-ta 的 key 预演带上了，`chain` 回了实时报价。
- 用时：三轮 627、526、492 秒（10.5、8.8、8.2 分钟）。token 只抓到部分，下限见「token 与时长」。

## 环境

| 项 | 做法 | 核对 |
|---|---|---|
| 代码 | `git worktree add --detach` 到临时目录（`origin/main` `29e2dff2`），链主目录的 `node_modules` | 主工作目录没切分支、没改文件 |
| 状态目录 | `mktemp -d`，权限 700 | 没碰真实状态目录，没碰老 Mac |
| 模型 | router `openai-codex/gpt-6.1-terra`，worker 和 fallback `openai-codex/gpt-6.1-sol` | 起宿主前 grep 临时 `config.json`，`anthropic` 0 处；宿主启动行和三轮预演开头都是这两个模型 |
| 密钥文件 | `secretsFile` 是临时目录里新建的空文件 | 没有 `TELEGRAM_BOT_TOKEN`、Gmail 授权、GitHub token |
| Telegram | `config.json` 没有 `telegram` 段 | 宿主日志 0 处 Telegram |
| 网页 | `webPort: 4597` | 起之前 4597 没有监听，本机没有别的宿主在跑 |
| feed | `"feedFixtures": "rows-only"` | 外层宿主只跑了 stock-ta 的两个样例；`module try` 自己的临时宿主也是 rows-only（代码写死） |
| stock-ta | 复制包、`just module setup stock-ta`（ta-trading 装上了）、合成夹具 `ta.sqlite`（本机没有真实库）、两把 key 经管道写进临时 `modules-data/stock-ta/.env`（600，值不经屏幕）、`just module on stock-ta` | `just modules` 显示 stock-ta「运行中」；三轮预演开头都没有「stock-ta 现在没开」 |
| option-ta 的 key | 从本机 secretsFile 只取 `POLYGON_API_KEY`、`FINNHUB_API_KEY` 两行，写进临时 `modules-data/option-ta/.env`（600，值不经屏幕） | 预演按 ADR-0031 复制了它：`chain` 三轮都回了 Massive 实时报价 |
| 检查 | `just module check docs/modules/examples/option-ta` | `ok option-ta@0.1.0`，digest `8544d6ee491d`，提醒只剩两行外部 `uses` |

命令：`PSA_STATE_DIR=<临时目录> just module try docs/modules/examples/option-ta`，连跑三轮，中间不改任何东西。

## 三轮结果

| 考题 | `uses` / `expect` | 第 1 轮 | 第 2 轮 | 第 3 轮 |
|---|---|---|---|---|
| chain-put-quote | tools/chain / `O:QQQ261218P00600000` | PASS | PASS | PASS |
| csp-entry | stock-ta/tools/structure | PASS | PASS | PASS |
| diagonal-roll | tools/strategy / `190` | PASS | FAIL：没用到 tools/strategy | PASS |
| earnings-before-expiry | stock-ta/tools/earnings-date | FAIL：任务开在 stock-ta；没用到 earnings-date | FAIL：同左 | PASS |
| record-fill | tools/record / `TSLA261218C00300000:STO:2026-11-17:acct-blue:cum2` | PASS | FAIL：没用到 tools/record；汇报里没有 fill_id | FAIL：同左 |
| watchlist-add | data/watchlist | PASS | PASS | PASS |
| 合计 | | 5/6 | 3/6 | 5/6 |
| 用时 | | 627 秒 | 526 秒 | 492 秒 |

补充两次只含 record-fill 的预演（包的副本删掉其余五道题，其他不变）：第 1 次 PASS（103 秒），第 2 次 FAIL（56 秒）。

三轮的完整输出在 `try-logs/round1.log` 到 `round3.log`，补充两次在 `try-logs/record-fill-extra1.log`、`extra2.log`。临时路径换成了 `<预演临时目录>`。

## 每道题记录

调用的工具取自各任务的会话记录（预演临时目录删掉之前抓的）。

**chain-put-quote。** 三轮都是领队自己调一次 `chain`，回 595、600、605 三档的 bid、ask、mid、IV，写明「期权报价实时、正股延迟 15 分钟」，IV 写明来自供应方。600 put 三轮的 mid 是 8.845、8.365、8.295，随行情变。每轮约 23 到 28 秒、5 次工具调用、约 78k 输入。

**csp-entry。** 三轮都走全员会诊：领队调 `chain`，派方向、波动率、策略三位专家，再派反方。方向专家调到的 stock-ta 工具：第 1 轮 `structure`；第 2 轮 `structure`、`signals`（领队另调了 `quote`）；第 3 轮 `structure`、`prices`、`signals`、`quote` 四个。波动率专家三轮都调 `vol`（回 `NO_HISTORY`，预演里没有 IV 快照，预期内）和 `earnings-date`。策略专家调 `strategy`。三轮结论都是「先别开，核实财报和接股意愿」，都指出合成库的技术缓存停在 11/13、价位和现价对不上。第 1 轮领队中途问「愿意被指派后长期持有 NVDA 吗」，第 3 轮问「12/18 是 2026 年吗」，都没阻塞，汇报 ready。每轮约 3.3 到 4.7 分钟，最贵的一题（169k 到 358k 输入）。

**diagonal-roll。** 第 1、3 轮领队调一次 `strategy`，回 190。第 2 轮领队读完技能后直接 `bash` 跑 Python `Decimal` 算出 190，没调 `strategy`。汇报内容三轮都对。

**earnings-before-expiry。** 第 1、2 轮 Router 把任务开在 stock-ta：stock-ta 的 Worker 调了它自己的 `earnings-date`，又抓了十几次网页去 NVIDIA 投资者关系页核实（第 1 轮 26 次工具调用、316k 输入、110 秒）。回答本身正确（11/17 盘后，早于 12/18）。第 3 轮开在 option-ta，领队调 `stock-ta/tools/earnings-date`，PASS。

**record-fill。** 第 1 轮领队调 `record`，写进 `fills`，汇报原样照抄 fill_id，写明「持股覆盖、佣金费用未知，未认定为备兑」。第 2、3 轮领队没调 `record`，先问使用者：第 2 轮 Router 转述「这是 2026 年 11 月 17 日卖出开仓、到期日 2026 年 12 月 18 日吗」；第 3 轮还加问「有 200 股 TSLA 覆盖吗」。汇报 blocked，写「尚未入账」。补充两次：过的那次领队写「年份按今年理解」直接记；挂的那次问「成交日 11/17 和到期日 12/18 分别是哪一年」。

**watchlist-add。** 三轮都写进 `watchlist`，第 2、3 轮还说明 IV 回填已登记、没做完，不会同步加进 stock-ta 自选。

## `[样例]` 丢弃行

三轮和补充两次开头都是 14 行：stock-ta `quotes` 的 `nvda-down-5` 一行（丢 1 条触发、2 条提醒），option-ta `watch` 十三行（各丢 1 到 2 条提醒）。`fills`、`iv` 的样例不交提醒，没有丢弃行。考题记录里没有和考题无关的插话。

## FAIL 归因和建议

| # | 考题 | 挂几次 | 归因 | 建议修法（不在这个 PR 做） |
|---|---|---|---|---|
| 1 | record-fill | 2/3（补充 1/2） | 包：领队技能 | 见下 A |
| 2 | earnings-before-expiry | 2/3 | 包：description 撞车加考题措辞 | 见下 B |
| 3 | diagonal-roll | 1/3 | 模型随机性，技能约束不够硬 | 见下 C |

**A. 缺年份的日期，领队一会儿默认今年，一会儿追问。** 考题写的是「11/17 成交」「12/18」，没写年份。`option-lead` 技能第 24 行讲 `record` 的 `needs-input` 按 `ask` 问，最后一句是「用户不用提问时只列待确认，不把缺项补成事实」。领队把年份当成缺项，于是不调 `record` 就先问；`record` 的 `REQUIRED` 里 `expiry`、`trade_date` 都要完整日期，领队得自己补年份。持股覆盖在技能里写的是「CC 持股覆盖未知就待确认」，第 3 轮还是拿它来问，说明「待确认」和「要问」的界限模型分不清。

修法：在 `option-lead` 的手动成交一段写明默认值，例如「成交日没写年份按今年；到期日没写年份按今天以后最近的那个；在复述里写『年份按今年理解』，不为年份追问。持股覆盖、佣金费用未知不阻塞入账，记成待确认」。修完后这道题应当稳定，因为补充第 1 次的领队正是这么做的。考题不用改：使用者口述成交本来就不写年份。

**B. 「到期前会碰上财报吗」被派给 stock-ta。** stock-ta 的 description 写了「财报日」，option-ta 的写的是「期权链、隐含波动、希腊值、策略盈亏，记你的期权……；股价和技术面归 stock-ta」，没有财报。题面的核心是「会碰上财报吗」，Router 按 description 派给 stock-ta 是说得通的，stock-ta 的回答也对。这道题测的是 option-ta 的波动率专家会不会调 `earnings-date`，但 Router 一关就不稳。

修法，两处都改：
- option-ta 的 description 加一句期权视角的事件，例如「到期前的财报、除息对仓位的影响」，让「想卖 put……到期前」这种问法归 option-ta。改前看一下会不会把纯问财报日期的请求从 stock-ta 抢过来。
- 题面把期权意图说足，例如「想卖 NVDA 12/18 135 的 put 收租，到期前会碰上财报吗？对这张 put 有什么影响？」。

**C. 领队偶尔用 bash 算 Roll 净收。** 技能第 11 行写「计算必须来自确定性工具」，第 2 轮领队还是用了 `bash` 跑 Python。数对，但绕开了工具，等于测不到 `strategy`。

修法：在技能里点名「Roll 净收、盈亏平衡、年化一律调 `strategy`，不用 bash 或心算，即使使用者给全了价格」。更硬的办法是领队的 `bash` 不让做算术，但那归框架，不在这个包里。三轮挂一次，修完后要多跑几轮才看得出效果。

## 别的观察（不影响判分）

- **考题跟日期绑死。** chain-put-quote、csp-entry、earnings-before-expiry 都写「12/18 到期」。2026-12-18 以后，模型会把 12/18 读成 2027 年，或者那天的合约已经没了，`expect` 里的 `O:QQQ261218P00600000` 就对不上。P4 上线以后再跑预演会挂。建议考题写完整日期，或者选离现在远的到期日，并在 README 里注明。
- **csp-entry 在预演里中途提问。** 领队问「愿意接股吗」「12/18 是哪年」，预演里没人回答，领队照样给结论。行为合理，但每轮多一次 Router 转述。
- **汇报里带临时路径。** 第 2、3 轮 csp-entry、第 1 轮 earnings 的汇报末尾写「完整报告：<临时目录下的文件>」。真实宿主里这是使用者自己机器上的路径，问题不大，但 Telegram 上看不到这个文件。
- **stock-ta 一题花 316k。** 第 1 轮 earnings 派到 stock-ta 时，Worker 为核实官方日期抓了十几次网页。和 option-ta 无关，记下。
- **`vol` 三轮都回 `NO_HISTORY`。** 预演不带集合的行，`iv-snapshots` 是空的，预期内。波动率专家都照实说了「无法判断 IV 贵便宜」。

## token 与时长

三轮的总用时可靠（`module try` 从开始到删临时目录）：627、526、492 秒。

token 只抓到部分。`module try` 结束时删掉自己的临时目录，操作员用一个脚本每隔几秒从里面读 `tickets` 和 `usage_daily`；三轮这个脚本都在中途卡住了几分钟（原因没查清，可能是读 WAL 库时等锁），所以每轮后面几道题没抓到。下表是抓到的部分，是下限。

| 轮 | 抓到的任务 | 任务输入（含缓存）/ 输出 / 工具调用 | 当天用量（含 Router），抓取时刻的值 |
|---|---|---|---|
| 1 | chain、csp、roll、earnings（stock-ta） | 78k / 0.7k / 5；169k / 7.9k / 10；51k / 0.7k / 3；316k / 3.1k / 26 | 764k（record-fill 刚开始时） |
| 2 | chain、csp、roll | 78k / 0.6k / 5；255k / 13.5k / 17；24k / 0.4k / 2 | 442k（roll 刚结束时） |
| 3 | chain、csp、roll、earnings 开头 | 78k / 0.8k / 5；358k / 12.6k / 17；51k / 0.4k / 3；未完 | 616k（earnings 刚开始时） |

粗估：一轮六题在 0.8M 到 1.0M 输入之间，大头是 csp-entry 的会诊（每轮 169k 到 358k）。earnings 被派到 stock-ta 时一题 316k，派到 option-ta 时便宜得多（第 3 轮领队调一次 `earnings-date`）。这个粗估只基于三轮各一次、而且每轮缺两三道题，不能当成稳定的数。

下次要可靠的 token 数，建议 `module try` 在删临时目录前打印一行「任务合计输入、输出、工具调用」，不靠外部脚本去抢。

## 下一步

1. 整包复查合并 A、B、C 三条修法（和复查意见一起改）。
2. 修完再跑三轮 `module try`；P3-e 的完成标准是全部 PASS 的日志留档。
3. 考题日期问题在 P4 之前处理。
4. `module try` 打印 token 合计（框架，另开）。

## 清理

- 外层临时宿主已停，没有残留的 `src/host/main.ts` 进程；预演自己的临时目录每轮结束时由 `module try` 删掉。
- 临时 `PSA_STATE_DIR`（含两份 `.env` 里的真 key）整个删掉。
- 代码 worktree 已删。主工作目录没动。
- 临时目录里另有一个 2026-11-16 留下的 `psa-try-SuGv2s`，不是这次产生的，没动。
