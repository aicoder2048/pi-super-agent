# P1 行情契约与 IV 限制

## 材料记录，不是本轮联网

依据用户自写 option-ta-p1/README.md 及 option-ta-spec.md「行情取数规则」「IV 历史」。P1 记录时间：2026-11-17 美东 04:29–04:40，SPY/NVDA，54 次调用，全部盘前/休市；所述 key 能读、返回字段、分页和延迟均是当时材料记录，不代表本轮调用或当前可用性。本轮未联网、未读密钥、未移植 theta、未分发供应方原始应答。P2 工具/feed 最简显式未实现；以下为未来接入要求，不能回答成已取数。

## 目标接口与基本形状

| 接口 | 目标用途及材料契约 |
|---|---|
| /v3/reference/options/contracts | 合约列表；underlying_ticker、expiration_date、contract_type、strike_price.gte/.lte、limit；查已到期须 expired=true |
| /v3/snapshot/options/<标的> | 链快照；到期、类型、行权价范围过滤，limit 最大 250 |
| /v3/snapshot/options/<标的>/<合约代码> | 单合约快照，results 是对象，不是数组 |
| /v2/aggs/ticker/O:.../prev 或 /range/1/day/... | 期权成交日线，不是报价中间价；已到期合约日线在 P1 至少取到 2021-12 |
| /v3/reference/dividends | 已宣布除息；未宣布未来记录可能为空 |

P1 发现链的 as=<日期> 虽不报错却仍返回当下数据，不是历史快照接口。不要用它补造历史 IV。

## 合约身份、乘数和二元过滤

合约含 ticker、underlying_ticker、contract_type、exercise_style、expiration_date、strike_price、shares_per_contract。样本乘数都是 100，但不等于所有合约永久 100；调整交割物样本未录，Massive 的 shares_per_contract/additional_underlyings 对应关系未证实，不能猜交割股数或自动记调整合约。

列表/快照混有 O:B1... 二元期权，type 可能为 binary、exercise_style 为 european，没有 IV/Greeks，代码排序靠前。用户已定规则：仅留 details.ticker 以 O:<标的> 开头且 exercise_style=american 的标准合约。不能把被过滤二元合约的缺值混进标准链统计。

## 指数期权尚不受上述过滤支持

SPX 是 european，american 过滤也会排掉它。不能一面沿用过滤、一面宣称支持 SPX 实时链或 §1256 年末行情。税务保留 §1256/60:40 和年末快照目标，行情类别与过滤另待实现；不得擅自取消二元过滤假装指数支持已完成。

## 分页与输出完整性

看某行权价附近时带 contract_type、expiration_date、strike_price.gte/.lte；整链 OI 墙、GEX、最大痛点须跟完 next_url，下一页仍带 Authorization 头，密钥不进 URL。P1 记 SPY 一个周到期日约三页，不可外推为固定页数。给专家紧凑计算结果并标完整性，不能截一页当全链，也不能交整条庞大原始链让模型代算。

## 报价与时间单位

last_quote 的 bid/ask/midpoint 是每股美元，bid_size/ask_size 为张，last_updated 纳秒；last_trade 的 price 为每股美元、size 为张、sip_timestamp 纳秒。IV 是小数，0.216 表示 21.6%；OI 为张。合约日线 results 的 o/h/l/c 为成交价，v 为张，t 为毫秒。快照 day.change_percent 是百分数，不是 IV 小数口径。

/range 日线的 t 是美东当天零点对应 UTC；P1 中 /prev 期权和正股时刻口径不同，应按日期取用，不按时刻直接比。Greeks 的 theta 按日历日还是交易日、vega 每百分点等单位只是 P1 数值推断、未获供应方文档佐证；不能把推断升格成已证实单位。快照 IV 的利率、股息、时钟/模型未知。

## 零值、空对象与缺失值

