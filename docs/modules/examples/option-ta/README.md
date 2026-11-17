# option-ta · 期权分析

期权研究组：领队加方向与价位、波动率与事件、策略计算、仓位研判、账本与税务和仅会诊上场的反方。路由、权限和原始事实模型已搭好。`strategy` 已能按给定的腿算数（P3-a）。成交这条路已经做完（P3-c）：`fills` feed 解析交易台的成交回信，`record` 校验手动成交，`ledger` 出交易链和税务两种视图。行情已接 Massive（P3-b）：`chain` 回期权链快照，`vol` 回平值 IV、IV/HV、期限结构、偏斜和 IV rank、百分位。IV 回填和提醒还是明确返回 `NOT_IMPLEMENTED` 的骨架。纯计算从 theta 移植，每个文件头写着出处；没有搬 sidecar，也没有读 theta 的私人资料。

## 文件与权限

- `module.json`：中文标题、路由说明和团队；有私密集合，所以 `exports: []`。
- `skills/option-lead/SKILL.md`：分档、共同快照、一次会诊、输出五段和领队独占写入。
- `agents/{direction,volatility,strategy,position,ledger,critic}.md`：六位只读专家，最小 `uses`；只有需要者接触私密集合。领队不另建专家文件。
- 包根目录的纯计算 `*.ts`：从 theta 移植（BS 价格和反解 IV、首达概率、到期盈亏、方案经济、CC 收益、流动性、参考价、Roll 净收门槛、IV 压缩、GEX 墙、OI 期限结构、到期临近、交割物、IV rank 和 HV20）。不联网、不读写数据。门槛是命名常量，说明书没定的沿用 theta 的值，待使用者确认。
- `tools/{chain,vol,strategy,record,ledger}/`：每个包含 `tool.json`、`index.ts`、`cases.json`。`strategy` 只算不取数：给定腿，回权利金、参考价、盈亏平衡、到期盈亏、年化、指派概率、流动性和三种 Roll 的净收付。`chain`、`vol` 向 Massive 取数（行情辅助在包根目录的 `massive.ts`、`chain-rows.ts`），滤掉二元期权、跟分页，缺 IV 或希腊值用中间价自算并标「自算」，算不出标「无数据」，休市标「休市」；`chain` 的 OI 墙、GEX、最大痛点、异常成交还回 `NOT_IMPLEMENTED`。`vol` 只读 `iv-snapshots`，没有行时 history 回 `NO_HISTORY`。`record`、`ledger` 只读 `$PSA_MODULE_DATA/data.db`，不写库；它们的用例共用 `tools/ledger/fixtures/data/data.db`，这份库由 `tools/ledger/fixtures/seed.json` 经 `tests/helpers/option-ta-ledger-db.ts` 生成，全是虚构数据。
- `fills.ts`：feed 和 `record` 共用的订单键、`fill_id`、OCC 代码和累计增量（整数万分之一美元）。`data-db.ts`：工具只读打开 data.db。
- `data/{fills,chains,accounts,brokers}/collection.json`：四个 `private` 集合；`data/{watchlist,iv-snapshots}/collection.json`：两个 `shareable` 集合。全部初始为空。
- `feeds/fills/`：接宿主 `mail` 连接器，只收私密名单 `brokers` 上的发件人，写进私密集合 `fills`。`parse.ts` 是纯函数，`index.ts` 把结果交给宿主；样例是 P1 的四封虚构信和一份没有信的。
- `feeds/{iv,watch}/`：两个有 handler 的占位 feed，各有离线 `fixtures/`；均 `records: []`、不返回 cursor，并发固定 `NOT_IMPLEMENTED` notice/problem。notice 去重键固定，不按每拍新建通知。
- `rules.md`：状态通知的处理边界，不授权写集合或交易。
- `knowledge/` 和 `evals/` 由独立成员维护；检查与预演以最终包为准。

专家不写文件，也不写集合。工具不写库。领队写原始事实，派生盈亏/税务视图不能反写事实。`fills` 复用记录类型 FILL、EVENT、MARKET_SNAPSHOT、REVERSAL，保留指派/行权产生的股票和仍持有的 §1256/价差腿年末期权收盘观察；不增加股票或报税集合。价格、佣金、费用用十进制文本保精度；`partial_fill`、意图确认用文字，因为集合字段无 boolean。`instrument` 是合约 JSON 文本，兼有明确的合约事实字段；未来校验器须保证一致。未知费用留空，不当零。账户只存短码与匿名键，不存真实账号；税务归属和账户类型未知留空。

