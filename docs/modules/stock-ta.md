# 股票技术分析模块（stock-ta）

stock-ta 让 Pi Super Agent 回答美股个股的技术面问题，例如「NVDA 现在的支撑阻力和动量怎么样」。数据和计算都来自你本机的技术分析项目（`ta` 命令行），这个模块只是把它的只读查询接进来，再配上笔记、技能和一个五人的专家队「技术分析研究组」。

包在 `docs/modules/examples/stock-ta/`，不在仓库的 `modules/` 下。仓库 `modules/` 里的新布局包第一次被发现时默认打开，而这个模块离开你本机的技术分析项目就用不了：在没有这个项目的机器上（例如跑服务的旧 Mac），它会默认打开、工具全失败，还会在幕僚长的名单上和 us-market 抢美股问题。所以它放在例子目录里，你在要用的那台机器上复制一份，自己打开。

## 里面有什么

- **工具。** 七个只读工具调 `ta` 的子命令：`structure`（支撑阻力、形态、动能）、`signals`（技术信号）、`note`（笔记原文）、`prices`（缓存里的最新价）、`conditions`（规则状态）、`rules`（规则定义）、`screen`（已经跑过的选股结果）。另有一个纯计算工具 `risk-reward`，算盈亏比和止损距离，用例在 `cases.json` 里，每次检查都跑。
- **专家。** 趋势与动量、结构与形态、信号分诊、市场情绪、风险与交易计划。每位专家只够得到 `uses` 里列的工具。
- **技能。** `principle-evidence`、`principle-freshness`、`ta-interpret`、`ta-screen`，从技术分析项目的 Pi 技能搬过来，去掉了桌面界面的部分。
- **报价。** feed `quotes` 在交易时段（美东 9:30 到收盘后 20 分钟）每 60 秒向 Massive 发一次快照请求，取回整张自选股，每只存一行进 `quotes`：价格、相对昨收的涨跌幅、当天成交量和数据时间。Starter 套餐的数据延迟 15 分钟，所以数据时间比现在早约 15 分钟。同一数据时间的行只存一次。自选股在 `watchlist` 里。
- **大涨大跌自动分析。** 自选股里一只股票当天相对昨收涨跌达到 5%，`quotes` 发一条触发，规则 `big-move`（`rules.md`）让幕僚长给技术分析研究组开任务：结构与形态和趋势与动量各看一遍，汇报带数据时间和出处，并说明不是交易指令。同一只股票同一天同一方向只开一次；当天先跌 5% 再涨 5% 是两次，哪怕跌 5% 的任务还没结束，涨 5% 也另开一个任务。5% 写死在 `feeds/quotes/index.ts` 的 `BIG_MOVE_PCT`。
- **知识。** 术语表随包自带。十八份笔记包里只有出处（`source.json`，`"license": "user-import"`），全文要你从本机导入，见下文。笔记不是你写的，仓库是公开的，所以全文不进仓库。

## 工具保证不改你的技术分析项目

- 每次调用先把 `app/data/ta.sqlite`（选股还有 `market.sqlite`）在临时目录里克隆一份，`ta` 只在副本上跑，跑完删掉。实测 `ta` 哪怕只是读，也会开一次写事务，改掉数据库文件头的计数，所以不能直接对原库跑。APFS 上克隆不占时间也不占空间。
- 行情接口指向一个关着的端口（`MASSIVE_BASE_URL=http://127.0.0.1:9`），不联网。
- `structure` 的 `now` 取这个标的和 QQQ、SPY 最近一次同步分红的时间再加一分钟，正好落在缓存有效的窗口里，`ta` 不会去补数据。缓存里没有这个标的，或者它比 QQQ、SPY 旧了一天以上，工具直接说明，不调用 `ta`。所以要分析的标的得在技术分析项目里扫描过（自选股里的标的每次扫描都会同步）。
- 只用只读子命令。`signals` 不传 `mark_read`，`rules` 不传 `patch`，`screen` 只查 `results`。
- 每个结果裁剪到 20 KB 以内，裁剪过的带 `"truncated": true`。`note` 不返回笔记在你电脑上的绝对路径。

## 安装

下面的命令在本仓库根目录运行。状态目录默认是 `~/.pi-super-agent`，设了 `PSA_STATE_DIR` 就是它。

