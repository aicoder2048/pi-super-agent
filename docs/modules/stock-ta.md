# 股票技术分析模块（stock-ta）

stock-ta 让 Pi Super Agent 回答美股的报价和技术面问题，例如「NVDA 现在多少」「NVDA 现在的支撑阻力和动量怎么样」。它只管客观的交易数据和由它算出的技术面，外加下一次财报日这个日期，不管新闻、财报解读和宏观。计算来自技术分析私有仓库里的 `ta-trading`（`ta` 命令行），模块用 `just module setup` 把钉住的版本装进自己的数据目录；数据也归模块自己，`scan` feed 每个交易日收盘后扫一次自选股。工具只读这份数据，再配上笔记、技能和一个六人的专家队「技术分析研究组」。它不需要你本机的技术分析项目，跑服务的旧 Mac 上也能用。

包在 `docs/modules/examples/stock-ta/`，不在仓库的 `modules/` 下。仓库 `modules/` 里的新布局包第一次被发现时默认打开，而这个模块要先在那台机器上跑一次 `just module setup`、有一把 Massive 密钥才能用，没准备好就打开的话工具全失败，还会在幕僚长的名单上和 us-market 抢美股问题。所以它放在例子目录里，你在要用的那台机器上复制一份，自己打开。

## 里面有什么

- **工具。** `quote` 向 Massive 要一次快照，回现价，见下文「问现价」。`intraday` 向 Massive 要一只股票当天的分钟线或小时线，`earnings-date` 向 Finnhub 要下一次财报日，见下文「联网的工具和密钥」。六个只读工具调 `ta` 的子命令：`structure`（支撑阻力、形态、动能）、`signals`（技术信号，日线和周线）、`note`（笔记原文）、`prices`（数据库里的最新价）、`conditions`（规则状态）、`rules`（规则定义）。另有一个纯计算工具 `risk-reward`，算盈亏比和止损距离，用例在 `cases.json` 里，每次检查都跑。
- **专家。** 趋势与动量、结构与形态、信号分诊、市场情绪、风险与交易计划、盘面。每位专家只够得到 `uses` 里列的工具，成员只有读文件的 `read`，不能读网页。盘面判断当天的涨跌是个股还是大盘、板块，用 `quote`、`intraday`、`prices`、`note`，汇报分结论、证据、数据时间三段，不找原因。风险与交易计划每次给计划都查一次 `earnings-date`，财报日在持有期内或 10 个交易日内时单独写一行跳空风险，只有它能用这个工具。
- **技能。** `principle-evidence`、`principle-freshness`、`ta-interpret`，从技术分析项目的 Pi 技能搬过来，去掉了桌面界面、选股和日内的部分。`quick-quote` 让领队自己回答只问价格的问题，`market-desk` 是盘面查当天行情的做法。
- **报价。** feed `quotes` 在交易时段（美东 9:30 到收盘后 20 分钟）每 60 秒向 Massive 发一次快照请求，取回整张自选股，每只存一行进 `quotes`：价格、相对昨收的涨跌幅、当天成交量和数据时间。Starter 套餐的数据延迟 15 分钟，所以数据时间比现在早约 15 分钟。同一数据时间的行只存一次。自选股在 `watchlist` 里。
- **日线扫描。** feed `scan` 每小时看一次，每个交易日收盘 15 分钟后用模块自己装的 `ta` 扫一次自选股和 QQQ、SPY，把两年日线、分红和信号写进模块自己的数据库 `modules-data/stock-ta/files/ta/ta.sqlite`，每次运行在 `scan-runs` 里记一行。工具读的就是这份数据库。见下文「日线扫描」。
- **大涨大跌自动分析。** 自选股里一只股票当天相对昨收涨跌达到 5%，`quotes` 发一条触发，规则 `big-move`（`rules.md`）让幕僚长给技术分析研究组开任务：结构与形态和趋势与动量各看一遍，汇报带数据时间和出处，并说明不是交易指令。同一只股票同一天同一方向只开一次；当天先跌 5% 再涨 5% 是两次，哪怕跌 5% 的任务还没结束，涨 5% 也另开一个任务。5% 写死在 `feeds/quotes/index.ts` 的 `BIG_MOVE_PCT`。
- **知识。** 术语表随包自带。十八份笔记包里只有出处（`source.json`，`"license": "user-import"`），全文要你从本机导入，见下文。笔记不是你写的，仓库是公开的，所以全文不进仓库。

