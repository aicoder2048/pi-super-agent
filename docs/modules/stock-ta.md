# 股票技术分析模块（stock-ta）

stock-ta 让 Pi Super Agent 回答美股的报价和技术面问题，例如「NVDA 现在多少」「NVDA 现在的支撑阻力和动量怎么样」。它只管客观的交易数据和由它算出的技术面，外加下一次财报日这个日期，不管新闻、财报解读和宏观。计算来自技术分析私有仓库里的 `ta-trading`（`ta` 命令行），模块用 `just module setup` 把钉住的版本装进自己的数据目录；数据也归模块自己，`scan` feed 每个交易日收盘后扫一次自选股。工具只读这份数据，再配上笔记、技能和一个六人的专家队「技术分析研究组」。它不需要你本机的技术分析项目，跑服务的旧 Mac 上也能用。

按「你这样问，会得到什么」组织的使用手册见 [stock-ta-cookbook.md](stock-ta-cookbook.md)，例子是真实数据实测的。

包在 `docs/modules/examples/stock-ta/`，不在仓库的 `modules/` 下。仓库 `modules/` 里的新布局包第一次被发现时默认打开，而这个模块要先在那台机器上跑一次 `just module setup`、有一把 Massive 密钥才能用，没准备好就打开的话工具全失败。所以它放在例子目录里，你在要用的那台机器上复制一份，自己打开。

## 里面有什么

