# option-ta P1：数据摸底和 theta 移植清单

这是 `option-ta-build-plan.md` 的 P1 产出，交给 P2（模块工坊）和 P3（补强）。它回答两件事：Massive 的期权接口实际给什么、缺什么；theta（下称 T）里哪些纯计算和规则值得搬、出处在哪。

## 结论摘要

- 计划用到的字段都实测到了，样本在 `samples/`。缺字段有固定的几种情况，见「期权链快照」一节。
- 合约列表和期权链快照里混着**二元期权**（代码以 `O:B1` 开头），没有 greeks 和 IV，按代码排序时排在最前面。工具必须先滤掉。
- 休市时字段都还在。期权报价停在收盘那一刻，但正股价、IV、希腊值会跟着盘前盘后的正股价继续变。
- 没有现成的 IV 历史接口。可以用期权日线反解 IV 回填：已到期合约的日线照样取得到，至少回溯到 2021-12。反解的口径和快照 IV 不一样，两者不能混在一个序列里。
- 没打出 429，也没有限流响应头。宿主的回放夹具只能回 200，`cases.json` 写不出「HTTP 429」这种用例。
- T 的纯计算搬 17 项（其中 3 项只搬部分函数），不搬的列了 16 类；18 个技能里 10 个作规则参考，8 个不用。

## 怎么测的

- 时间：2026-11-17 美东 04:29 至 04:40（周二盘前，常规时段没开）。上一个交易时段是 11-16 周一。所以这次的样本全部是「休市」状态。盘中样本还没录，见「遗留问题」。
- 标的：SPY（主要）和 NVDA。都是公共标的，和使用者的持仓无关。
- 基址：`https://api.massive.com`，取自 stock-ta `feeds/quotes/feed.json` 的 `settings.baseUrl`。
- key：本机 `~/.pi-super-agent/config.json` 的 `secretsFile` 里的 `POLYGON_API_KEY`，放在 `Authorization: Bearer` 头里，不进 URL。stock-ta 的 `massive.ts` 也这样传。
- 调用量：共 54 次。其中 20 次是并发试探限流，15 次是最后用 `probe.sh` 重跑一遍确认脚本能用。
- 重跑：`probe.sh [输出目录]` 取原始应答，`make-samples.py` 裁成 `samples/`。合约代码写死在脚本里，过了 2026-11-20 要换成新的到期日。

## 接口和字段

### 合约列表 `/v3/reference/options/contracts`

| 字段 | 类型 | 说明 | 会缺吗 |
|---|---|---|---|
| `ticker` | 字符串 | `O:SPY261120P00730000` 格式；行权价 ×1000 补到 8 位 | 不缺 |
| `underlying_ticker` | 字符串 | 正股代码 | 不缺 |
| `contract_type` | `"call"` / `"put"` | | 不缺 |
| `exercise_style` | `"american"` / `"european"` | 个股和 ETF 期权是 american；二元期权是 european | 不缺 |
| `expiration_date` | `YYYY-MM-DD` | 美东日期 | 不缺 |
| `strike_price` | 数字 | 美元，可能是整数也可能带小数 | 不缺 |
| `shares_per_contract` | 整数 | 合约乘数，样本都是 100 | 不缺 |
| `type` | 字符串 | 二元期权是 `"binary"`；标准期权的样本里没有这个字段 | 标准期权缺 |
| `additional_underlyings` | 数组 | 二元期权带 `{type: currency, underlying: USD, amount: 100}` | 标准期权缺 |
| `cfi`、`primary_exchange` | 字符串 | 用不到 | |

- 过滤参数实测可用：`underlying_ticker`、`expiration_date`、`contract_type`、`strike_price`、`strike_price.gte/.lte`、`limit`、`expired=true`。
- 已到期的合约要带 `expired=true` 才查得到（样本 `contracts-spy-expired.json`）。
- 补记（2026-11-17，iv 回填修复时实测）：不带 `as_of` 的列表含某天之后才挂牌的合约。QQQ 2025-12-01、到期 12-22 到 01-15 的 put，不带 `as_of` 时最前面是 12-22（周一）到期，它 12-08 才有第一根日线；带 `as_of=2025-12-01` 只列 12-26、12-31、01-02、01-09 四个当天挂牌的到期日，这时 `expired=true` 回空，`expired` 按 `as_of` 那天算。

### 期权链快照 `/v3/snapshot/options/<标的>`

单合约用 `/v3/snapshot/options/<标的>/<合约代码>`，`results` 是一个对象，不是数组（样本 `chain-single-contract.json`）。

