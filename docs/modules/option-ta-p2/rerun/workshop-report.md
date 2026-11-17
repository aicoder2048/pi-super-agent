# option-ta 构建交付报告

日期：2026-11-17。交付为 P2 模块包，不是已完成全部业务功能的生产版本；没有移植 theta 计算代码，也没有启用模块。

## 位置与范围

- 模块：`<状态目录>/modules/option-ta/`
- 本报告：`<状态目录>/output/docs/reports/20261117-option-ta-delivery.md`
- 工作说明书（原文复制，仅末尾追加假设）：`<状态目录>/workers/tkt_1e1b3ee1-4629-459f-afc3-208193cba12d/spec.md`

按使用者的 spec、glossary、tax memo 第14节、P1 README 与四封虚构成交邮件、build-plan「已定的第一版范围」构建。材料日期为2026-11-16/17，不宣称重新实测全部接口或实时核验税法。

## 已交付

- `full` 模板，版本0.1.0，期权研究组；领队流程与六位只读专家（方向、波动率、策略、仓位、账本税务、仅会诊上场的反方）。三档分流、共同快照、单轮会诊及五段输出写入技能。
- 六份知识：术语表、交易规则、账本模型、税务边界、行情口径、成交证据。术语表在 `knowledge/glossary/glossary.md`，逐字节与使用者文件一致；元数据为 `license: bundled`、`authority: reference`。其余知识同为自有资料摘要/规则，公共资料只作短转述及链接，无需额外导入。
- 六个集合：`fills/chains/accounts/brokers` 为 private，`watchlist/iv-snapshots` 为 shareable；没有 exports，不打包账户、真实发件人、持仓、密钥或 theta 私人资料。
- 五个工具 `chain/vol/strategy/record/ledger`，均带 tool.json、index.ts、cases.json，当前明确返回 `NOT_IMPLEMENTED`，不伪造行情或计算结果。
- 三个 feed `fills/iv/watch`，均有离线 fixtures；提醒阈值、税务降级边界与 IV 输入口径已经写成行为契约。
- fills 已实现已解码 HTML 的纯函数解析：第一张 Account 表及套表、按列名取值、成交/挂单/失效/普通股票分流、OCC与日期解析、按订单累计量生成增量、整数万分之一美元及半进位、稳定 fill_id/order_key、重复与乱序跳过、部分成交保留、异常最小 notice。只追加记录；乘数、交割物和账户映射缺失不猜。
- 14份 fills fixtures（4封源虚构邮件及10份合成边界），同时断言 fills/skipped；异常夹具断言 notice。加 iv/watch 各一份，共16份 feed fixtures。
- 已查实际 stock-ta 包的 exports 与工具定义，方向专家声明 structure/signals/prices/quote，波动专家声明 earnings-date；只传必要短代码、提供方缺失时降级、内部出处和写操作转述「请对 stock-ta 说……」。实际 prices 是缓存最新价，不冒称日线工具。

## 验证

最终静态及离线检查：

```text
ok option-ta@0.1.0 | knowledge=6 data=6 tools=5 skills=5 feeds=3 agents=6 evals=3 | rules=4 | data-classes=shareable:2,private:4 | secrets=FINNHUB_API_KEY,POLYGON_API_KEY | digest=611e4b4b7e59
```

全部提醒原文如下。它们表示静态检查不检查提供方，不表示工具没有开放；已人工核对本状态目录 stock-ta 的实际 exports。

```text
note agents/direction.md: uses "stock-ta/tools/structure", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/signals", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/prices", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/quote", another module's tool; this check cannot see whether stock-ta exports it
note agents/volatility.md: uses "stock-ta/tools/earnings-date", another module's tool; this check cannot see whether stock-ta exports it
note evals/roll-earnings-unimplemented.md: uses "stock-ta/tools/earnings-date", another module's tool; this check cannot see whether stock-ta exports it
```

### 模型预演

