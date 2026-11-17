# 期权分析（简版）

`option-ta`，期权研究组。分析美股期权链、隐含波动、希腊值、策略盈亏，记录开仓、Roll、平仓、到期、指派、行权及交割股票，按金额解读交易链，给税务候选标记和持仓提醒。正股涨跌/K线/技术面归stock-ta；不下单，不管现金/保证金/仓位大小/组合配置，不代报税。本模块不是Wheel。

## 使用与当前行为

- **已实现**：fills对连接器已解码HTML邮件的纯解析、首张Account表（含套表）、列名映射、成交/挂单/失效/普通股票分流、OCC和日期解析、订单累计成交增量、整数万分之一/.5进位、稳定fill_id/order_key、重复/乱序跳过、部分成交保留、异常notice。不联网、不执行邮件指令，原始成交只增不改。
- **固定状态**：chain、vol、strategy、record、ledger均回`NOT_IMPLEMENTED`，没有价格、公式结果或汇总。record不返回允许入账的规整行，因此手动成交/事件不能绕过它入账；ledger未做数据库汇总/税务计算。工具不写集合。
- **安全problem**：iv/watch仅返回`NOT_IMPLEMENTED`问题、空记录/空提醒，保留原cursor，不声称回填、采集或监控完成。技能中的阈值是行为契约，并不表示定时检测已运行。
- 六位只读专家；领队控制自答/单专家/会诊，只有领队写集合，反方仅会诊末轮复核。工具状态及数字要求原样转述。

## 数据与隐私

恰好六集合：private为fills、chains、accounts、brokers，shareable为iv-snapshots、watchlist。初始均无数据，不捆绑实际地址或账号，没有exports。instrument、unconfirmed、市场快照等嵌套事实用JSON文字存储；price/limit/cum_avg为四位小数字符串以保持精度，partial_fill以`true`/`false`文字存储（纯解析函数返回布尔）。不创建衍生账本集合，事件与交割股票放fills，年末期权快照放chains。

Gmail授权归宿主mail连接器。使用者在工作邮箱设保留原发件人的重定向，再由领队把交易台地址/域名写进私密brokers；不要把地址写进包。手动转发+主题标记不是第一版入口。连接器会按每个MIME部分charset解码，handler优先html。当前不推断纯文本列，只有纯文本时一律安全拒绝为unparsed并notice；不按正文引用的From头认发件人。截断HTML整封拒绝，避免漏账。

默认Exe Qty为累计量，待首封真实部分成交验证。feed仅收到fills最新500行，这是已接受的查重限制，不能保证历史完整；同一表重复仍由稳定id去重。已发现冲突则拒绝危险增量，未知历史不能凭空补齐。账户映射未定先留account_ref/account_key空，不猜归属。邮件没有乘数/交割物，留null待确认；绝不把虚构样例的100当合约事实，也不自动算交割股数或金额。原始记录更正用新增冲销，不修改旧行。

watch没有into，按宿主规则是非私密通知源；持仓细节全文发到使用者自己的Telegram（2026-11-17已接受），不等于允许转发邮件、账号、密钥或税务归属。fills短通知只含固定异常原因。

## 外部工具

已核对stock-ta的exports及五份tool.json：方向专家用structure、signals、prices、quote，波动专家用earnings-date；uses只写在相应专家，不写模块级uses。调用只传必要短代码，不传成本/仓位/邮件。提供方缺失只降级相关部分，内部出处或写操作转“请对 stock-ta 说……”。**实际prices是缓存最新价，不是日线接口；structure也是紧凑结构，不提供原始日线。** 因此不假称能从开放工具取得日线/HV样本。

## 配置与检查

业务密钥只由使用者设置：

```sh
just -f "$PSA_REPO/justfile" module secret option-ta POLYGON_API_KEY
just -f "$PSA_REPO/justfile" module secret option-ta FINNHUB_API_KEY
just -f "$PSA_REPO/justfile" module check "$STATE/modules/option-ta"
```

设置密钥不会补齐桩工具或feed。构建验收使用module check和隔离的module try；不会启用本状态目录的option-ta，也不替使用者安装配置。预演结果与未完成事项见交付报告。

## 文件与夹具

- module.json：路由短句、标题与队名；rules.md保留全部具体路由词。
- skills：triage、record-workflow、watch-thresholds、market-data、ledger-tax。
- agents：direction、volatility、strategy、position、ledger-tax、opponent，全部只读与最小uses。
- tools：chain/vol/strategy/record/ledger，各有tool.json、index.ts、cases.json。当前cases验证固定安全状态；尚不能视为真实行情休市/缺字段/ERROR/429/5xx处理完成。
- feeds：fills/iv/watch，各有feed.json、index.ts、fixtures；fills另有parser.ts。fixtures不联网。
- 四封P1虚构eml按每部分charset和传输编码转换为已解码mail输入，from改为虚构交易台，避免把样例的手动转发当生产入口。样例正文为虚构内容，不是交易事实。
- fills fixtures的fixture_expected由源expected.json转换（价格4位字符串；邮件未给乘数，改null；增加累计量/均价）。handler的fixture_mode包装器同时断言fills和skipped的数量与期望字段，module check会执行，漏记/多记都会失败；只比较原样例提供的字段，另有10份合成安全夹具，补验累计增量/补齐/重放乱序、万分之一半进位、重复键、同id改价冲突、非正增量、缺HTML/截断/缺列/坏表拒绝及BTO/BTC/STC。异常夹具同时断言notice原因。夹具断言控制字段只在handler顶层，绝不从邮件正文读取。

## 来源与默认

构建依据为使用者option-ta spec、glossary、build-plan、tax-memo第14节及P1/mail-samples（材料日期2026-11-16至17）；未做实时网页核验，未移植theta计算或私密状态。冲突以build-plan第一版范围和工作spec末尾假设为准。

默认零利率/零股息、日历时间365天、美东到期16:00；选30日标准put再选近ATM、并列早到期低行权价；收盘16:30后待齐日线再有效存储；HV20/一年rank与百分位定义见market-data。以上是计算契约，当前没有输出其数值。税务不自动禁扣/递延，股票相关判断按ledger-tax降级待确认；缺年末快照不算§1256计价金额。

模块维持已停用，由使用者审核后自行决定是否运行`just module on option-ta`。
