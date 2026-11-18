# option-ta · 期权分析

期权研究组：领队加方向与价位、波动率与事件、策略计算、仓位研判、账本与税务和仅会诊上场的反方。路由、权限和原始事实模型已搭好。`strategy` 已能按给定的腿算数（P3-a）。成交这条路已经做完（P3-c）：`fills` feed 解析交易台的成交回信，`record` 校验手动成交，`ledger` 出交易链和税务两种视图。行情已接 Massive（P3-b）：`chain` 回期权链快照，`vol` 回平值 IV、IV/HV、期限结构、偏斜和 IV rank、百分位。盯盘也做完了（P3-d）：`iv` feed 存 IV 原始输入并回填一年，`watch` feed 按第一版门槛给记下的仓位发提醒。纯计算从 theta 移植，每个文件头写着出处；没有搬 sidecar，也没有读 theta 的私人资料。

## 文件与权限

- `module.json`：中文标题、路由说明和团队；有私密集合，所以 `exports: []`。
- `skills/option-lead/SKILL.md`：分档、共同快照、一次会诊、输出五段和领队独占写入。
- `agents/{direction,volatility,strategy,position,ledger,critic}.md`：六位只读专家，最小 `uses`；只有需要者接触私密集合。领队不另建专家文件。
- 包根目录的 `massive.ts`（Massive 请求、分页、错误）和 `chain-rows.ts`（解析快照行、补算 IV 和希腊值）联网取行情，给 chain、vol 和 iv、watch 两个 feed 用。其余 `*.ts` 是纯计算：从 theta 移植（BS 价格和反解 IV、首达概率、到期盈亏、方案经济、CC 收益、流动性、参考价、Roll 净收门槛、IV 压缩、GEX 墙、OI 期限结构、到期临近、交割物、IV rank 和 HV20）。不联网、不读写数据。门槛是命名常量，说明书没定的沿用 theta 的值；Roll 净收不到平仓成本一成算「为几分钱 Roll」，使用者 2026-11-17 确认。
- `tools/{chain,vol,strategy,record,ledger}/`：每个包含 `tool.json`、`index.ts`、`cases.json`。`strategy` 只算不取数：给定腿，回权利金、参考价、盈亏平衡、到期盈亏、年化、指派概率、流动性和三种 Roll 的净收付。`chain`、`vol` 向 Massive 取数（行情辅助在包根目录的 `massive.ts`、`chain-rows.ts`），滤掉二元期权、跟分页，缺 IV 或希腊值用中间价自算并标「自算」，算不出标「无数据」，休市标「休市」；`chain` 的 `operation` 是 `oi`、`gex`、`max-pain`、`unusual-volume` 时回期权链结构（包根目录的 `chain-structure.ts`，复用 theta 的 `net-gamma-walls.ts`、`oi-term-structure.ts`），每个结果带 `note` 说明局限。`vol` 只读 `iv-snapshots` 和 `vix-closes`，没有行时 history 回 `NO_HISTORY`、vix 回 `NO_DATA`。`record`、`ledger`、`vol` 只读 `$PSA_MODULE_DATA/data.db`，没设这个变量就当库是空的，不写库。`record` 只认 `accounts` 和已记 `fills` 里有的账户短码，没见过的回 `needs-input` 并列出已知短码，防止手动记账和邮件因短码写法不同把同一笔记两遍；两处都空（第一次用）照常记，提示这是第一个短码。它们的用例共用 `tools/ledger/fixtures/data/data.db`，这份库由 `tools/ledger/fixtures/seed.json` 经 `tests/helpers/option-ta-ledger-db.ts` 生成，全是虚构数据。
- `fills.ts`：feed 和 `record` 共用的订单键、`fill_id`、OCC 代码和累计增量（整数万分之一美元）。`symbols.ts`：标的代码的唯一规则（工具、两个 feed、成交共用），OCC 期权根去掉类别点（BRK.B 是 BRKB）。`data-db.ts`：工具只读打开 data.db。
- `data/{fills,chains,accounts,brokers}/collection.json`：四个 `private` 集合；`data/{watchlist,iv-snapshots,vix-closes}/collection.json`：三个 `shareable` 集合。全部初始为空。
- `feeds/fills/`：接宿主 `mail` 连接器，只收私密名单 `brokers` 上的发件人，写进私密集合 `fills`。`parse.ts` 是纯函数，`index.ts` 把结果交给宿主；样例是 P1 的四封虚构信和一份没有信的。
- `feeds/iv/`：收盘 30 分钟后给期权自选每个标的存一行 IV 原始输入，新标的先回填一年，每拍最多 `requestsPerTick` 次请求；`feeds/watch/`：交易时段按门槛检查 `fills` 里的未平仓期权，仓位用 `ledger` 的先进先出算法汇总，提醒直接发（`alerts`），每条 id 固定、宿主只发一次。两者和 `chain`、`vol` 的盘中判断共用包根目录的 `market-days.ts`（宿主时段和 stock-ta 假日表的副本，`tests/unit/market-hours.test.ts` 保持三者一致。假日和提前收盘日只填到 2028 年底，同一个测试在 2028-10-02 以后失败，提醒补下一年）、`feed-fetch.ts`（Finnhub 请求和时间戳）、`dividends.ts`（预计除息日）。
- `feeds/vix/`：收盘后从 CBOE 公开历史文件取 VIX、VIX9D、VIX3M 的日收盘存进 `vix-closes`，第一次回填一年；`vix.ts` 解析文件、分档、比期限结构，`vol` 读它回市场环境。
- `rules.md`：状态通知的处理边界，不授权写集合或交易。
- `knowledge/` 和 `evals/` 由独立成员维护；检查与预演以最终包为准。