- **工具。** `quote` 向 Massive 要一次快照，回现价，见下文「问现价」。`intraday` 向 Massive 要一只股票当天的分钟线或小时线，`earnings-date` 向 Finnhub 要下一次财报日，见下文「联网的工具和密钥」。六个只读工具调 `ta` 的子命令：`structure`（支撑阻力、形态、动能）、`signals`（技术信号，日线和周线）、`note`（笔记原文）、`prices`（数据库里的最新价）、`conditions`（规则状态）、`rules`（规则定义）。另有一个纯计算工具 `risk-reward`，算盈亏比和止损距离，用例在 `cases.json` 里，每次检查都跑。
- **专家。** 趋势与动量、结构与形态、信号分诊、市场情绪、风险与交易计划、盘面。每位专家只够得到 `uses` 里列的工具，成员只有读文件的 `read`，不能读网页。盘面判断当天的涨跌是个股还是大盘、板块，用 `quote`、`intraday`、`prices`、`note`，汇报分结论、证据、数据时间三段，不找原因。风险与交易计划每次给计划都查一次 `earnings-date`，财报日在持有期内或 10 个交易日内时单独写一行跳空风险，只有它能用这个工具。
- **技能。** `principle-evidence`、`principle-freshness`、`ta-interpret`，从技术分析项目的 Pi 技能搬过来，去掉了桌面界面、选股和日内的部分。`quick-quote` 让领队自己回答只问价格的问题，`band-move` 是领队接到到档触发时只派盘面、结构与形态、趋势与动量三位的做法，`market-desk` 是盘面查当天行情的做法。
- **报价。** feed `quotes` 在交易时段（美东 9:30 到收盘后 20 分钟）每 60 秒向 Massive 发一次快照请求，取回整张自选股，再加上 SPY 和 QQQ（不在自选股里也取），每只存一行进 `quotes`：价格、相对昨收的涨跌幅、当天成交量和数据时间。Starter 套餐的数据延迟 15 分钟，所以数据时间比现在早约 15 分钟。同一数据时间的行只存一次。自选股在 `watchlist` 里。
- **日线扫描。** feed `scan` 每 5 分钟看一次，每个交易日收盘 20 分钟后（模块自己的日历，提前收盘日跟着提前）用模块自己装的 `ta` 扫一次自选股和 QQQ、SPY，把两年日线、分红和信号写进模块自己的数据库 `modules-data/stock-ta/files/ta/ta.sqlite`，每次运行在 `scan-runs` 里记一行。工具读的就是这份数据库。见下文「日线扫描」。
- **到档提醒和自动分析。** 到档是盯盘规则表 `watch-rules.ts`（包根目录）里的两条规则：第一档 `move-1` 是个股 5%、SPY 和 QQQ 2%，第二档 `move-2` 是个股 8%、SPY 和 QQQ 3%（设计见 `stock-ta-rules-design.md`）。两档都是 5 层：发一行提醒再开一个分析任务。第一档那一行是静音的，Telegram 用 `disable_notification` 发，手机不响，网页也不弹「今天」；第二档那一行响铃。数字只写在表里：规则 `watch-task`、技能和 feed 说明都不写数字，只说「到了哪一档看触发正文」。涨跌幅按现价和昨收算，不取整，4.996% 不算到 5% 档。每轮取已经到达的最高一档；每只股票每个方向每天只升不降，回落再上来不重报，跳空直接到 8% 只报 8% 档。已报到哪一档存在 feed 的 cursor 里，按宿主时钟的美东日期换日清空，宿主重启后接着用，改档不会让当天已经报过的档重报。到档时先发一行提醒，不经幕僚长，直接到网页和 Telegram，例如 `提醒 · 股票技术分析：NVDA 涨 +5.31%，到达 +5% 档。现价 105.31，昨收 100.00。报价时间 10:05 ET（延迟行情）。`。报价不是私密数据，所以幕僚长读过私密模块以后，这一行在 Telegram 上照样完整。同时发一条触发，正文是这一行加上「（规则 move-1，层级 5，做法 band-move）」，规则 `watch-task`（`rules.md`）让幕僚长开一个任务，领队照做法同名的技能 `band-move` 同一轮派盘面、结构与形态和趋势与动量三位，汇报先写盘面。同一只股票当天的后续触发（先到第一档再到第二档，或者先跌后涨）进同一个任务。
- **在对话里改层级和门槛。** 说「TSLA 的第一档改成 7%」「第一档改成响铃、不开任务」，Worker 照技能 `rule-levels` 往 `rule-levels` 集合加一行（规则、代码、层级、门槛、你的原话），只加不删。生效的是表里的默认，叠上你对全部票的最新改动，再叠上对这只票的最新改动；下一轮报价就按新的算，不用重启。门槛不写代码时只改个股，SPY、QQQ 要写代码。撤回是加一行同样的规则和代码，写上 `removedAt`。层级 0、1、4 现在都不推送（页面标记和收盘小结还没做），2 是静音一行，3 是响铃一行不开任务，5、6 是一行加任务。规则不在表里、层级不在 0 到 6、门槛不是大于 0 小于 100 的数、或让某只票第一档门槛不低于第二档的行不生效，feed 报一个问题 `bad-level`，说是第几行；只看每条规则每只票最新的一行，所以加一行撤回或写对的值，下一轮问题就消失。一轮越过两档时只发一行：用越过的档里会发一行的最高一档，有一档响铃就响，有一档是 5 层就开任务，第二档改成 0 层不会吞掉第一档。
- **你的当天涨跌条件和档位一起到。** 你设的 `day-move` 条件（例如 NVDA 当天涨跌 1%）和档位在同一轮、同一方向第一次到线时，只发一行：档位那一行后面接上「也到了你设的涨跌 1% 提醒线。」。不在同一轮的照旧各发各的。
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

   `MASSIVE_S3_ACCESS_KEY` 和 `MASSIVE_S3_SECRET_KEY` 是下载整日文件用的，这里用不上。没设 `POLYGON_API_KEY` 的时候，报价和扫描每一轮不发请求，网页和 Telegram 上各说一次「没有设置 POLYGON_API_KEY……」（见下文「出了问题它会说」），宿主和其他工具照常。`just module check` 和样例排练不需要这把密钥。`FINNHUB_API_KEY` 只给 `earnings-date` 查财报日用，us-market 用的是同一把，已经有就不用再加；没有时风险计划写「没查到财报日」，别的照常。以前的 `TA_ROOT` 不用了，密钥文件里有的话可以删掉。

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

自选股是你要系统主动盯和长期盯的票（ADR-0024）。问价和日内走势任何代码都能查；技术面靠每天收盘后积累的日线和信号，所以只对自选股有数据。新代码先加进自选股，等下一次收盘后的扫描。