- 首轮：2/3 PASS。Roll/财报查询与年度账本查询均实际调用所需工具，原样转述 NOT_IMPLEMENTED；没有用模型计算替代工具。外部 earnings-date 确实被调用，而非提供方缺失的假通过。
- 首轮 QCC 题含义正确，但最终写成「QCC 待确认」，未匹配既定 `QCC待确认`。修复三处提示词：`skills/triage/SKILL.md`、`skills/ledger-tax/SKILL.md`、`agents/ledger-tax.md`，明确最终汇报必须原样含不插空格的固定标记；知识引文仍保留原文措辞。
- **expect 改动：无。** 没有拆分、删除或放宽考题断言。
- 第二轮：**3/3 PASS**，命令退出码0，临时状态目录已删。`cc-qcc-boundary` 输出既定 `QCC待确认`；Roll题实际调用 strategy 与外部 earnings-date；年度题实际调用 ledger，并明确无法计算不等于0。两轮均使用 Router `openai-codex/gpt-6.1-terra`、Worker `openai-codex/gpt-6.1-sol`。通过的是本轮最简行为与边界，不是未实现业务功能。

考题只覆盖 QCC 边界、Roll工具状态加外部财报调用、年度账本工具状态。不能据此声称实盘行情、计算、邮件投递、完整会诊或盯盘已经验收；固定短语匹配本身也不证明整份回答绝无额外错误。预演中曾出现由异常邮件夹具引起的无关核对提示，不代表真实收信或要求使用者现在提供邮件。

## 默认值与冲突处理

使用者明确不提问，按以下默认继续；它们是待后续实现的契约，不是当前已产生的计算数值。

1. 范围以 build-plan 已定第一版及 tax memo 第14节优先：支持 CSP、CC、买 put/call、贷方/借方垂直价差；Calendar/Diagonal/Combo 是 Roll 分类，不授权跨期价差。只记录期权及事件交割股票，普通股票买卖不记。Roll 是管理动作，税务仍逐腿处理；不自动禁扣或递延。
2. 原路由说明超过60字符，默认缩为「分析美股期权与策略盈亏，记录成交和交易链，提醒持仓风险；正股技术面归 stock-ta。」压缩了链/IV/希腊值逐项列举及开仓、Roll、平仓、到期、指派逐项列举；完整事项保留在 rules/技能/README，原工作说明书未改。标题采用 build-plan 的「期权分析（简版）」。
3. 行情链默认美式个股/ETF，过滤二元；保留 §1256 税务分类不代表指数链纳入。保留 §1256 及价差腿的年末快照形状，不保留第一版排除的开CC行情快照/批次指定/跨式标识/1099-B。
4. BS利率/股息默认为0，日历年365天、到期美东16:00；美式提前行权只是近似，价内概率不等于实际指派概率。未核实 theta 选约函数，默认30天标准put、最近ATM，并列早到期/低行权价。HV20为日对数收益样本标准差乘√252；rank用一年极差，百分位为严格低于当前值比例；缺样本不当0。
5. IV日常默认美东16:30后等待当日日线齐备，回填/日常均使用合约日线收盘价；中间价只作对照，改变口径须整段重算，缺日线不换价格补洞。早收市依交易日历处理，具体采集时间仍需P3实测。
6. 权利金进度默认按同账户同合约未平仓部分开仓均价与当前买回ask比较，不用Roll全链净收；未知费用标未计费用。同仓位/类别/门槛去重，更高门槛可升级，回落后再穿越不反复响铃。
7. 提醒契约：到期前5交易日静音；到期日09:45后首检距行权价<3%响铃；卖方距<2%静音、穿入价内响铃；权利金50%静音、80%响铃；建仓时到期前财报立即提醒且财报前2交易日再提醒；价内卖call遇到期前除息，提前2交易日响铃。预计除息仅静音并标「预计、未宣布」。这些尚未由watch执行。
8. 预计除息歧义保守处理：最新记录非CD即停止，不跳过最新非CD去挑旧CD；frequency限1/2/4/12，按周期推算并向前对齐交易日，每天重查已宣布信息。
9. Exe Qty暂作累计成交量，第一封真实部分成交信仍须验证。使用最近500行历史是已接受限制，不能保证无限历史查重；发现明确冲突则拒绝危险增量。未知账户保留account_ref、account_key留空，不猜税务归属。乘数/交割物留空，不把样例100当成所有合约事实；未知费用/时间/订单号等留待确认。
10. HTML字段遵从当前连接器契约html；仅有纯文本目前拒绝为unparsed，不按模糊列记账。只信连接器过滤的发件人，不凭正文From头绕名单；手动转发加主题标记仍不在第一版。
11. 意图缺失按术语表：卖put/CC收租、买put买保险、买call看涨、贷方价差限定风险收租、借方价差限定成本看方向，附待确认；邮件正文不能授权改意图。
12. 股票批次相关税务判断均待确认；持有超过一年个股买put长短期同样待确认。税务候选不等于结论，缺年末快照不算年末金额。带持仓细节的Telegram全文提醒遵使用者既有接受范围，不扩展到邮件全文/账号/密钥/税务归属。