| 字段 | 类型 | 单位、含义 | 用在哪 | 会缺吗 |
|---|---|---|---|---|
| `details.ticker` | 字符串 | 合约代码 | 全部 | 不缺 |
| `details.contract_type` / `strike_price` / `expiration_date` / `exercise_style` / `shares_per_contract` | | 同合约列表 | 全部 | 不缺 |
| `last_quote.bid` / `ask` / `midpoint` | 数字 | 每股美元；`midpoint` = (bid+ask)/2 | 权利金达标、策略计算、Roll 净收、流动性 | 不缺；没有报价时是 0 |
| `last_quote.bid_size` / `ask_size` | 整数 | 张 | 流动性 | 不缺 |
| `last_quote.last_updated` | 整数 | 纳秒时间戳 | 判断报价新不新 | 不缺 |
| `last_quote.timeframe` | 字符串 | 样本全是 `REAL-TIME` | 标注延迟 | 不缺 |
| `last_trade.price` / `size` / `sip_timestamp` / `conditions` | | 每股美元、张、纳秒 | 异常成交 | 当天没成交时是空对象 `{}` |
| `day.open/high/low/close/vwap/volume/change/change_percent/previous_close/last_updated` | | 当天（或上一交易日）的合约日线；`change_percent` 是百分数（-31.1 表示 -31.1%） | 异常成交、成交量 | 没成交时 `day` 是空对象；有成交但没有前收时缺 `change`、`previous_close` |
| `open_interest` | 整数 | 张 | OI 墙、最大痛点、流动性 | 不缺；可能是 0 |
| `implied_volatility` | 数字 | 小数（0.216 表示 21.6%） | IV 快照、波动率专家 | 二元期权缺；深度价内、极度价外的近月合约缺 |
| `greeks.delta` / `gamma` / `theta` / `vega` | 数字 | 每股；theta 是每天的美元；vega 是 IV 变 1 个百分点的美元（按样本数值推断，供应方没写文档）。没有 rho | 策略计算、GEX、指派概率参考 | 同 IV：二元期权整个字段不在；深度价内或极度价外时 `greeks` 是空对象 `{}` |
| `break_even_price` | 数字 | 美元；put = 行权价 − 中间价，call = 行权价 + 中间价（按样本验算） | 盈亏平衡 | 只有二元期权缺；没有 IV 和希腊值的合约照样有 |
| `underlying_asset.price` | 数字 | 正股价，`timeframe` 是 `DELAYED` | 离行权价多远 | 不缺 |
| `underlying_asset.change_to_break_even` | 数字 | 正股价到盈亏平衡的距离（美元） | | 只有二元期权缺 |
| `underlying_asset.last_updated` | 整数 | 纳秒 | 判断正股价新不新 | 不缺 |

缺字段实测（各取一页 250 行）：

| 页 | 行数 | 二元期权 | 有 IV | 缺 IV 的标准期权 | bid 为 0 | OI 为 0 |
|---|---|---|---|---|---|---|
| SPY 11-20 第一页 | 250 | 32 | 218 | 0 | 80 | 46 |
| NVDA 不限到期第一页 | 250 | 34 | 176 | 40 | 20 | 54 |

- 过滤参数实测可用：`expiration_date`、`contract_type`、`strike_price.gte/.lte`、`limit`（最大 250）。`as=<日期>` 不报错，但应答和当下一样，**不是历史快照**（`chain_spy_asof` 对比，IV 只差 1e-6，是两次调用之间正股价动了）。
- 默认按 `ticker` 排序：先二元期权 `O:B1...`，再全部 call，再全部 put。不带 `expiration_date` 时几个到期日混在一页里。

### 二元期权

合约列表和快照里都有一批 `O:B1<根>YYMMDDC/P...` 的合约：`type: "binary"`、`exercise_style: "european"`、`primary_exchange: XASE`，没有 greeks、IV、break_even，报价常是 0。代码的根会被截断，比如 NVDA 的是 `O:B1VDA...`，所以不能靠「代码以 `O:<标的>` 开头」之外的规则去猜。

建议的过滤：快照里只留 `details.ticker` 以 `O:<标的>` 开头、且 `exercise_style` 是 `american` 的行。将来做指数期权（SPX 是 european）时这条要改。T 的 `python/get_chain.py` 没滤这些行。

### 合约日线 `/v2/aggs/ticker/O:.../prev` 和 `/range/1/day/...`

| 字段 | 类型 | 说明 |
|---|---|---|
| `results[].o/h/l/c` | 数字 | 每股美元；按**成交价**算，不是报价中间价 |
| `results[].v` | 数字 | 张 |
| `results[].vw` | 数字 | 成交量加权均价 |
| `results[].n` | 整数 | 成交笔数 |
| `results[].t` | 整数 | 毫秒时间戳。`/range` 的日线是美东当天 0 点对应的 UTC 毫秒；`/prev` 口径不同（期权 prev 是前一交易日美东 16:00，正股 prev 是 04:00），按日期取用，不要按时刻比 |
| `adjusted`、`resultsCount`、`queryCount` | | |