- **改自选股。** 在对话里说「把 AAPL 加进 stock-ta 的自选股」或「NVDA 从自选股划掉」。Worker 往 `watchlist` 加一行，划掉是给那一行写上 `removedAt`，不删行。同一只股票有好几行时以最新的一行为准。下一轮报价就用新名单，不用重启。自选股是空的时候不发请求。
- **问现价。** 「NVDA 现在多少」「META 和 TSM 今天涨了多少」：领队按技能 `quick-quote` 自己调一次 `quote`，不派专家，回答写价格、相对昨收的涨跌幅、数据时间（美东）、时段和「行情延迟 15 分钟」。问到为什么涨跌、要技术面时才派专家。`quote` 的细节：
  - 一次 1 到 10 个代码，自选股以外的股票和 ETF 也能查，一次快照请求，用 `POLYGON_API_KEY`。超过 10 个、没有密钥，都一行说明，不发请求。行情服务 15 秒没应答就放弃并说明，宿主的 20 秒上限之前一定结束。
  - 时段看数据时间：盘前（4:00 起）、盘中、盘后（到 20:00）。数据的美东日期早于今天时是「休市」，这样周末、节假日和夜里不用节假日表也能认出来，价格是上一交易日最后一笔（可能是盘后的），数据时间照实写。收盘是不是结束了看现在的时钟，不看数据时间：收盘 20 分钟以后（行情延迟 15 分钟，再留出收盘成交的余量），当天的数据都算盘后。没有盘后成交的票（PFFD、BRK.A）分钟线一整晚停在 15:59，不能因此叫它盘中。提前收盘日 13:00 收盘，表在 `market-days.ts`，是宿主 `src/sources/market/session.ts` 的副本，`tests/market-hours.test.ts` 比对两份相同，每年加提前收盘日时两处都改。
  - 盘后和休市时另外回 `close`、`closeDate` 和 `closeChangePct`：常规时段的正式收盘价、收盘日期和收盘相对昨收的涨跌幅，取自快照的日线（`day.c`）。收盘以后分钟线跟着盘后成交走，日线停在正式收盘价：2026-11-13 美东 23:00 实测 QQQ 分钟线是 19:59 的盘后价 674.25，`day.c` 是 679.89，和 Massive 的日线聚合、open-close 接口的收盘价相同。所以问「今天的收盘价」不受自选股限制。同一晚 PFFD 分钟线停在 15:59，`day.c` 是 16.59。收盘 20 分钟以内不回收盘价：那时延迟的日线还在常规时段里，不是正式收盘。盘中和盘前不回收盘价，日线被清空时也不回。问收盘价时领队先报收盘价和日期，再报盘后价。
  - Starter 套餐的快照没有成交明细，价格是延迟 15 分钟的那根分钟线的收盘价。交易日凌晨 3:30 美东 Massive 清空当天的日线，盘前的当天成交量是 0，不代表没有成交（沿用 R2a 的说法，这次没有复测）。周末和节假日 Massive 清不清空日线没有实测：`saturday`、`holiday` 两个 fixture 假设整天停在上一交易日、`day.c` 是那天的正式收盘；要是被清空，`quote` 不回收盘价，领队照技能写没查到正式收盘价。
  - 读的 Massive 地址和报价 feed 是同一个（`feeds/quotes/feed.json` 的 `settings.baseUrl`）。