专家不写文件，也不写集合。工具不写库。领队写原始事实，派生盈亏/税务视图不能反写事实。`fills` 复用记录类型 FILL、EVENT、MARKET_SNAPSHOT、REVERSAL；EVENT 行的 `trade_date` 写成 `event_date`，因为宿主按 `trade_date` 给 feed 最新 500 行，没写的事件排在最后，fills 多了以后 watch 看不到到期和指派（`ledger` 在 notes 里提醒没写的行）；保留指派/行权产生的股票和仍持有的 §1256/价差腿年末期权收盘观察；不增加股票或报税集合。价格、佣金、费用用十进制文本保精度；`partial_fill`、意图确认用文字，因为集合字段无 boolean。`instrument` 是合约 JSON 文本，兼有明确的合约事实字段；未来校验器须保证一致。未知费用留空，不当零。账户登记名、匿名键和经使用者确认的来源别名仅存私密 accounts；真实映射、账号不得放进包、fixtures 或对外参数。税务归属和账户类型未知留空。

## 账户别名（本轮）

`accounts.aliases` 是私密 text 字段，保存 JSON 列表。以下仅为虚构格式样例，不得据此登记真实账户：

```json
[
  {"kind":"email","code":"DEMO-A"},
  {"kind":"jpm-export","account_name":"Demo Portfolio","account_type":"Individual","account_number":"000042"},
  {"kind":"etrade-export","account_label":"Demo Label A"}
]
```

`account-aliases.ts` 精确匹配登记名或 email/code；JPM 必须完整匹配 account_name、account_type、account_number 三元组，号码保持文字和前导零；E*TRADE 只匹配 account_label。不折叠大小写、不按尾号或相似度猜测。未知、重复别名和相关历史歧义交回确认。

`record.account_ref` 可传登记名、email code 或上述来源对象的 JSON 文本。新事实使用登记名；历史邮件短码及其 account_ref/order_key/fill_id 不改写，仅在内存对齐用于去重、累计增量和冲销保护。旧库全部未配置 aliases 时保留精确历史短码兼容；配置后未知历史短码不能绕过登记映射。本轮没有 CSV importer。fills feed、watch 和 ledger 读同一份 accounts：邮件短码认出唯一登记名时，新邮件行记登记名，原短码写进 `account_alias_seen`；认出多个不入账，记 `ambiguous-account` 并通知领队；登记了别名却认不出时照旧按短码入账并通知领队确认，登记别名后各视图自动对齐。watch 和 ledger 在内存里把历史行的账户和键对到登记名再分仓位、交易链和税务；有歧义的历史行不合并，按原账户单列并列进「待确认账户」。record fixtures 的 Demo 名称、代码及号码均为虚构，真实映射仅由使用者确认后写私密 DB。

## fills：成交邮件

`feeds/fills/feed.json` 照说明书写 `"connector": "mail"`、`settings.senders: "brokers"`、`into: "fills"`、`reads: ["fills"]`。解析规则以说明书「成交邮件（`fills`）」为准：