- `prev` 的成交量（26946）和快照 `day.volume`（27340）对同一合约同一天不一样，差 1.5%。猜测是两边对成交条件的取舍不同，没验证。做「异常成交」时选定一个来源，不要混。
- 没成交的日子没有那根 K 线，深度价外的合约日线会断断续续。
- 已到期合约照样取得到，2022-01 到期的合约能取到 2021-12 的日线（样本 `aggs-range-2021-option.json`）。

### 除息 `/v3/reference/dividends`

| 字段 | 类型 | 说明 |
|---|---|---|
| `ex_dividend_date` | `YYYY-MM-DD` | 除息日 |
| `cash_amount` | 数字 | 每股美元 |
| `declaration_date` / `record_date` / `pay_date` | 日期 | |
| `frequency` | 整数 | 一年几次，4 = 季度 |
| `dividend_type` | 字符串 | `CD` = 常规现金股息 |

- 默认按除息日倒序。`ex_dividend_date.gte` 过滤可用。
- **还没宣布的除息查不到**：SPY 下一次（按季度规律应在 12 月）今天查 `ex_dividend_date.gte=2026-11-17` 是空数组（样本 `dividends-spy-future-empty.json`）。

### 其他

- `/v3/quotes/O:...`（逐笔报价历史）这把 key 能读。第一版用不到，留了一份样本作证据。
- 期权的报价和成交标 `REAL-TIME`，正股标 `DELAYED`（stock-ta 记的是 Starter 套餐，延迟 15 分钟）。盘中两者差 15 分钟。

## 分页

- 应答带 `next_url` 时还有下一页。游标里只有查询条件（解码看过），不含 key；取下一页要再带一次 `Authorization` 头。
- SPY 一个周到期日的整条链（二元 + call + put）一页 250 行装不下，要 3 页左右，每页约 230 KB。算最大痛点、GEX 要整条链；只看某个行权价附近，用 `contract_type` + `strike_price.gte/.lte` 一页就够（样本 `chain-spy-puts-filtered.json` 只有 26 行）。
- T 的 `get_chain.py` 一边一次调用、不跟 `next_url`，行多的标的会截断。

## 限流

- 20 个并发请求全部 200。所有应答头里都没有 `X-RateLimit-*`、`Retry-After` 这类头，只有 `x-request-id`、`x-item-count`、`link`（下一页）。
- 没见到 429 的样子。T 的 `python/_http_helper.py` 对 429 退避 4、8、16 秒后放弃。stock-ta 的 `massive.ts` 只按应答体 `status: "ERROR"` 报错。
- **回放夹具的状态码**：只写应答体时宿主 `src/modules/run-code.ts` 的假 `fetch` 回 200。要测「HTTP 状态是 429」，把应答写成 `{ "status": 429, "headers": { "retry-after": "30" }, "body": {...} }`（PR #171，写法见 `docs/modules/module-user-guide.md` 的「回放网络应答」）。应答体是 `{status: "ERROR", error: ...}` 照旧能测。
- 回放按完整 URL 精确匹配。`encodeURIComponent("O:SPY...")` 会写成 `O%3ASPY...`，用例里的 URL 键要和代码拼出来的一字不差。

## 休市时字段还在不在

全部在。细节：

| 字段 | 休市时的值（11-17 美东 04:30 实测） |
|---|---|
| `last_quote` | 还在，停在 11-16 美东 16:14:57，也就是收盘时的报价。T 的代码注释说「休市时 last_quote 不在」，这次实测不对 |
| `last_trade`、`day` | 还在，是 11-16 那个时段的 |
| `underlying_asset.price` | **还在动**：04:15 更新过，736.17，而 SPY 11-16 收盘是 739.95。是盘前成交价 |
| `implied_volatility`、`greeks` | **还在动**：两次调用相隔几十秒，IV 差 1e-6。说明供应方拿冻结的期权报价和移动的正股价、当前时刻重算 |
| `break_even_price` | 不变（只依赖行权价和中间价） |
| `change_to_break_even` | 跟着正股价变 |

后果：休市或盘后取的 IV 是「收盘报价 + 盘前盘后正股价 + 更短的剩余时间」算出来的，不是收盘 IV。

## IV 历史

结论：**没有现成接口，但可以自己回填。**