- **问新闻。** 股票技术分析不管新闻和财报解读。只问新闻的问题，幕僚长按模块说明不交给 stock-ta，交给不属于任何领域的通用助手，它能读网页。一句话里既问涨跌又问原因或新闻时，stock-ta 的领队只报涨跌，不猜原因，最后加一句「原因不在行情数据里，想知道原因可以问「NVDA 最新新闻」。」（代码换成问到的）。建议的接着问是只问新闻的问题，它不归 stock-ta，幕僚长交给通用助手。这一句在网页的任务卡片上看得到，Telegram 上幕僚长常把它改写或删掉。幕僚长有时会把原因那一半另开成通用任务（混合问题实跑 9 次里 1 次），那时原因从通用任务来。
- **设提醒。** 「NVDA 跌破 170 提醒我」「NVDA 当天涨跌 5% 提醒我」：只有你本人发起的任务能设，条件存在 `quotes` 上，满足时网页和手机直接提醒你，例如 `提醒 · 股票技术分析：NVDA 105.30，相对昨收 100.00 涨了 5.30%，到了你设的涨跌 5% 提醒线（2026-11-12 10:05 美东，延迟行情）`。提醒里的时间按美东写；`quotes` 里存的还是 UTC。这是因为 `quotes` 的 `watch` 写了 `"zone": "America/New_York"`，别的模块的数据不写就照存的原样显示。当天涨跌用的是 `day-move` 条件，按每行的昨收（`prevClose`）算不取整的涨跌幅，同一天同一方向只提醒一次，盘中改了阈值按新阈值再提醒一次。
- **只存新鲜的报价。** 报价 feed 只写数据时间落在当天常规时段（9:30 到 16:00，提前收盘日到 13:00）的报价，「当天」按宿主时钟（feed 输入里的 `now`）算。所以开盘第一份快照里的盘前成交、节假日拿到的昨天的报价、提前收盘后的成交都不写行，提醒条件和档位都不会被它们触发。
- **us-market 退役。** us-market 的包在 R5 删掉了，档位提醒只走这个报价 feed 一条路。`config.json` 里还留着 `sources.us-market` 时宿主拒绝启动，报错说删掉哪一项。us-market 以前的任务、触发和提醒行照旧能在网页上看。`quotes` 不会自动清理，十只股票一年大约一百万行。
- **网页上的模块卡片。** stock-ta 的卡片多两行：「今日提醒 n 条」，和每个 feed 最近一轮的时间和取到几行（报价按美东写，例如「自选股报价 10:05 美东 取到 11 行」），失败时写原因。宿主重启以后要等第一轮跑完才有这一行。
- **出了问题它会说。** 两个 feed 用宿主的「报问题」口子，报出的问题就是这个 feed 的警报（`docs/health/README.md`）：网页页头下的横幅一直显示到解除，Telegram 上拉响时一条 ⚠️、解除时一条 ✅；之后换了一种问题（id 变了）只更新横幅上的文字，不再发；哪一轮没报这个问题就解除，之后再报时再响一次；宿主重启后还没修好的会再响一次。文字写在 feed 代码里，不带行情数据。报价 feed 有三种。没设密钥（`no-key`）。连着 5 轮取不到报价，Massive 出错、连不上或应答不对都算（`massive-down`，按 60 秒一轮大约 5 分钟，轮数存在 cursor 里，宿主重启后接着数，换日重数）：问题里写上第 5 轮的错误，例如「（最近一次：行情服务返回 HTTP 401）」；HTTP 401、403 是密钥失效或套餐到期，不会自己好，问题让你检查宿主密钥文件里的 `POLYGON_API_KEY`，别的错误说恢复后自动接着取；之后几轮换了一种错误，id 没变，不会再说。常规时段里 20 分钟没有数据时间更新的报价（`stale`，从这一天第一轮或上一次报价更新那一轮算起，所以开盘头 15 分钟拿到的盘前报价不会让它报；收盘以后不报，提前收盘日 13:00 以后也不报；`market-days.ts` 表里的休市日不报，宿主的美股时段在休市日照跑，拿到的一直是前一天的报价）。扫描 feed 有两种：没设密钥（`no-key`）和扫描失败（`scan-failed`：每个标的都出错、超时、`ta` 退出码非零或环境没装好，原因写在 `scan-runs` 那一行里）。扫描的问题哪一拍没报就清掉：换上的扫描、cursor 命中直接返回的一拍、`ta` 说跳过的一拍都算。失败的扫描不动 cursor，所以一直扫不成功时，收盘后那一晚的几拍都起 `ta`、都失败，只说一次；过了美东午夜的第一拍 `ta` 说跳过，问题清掉，下一个交易日收盘后的第一拍再失败时再说一次，也就是一直坏着的话每个交易日说一次。刚装好、还没有数据库时没有跳过的一拍（第一次扫描补上一个收过盘的交易日），一直失败就只说一次。取不到报价的那几轮在网页卡片上仍写「取到 0 行」，不写「这一轮失败」，原因在警报里，不进宿主日志。
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
4. **删 us-market 的配置。** 从 R6 那次起，换代码之前先做这一步。打开 `~/.pi-super-agent/config.json`，删掉 `sources` 里的 `us-market` 一项，`sources` 删空了就把整个 `sources` 删掉；有 `modules.us-market` 也删。新代码看到这两项会拒绝启动。旧代码没有这一项也能跑（轮询回到默认的每 60 秒），所以先删，再 `just redeploy --no-pull` 用旧代码重启一次，`just modules` 和删之前一样。
5. **换代码。** `just redeploy`（拉 main 并重装服务，见 `docs/deploy/home-mac.md` 的「更新」），再 `cp -R docs/modules/examples/stock-ta ~/.pi-super-agent/modules/` 和 `just module setup stock-ta`（钉的提交没变时什么都不做）。包换上不用重启，宿主几秒内换新版本。
   注意，`cp -R` 用仓库里的包覆盖状态目录里的 `modules/stock-ta`。你在旧 Mac 上直接改过的包文件会被换回仓库的版本。档位不再是包里的文件：你的改动存在 `rule-levels` 集合里，`cp -R` 不会碰它。想留下的改动先改进仓库，或者复制前另存那个文件、复制后再改回去。