- 优先读 HTML，没有 HTML、或 HTML 在交易表中间被截断时读纯文本。只读第一张以 `Account` 开头的表（含套在别的表里的），按列名取值，多出的 `Executed At` 存进 `executed_at`。
- 成交按订单键 `<OCC>:<方向>:<成交日>:<账户短码>` 记累计增量，`fill_id` 是 `<订单键>:cum<累计张数>`。价格按整数万分之一美元算，四舍五入后存 4 位小数文字。`Open Qty` 还有值的行 `partial_fill` 是 `"true"`。
- 挂单、没成交、股票行、部分成交不打扰。`unparsed`、`duplicate-order-key` 每封信发一条通知，只带信的编号、行数和原因，不带信的内容。领队收到后问使用者。
- 只有信的形状不对（没有编号）时 handler 才抛错，抛的话固定，不引用信的内容。
- 佣金、费用、订单号、成交时间表里没有，留空待确认。账户记 `account_ref`：没有登记别名时是邮件短码，登记了别名时是登记名（见上「账户别名」）；映射到 `account_key` 是下一步。

**什么时候往 `brokers` 加地址。**名单交出时是空的，连接器一封信都不收（使用者 2026-11-17 定：解析做好之前名单留空）。解析在 P3-c 做好了，但地址仍然由使用者确认后再加：

- 模块打开后，宿主会挂一条告警「交易台发件人私密名单是空的，什么都不收」。使用者确认之前，这条告警是预期的。
- 使用者确认后，由使用者说出交易台的发信地址，领队用 `data/brokers` 写进去。地址是私人数据，不进仓库，也不写进本包。
- 加地址以后的第一封部分成交信要核对一次：说明书假设 `Exe Qty` 是累计成交量，见说明书「还没定的」。

待确认（说明书「还没定的」）：`Exe Qty` 是累计量还是本次量；订单的前几次成交超出 `reads` 的 500 行时怎么查（宿主按第一个日期字段排新旧，所以 `trade_date` 排在 `expiry` 前面）；账户映射。Gmail 授权归宿主，不声明 Gmail key。

## 外部 stock-ta 契约

已核对提供方包的实际 exports 与 tool.json：direction 只用 structure、signals、prices、quote；volatility 只用 earnings-date。`prices` 是缓存最新价，**不是日线历史接口**，因此本包不假装能从它读取日线。quote 的参数为 symbols，earnings-date 为 symbol；now 仅回放使用，实盘不传。结构/信号使用工具明示短参数，保留 data_end/data_time/at、stale、session、truncated 与 missing。

提供方缺席、未开放或环境未就绪时原样报告原因，其余有依据的部分继续。note 未开放，sources 原文与自选写入需转述“请对 stock-ta 说……”。所有外部调用只传必要股票代码及明示短筛选参数，不传私密邮件、账户、成本、张数、仓位和使用者原话。feed 不调用任何外部模块工具。

## 默认值