- 快照不支持按日期取历史（`as=` 无效，见上）。
- 期权日线（包括已到期合约）至少能回溯到 2021-12。T 的做法是选每天的平值合约，用收盘价反解 Black-Scholes 得 IV（`src/backtest/iv.ts` 的 `impliedVolPut`，`src/lib/iv-history.ts` 的 `selectAtmContract`、`ivRank`、`ivPercentile`）。
- **口径不同，不能混**：同一合约 SPY 11-20 730P，用 11-16 收盘价 3.72、正股收盘 739.95、剩 4 天反解，IV ≈ 0.251；快照给的是 0.216。把正股价换成盘前 736.17、剩余时间换成约 3.5 至 3.8 天，就落到 0.21 至 0.22 之间。差别来自正股价和剩余时间两个输入（计算见本次会话，没写进仓库）。
- 建议：`iv` feed 每天存原始输入（收盘时的报价中间价、正股收盘价、到期日、取数时刻），IV 用模块自己的同一个公式算。快照给的 IV 只作对照。这样回填出来的历史和以后每天的快照是同一口径。
- 日线是成交价，不是中间价；平值合约一般每天都有成交，但成交价可能在 bid 和 ask 之间任何位置。T 的设计文档把这个噪声记作已知限制。

## 样本清单

`samples/` 下每个文件是 `{ recorded: {at, request, status, note}, body }`。`body` 是接口原样的应答（行数裁过，裁法写在 `note` 里），P3 写 `cases.json` 时把 `body` 放进 `responses`，URL 键按代码实际拼出来的写。

| 文件 | 接口 | 用来测 |
|---|---|---|
| `contracts-spy-puts.json` | 合约列表，按到期、类型、行权价过滤 | 二元期权过滤、合约字段 |
| `contracts-spy-page1-binary.json` | 合约列表第一页 | 第一页全是二元期权；`next_url` 格式 |
| `contracts-spy-expired.json` | 合约列表 `expired=true` | 已到期合约 |
| `chain-spy-puts-filtered.json` | 链快照，按行权价窄过滤 | 正常行 + 二元行；无 `next_url` |
| `chain-nvda-missing-greeks.json` | 链快照，不限到期 | `greeks: {}`、缺 IV、二元行、带 `next_url` |
| `chain-single-contract.json` | 单合约快照 | `results` 是对象 |
| `aggs-prev-option.json` | 合约 `prev` | 合约日线 |
| `aggs-prev-underlying.json` | 正股 `prev` | 和快照里的正股价对照 |
| `aggs-range-expired-option.json` | 已到期合约日线 | IV 回填 |
| `aggs-range-2021-option.json` | 2022 年到期合约日线 | 回溯深度 |
| `dividends-spy.json` | 除息 | 字段 |
| `dividends-spy-future-empty.json` | 除息，未来日期 | 未宣布查不到 |
| `quotes-option.json` | 逐笔报价 | 只作证据 |

全部是休市时录的。样本是公开行情，不含 key 和个人信息；`probe.sh` 收尾时检查过应答里没有 key。

## theta 移植清单

T = `LearnTypeScript2PiAgent/playground/theta/app`，私有仓库，HEAD `ca23f00acb09c8e65c8de08189fff98be31467c6`。下表的提交是 `git log -1 --format=%H -- <路径>`，也就是该文件最后一次改动的提交。T 没有单元测试，「smoke」列是 T 里用来验这段代码的离线脚本（括号里是脚本最后改动的短 SHA）；P3 先把这些用例写成失败的测试，再搬代码。

### 纯计算：搬（17 项）