6. **发一行测试。** `just notify` 发一行。事后在 `state.db` 的 `telegram_messages` 里查到这一行的 `message_id` 就算发出。
7. **R2a 这次的检查。** 在 Telegram 上问「NVDA 现在多少」，25 秒内收到带价格、涨跌幅、数据时间和「延迟 15 分钟」的回答，网页上这个任务没有派活记录。再从宿主日志的 `[gateway] stock-ta tools/quote` 行和 `telegram_messages` 算 3 次从提问到回答的时间，中位数超过 25 秒就记成阻碍，回到 R2a 修。周末第一次问时顺便看「休市」的价格和数据时间是不是上一交易日最后一笔。
8. **R1 这次迁移。** 换完代码后跑 `just migrate-us-market`，应该打印 1 行「新建」（种类和预检相同）和 2 行「划掉」（AMZN、AAPL）；看过再 `just migrate-us-market --apply`；再跑一次 `--apply`，打印「全部不变」。`_conditions` 多 1 行 `day-move`，你的盯盘条件从这时起重新会响。
9. **R6 这次的检查。** `just modules` 里没有 us-market，stock-ta 运行中，版本括号里的 digest 和 `just module check docs/modules/examples/stock-ta` 打印的 `digest=` 相同；`config.json` 没有 `sources`；`_conditions` 还是 R1 迁来的那 1 行 `day-move`。下一个交易日只读查看，提醒行和触发只来自 stock-ta，部署之后没有 `us-market` 来源的新行。
10. **回退。** 恢复 `config.json` 和 `data.db` 的备份（`state.db` 只在它出问题时恢复），`git checkout` 部署前的 SHA，从那个 SHA 重新 `cp -R` stock-ta 包，重启。恢复的 `config.json` 带回 `sources.us-market`，R6 以前的代码认它。R2a 不改数据格式，回退到 R2a 以前不需要恢复 `data.db`。回退到 R1 以前必须恢复 `data.db`：旧代码遇到 `day-move` 条件会出错。`just migrate-us-market --undo` 只在新代码能启动时用。

## 日线扫描