## 联网的工具和密钥

`quote` 和 `intraday` 现查 Massive，只读，不写模块数据，用宿主密钥文件里的 `POLYGON_API_KEY`。`earnings-date` 现查 Finnhub，只读，用 `FINNHUB_API_KEY`。没有密钥时一行说明去哪里加，不发请求。

- **`quote`。** 每次一个快照请求，1 到 10 个代码。
- **`intraday`。** 每次一个分钟聚合请求（`/v2/aggs/ticker/{代码}/range/1/{minute 或 hour}/{from}/{to}?adjusted=true&sort=desc&limit=50000`）。Massive 的 `limit` 限的是它读的分钟数据，不是回几根，所以请求要得大，工具自己只留离 `to` 最近的 500 根以内，真截掉了更早的才标 `truncated`。`from`、`to` 是纽约日期，可带时刻（`2026-11-12 09:30`），工具在本地筛出那一段，这样也能看过去某天的开盘；不填是今天，周末是上一个交易日，`to` 不能晚于今天；最多回看 4 个交易日（只跳过周末，节假日也算一天）。回放时填的 `now` 之后还没走完的 K 线不给。每根 K 线带 Massive 给的 VWAP，另算最新那一天的 VWAP（`dayVwap`）。超过上限一行拒绝，不发请求。没有 K 线时一行说明是休市、代码可能不对、盘前 04:00 还没开始，还是那段时刻里没有。
- **`earnings-date`。** 每次一个 Finnhub 财报日历请求（`/calendar/earnings?from=<今天>&to=<今天+120 天>&symbol=<代码>`，请求头 `X-Finnhub-Token`）。回下一次财报的日期（纽约日期，今天盘后发布的算今天，已公布实际数字的跳过）、盘前盘后盘中或时间未公布、离今天几个交易日（跳过周末和 `market-days.ts` 里的休市日，今天是 0）。120 天内没有时回「120 天内没有已公布的财报日」，ETF 也是这样。只回日期，不回预期、实际 EPS 和营收，不请求 `/stock/earnings`。Finnhub 回 429 时说「请求太多，稍后再查」。Finnhub 地址在 `tools/earnings-date/finnhub.json`。
- **一把密钥，几路请求。** 报价 feed（交易时段每 60 秒一个快照请求）、`scan` feed（每个交易日收盘后扫一次自选股）、`quote` 和 `intraday`（按需，每次一个）共用这一把 `POLYGON_API_KEY`。Starter 套餐没有次数上限；Massive 回 HTTP 429 时工具说「请求太多，稍后再查」，盘面的技能让它等手上的查询回来再重试一次，同时在途的联网查询最多两个。
- 三个联网工具都在 15 秒内放弃并说明，宿主的 20 秒上限之前一定结束。读的 Massive 地址和报价 feed 是同一个（`feeds/quotes/feed.json` 的 `settings.baseUrl`）。

## 读日线数据库的工具不联网