bid=0、OI=0、last_trade={}、day={} 可以是真实状态，不一律报接口故障；没有当日成交不等于市场价格为零。标准合约近月深度价内/极度价外可能缺 implied_volatility、greeks={}；缺 IV/Greeks 不是 0。未来有确定性 BS 实现且报价有效才允许按中间价反解并标「自算」，与供应方值分列；P2 未实现自算，只能说无数据/未实现。bid、ask 都为 0 或反解不收敛也不产数。

## 休市、延迟与双时刻

P1 记 last_quote 停在前一日收盘，而 underlying_asset.price 在盘前继续变，供应方 IV/Greeks 也继续变。因此盘前/盘后快照 IV 不是正式收盘 IV；输出需标「休市」、取数时间和行情数据时间。材料中期权 last_quote.timeframe 为 REAL-TIME，正股 underlying_asset.timeframe 为 DELAYED、约延迟 15 分钟，不能把二者当同刻输入。提醒的 09:45 修订见 alert-thresholds；具体跨时刻容忍仍待验证。

每个未来行情结果须带来源、取数时刻、数据时刻和延迟/休市状态。没有元数据不能靠常识编日期或实时性。

## 异常成交量只选日线来源

今天与历史均量均用合约日线 v，不混快照 day.volume。P1 同合约同一天二者约差 1.5%，原因是材料的猜测、未验证；不能当固定修正系数。没成交的日期可以没有日线，缺 bar 不填 0。

## IV 序列用同一组原始输入

2026-11-17 使用者已定：期权自选新增标的时回填一年，以后每交易日收盘后存原始输入。保存标的、交易日、选约代码、行权价、到期、合约日线收盘、正股日线收盘、日常报价中间价和取数时刻。序列一律由同一选约、同一剩余时间算法、同一 BS 公式反解合约日线收盘价；供应方 IV 和中间价反解仅作对照，不进历史序列。回填和日常不能混口径。

所选合约当日没日线，记无数据，不用中间价、其他价或 0 补；成交价处于 bid/ask 的不同位置带来噪声是已知限制。以后更改选约、价格字段、时间算法或公式，整段重算，不能拼接新旧序列。历史不足/不完整、算法未实现时 IV rank/百分位无数据，不伪造一年样本。

## IV 的未决常量与落盘时刻

P1 对 theta 的说明只记录 r=0、无股息等假设；本轮不读取或搬其代码。ATM 到期期限、平值/并列选择、剩余时间单位和日历的精确常量未定，不能借此宣称计算已完成。收盘后日线定稿时刻待 P3 补录 16:15–16:30 样本确认。过程说明书的正式收盘后 30 分钟（纽约时区、考虑半日市）只是开发假设，不是 P1 已测结论。

## 除息接口的边界

字段是 ex_dividend_date、cash_amount、declaration_date、record_date、pay_date、frequency、dividend_type；默认除息日倒序，ex_dividend_date.gte 过滤在 P1 可用。未来记录为空不代表公司以后不分红，只代表未查询到已宣布事件。预计除息算法、CD 限制及静音规则见 alert-thresholds，不能把预计说成已宣布。

## 限流与回放结论的修订

P1 的 20 次并发均 200，未录到真实 429，也没限流响应头，不能据此证明无限额或无故障。P1 开头「宿主夹具只能回 200」是旧摘要；同文后面的修订说明 PR #171 支持带 status/headers/body 的回放封装，应优先保留后者，但本轮未核验当前宿主运行态。HTTP 429/5xx 测试如用合成应答必须标合成，不伪装真实取证；错误回放与真实网络支持另行验收。

## stock-ta 依赖不能补造期权历史

过程说明书补充的磁盘契约记录：quote/prices 参数为复数 symbols，earnings-date 为单数 symbol；prices 是缓存最新价，不是历史日线，不能拿它补 HV 历史。方向可用 structure/signals/quote/prices，财报可用 earnings-date；note 未开放。外部调用只传必要标的/合法短筛选，不传账户、持仓、邮件、成本或用户原话。提供方缺席、未开放或没有已公布财报日期，要说明缺项，其余继续；需 stock-ta 自选或笔记原文时转述「请对 stock-ta 说……」，不擅自写其名单。上述不是本轮调用成功证明。