## fills：成交邮件

`feeds/fills/feed.json` 照说明书写 `"connector": "mail"`、`settings.senders: "brokers"`、`into: "fills"`、`reads: ["fills"]`。解析规则以说明书「成交邮件（`fills`）」为准：

- 优先读 HTML，没有 HTML、或 HTML 在交易表中间被截断时读纯文本。只读第一张以 `Account` 开头的表（含套在别的表里的），按列名取值，多出的 `Executed At` 存进 `executed_at`。
- 成交按订单键 `<OCC>:<方向>:<成交日>:<账户短码>` 记累计增量，`fill_id` 是 `<订单键>:cum<累计张数>`。价格按整数万分之一美元算，四舍五入后存 4 位小数文字。`Open Qty` 还有值的行 `partial_fill` 是 `"true"`。
- 挂单、没成交、股票行、部分成交不打扰。`unparsed`、`duplicate-order-key` 每封信发一条通知，只带信的编号、行数和原因，不带信的内容。领队收到后问使用者。
- 只有信的形状不对（没有编号）时 handler 才抛错，抛的话固定，不引用信的内容。
- 佣金、费用、订单号、成交时间表里没有，留空待确认。账户先记短码 `account_ref`，映射到 `account_key` 是下一步。

**什么时候往 `brokers` 加地址。**名单交出时是空的，连接器一封信都不收（使用者 2026-11-17 定：解析做好之前名单留空）。解析在 P3-c 做好了，但地址仍然由使用者确认后再加：

- 模块打开后，宿主会挂一条告警「交易台发件人私密名单是空的，什么都不收」。使用者确认之前，这条告警是预期的。
- 使用者确认后，由使用者说出交易台的发信地址，领队用 `data/brokers` 写进去。地址是私人数据，不进仓库，也不写进本包。
- 加地址以后的第一封部分成交信要核对一次：说明书假设 `Exe Qty` 是累计成交量，见说明书「还没定的」。

待确认（说明书「还没定的」）：`Exe Qty` 是累计量还是本次量；订单的前几次成交超出 `reads` 的 500 行时怎么查（宿主按第一个日期字段排新旧，所以 `trade_date` 排在 `expiry` 前面）；账户映射。Gmail 授权归宿主，不声明 Gmail key。

## 外部 stock-ta 契约

已核对提供方包的实际 exports 与 tool.json：direction 只用 structure、signals、prices、quote；volatility 只用 earnings-date。`prices` 是缓存最新价，**不是日线历史接口**，因此本包不假装能从它读取日线。quote 的参数为 symbols，earnings-date 为 symbol；now 仅回放使用，实盘不传。结构/信号使用工具明示短参数，保留 data_end/data_time/at、stale、session、truncated 与 missing。

提供方缺席、未开放或环境未就绪时原样报告原因，其余有依据的部分继续。note 未开放，sources 原文与自选写入需转述“请对 stock-ta 说……”。所有外部调用只传必要股票代码及明示短筛选参数，不传私密邮件、账户、成本、张数、仓位和使用者原话。feed 不调用任何外部模块工具。

## 默认值（仅口径，不代表算法已实现）