- 工具直接调 `modules-data/stock-ta/files/venv-<12 位>/bin/ta`，不经过 `uv`，所以服务的 PATH 里不需要 `uv`。用的是和这份包副本的 `py/uv.lock` 对得上的那个环境，钉在旧版本上的任务照样用旧环境。
- 每次调用先把 `files/ta/ta.sqlite` 在临时目录里克隆一份，`ta` 只在副本上跑，跑完删掉。实测 `ta` 哪怕只是读，也会开一次写事务，改掉数据库文件头的计数，所以不能直接对原库跑。只有 `scan` feed 写这份库，而且是整份换上，所以工具读到的总是一整份旧库或一整份新库。
- 行情接口指向一个关着的端口（`MASSIVE_BASE_URL=http://127.0.0.1:9`），密钥设成 `offline`，不联网。缓存缺数据时 `ta` 报「行情不可用」。
- `structure` 的 `now` 取两者里晚的那个（不再多加时间，`ta` 的两个判断都含端点）：这个标的和 QQQ、SPY 最近一次同步分红的时间，或这个标的最新一根日线收盘再加 `ta` 的 15 分钟延迟。`ta` 只在上次同步满一天时才刷新分红，第二天的扫描差不多正好隔 24 小时，常常不刷新，所以只看同步时间会用到前一天的收盘。这样取的 `now` 用上最新日线，又落在分红缓存有效的窗口里，`ta` 不会去补数据。数据库里没有这个标的，或者它或 QQQ、SPY 的同步旧了一天以上，工具直接说明，不调用 `ta`：标的在自选股里就让你等下一次收盘后的扫描，不在就让你先加进自选股。
- 只用只读子命令。`signals` 不传 `mark_read`，`rules` 不传 `patch`。
- `note` 读你用 `just module import` 导入的笔记：每次调用把 `modules-data/stock-ta/knowledge/` 下的 `TA?? - *.md` 链进一个临时目录交给 `ta`。没导入的那份，工具说出导入命令。同一个笔记文件导进了两份知识文档时只链一次。
- 每个结果裁剪到 20 KB 以内，裁剪过的带 `"truncated": true`。`note` 不返回笔记在你电脑上的绝对路径。
- 还没准备好时，工具回一行说明，不调用 `ta`：一个环境都没装，说「先跑 just module setup stock-ta」；只装了别的版本（包里钉的提交换了），说「重跑 just module setup stock-ta」；还没有数据库，说「还没有数据，等 scan feed 第一次跑完」。`rules` 和 `note` 不读数据库，第一次扫描前也能用。

## 你会少什么

这个模块只扫日线，和在你本机直接用技术分析项目比，少了三样：

- **全市场选股 `screen`。** 它要一份全市场的数据库（你本机那份 419 MB），从零同步约 2400 个 Massive 请求，旧 Mac 上还要每周刷新市值，不适合放进一个每天跑的 feed。信号、结构、盈亏比都不受影响。
- **日内 5 分钟信号。** 要每 5 分钟起一次 `ta`、每只每次一个请求。今天的问题都是日线问题。`signals` 的周期只收 `1d` 和 `1w`。
- **OR30（开盘 30 分钟区间突破）。** 它是 5 分钟信号的一种，跟着一起没了。

想要回来，见 `docs/modules/stock-ta-self-contained-plan.md` 的 Appendix E 第 1 条（`screen`）和第 5 条（5 分钟信号和 OR30）。

## 安装

下面的命令在本仓库根目录运行。状态目录默认是 `~/.pi-super-agent`，设了 `PSA_STATE_DIR` 就是它。

1. 把包复制进状态目录。新包被发现时是停用的。

   ```bash
   cp -R docs/modules/examples/stock-ta ~/.pi-super-agent/modules/
   ```

2. 装模块自己的 `ta`。模块带一个小的 Python 子项目 `py/`，钉在技术分析私有仓库 `ta-trading` 的一个提交上，用 HTTPS 地址拿。先确认 `uv` 在 PATH 里，而且这台机器的 git 能拿到这个私有仓库（`git ls-remote https://github.com/aicoder2048/TechnicalAnalysis` 不报错），然后：

   ```bash
   just module setup stock-ta
   ```

   环境装在 `modules-data/stock-ta/files/venv-<12 位>/`，不进包目录，大约 75 MB。重跑什么都不变。仓库里的例子换了钉的提交以后，复制新包再跑一次。只在这一步用 `uv`，工具和 `scan` 运行时直接调环境里的 `ta`。