- IV：口径 `option-ta-iv-close-v2`；收盘后 30 分钟开始尝试，含提前收盘日；每交易日一次，回填 365 日，上市不到一年的从上市日、且有合约可选的第一天起。取那天已挂牌（合约列表带 `as_of`）的标准美式 put，照 theta 的 `selectAtmContract`：期限 21—45 天里最近的到期日，再取离正股收盘价最近、当天有成交的行权价，一样近取较低的；探最近 3 个到期日各 2 张最近的行权价，行权价只查正股收盘价上下 5%。v1 的合约列表没带 `as_of`，把那天还没挂牌的周一到周四到期合约排在最前面，回填大量误记无数据，换口径从头存。无候选或当日合约日线记无数据，不补别日/供应方 IV。
- 序列输入为合约日线收盘价；正股同日收盘、到期、行权价、抓取时刻同存。中间价仅日常对照，不进序列。BS 假设利率 0、连续股息率 0，剩余时间按 theta 的 `dteOn` 取日历天数 ÷ 365（不按到期日美东 16:00 细算）；均为近似、未计算，非 P1 已证实的就绪时刻。HV20 用 20 个交易日收盘对数收益率、样本标准差、252 日年化。口径变更整段重算，不混序列。
- 期权链结构：oi、gex、max-pain 要整条链，不接受 `right`、`strike_min`、`strike_max`，到了分页上限没取全回 `NO_DATA`（`knowledge/market-data-limits`）。OI 墙分边，正股价及以下的 put 墙、及以上的 call 墙各列前 `TOP_WALLS` 8 个；某个到期日未平仓全是 0 时最大痛点为空。GEX 用 Gamma × 未平仓 × 100 × 正股价² × 1%（正股变动 1% 的美元），call 记正、put 记负，call 墙只在正股价及以上、put 墙只在正股价及以下找，未平仓合计不到 5000 张或算不出 GEX 时可信度标低（算不出时正负档为空），gamma 翻转点离正股超过 25% 不报，`near_spot` 列离正股最近的 `GEX_STRIKES_SHOWN` 12 个行权价。异常成交是当天成交量 ≥ 未平仓 `UNUSUAL_VOLUME_OI_RATIO` 2 倍且 ≥ `UNUSUAL_MIN_VOLUME` 500 张，未平仓为 0 也算，没有未平仓的不判断，按量列前 15 个；休市时成交量是上一交易日的，说明里写明意思弱一些。
- VIX：vix feed 每 30 分钟看一次，收盘 30 分钟后开始从 CBOE 公开历史文件（`VIX_History.csv`、`VIX9D_History.csv`、`VIX3M_History.csv`，免 key，跟随 307 重定向）取那天的开高低收，存进 `vix-closes`；第一次回填 365 日；收盘 18 小时后还没有那天的收盘报 problem。CBOE 一般在美东晚上更新，VIX 比 VIX9D、VIX3M 晚。档位 `VIX_LEVELS`：<15 平静、15—20 正常、20—25 偏高、25—35 开始紧张、35—50 恐慌、≥50 危机；卖方风控线 `VIX_SELLER_RISK_LINE` 35。期限结构用同一天的 VIX 和 VIX3M 比，VIX ≥ VIX3M 算倒挂；一年分位是最近 365 日收盘里低于最新值的比例。
- IV/HV 分档 `IV_HV_BANDS` 0.8 / 0.95 / 1.2 / 2.0（便宜、略便宜、合理、偏贵、很贵），照 `knowledge/vol-regime` 从 theta 的 0.85 / 1.0 / 1.15 / 1.4 改过来。`vol` 的 `regime.iv`：一年 IV 分位 ≥ 0.8 且 IV/HV ≥ 1.2 为偏贵，分位 ≤ 0.2 且 IV/HV < 0.8 为偏便宜（`RICH_PERCENTILE`、`RICH_RATIO`、`CHEAP_PERCENTILE`、`CHEAP_RATIO`），一高一低为信号不一致，其余为中间。
- 整单希腊值（`strategy` 的 `greeks`，`portfolio-greeks.ts`）：BS（利率 0、无股息），卖出记负，按张数 × 100 股加总；IV 压力测试各加减 `IV_STRESS_POINTS` 10 个点，向下不低于 1%；Gamma 区是 `GAMMA_ZONE_DAYS` 3 天内到期、行权价离正股不到 `GAMMA_ZONE_MONEYNESS` 3% 的腿；Roll 只算留下的新腿；没给 spot 回 `NO_SPOT`。
- 提醒检查 5 分钟；到期前 5 个交易日静音；到期日 09:45 后首次检查离行权价小于 3% 响铃；卖方小于 2% 静音；权利金五成静音、八成响铃，不等于强制买回。价内卖 call 到期前有除息则前 2 个交易日响铃，预计但未宣布只静音。接近行权价每个仓位每个交易日发一次；其余每个仓位（财报、除息按那一天）只发一次。报价不对齐不判断。
- 使用者 2026-11-17 定的三条：提醒正文带账户短码；穿过行权价只在刚穿过的那次响铃，之后一直在价内不再响，回到价外再穿过算新的一次；同一仓位同一天最多响一次铃，多出来的改成静音，到期日只有开盘离行权价不到 3% 那条响。同一拍里按到期、除息、穿价、财报、权利金的顺序占这一次。同一天里穿过、回到价外、再穿过，只记第一次（提醒 id 按天）。
- 财报：到期前有财报静音提醒，财报前 2 个交易日响铃，使用者 2026-11-17 确认保持这样。
- 预计除息仅最近一次常规 CD 且 frequency 为 1/2/4/12 时按月周期滚动，休市日前移；否则除息无数据。watch 每交易日重查一次除息接口和财报日。
- 默认意图：卖 put/call 收租、买 put 买保险、买 call 看涨、贷方价差限定风险收租、借方价差限定成本看方向，均待确认，不证明持股覆盖。
- QCC、涉及独立股票批次的跨式/§1233/wash sale、长期个股买 put、缺年末快照等标待确认。只做税务标记，不自动禁扣/递延，不做 1099-B 对账。`ledger` 的税务视图按 tax memo 第 14.3 节第一版范围算：每腿的盈亏、长短期、税年照算；价差两腿标跨式，期权之间按 30 天窗口标 wash sale；QCC、涉及股票的 wash sale、持有超过一年的买入 put、指派后交出的股票批次、§1256 类别没核实和缺年末快照一律标待确认。