- IV：口径 `option-ta-iv-close-v1`；收盘后 30 分钟开始尝试，含提前收盘日；每交易日一次，回填 365 日。取标准美式 put，目标到期 30 天、范围 21—45 天，先按离目标日最近选到期、再按离正股收盘价最近选行权价，并列取较早到期、较低行权价。无候选或当日合约日线记无数据，不补别日/供应方 IV。
- 序列输入为合约日线收盘价；正股同日收盘、到期、行权价、抓取时刻同存。中间价仅日常对照，不进序列。BS 假设利率 0、连续股息率 0、ACT/365、到期日美东 16:00；均为近似、未计算，非 P1 已证实的就绪时刻。HV20 用 20 个交易日收盘对数收益率、样本标准差、252 日年化。口径变更整段重算，不混序列。
- 提醒检查 5 分钟；到期前 5 个交易日静音；到期日 09:45 后首次检查离行权价小于 3% 响铃；卖方小于 2% 静音、穿价响铃；权利金五成静音、八成响铃，不等于强制买回。财报入仓发现即提醒、前 2 个交易日再提醒；价内卖 call 到期前有除息则前 2 个交易日响铃，预计但未宣布只静音。每账户/仓位/类型/交易日去重，升级可再触发。报价不对齐不判断。
- 预计除息仅最近一次常规 CD 且 frequency 为 1/2/4/12 时按月周期滚动，休市日前移；否则除息无数据。未来 watch 每交易日重查。当前没有推算也没有提醒。
- 默认意图：卖 put/call 收租、买 put 买保险、买 call 看涨、贷方价差限定风险收租、借方价差限定成本看方向，均待确认，不证明持股覆盖。
- QCC、涉及独立股票批次的跨式/§1233/wash sale、长期个股买 put、缺年末快照等标待确认。只做税务标记，不自动禁扣/递延，不做 1099-B 对账。`ledger` 的税务视图按 tax memo 第 14.3 节第一版范围算：每腿的盈亏、长短期、税年照算；价差两腿标跨式，期权之间按 30 天窗口标 wash sale；QCC、涉及股票的 wash sale、持有超过一年的买入 put、指派后交出的股票批次、§1256 类别没核实和缺年末快照一律标待确认。

watch 不设置 into，宿主按非私密 feed 处理；未来合约、张数、权利金进度提醒会全文发到使用者自己的 Telegram，这是说明书已接受的边界，reads 私密集合不会自动遮蔽通知。当前仅发送无持仓详情的能力状态。

## 密钥、检查与运行

本轮不取 key、不联网、不启用模块，不改 config、不安装环境。未来实现取数后，使用者自行设置业务密钥：

```sh
just -f "$PSA_REPO/justfile" module secret option-ta POLYGON_API_KEY
just -f "$PSA_REPO/justfile" module secret option-ta FINNHUB_API_KEY
```

iv 声明 Massive key，watch 声明 Massive/Finnhub key；`chain`、`vol` 声明 Massive key，缺 key 时回 `NO_KEY` 和上面第一条命令。业务 key 各模块独存；共享同一个服务额度，宿主不替多个模块排队。缺 key 的未来实现必须给明确原因和上述命令，不能返回空成功。

```sh
just -f "$PSA_REPO/justfile" module check "$STATE/modules/option-ta"
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module try option-ta
```

`strategy` 的 cases 用算出来的数断言，不联网，所以没有休市和 HTTP 用例。record/ledger 的 cases 用夹具库断言算出来的数，覆盖缺账户、费用未知、重复 `fill_id`、部分成交合计；它们没有 HTTP 路径。chain/vol 的 cases 用 P1 样本回放，覆盖休市、盘中、缺字段、分页、应答体 ERROR、HTTP 429 和 5xx；`vol` 有历史的那条读 `tools/vol/fixtures/history/data.db`（由 `tests/helpers/option-ta-iv-history.ts` 生成的虚构序列）。缺 key 回放写不出（检查给点名的密钥填假值），由 `tests/unit/option-ta-chain-tool.test.ts`、`option-ta-vol-tool.test.ts` 断言。`module check` 只检查 feed 样例交回的格式；解析对不对由仓库的 `tests/unit/option-ta-fills.test.ts` 断言（四封信的 HTML 和纯文本各一遍，期望取 `option-ta-p1/mail-samples/*.expected.json`），record/ledger 由 `tests/unit/option-ta-ledger.test.ts` 断言，纯计算由其余 `tests/unit/option-ta-*.test.ts` 断言，都由 `just test` 跑，包里不放测试文件。

## 范围与依据

本包结构依据任务说明书及其“假设和缺项”、`option-ta-build-plan.md`“已定的第一版范围”（2026-11-16、2026-11-17）、`option-ta-tax-memo.md` 第 14 节（范围决定 2026-11-16）、`option-ta-p1/README.md`（2026-11-17 美东 04:29—04:40）和 `option-ta-p1/mail-samples/` 的虚构结构样例（2026-11-17）。没有重新核验税法或盘中行情。fixtures 为依这些结构重新缩写的合成数据，不含真实邮件，不携带真实名单，不从 theta 导入私人资料。

当前未完成真实取数、策略计算、年末快照采集、IV 回填和主动风险提醒；不能生产使用。概念解释和 stock-ta 已开放接口可独立降级使用，提供方实际可用性以调用为准。模块保持停用；完整实现、检查与审阅前不要启用。