3. 密钥。`scan` 用 Massive（原来的 Polygon）的 REST 密钥，名字是 `POLYGON_API_KEY`，报价也用它。宿主的密钥文件里已经有这一行就不用再加；没有的话加一行（密钥文件是 `config.json` 里 `secretsFile` 指向的 .env 文件，没有就新建一个，再在 `config.json` 里写 `"secretsFile": "secrets.env"`）：

   ```bash
   POLYGON_API_KEY=<你的 Massive/Polygon REST 密钥>
   FINNHUB_API_KEY=<你的 Finnhub 密钥>
   ```

   `MASSIVE_S3_ACCESS_KEY` 和 `MASSIVE_S3_SECRET_KEY` 是下载整日文件用的，这里用不上。没设 `POLYGON_API_KEY` 的时候，报价和扫描每一轮不发请求，只在宿主日志里记一行「没有设置 POLYGON_API_KEY」，宿主和其他工具照常。`just module check` 和样例排练不需要这把密钥。`FINNHUB_API_KEY` 只给 `earnings-date` 查财报日用，us-market 用的是同一把，已经有就不用再加；没有时风险计划写「没查到财报日」，别的照常。以前的 `TA_ROOT` 不用了，密钥文件里有的话可以删掉。

4. 导入笔记全文。每条命令导入一份，只收 `.md` 文件，导入后 `knowledge` 和 `note` 马上能用。笔记在你本机技术分析项目的 `docs/` 里；在别的机器上装时，先把这个 `docs/` 目录复制过去，`T` 指向复制过去的那一份的上一级。

   ```bash
   T=<放着笔记 docs/ 目录的地方>
   just module import stock-ta ta01-moving-averages "$T/docs/ta-knowhow/TA01 - 均线实战精华总结.md"
   just module import stock-ta ta01-moving-averages-2 "$T/docs/ta-knowhow/TA01 - 均线实战精华总结之二.md"
   just module import stock-ta ta02-macd "$T/docs/ta-knowhow/TA02 - MACD 实战精华总结.md"
   just module import stock-ta ta05-patterns "$T/docs/ta-knowhow/TA05 - 买卖点与常用 Patterns 实战精华总结.md"
   just module import stock-ta ta06-patterns-2 "$T/docs/ta-knowhow/TA06 - 买卖点与常用 Patterns 实战精华总结（二）.md"
   just module import stock-ta ta09-support-resistance "$T/docs/ta-knowhow/TA09 - 支撑与阻力实战精华总结.md"
   just module import stock-ta ta15-dow-theory "$T/docs/ta-knowhow/TA15 - 趋势 - 从道氏理论总结.md"
   just module import stock-ta ta15-ma-trend "$T/docs/ta-knowhow/TA15 - 趋势 - 从均线总结.md"
   just module import stock-ta ta18-bottom-fishing "$T/docs/ta-knowhow/TA18 - 抄底实战精华总结.md"
   just module import stock-ta ta51-candlesticks "$T/docs/ta-knowhow/TA51 - Japanese Candlesticks.md"
   just module import stock-ta ta52-td-sequential "$T/docs/ta-knowhow/TA52 - 九转序列.md"
   just module import stock-ta ta53-sentiment "$T/docs/ta-knowhow/TA53 - 市场情绪实战精华总结.md"
   just module import stock-ta ta54-other "$T/docs/ta-knowhow/TA54 - 其它重要的 TA 信息.md"
   just module import stock-ta ta55-intraday "$T/docs/ta-knowhow/TA55 - 日内精华.md"
   just module import stock-ta ta56-trim-core "$T/docs/ta-knowhow/TA56 - 长持仓位高抛低吸.md"
   just module import stock-ta pattern-guide "$T/docs/ta-knowhow/经典技术分析形态完全指南.md"
   just module import stock-ta risk-reward-vs-win-rate "$T/docs/投资理念和策略/盈亏比VS胜率.md"
   just module import stock-ta small-account "$T/docs/投资理念和策略/小资金做大策略.md"
   ```

   不导入也能用别的工具。`knowledge` 会说哪几份还没导入，`note` 查没导入的笔记时说出导入命令。