| T 路径 | 提交 | 依赖 | IO | smoke | 给 option-ta 的哪部分 | 搬时注意 |
|---|---|---|---|---|---|---|
| `src/lib/options-math.ts` | `94c32859efcd8f8ff1df51e273f306e0a1bd4ef0` | 无 | 无 | `scripts/smoke-assignment-gauge.ts`（807317a）、`smoke-property-invariants.ts`（374f593）、`smoke-strike-scoring.ts`（94c3285） | 所有计算的基础：正态分布、BS 价格、到期被指派概率、年化 | 假设利率 0、无股息；没有单独的 smoke，要补价格和 put-call 平价的用例 |
| `src/lib/first-passage.ts` | `374f593c4d9b7e82160576a9719d76970d28b524` | options-math | 无 | `smoke-first-passage.ts`（374f593） | 触及行权价的概率；接近或穿过行权价提醒的辅助数字 | |
| `src/lib/scenario-pl.ts` | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | 无 | 无 | `smoke-scenario-pl.ts`（087cd80） | 策略计算：到期盈亏 | 只有卖 put、卖 call、牛市 put 价差、熊市 call 价差四种；第一版还要买 put、买 call、借方价差 |
| `src/lib/strategy-economics.ts` | `94c32859efcd8f8ff1df51e273f306e0a1bd4ef0` | options-math | 无 | `smoke-strategy-economics.ts`（94c3285） | 策略计算：占用资金、最大盈亏、盈亏平衡、年化 | 同上，要补买方 |
| `src/lib/cc-yield.ts` | `3db2d93d2abe4ef97c9a999d4753eefbdc7b47ce` | options-math | 无 | `smoke-cc-yield.ts`（404254d） | CC 的收益、被 call 走时的总收益 | |
| `src/lib/liquidity.ts` | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | 无 | 无 | `smoke-liquidity.ts`（404254d） | 策略计算：流动性 | 价差、OI、成交量的分档权重是 T 为卖方调的，写成命名常量并注明出处 |
| `src/lib/limit-price.ts` | `6f43df0b82d3755724208859b5ccfb7f280c611b` | 无 | 无 | `smoke-limit-price.ts`（6f43df0） | 「现在什么价」「Roll 净收多少」的参考成交价（单腿和多腿净价） | option-ta 不下单，输出叫「参考价」，不叫「建议限价」 |
| `src/lib/roll-credit-gate.ts` | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | 无 | 无 | `smoke-roll-credit-gate.ts`（404254d） | 策略计算、仓位研判：Roll 是净收还是净付 | 「净收不到平仓成本 10% 就警告」是 T 的使用者 2026-06-17 定的，option-ta 要重新问 |
| `src/lib/iv-crush.ts` | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | options-math | 无 | `smoke-iv-crush.ts`（404254d） | 波动率与事件：财报后 IV 压缩对价格的影响 | |
| `src/lib/net-gamma-walls.ts` | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | 无 | 无 | `smoke-net-gamma-walls.ts`（404254d） | 方向与价位：put 墙、call 墙、GEX 正负 | 要整条链（多页），见「分页」 |
| `src/lib/oi-term-structure.ts` | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | 无 | 无 | `smoke-oi-term-structure.ts`（404254d） | 方向与价位：各到期 P/C 比、最大痛点、跨到期 OI 墙 | 同上 |
| `src/lib/pin-risk-check.ts` | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | 无 | 无 | `smoke-pin-risk-check.ts`（404254d） | 到期临近提醒 | T 的门槛是「剩 2 天内、离行权价 1.5% 内、OI 高」；option-ta spec 定的是「到期日开盘离行权价不到 3%」，常量换成 spec 的 |
| `src/lib/contract-deliverable.ts` | `a1e637b7db3d9bc0beb48cac7d2da62a27bdc4c9` | 无 | 无 | `smoke-contract-deliverable.ts`（a1e637b） | 记被指派的股票时算股数：拆股、并股后一张合约不再是 100 股 | 这次没录到调整过的合约，Massive 怎么标交割物没验证 |
| `src/lib/iv-history.ts`（只搬 `selectAtmContract`、`ivRank`、`ivPercentile`） | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | `backtest/iv.ts`、`backtest/entry.ts`、`backtest/types.ts` | 无 | `smoke-iv-history.ts`（404254d） | 波动率：IV rank、IV 百分位 | `buildIvSeries` 吃 T 的回测数据形状，改成吃 option-ta 自己的 IV 快照；smoke 里调 T 工具的部分不搬 |
| `src/backtest/iv.ts` | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | options-math | 无 | `smoke-backtest.ts`（404254d）第 167 至 175 行附近 | 由价格反解 IV，用于回填和每日 IV 快照 | 只有 put 版，要补 call 版 |
| `src/backtest/vol-regime.ts`（只搬 `hv20`、`classifyIvHvRatio`） | `404254dee0078bfe8a35d7efdbf3c949bde9bfe7` | `backtest/iv.ts`、`entry.ts`、`types.ts` | 无 | `smoke-dynamic-take-backtest.ts`（404254d） | 波动率：HV20、IV/HV 比的分档 | 分档 0.85、1.0、1.15、1.4 是 T 的口径，写成命名常量 |
| `src/tools/check-assignment-risk.ts`（只搬 `extrinsicGauge`、`exDivCallVerdict`、`putCarryCostVerdict`、`assignmentTouchProb`） | `807317a4624856c625fb1b35647b4b390175fe2a` | first-passage、options-math | 这 4 个函数无 IO；同文件其他部分调 Python sidecar 和 T 的持仓 | `smoke-assignment-gauge.ts`（807317a） | 除息提醒（价内卖出 call、除息前）、提前指派风险 | 只挖这 4 个函数，文件其余部分不搬 |

### 纯计算：不搬