1. 确认技术分析项目能用：`uv` 在宿主的 PATH 里（`which uv`），项目的 `app/trading` 跑过 `uv sync`。宿主作为服务运行时，服务的 PATH 也要有 `uv`：`just service-install` 会把装机时 PATH 里 `uv` 的目录写进去，装了 uv 之后重跑一次。

2. 把包复制进状态目录。新包被发现时是停用的。

   ```bash
   cp -R docs/modules/examples/stock-ta ~/.pi-super-agent/modules/
   ```

3. 告诉宿主技术分析项目在哪。在宿主的密钥文件里加一行（密钥文件是 `config.json` 里 `secretsFile` 指向的 .env 文件，没有就新建一个，再在 `config.json` 里写 `"secretsFile": "secrets.env"`）：

   ```bash
   TA_ROOT=<你的技术分析项目>
   ```

   报价用 Massive（原来的 Polygon）的 REST 密钥，名字是 `POLYGON_API_KEY`。宿主的密钥文件里已经有这一行就不用再加；没有的话加一行：

   ```bash
   POLYGON_API_KEY=<你的 Massive/Polygon REST 密钥>
   ```

   `MASSIVE_S3_ACCESS_KEY` 和 `MASSIVE_S3_SECRET_KEY` 是下载整日文件用的，报价用不上。没设 `POLYGON_API_KEY` 的时候，报价 feed 每一轮不发请求，只在宿主日志里记一行「没有设置 POLYGON_API_KEY」，宿主和其他工具照常。`just module check` 和样例排练不需要这把密钥。

   也可以在启动宿主的环境里设 `TA_ROOT`，环境变量优先。这个路径只在你的机器上，不进模块包。没设的时候，工具会回一行「没有设置 TA_ROOT」并指向这份文档。

4. 导入笔记全文。每条命令导入一份，只收 `.md` 文件，导入后马上能用 `knowledge` 查到。

   ```bash
   T=<你的技术分析项目>
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

   不导入也能用工具，`knowledge` 会说哪几份还没导入。`note` 工具不靠导入，它直接读技术分析项目里的笔记。

5. 检查、预演、打开。

   ```bash
   just module check ~/.pi-super-agent/modules/stock-ta
   TA_ROOT=<你的技术分析项目> just module try stock-ta
   just module on stock-ta
   ```

   `just module try` 在临时状态目录里起宿主，读不到你的密钥文件，所以 `TA_ROOT` 要放在命令前面。它会用 `config.json` 里的模型，按量计费的模型会被拒绝。

打开以后在对话里问「NVDA 现在的支撑阻力和动量怎么样」，领队会把支撑阻力派给结构与形态，把动量派给趋势与动量，再汇总，汇报带数据时间和笔记出处。

## 自选股、报价和提醒

- **改自选股。** 在对话里说「把 AAPL 加进 stock-ta 的自选股」或「NVDA 从自选股划掉」。Worker 往 `watchlist` 加一行，划掉是给那一行写上 `removedAt`，不删行。同一只股票有好几行时以最新的一行为准。下一轮报价就用新名单，不用重启。自选股是空的时候不发请求。
- **问现价。** 「NVDA 现在多少，离 170 还有多远」：专家读 `quotes` 里最新的一行，回答写出数据时间，并说明延迟 15 分钟。
- **设提醒。** 「NVDA 跌破 170 提醒我」：只有你本人发起的任务能设，条件存在 `quotes` 上，满足时网页和手机直接提醒你，带价格和数据时间。提醒里的时间按美东写，例如「2026-11-09 09:47 美东」；`quotes` 里存的还是 UTC。这是因为 `quotes` 的 `watch` 写了 `"zone": "America/New_York"`，别的模块的数据不写就照存的原样显示。
- **和 us-market 分开取。** 模块的代码不能用宿主的行情客户端，所以 stock-ta 自己发快照请求、有自己的自选股，和 us-market 用同一把密钥时请求量相加（交易时段每分钟各一次）。`quotes` 不会自动清理，十只股票一年大约一百万行。
- **盘后和周末不请求。** 休市日没有日历，开盘时段照常请求，Massive 返回的还是上一个交易日的数据，数据时间不变就不会存新行。

## 更新和关掉

仓库里的例子更新以后，再执行一次第 2 步的 `cp -R`，宿主几秒内换上新版本，不用重启。关掉用 `just module off stock-ta`。导入的笔记在 `~/.pi-super-agent/modules-data/stock-ta/`，关掉或删掉包都不会删它。