5. 检查、预演、打开。

   ```bash
   just module check ~/.pi-super-agent/modules/stock-ta
   just module try stock-ta
   just module on stock-ta
   ```

   `just module try` 在临时状态目录里起宿主，用的是真实 `files/` 的副本，所以要先装好环境；考题 `nvda-structure` 还要 NVDA 在自选股里、`scan` 扫过一次。它会用 `config.json` 里的模型，按量计费的模型会被拒绝。

6. 等第一拍扫描。打开后一小时内 `scan` 跑第一拍，用上一个交易日的收盘补齐两年日线。在这之前，读数据的工具都说「还没有数据」。`scan-runs` 里出现一行「换上」就好了。

打开以后在对话里问「NVDA 现在的支撑阻力和动量怎么样」，领队会把支撑阻力派给结构与形态，把动量派给趋势与动量，再汇总，汇报带数据时间和笔记出处。

## 自选股、报价和提醒

- **改自选股。** 在对话里说「把 AAPL 加进 stock-ta 的自选股」或「NVDA 从自选股划掉」。Worker 往 `watchlist` 加一行，划掉是给那一行写上 `removedAt`，不删行。同一只股票有好几行时以最新的一行为准。下一轮报价就用新名单，不用重启。自选股是空的时候不发请求。
- **问现价。** 「NVDA 现在多少」「META 和 TSM 今天涨了多少」：领队按技能 `quick-quote` 自己调一次 `quote`，不派专家，回答写价格、相对昨收的涨跌幅、数据时间（美东）、时段和「行情延迟 15 分钟」。问到为什么涨跌、要技术面时才派专家。`quote` 的细节：
  - 一次 1 到 10 个代码，自选股以外的股票和 ETF 也能查，一次快照请求，用 `POLYGON_API_KEY`。超过 10 个、没有密钥，都一行说明，不发请求。行情服务 15 秒没应答就放弃并说明，宿主的 20 秒上限之前一定结束。
  - 时段看数据时间：盘前（4:00 起）、盘中、盘后（到 20:00）。数据的美东日期早于今天时是「休市」，这样周末、节假日和夜里不用节假日表也能认出来，价格是上一交易日最后一笔（可能是盘后的），数据时间照实写。提前收盘日 13:00 以后算盘后，表在 `market-days.ts`，是宿主 `src/sources/market/session.ts` 的副本，`tests/market-hours.test.ts` 比对两份相同，每年加提前收盘日时两处都改。
  - Starter 套餐的快照没有成交明细，价格是延迟 15 分钟的那根分钟线的收盘价。每天凌晨 3:30 美东 Massive 清空当天的日线，盘前的当天成交量是 0，不代表没有成交。
  - 读的 Massive 地址和报价 feed 是同一个（`feeds/quotes/feed.json` 的 `settings.baseUrl`）。
- **问新闻。** 股票技术分析不管新闻和财报解读。只问新闻的问题，幕僚长按模块说明不交给 stock-ta，交给不属于任何领域的通用助手，它能读网页。一句话里既问涨跌又问原因或新闻时，stock-ta 的领队只报涨跌，不猜原因，最后加一句「原因不在行情数据里，想知道原因可以问「NVDA 最新新闻」。」（代码换成问到的）。建议的接着问是只问新闻的问题，它不归 stock-ta，幕僚长交给通用助手。这一句在网页的任务卡片上看得到，Telegram 上幕僚长常把它改写或删掉。幕僚长有时会把原因那一半另开成通用任务（混合问题实跑 9 次里 1 次），那时原因从通用任务来。
- **设提醒。** 「NVDA 跌破 170 提醒我」「NVDA 当天涨跌 5% 提醒我」：只有你本人发起的任务能设，条件存在 `quotes` 上，满足时网页和手机直接提醒你，例如 `提醒 · 股票技术分析：NVDA 105.30，相对昨收 100.00 涨了 5.30%，到了你设的涨跌 5% 提醒线（2026-11-12 10:05 美东，延迟行情）`。提醒里的时间按美东写；`quotes` 里存的还是 UTC。这是因为 `quotes` 的 `watch` 写了 `"zone": "America/New_York"`，别的模块的数据不写就照存的原样显示。当天涨跌用的是 `day-move` 条件，按每行的昨收（`prevClose`）算不取整的涨跌幅，同一天同一方向只提醒一次，盘中改了阈值按新阈值再提醒一次。
- **只存新鲜的报价。** 报价 feed 只写数据时间落在当天常规时段（9:30 到 16:00，提前收盘日到 13:00）的报价，「当天」按宿主时钟（feed 输入里的 `now`）算。所以开盘第一份快照里的盘前成交、节假日拿到的昨天的报价、提前收盘后的成交都不写行，提醒条件和 5% 规则都不会被它们触发。
- **和 us-market 分开取。** 模块的代码不能用宿主的行情客户端，所以 stock-ta 自己发快照请求、有自己的自选股，和 us-market 用同一把密钥时请求量相加（交易时段每分钟各一次）。`quotes` 不会自动清理，十只股票一年大约一百万行。
- **盘后和周末不请求。** 休市日没有日历，开盘时段照常请求，Massive 返回的还是上一个交易日的数据，数据时间不变就不会存新行。