| T 路径 | 理由 |
|---|---|
| `src/lib/strike-scoring.ts` | 打分目标（最大 ROC、限指派概率下最大收益等）全是卖方收租口径；option-ta 的意图有买方。方案比较用 strategy-economics 就够。要「按 delta 找行权价」时只抄 `closest_to_target_delta` 那一段 |
| `src/lib/premium-quality.ts` | 「这份权利金够不够肥、该不该卖」的硬闸加打分，属于开仓机会筛选；基于 IV 的机会提醒在第二版。里面还有集中度检查，属于仓位管理，第一版不管 |
| `src/lib/premium-targets.ts` | IV/HV 升到某档时的目标权利金，同样是机会筛选，第二版 |
| `src/lib/dynamic-take.ts` | T 自己回测发现动态止盈输给固定 50%，已退回固定值；option-ta 用 spec 定的五成、八成 |
| `src/lib/oi-clip-guard.ts` | 按 OI 和成交量限能开几张，是仓位规模，第一版不管 |
| `src/lib/gamma-phase.ts` | 按入场期限的一半判 gamma 加速区，对仓位研判有用但不是第一版提醒的门槛，第二版再看 |
| `src/lib/roll-trend-gate.ts` | 要正股趋势结论做输入，那是专家调 stock-ta 后的判断，不适合写成 option-ta 的确定性代码 |
| `src/lib/roll-chain.ts`、`roll-chain-ledger.ts`、`closed-trade-analysis.ts`、`win-rate.ts`、`pnl-report.ts`、`pnl-reconcile.ts`、`roc.ts` | 都吃 T 的持仓形状（`src/positions.ts`）；option-ta 的交易链带意图、三种 Roll、按金额评判，模型不同。只借数据形状，不搬代码 |
| `src/lib/cc-tax-status.ts`、`lot-tax.ts` | 要股票批次和持有期；第一版不记股票批次，这类判断标「待确认」（tax memo 第 14.3 节） |
| `src/lib/dividends.ts` | 经 Python sidecar 取数；option-ta 直接调 Massive 除息接口 |
| `src/lib/chain-errors.ts` | 解析 Python sidecar 的报错，option-ta 没有 sidecar |
| `src/lib/market-session.ts`、`cm-trading-clock.ts` | 依赖 T 的 cron 交易日历；模块代码不能 import 别的模块，按 stock-ta `market-days.ts` 的做法自带一份 |
| `src/lib/price-channel.ts` | 价位通道属于正股技术面，归 stock-ta |
| `src/lib/event-calendar.ts`、`event-coverage.ts`、`event-exit-overlay.ts`、`fda-events.ts` | 财报日走 stock-ta 的 `earnings-date` 或 Finnhub；非财报事件第一版不管 |
| `src/lib/portfolio-*`、`book-*`、`beta-*`、`theta-yield.ts`、`pacing.ts` | 组合层和账户层，第一版不做仓位管理 |
| 其余（`agent-role`、`signals`、`state-*`、`recon-*`、`statement-*`、`skill-lint` 等） | T 自己的运维、对账和代理框架，和期权分析无关 |

### 技能：作规则参考（10 个）

技能只作参考，不照搬。门槛进 option-ta 时要么来自使用者（拷问记录），要么写成命名常量并注明「出自 theta，使用者未确认」。下面的门槛是我的转述。

| T 路径（`.pi/skills/` 下） | 提交 | 给谁 | 带的门槛（转述） |
|---|---|---|---|
| `theta-btc-decision/SKILL.md` | `6d10fb838fd6b26bacb1da2850214356e31f3ff9` | 仓位研判 | 赚到八成就买回；赚到五成且剩 7 天以上也买回。和 spec 的五成、八成提醒一致 |
| `theta-roll-decision/SKILL.md` | `6d10fb838fd6b26bacb1da2850214356e31f3ff9` | 仓位研判、策略计算 | 被指派概率 30%、50%、80% 三档；剩 2 天内贴近行权价按 pin 风险处理；Roll 净付就不 Roll、认亏；Roll 次数过多要提示 |
| `theta-assignment-cc/SKILL.md` | `6d10fb838fd6b26bacb1da2850214356e31f3ff9` | 仓位研判 | 被指派后卖 CC，行权价不低于接股成本 |
| `theta-earnings-cross/SKILL.md` | `6d10fb838fd6b26bacb1da2850214356e31f3ff9` | 波动率与事件 | 跨财报时，缓冲距离对比历史财报跳空的 75 和 90 分位；财报后 IV 一般压缩三到五成。里面「单笔不超过账户 2%」属于仓位管理，不用 |
| `theta-bull-put-eval/SKILL.md` | `6d10fb838fd6b26bacb1da2850214356e31f3ff9` | 策略计算 | 净收 ÷ 价差宽度：三分之一以上优，两成到三分之一可，两成以下警告；净收不为正就不做；五成止盈 |
| `theta-pre-sto/SKILL.md` | `2fbf8cb432e523ff0c5c9c80c5905d18d6c2eee4` | 会诊（开新仓） | 开 CSP 前的快速检查顺序；机械闸来自 premium-quality（第二版），第一版只借检查顺序 |
| `theta-strike-limit-plan/SKILL.md` | `6d10fb838fd6b26bacb1da2850214356e31f3ff9` | 策略计算 | 把行权价阶梯摆出来，先问使用者愿不愿意被指派，再给 1 至 3 个候选和参考价。张数部分不用 |
| `theta-oi-analysis/SKILL.md` | `6d10fb838fd6b26bacb1da2850214356e31f3ff9` | 方向与价位 | OI 期限结构、OI 墙、最大痛点怎么读；没有数字门槛 |
| `theta-rolling-pnl/SKILL.md` | `688d23a4e3dffa25bca67a018ea32e0486c7b010` | 账本与税务 | 已实现盈亏和未平仓浮动盈亏分开列；按交易链汇总。它以胜率为主口径，和 option-ta「看金额」相反，这一点不用 |
| `theta-gap-shock-check/SKILL.md` | `6d10fb838fd6b26bacb1da2850214356e31f3ff9` | 仓位研判 | 正股大幅跳空后，按历史跳空分位重看仓位。第一版没有对应提醒，只在使用者问时参考 |