watch 不设置 into，宿主按非私密 feed 处理；合约、张数、权利金进度的提醒全文发到使用者自己的 Telegram，这是说明书已接受的边界，reads 私密集合不会自动遮蔽提醒。watch 只读 `fills` 最新 500 行，更早开的仓位看不到。

## 密钥、检查与运行

`chain`、`vol` 和 `iv`、`watch` 两个 feed 联网取行情；`vix` feed 取 CBOE 的公开文件，不要 key。使用者自行设置业务密钥：

```sh
just -f "$PSA_REPO/justfile" module secret option-ta POLYGON_API_KEY
just -f "$PSA_REPO/justfile" module secret option-ta FINNHUB_API_KEY
```

iv 声明 Massive key，watch 声明 Massive/Finnhub key；`chain`、`vol` 声明 Massive key，缺 key 时回 `NO_KEY` 和上面第一条命令；两个 feed 缺 key 回 problem，写明对应的命令。业务 key 各模块独存；共享同一个服务额度，宿主不替多个模块排队。缺 key 时都给明确原因和上述命令，不返回空成功。

```sh
just -f "$PSA_REPO/justfile" module check "$STATE/modules/option-ta"
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module try option-ta
```

`strategy` 的 cases 用算出来的数断言，不联网，所以没有休市和 HTTP 用例。record/ledger 的 cases 用夹具库断言算出来的数，覆盖缺账户、费用未知、重复 `fill_id`、部分成交合计；它们没有 HTTP 路径。chain/vol 的 cases 用 P1 样本回放：chain 覆盖休市、盘中、缺字段、分页、应答体 ERROR、HTTP 429 和 5xx；vol 覆盖休市、缺字段（自算）、没有历史、有历史、21 到 45 天没有到期日、应答体 ERROR、HTTP 429 和 5xx；`vol` 有历史的那条读 `tools/vol/fixtures/history/data.db`（由 `tests/helpers/option-ta-iv-history.ts` 生成的虚构序列）。缺 key 回放写不出（检查给点名的密钥填假值），由 `tests/unit/option-ta-chain-tool.test.ts`、`option-ta-vol-tool.test.ts` 断言。`module check` 只检查 feed 样例交回的格式；解析对不对由仓库的 `tests/unit/option-ta-fills.test.ts` 断言（四封信的 HTML 和纯文本各一遍，期望取 `option-ta-p1/mail-samples/*.expected.json`），record/ledger 由 `tests/unit/option-ta-ledger.test.ts` 断言，`iv`、`watch`、`vix` 的样例（每种门槛触发和不触发、回填、当天已存、休市、缺数据、429/5xx）由 `tests/unit/option-ta-{iv,watch}-*.test.ts`、`option-ta-vix.test.ts` 回放断言，缺 key 也在那里测，纯计算由其余 `tests/unit/option-ta-*.test.ts` 断言，都由 `just test` 跑，包里不放测试文件。

## 考题

`evals/` 题：报价（chain）、期权链结构（chain 的 max-pain 和 oi）、开仓会诊（stock-ta 的 structure）、Roll 净收（strategy）、到期前财报（stock-ta 的 earnings-date）、记成交（record）、加自选（data/watchlist）。现在没有考 `knowledge` 的题。题里的到期日写成完整日期（2026-12-18、2027-01-15），`expect` 里的合约代码和 fill_id 跟着这些日子；2026-12-18 以后这些合约到期，要换成那时还没到期的日子再预演。记成交那道题的成交日故意不写年份，考领队按今年理解。

## 范围与依据

本包结构依据任务说明书及其“假设和缺项”、`option-ta-build-plan.md`“已定的第一版范围”（2026-11-16、2026-11-17）、`option-ta-tax-memo.md` 第 14 节（范围决定 2026-11-16）、`option-ta-p1/README.md`（2026-11-17 美东 04:29—04:40）和 `option-ta-p1/mail-samples/` 的虚构结构样例（2026-11-17）。没有重新核验税法或盘中行情。fixtures 为依这些结构重新缩写的合成数据，不含真实邮件，不携带真实名单，不从 theta 导入私人资料。

当前未完成年末快照采集，也没有用真实接口验证过 `iv` 的取数时刻；不能生产使用。概念解释和 stock-ta 已开放接口可独立降级使用，提供方实际可用性以调用为准。模块保持停用；完整实现、检查与审阅前不要启用。