## 从 us-market 搬过来

us-market 已经在旧 Mac 上关掉，要退役。你在 us-market 里设的盯盘条件（tripwire）存在 `state.db` 的 `source_user_data` 里，`just migrate-us-market` 把它们搬成 stock-ta 的提醒条件：

- 只搬当天涨跌（day），变成 `day-move`，阈值和方向不变。条件编号是 `cnd_usm_<代码>_day`，重跑只补差：没有就新建，参数变了就更新，一样就不变。遇到成本线（cost）或均线交叉（cross）就停下，什么都不写；代码不在 stock-ta 自选股里也停下，先在对话里加回自选股。
- 按你的决定，同时从 stock-ta 自选股划掉 AMZN 和 AAPL（写一行带 `removedAt` 的新行，不删行）。加 `--keep-watchlist` 不动自选股。
- 默认只打印一张表，不写。`--apply` 才写，`--undo` 只删 `cnd_usm_` 开头的条件、加回它划掉的自选股。us-market 原来那一行不改不删，网页照旧能看。
- 直接读写状态目录，和 `just module import` 一样，宿主不用停：宿主每写一行报价都重新读条件。stock-ta 要开着。

## 旧 Mac 部署

R2a、R1、R6 合并后各在旧 Mac 部署一次，每次都等你说「部署」。下面的命令在旧 Mac 的仓库目录跑，状态目录是 `~/.pi-super-agent`。

1. **只读预检。** 记下 `git rev-parse --short HEAD`、`just modules` 里各模块的开关、stock-ta 的 `_conditions` 条数和自选股条数（`sqlite3 -readonly ~/.pi-super-agent/modules-data/stock-ta/data.db`）、`config.json` 的键、当天的提醒行和触发条数。
2. **时间。** 美东 16:20 以后或周末，切换中没有盘中行情。
3. **备份。** 复制一份 `config.json`；`sqlite3 ~/.pi-super-agent/state.db ".backup <备份目录>/state.db"`，`modules-data/stock-ta/data.db` 也这样备份。
4. **换代码。** `just redeploy`（拉 main 并重装服务，见 `docs/deploy/home-mac.md` 的「更新」），再 `cp -R docs/modules/examples/stock-ta ~/.pi-super-agent/modules/` 和 `just module setup stock-ta`（钉的提交没变时什么都不做）。包换上不用重启，宿主几秒内换新版本。
5. **发一行测试。** `just notify` 发一行。事后在 `state.db` 的 `telegram_messages` 里查到这一行的 `message_id` 就算发出。
6. **R2a 这次的检查。** 在 Telegram 上问「NVDA 现在多少」，25 秒内收到带价格、涨跌幅、数据时间和「延迟 15 分钟」的回答，网页上这个任务没有派活记录。再从宿主日志的 `[gateway] stock-ta tools/quote` 行和 `telegram_messages` 算 3 次从提问到回答的时间，中位数超过 25 秒就记成阻碍，回到 R2a 修。周末第一次问时顺便看「休市」的价格和数据时间是不是上一交易日最后一笔。
7. **R1 这次迁移。** 换完代码后跑 `just migrate-us-market`，应该打印 1 行「新建」（种类和预检相同）和 2 行「划掉」（AMZN、AAPL）；看过再 `just migrate-us-market --apply`；再跑一次 `--apply`，打印「全部不变」。`_conditions` 多 1 行 `day-move`，你的盯盘条件从这时起重新会响。
8. **回退。** 恢复 `config.json` 和 `data.db` 的备份（`state.db` 只在它出问题时恢复），`git checkout` 部署前的 SHA，从那个 SHA 重新 `cp -R` stock-ta 包，重启。R2a 不改数据格式，回退到 R2a 以前不需要恢复 `data.db`。回退到 R1 以前必须恢复 `data.db`：旧代码遇到 `day-move` 条件会出错。`just migrate-us-market --undo` 只在新代码能启动时用。