### 技能：不用（8 个）

| T 技能 | 理由 |
|---|---|
| `theta-premium-richness` | 机会筛选，第二版 |
| `theta-new-watchlist-eval` | 按 Wheel 适合度选标的，option-ta 不是 Wheel；期权自选的初始名单由使用者定 |
| `theta-find-opportunities` | 主动扫机会，第一版没有 |
| `theta-event-catalyst` | 非财报事件（FDA、IPO 等），第一版不管 |
| `theta-weekly-review` | 组合体检，第一版不做仓位管理 |
| `theta-defense-terrain` | 依赖 T 的组合工具 |
| `theta-self-audit` | T 内部的代码自查 |
| `theta-pb-email` | 涉及私人数据；不在 T 的版本库里，没读 |

### digest：和第一版相关的

`T/docs/research/digests/` 共 38 篇（`git log -1 -- docs/research/digests` 是 `376b42406e025e9a2ee788d75d22e2e907352fc0`）。进 option-ta 的知识时只留一两句意译和原始出处链接，不复制 digest 正文。下表的「主题」是我对标题的意译，「出处」是 digest 里引用的公开来源（各取几条）。

| digest 文件 | 主题 | 给谁 | 出处（公开链接） |
|---|---|---|---|
| `2026-06-10-roll-timing.md` | 短期卖方什么时候 Roll | 仓位研判 | tastylive rolling-options、defending-positions；CBOE PutWrite 指数方法 |
| `2026-06-12-assignment-management.md` | 指派管理，剩余时间价值是首要指标 | 仓位研判 | tastylive assignment；FINRA 指派说明；OCC 产品规格 |
| `2026-06-12-profit-taking.md` | 止盈规则，固定五成之外 | 仓位研判 | tastylive managing-winners；ORATS 回测博客 |
| `2026-06-13-cc-strike-selection.md` | CC 行权价选择 | 策略计算 | CBOE BuyWrite 指数方法；tastylive 节目 |
| `2026-06-13-iv-timing.md` | IV 择时、IV rank | 波动率 | tastylive IVR 节目；ORATS HV 预测 |
| `2026-06-13-vertical-spreads.md` | 垂直价差定价和输家管理 | 策略计算 | tastylive managing-short-vertical-spreads、one-third-the-width |
| `2026-06-15-roll-chain-management.md` | Roll 链的净收纪律和退出 | 仓位研判 | tastylive cash-secured-put、rolling-options |
| `2026-06-20-early-assignment-pin-risk.md` | 提前指派和 pin 风险 | 仓位研判、到期提醒 | tastytrade 支持文档；SSRN 458020、519044 |
| `2026-06-20-gex-regime-premium-selling-timing.md` | GEX 和做市商仓位 | 方向与价位 | SpotGamma GEX 说明；SSRN 4138512 |
| `2026-06-20-oi-analysis-put-call-spreads.md` | OI 分析接到价差结构 | 方向与价位 | SpotGamma put wall；OCC 未平仓量报告；CME 教程 |
| `2026-06-20-volatility-skew-strike-selection.md` | 偏斜和行权价选择 | 波动率 | tastylive volatility-skew；SSRN 2322945 |
| `2026-06-22-rolling-short-put-vs-btc-stoploss.md` | 持续下跌时继续 Roll 还是认亏 | 仓位研判 | SSRN 2444999、3393940；ORATS |
| `2026-07-03-value-of-stop-losses.md` | 止损对期权卖方值不值 | 仓位研判 | SSRN 968338（Kaminski 和 Lo）；tastylive 小亏损文章 |
| `2026-07-12-dte-selection-tradeoff.md` | 短期限和月度期限的取舍 | 策略计算 | tastylive alternative-to-managing-losers；CBOE PutWrite 研究 |
| `2026-08-02-covered-call-tax-mechanics.md` | CC 的税务机制 | 账本与税务（对照 tax memo） | CBOE 税务文章；CBOE 税务手册 PDF |
| `2026-08-16-corporate-action-contract-adjustments.md` | 公司行动和合约调整 | 记成交（股数） | OCC infomemo；CBOE 公司行动政策 |
| `2026-08-23-execution-quality-liquidity.md` | 价差、限价摆位、组合单 | 策略计算 | CBOE Penny Interval Program；SSRN 2580548 |
| `2026-09-19-realized-vol-estimators-iv-hv-horizon.md` | HV 估计方法和 IV/HV 口径 | 波动率 | CBOE VIX、RVOL 方法；ORATS 博客 |
| `2026-09-26-expected-move-calibration-event-variance.md` | 预期波幅的口径 | 波动率与事件 | ORATS 财报 IV 博客 |
| `2026-10-03-nontrading-time-clock-weekend-variance.md` | 周末和隔夜的时间口径 | 波动率、策略计算 | CBOE VIX 插值白皮书；SpotGamma 周末 theta |