## 未完成事项（后续工程）

- chain：实际 Massive 取数、过滤和安全分页、紧凑链结果、OI/GEX/最大痛点/异常成交及行情错误降级。
- vol：BS反解、greeks、自算/供应方分列、HV与IV比值、rank/百分位、期限结构/偏斜及样本覆盖。
- strategy：期权腿盈亏、平衡点、年化、概率、流动性、三种Roll与并排比较；未移植任何theta计算。
- record：手动成交/事件的校验、数据库只读查重、规范化输出。当前桩不授权手动入账，不能绕过它让领队自行写交易。
- ledger：数据库汇总、链与税务两视图、订单汇总、原始记录冲销、wash sale/跨式/§1256候选及恒等式检查；暂不能输出真实盈亏金额。
- iv feed：交易日历、一年回填、选约、每日采集和有效游标；当前只回安全problem，不推进成功游标。
- watch feed：全部定时监控、门槛检测、去重、预期除息及提醒；当前只回安全problem，不发送已检查/安全的误导结论。
- fills：可唯一识别的纯文本后备尚未实现；真实端到端重定向/连接器投递、账户映射、实际累计量语义仍需验证；超过500行历史方案未扩展。邮件不含乘数等事实，需后续可信合约信息补齐。完整部分成交最终状态等汇总依赖ledger。
- 工具cases目前只验证安全固定状态，尚未真实覆盖休市、缺字段、应答体ERROR、HTTP429/5xx。不能以通过检查代替这些业务错误路径测试。
- 未做已排除的1099-B导入/对账、普通股票账本、IV机会提醒、实盘下单或仓位管理。未移植theta digest或计算源码。

## 使用者后续操作

无知识导入命令。先审阅模块和本报告；补强完相应功能前，不应把本模块当成运行中的行情/账本/盯盘服务。

业务密钥由使用者自行设置，不复制stock-ta的.env：

```sh
just module secret option-ta POLYGON_API_KEY
just module secret option-ta FINNHUB_API_KEY
```

Gmail授权归宿主mail连接器。使用者在工作邮箱配置保留原发件人的重定向，再通过领队维护私密brokers名单及accounts匿名映射；不把真实地址/账号写进包。即使填好密钥也不会让桩工具或iv/watch自动具备功能。后续需要实际stock-ta提供方已装好且在服务；现有开放接口不能提供原始日线/HV样本，需在后续接口设计中明确，不擅自复制另一模块实现。

## 写入审计

构建仅写模块目录、任务/成员工作目录、宿主预演临时目录及本成品报告；未改代码仓库、配置、启停开关或安装扩展，仓库git状态为空。所有成员已正常返回，无超时缺席。预演临时宿主及日志不作为使用者模块实例。

新模块停在已停用，你看过以后运行 `just module on option-ta` 打开。