## 日线扫描

- **什么时候扫。** feed `scan` 每小时一拍。一拍先看 cursor：这一拍的美东日期和标的列表都和上一次换上的扫描一样，就直接返回，不起 `ta`。不一样才起 `ta scan`，没到收盘后 15 分钟或者不是交易日，`ta` 说跳过，什么都不存。所以每个交易日收盘后的第一拍扫一次，改了自选股的当天下一拍再扫一次。
- **扫哪些。** `watchlist` 里最早加的 30 只，再加 QQQ、SPY，自选股是空的也加。超过 30 只时少扫的写在那一行的说明里。`ta` 只认 1 到 10 个英文字母、可带一个点和 1 到 2 个字母的代码（`BRK.B`，`BRK-B` 当成 `BRK.B`），一只不认的代码会让整次扫描报错，所以「腾讯」「0700.HK」「$NVDA」这类代码不传给 `ta`，那一行的说明里点名，其余照扫。
- **第一次。** 数据库还不存在时，扫描用上一个交易日收盘后 16 分钟当作 `now`，第一拍就补齐两年日线，不用等到当天收盘（周末装也一样）。上一个交易日从 `ta calendar` 一天一天往回查。
- **只写副本。** 先删掉上次崩溃可能留下的 `ta.sqlite.next`、`ta.sqlite.next-journal`、`ta.sqlite.next.scan.lock`，再把 `ta.sqlite` 克隆成 `ta.sqlite.next`，`ta` 只写这个副本。成功了才把副本改名成 `ta.sqlite`，所以读的人只会看到整份旧库或整份新库。
- **成败看输出，不看退出码。** 断网时 `ta` 的退出码也是 0，每个标的都报 `MARKET_UNAVAILABLE`。每个标的都出错算失败：副本删掉，旧库不动，`scan-runs` 记一行「失败」带原因，下一拍再试。部分标的出错照样换上，那一行列出出错的标的，它们第二个交易日再试。「分红不可用」只是提醒，不算出错。超过 270 秒的扫描时限也算失败：`ta` 被停掉，副本删掉，旧库不动，`scan-runs` 记一行「失败」，原因写超时，下一拍再试。断网时 `ta` 每个标的要重试好一阵（审查时实测约 12 秒一只），30 只加 QQQ、SPY 会超过 270 秒，这时看到的就是这一行超时。`ta` 退出码非零，副本删掉，旧库不动，宿主日志一行。
- **密钥。** 用宿主密钥文件里的 `POLYGON_API_KEY`，以 `ta` 认的名字 `MASSIVE_API_KEY` 传给它。没设的话每一拍报一行，不起 `ta`。
- **请求量。** 第一次扫 10 只加 QQQ、SPY 用了 36 个请求、22 秒（2026-11-12 实测），以后每个交易日一次。第一次补数会把两年里的历史信号都记成新信号（实测 7050 条），只写进 `scan-runs` 的计数。
- **不发提醒。** 新信号不叫醒领队，你问的时候再查。

## 在另一台机器上装

跑服务的旧 Mac 上没有技术分析项目，也不需要。2026-11-13 在旧 Mac（Intel，macOS 12）上照下面做了一遍，记录在 `docs/modules/evidence/s4-old-mac.md`。