第二版再看：`2026-07-26-calendar-diagonal-pmcc.md`（跨期价差）、`2026-09-06-iron-condor-mechanics-management.md`（铁鹰，第一版不做）、`2026-10-10-single-stock-option-return-cross-section.md`（权利金贵不贵，机会筛选）。

不进 option-ta：`2026-07-03-event-exit-management.md`（没有公开出处）、`2026-07-01-wheel-book-postmortem-failure-attribution.md` 和 `2026-07-05-case-attribution-lesson-methodology.md`（涉及私人数据）、组合层的 6 篇（portfolio、pacing、whole-book ROC、dynamic ROC、beta、下跌相关性；最后一篇在 T 里还没提交）、和期权无关的 5 篇（harness、loop engineering、DoubleAgents、Jane Street 两篇）、`hypothesis-2026-07-05-community-mechanisms.md`（社区帖子汇总，不是权威出处）。信任源白名单在 `T/docs/research/scout-sources.md`，P2 写知识时可以对照。

这次没有打开 digest 正文，只读了标题和链接。P2 或 P3 引用某篇时要逐篇查版权。

### 私人数据

T 里的 `positions.json`、`accounts/`、`state/`、`book-roc/`、`reports/`、`briefs/`、`advisories/`、成交邮件样例，这次一样都没读，本目录也没有引用其内容。T 的 smoke 用例是合成数据；P3 搬用例时仍要逐条看一遍，确认没有真实持仓的数字。

## 对计划和 spec 的影响

1. **IV 历史不必从零攒。**spec 和 build plan 说「每天存 IV 快照，从零攒 IV rank」。实测可以用期权日线回填至少几年。使用者已定回填一年（见 spec「IV 历史」）；回填和每日快照必须同一口径。基于 IV 的机会提醒仍留第二版（使用者 2026-11-17 确认）。
2. **`iv` feed 的取数时刻和口径。**收盘后快照里的 IV 会跟着盘后正股价变。feed 应存报价中间价、正股收盘价和到期日，自己算 IV，不直接存供应方的 `implied_volatility`。
3. **「到期日开盘时正股离行权价不到 3%」**用的正股价延迟 15 分钟（`underlying_asset.timeframe: DELAYED`）。09:30 那一刻读到的还是盘前价。实际上要在 09:45 以后检查才算「开盘价」，或者把门槛写成「开盘后第一次检查」。
4. **除息提醒只能用已宣布的除息。**「记下仓位时到期前有除息就提醒」遇到还没宣布的除息会漏。可选做法：按 `frequency` 和上一次除息日推一个「预计除息日」，标「未宣布」。这需要使用者拍板。
5. **期权链工具必须滤二元期权**，并且只取需要的行权价范围。整条链要翻页，`chain` 工具给专家的输出要压紧（spec 已要求专家只读工具算好的紧凑结果）。
6. **缺 IV 和希腊值是常态**：近月深度价内、极度价外的合约经常没有。工具对这些行要么自己用 BS 算并标明「自算」，要么标「无数据」，不能当 0。
7. **P3 的完成标准「`cases.json` 覆盖 429」**：宿主的夹具已能回 HTTP 状态（PR #171），用例把应答写成 `{ "status": 429, "headers": {...}, "body": {...} }` 即可，按字面要求做。
8. **spec 的「除息日：Massive `/v3/reference/dividends`（P1 实测）」**已实测，字段够用，限制见第 4 条。
9. **期权日线和快照的成交量不一致**（差约 1.5%）。「期权异常成交」只用一个来源。

## 遗留问题

- 盘中样本没录：这次全在休市。盘中要补一份链快照（看 `last_quote` 是否实时、`underlying_asset` 延迟多少）和一份收盘后 16:15 至 16:30 的快照（定 `iv` feed 的取数时刻）。
- 没见到 429 的真实应答体和响应头。
- 没录到调整过交割物的合约（拆股、并股后），不知道 Massive 在 `shares_per_contract` 或 `additional_underlyings` 里怎么标。
- `greeks.theta` 是按日历日还是交易日、`vega` 的单位，都是按样本数值推断，供应方没有文档佐证。
- 快照 IV 的具体模型（利率、股息、时间口径）不知道，本次只确认它和收盘价反解的口径不同。