- **什么时候扫。** feed `scan` 每 5 分钟一拍。一拍先按模块自己的日历（`market-days.ts`，提前收盘日 13:00）算出最近一个收盘已过 20 分钟的交易日，再看 cursor：这个交易日和标的列表都和上一次换上的扫描一样，就直接返回，不起 `ta`。不一样才起 `ta scan`。收盘后 20 分钟是为了等报价 feed 写完当天最后的命中（它收盘后还跑 20 分钟）。所以每个交易日收盘后 20 到 25 分钟扫一次，改了自选股的当天下一拍再扫一次。这一拍的美东日期就是那个交易日时 `now` 传这一拍的时间；周末、过了美东午夜补扫时传那个交易日收盘后 16 分钟，`ta` 才不会说跳过。扫描失败时每拍都重试那个交易日，换上了才清掉问题。
- **扫哪些。** `watchlist` 里最早加的 30 只，再加 QQQ、SPY，自选股是空的也加。超过 30 只时少扫的写在那一行的说明里。`ta` 只认 1 到 10 个英文字母、可带一个点和 1 到 2 个字母的代码（`BRK.B`，`BRK-B` 当成 `BRK.B`），一只不认的代码会让整次扫描报错，所以「腾讯」「0700.HK」「$NVDA」这类代码不传给 `ta`，那一行的说明里点名，其余照扫。
- **第一次。** 数据库还不存在时，第一拍就补齐两年日线，不用等到当天收盘（周末装也一样）：补的是最近一个收盘已过 20 分钟的交易日，按模块自己的日历算。
- **只写副本。** 先删掉上次崩溃可能留下的 `ta.sqlite.next`、`ta.sqlite.next-journal`、`ta.sqlite.next.scan.lock`，再把 `ta.sqlite` 克隆成 `ta.sqlite.next`，`ta` 只写这个副本。成功了才把副本改名成 `ta.sqlite`，所以读的人只会看到整份旧库或整份新库。
- **成败看输出，不看退出码。** 断网时 `ta` 的退出码也是 0，每个标的都报 `MARKET_UNAVAILABLE`。每个标的都出错算失败：副本删掉，旧库不动，`scan-runs` 记一行「失败」带原因，下一拍再试。部分标的出错照样换上，那一行列出出错的标的，它们第二个交易日再试。「分红不可用」只是提醒，不算出错。超过 270 秒的扫描时限也算失败：`ta` 被停掉，副本删掉，旧库不动，`scan-runs` 记一行「失败」，原因写超时，下一拍再试。断网时 `ta` 每个标的要重试好一阵（审查时实测约 12 秒一只），30 只加 QQQ、SPY 会超过 270 秒，这时看到的就是这一行超时。`ta` 退出码非零、起不来或环境没装好，也一样：副本删掉，旧库不动，`scan-runs` 记一行「失败」带原因。
- **密钥。** 用宿主密钥文件里的 `POLYGON_API_KEY`，以 `ta` 认的名字 `MASSIVE_API_KEY` 传给它。没设的话不起 `ta`，报问题 `no-key`。
- **请求量。** 第一次扫 10 只加 QQQ、SPY 用了 36 个请求、22 秒（2026-11-12 实测），以后每个交易日一次。第一次补数会把两年里的历史信号都记成新信号（实测 7050 条），只写进 `scan-runs` 的计数。
- **收盘规则。** 换上的扫描里，`ta` 当天的新信号（数据日期是这个交易日、标的是自选股里的个股）都按盯盘规则表 `watch-rules.ts` 判层级，和报价 feed 同一张表，规则和层级见 [使用手册第 2 章](stock-ta-cookbook.md)。`ta` 的规则编号对表里的一行：`R-MA-2-200`、`R-MA-2-50:down`、`R-MA-2-50:up` 各有一行，形态、道氏趋势结束、九转 13、MACD 背离归 `ta-key`，其余归 `ta-other`。`ta` 存的关注度也用上：`noise` 降到 0 层，只有 `key` 的信号能被同向升一层。模块自己用当天完整的日线算收盘放量 `volume-close`（全天成交量对此前 20 日均量）。命中写进 `files/hits/<日期>/scan.json`，id 是 `<规则>:<代码>:<日期>`，`ta-key`、`ta-other` 两行用 `<ta 编号>:<方向>` 当规则那一段；当天报价 feed 的命中一起算同向升级和多空分歧。2 层发一行静音提醒；5 层发触发，正文是那一行加「（规则 R-MA-2-200，层级 5，做法 structure-trend）」，线程是 `<代码>:<日期>` 挂在模块名下（`threadScope: "module"`），和报价 feed 当天这只票的任务是同一个线程。同一天再扫（加了自选股）时，已经判过的命中留着、不再发。空库第一次扫描补的两年信号一条都不判。`settings.signals.rules` 和规则 `ma-break` 删掉了，想让某条收盘规则开任务或不出声，在对话里改它的层级（`rule-levels`）。`ta` 没有 20 日线的规则，价格对均线只有 MA50、MA120、MA200，EMA 8/21 交叉是 `R-MA-1`。
- **模块自己算的收盘规则。** 用读到的日线（最多 260 根，没复权）算 50/200 日均线金叉死叉 `cross-50-200`（简单平均）、RSI(14) `rsi`（Wilder 平滑，上穿 70、下穿 30，门槛改 `rsi` 的 threshold）。财报临近 `earnings` 每次扫描给每只个股查一次 Finnhub（`settings.finnhubBaseUrl`，密钥 `FINNHUB_API_KEY`，和工具 `earnings-date` 共用 `earnings.ts`），5 个交易日内记一条，id 是 `earnings:<代码>:<财报日>`，前 10 个交易日记过的不再记。没有密钥或 Finnhub 答不上时这条不算，扫描记录的说明里写一句。
- **收盘小结。** 判完收盘规则的同一拍，扫描发一行静音提醒 `digest:<日期>`，规则见使用手册第 2 章「收盘小结」（代码在 `feeds/scan/digest.ts`）。cursor 记着这个交易日的小结发过没有（`digest`），一个交易日只发一次。扫描一直失败时，收盘后 90 分钟（美东 17:30）照发。宿主本地 22:00 到 07:00（`watch-rules.ts` 的 `QUIET`）以内不发，命中标成 `held`，时段结束后的第一拍连同两个 feed 留下的 5、6 层触发一起发。

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