1. **git 能拿到私有仓库。** 旧 Mac 没有 `gh`，没有能访问 GitHub 的 SSH 密钥，终端里的登录钥匙串常是锁着的，`osxkeychain` 存的凭据会被悄悄丢掉，所以用 git 的 `store` helper。在 GitHub 网页上建一个 fine-grained token，只给技术分析这一个仓库的 Contents 只读权限，设过期时间，然后：

   ```bash
   git config --global credential.helper store
   git ls-remote https://github.com/aicoder2048/TechnicalAnalysis HEAD   # 第一次按提示填用户名和 token
   chmod 600 ~/.git-credentials
   ```

   再跑一次 `git ls-remote` 不问密码、打印一个提交就好了。凭据只在 `just module setup` 时用，服务运行时用不上。

2. **装 uv。** 用官方安装脚本，装到 `~/.local/bin`：

   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   uv --version
   ```

   uv 第一次 setup 时会自己下载 Python 3.12。numpy 和 pandas 都有 Intel、macOS 10.13 以上的 wheel，不用编译。

3. **服务的 PATH。** 只有 `just module setup` 用 `uv`，工具和 `scan` 直接调环境里的 `ta`。想让 Worker 也能跑 setup，就在装好 uv 以后的新终端里重装一次服务，装机时 PATH 里 `uv` 所在的目录会写进服务的 PATH：

   ```bash
   just redeploy --no-pull
   ```

4. **复制包、装环境、确认密钥。** 照上面「安装」的第 1 到 3 步。旧 Mac 上 setup 用了 12 秒（含下载 Python），环境 161 MB。密钥文件里有 `POLYGON_API_KEY` 就行，以前的 `TA_ROOT` 不要了。

5. **把笔记带过去。** 笔记只在你本机的技术分析项目里。在本机把要的 18 份打个包传过去，放进旧 Mac 的一个临时目录，再照「安装」第 4 步导入，`T` 指向那个临时目录：

   ```bash
   cd <本机技术分析项目> && tar cf - docs/ta-knowhow/TA*.md docs/ta-knowhow/经典技术分析形态完全指南.md docs/投资理念和策略/盈亏比VS胜率.md docs/投资理念和策略/小资金做大策略.md | ssh <旧 Mac> 'mkdir -p /tmp/ta-notes && tar xf - -C /tmp/ta-notes'
   ```

   导入以后临时目录可以删掉，全文已经在模块的数据目录里。

6. **检查、打开、自选股。** `just module check`、`just module on stock-ta`，再在对话里把自选股告诉它（例如「把 NVDA、AAPL 加进 stock-ta 的自选股」）。打开后几秒内就跑第一拍，这时自选股还是空的，只扫 QQQ、SPY；改了自选股以后，按下文「日线扫描」的规则，收盘后的拍子扫你的标的。旧 Mac 上那次是先用脚本照 us-market 写好 9 只自选股再打开的，第一拍扫 9 只（含 QQQ、SPY）用了约 73 秒，每只两年日线 502 根。

7. **问一句。** 在手机上问「NVDA 现在的支撑阻力和动量怎么样」，汇报写出最近一个交易日收盘的数据时间和笔记出处。

8. **换钉的提交以后。** 仓库里改了 `py/pyproject.toml` 的 `rev` 并重新 `uv lock` 以后，每台机器复制新包、重跑 `just module setup stock-ta`。旧的环境留着，钉在旧版本上的任务照常用它；新版本没装环境时工具会提醒你重跑 setup。

旧 Mac 的 CPU 慢，`structure` 一次约 6 秒（本机约 1.1 秒），一个专家任务里会调好几次，所以旧 Mac 上一份技术分析汇报要两分钟左右。

## 更新和关掉

仓库里的例子更新以后，再执行一次第 2 步的 `cp -R`，宿主几秒内换上新版本，不用重启。关掉用 `just module off stock-ta`。导入的笔记在 `~/.pi-super-agent/modules-data/stock-ta/`，关掉或删掉包都不会删它。
