# option-ta · 期权分析

期权研究组：领队加方向与价位、波动率与事件、策略计算、仓位研判、账本与税务和仅会诊上场的反方。路由、权限和原始事实模型已搭好；本轮是明确返回 `NOT_IMPLEMENTED` 的安全骨架，不是可计算、可收真实成交或可依赖的监控系统。没有移植 theta 代码、sidecar 或读取其私人资料。

## 文件与权限

- `module.json`：中文标题、路由说明和团队；有私密集合，所以 `exports: []`。
- `skills/option-lead/SKILL.md`：分档、共同快照、一次会诊、输出五段和领队独占写入。
- `agents/{direction,volatility,strategy,position,ledger,critic}.md`：六位只读专家，最小 `uses`；只有需要者接触私密集合。领队不另建专家文件。
- `tools/{chain,vol,strategy,record,ledger}/`：每个包含 `tool.json`、`index.ts`、`cases.json`。当前均只回固定 `status`、`reason`；不联网、不读写数据库、不返回伪数值。`record` 还不能校验、查重或返回可写成交，领队不得绕过它入账。
- `data/{fills,chains,accounts,brokers}/collection.json`：四个 `private` 集合；`data/{watchlist,iv-snapshots}/collection.json`：两个 `shareable` 集合。全部初始为空。
- `feeds/{fills,iv,watch}/`：三个有 handler 的占位 feed，各有离线 `fixtures/`；均 `records: []`、不返回 cursor，并发固定 `NOT_IMPLEMENTED` notice/problem。notice 去重键固定，不按每拍新建通知。
- `rules.md`：状态通知的处理边界，不授权写集合或交易。
- `knowledge/` 和 `evals/` 由独立成员维护；检查与预演以最终包为准。

专家不写文件，也不写集合。工具不写库。领队写原始事实，派生盈亏/税务视图不能反写事实。`fills` 复用记录类型 FILL、EVENT、MARKET_SNAPSHOT、REVERSAL，保留指派/行权产生的股票和仍持有的 §1256/价差腿年末期权收盘观察；不增加股票或报税集合。价格、佣金、费用用十进制文本保精度；`partial_fill`、意图确认用文字，因为集合字段无 boolean。`instrument` 是合约 JSON 文本，兼有明确的合约事实字段；未来校验器须保证一致。未知费用留空，不当零。账户只存短码与匿名键，不存真实账号；税务归属和账户类型未知留空。

## fills 为何暂不连接 mail

**当前 `feeds/fills/feed.json` 故意没有 `connector: "mail"`。** 这是安全降级，不是已经实现自动收信。宿主 mail 连接器与 handler 各有 cursor：回空成功会把信视作完成；抛错也会在重试耗尽后拒收推进。单纯不返回 handler cursor 或返回 problem，不能保证真实信不被消费。因此在未实现解析与失败保留前，采用 handler-only 定时状态通知，完全不进入 mail 连接器，既不取真实邮件也不推进连接器 cursor。不要把字段加回去试跑。`settings.senders: "brokers"` 为未来契约保留，brokers 初始为空；当前不填写真实名单。

尚未实现：第一张以 Account 开头的 HTML 交易表定位（含套表）、按列名取值/新增 Executed At、纯文本后备、描述/OCC/日期解析、挂单/空单/股票跳过、同表重复订单键、累计成交增量、整数万分位四舍五入、邮件与手动成交冲突、500 行窗口外去重和账户映射。未来按 MIME charset 的解码由宿主连接器完成。当前 synthetic fixtures 只验证不伪入账，不声称样例解析成功。

恢复 mail 必须先实现并验证这些能力和未解析邮件的保留/重放路径，再由维护者审阅添加 `connector: "mail"`，保留 handler、every、into private fills、reads fills、settings.senders brokers。Gmail 授权归宿主，不声明 Gmail key。生产信走工作邮箱重定向保留交易台发件人；手动转发加主题标记不在第一版。`Exe Qty` 作为累计量及最新 500 行足够的假设尚待真实部分成交验证。

## 外部 stock-ta 契约

已核对提供方包的实际 exports 与 tool.json：direction 只用 structure、signals、prices、quote；volatility 只用 earnings-date。`prices` 是缓存最新价，**不是日线历史接口**，因此本包不假装能从它读取日线。quote 的参数为 symbols，earnings-date 为 symbol；now 仅回放使用，实盘不传。结构/信号使用工具明示短参数，保留 data_end/data_time/at、stale、session、truncated 与 missing。

提供方缺席、未开放或环境未就绪时原样报告原因，其余有依据的部分继续。note 未开放，sources 原文与自选写入需转述“请对 stock-ta 说……”。所有外部调用只传必要股票代码及明示短筛选参数，不传私密邮件、账户、成本、张数、仓位和使用者原话。feed 不调用任何外部模块工具。

## 默认值（仅口径，不代表算法已实现）

- IV：口径 `option-ta-iv-close-v1`；收盘后 30 分钟开始尝试，含提前收盘日；每交易日一次，回填 365 日。取标准美式 put，目标到期 30 天、范围 21—45 天，先按离目标日最近选到期、再按离正股收盘价最近选行权价，并列取较早到期、较低行权价。无候选或当日合约日线记无数据，不补别日/供应方 IV。
- 序列输入为合约日线收盘价；正股同日收盘、到期、行权价、抓取时刻同存。中间价仅日常对照，不进序列。BS 假设利率 0、连续股息率 0、ACT/365、到期日美东 16:00；均为近似、未计算，非 P1 已证实的就绪时刻。HV20 用 20 个交易日收盘对数收益率、样本标准差、252 日年化。口径变更整段重算，不混序列。
- 提醒检查 5 分钟；到期前 5 个交易日静音；到期日 09:45 后首次检查离行权价小于 3% 响铃；卖方小于 2% 静音、穿价响铃；权利金五成静音、八成响铃，不等于强制买回。财报入仓发现即提醒、前 2 个交易日再提醒；价内卖 call 到期前有除息则前 2 个交易日响铃，预计但未宣布只静音。每账户/仓位/类型/交易日去重，升级可再触发。报价不对齐不判断。
- 预计除息仅最近一次常规 CD 且 frequency 为 1/2/4/12 时按月周期滚动，休市日前移；否则除息无数据。未来 watch 每交易日重查。当前没有推算也没有提醒。
- 默认意图：卖 put/call 收租、买 put 买保险、买 call 看涨、贷方价差限定风险收租、借方价差限定成本看方向，均待确认，不证明持股覆盖。
- QCC、涉及独立股票批次的跨式/§1233/wash sale、长期个股买 put、缺年末快照等标待确认。只做税务标记，不自动禁扣/递延，不做 1099-B 对账。当前 ledger 尚未计算任何标记。

watch 不设置 into，宿主按非私密 feed 处理；未来合约、张数、权利金进度提醒会全文发到使用者自己的 Telegram，这是说明书已接受的边界，reads 私密集合不会自动遮蔽通知。当前仅发送无持仓详情的能力状态。

## 密钥、检查与运行

本轮不取 key、不联网、不启用模块，不改 config、不安装环境。未来实现取数后，使用者自行设置业务密钥：

```sh
just -f "$PSA_REPO/justfile" module secret option-ta POLYGON_API_KEY
just -f "$PSA_REPO/justfile" module secret option-ta FINNHUB_API_KEY
```

iv 声明 Massive key，watch 声明 Massive/Finnhub key；五个工具当前没有请求或 secret 需求。业务 key 各模块独存；共享同一个服务额度，宿主不替多个模块排队。缺 key 的未来实现必须给明确原因和上述命令，不能返回空成功。

```sh
just -f "$PSA_REPO/justfile" module check "$STATE/modules/option-ta"
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module try option-ta
```

cases 的现阶段断言只验证 `NOT_IMPLEMENTED`。chain/vol/strategy 的休市、缺字段、正文 ERROR、HTTP 429/503 应答是命名明确的预留回放素材，**桩不 fetch，不代表真实异常路径已测通**。record/ledger 为离线桩，没有 HTTP 路径。feed fixtures 只被检查交回格式；本轮另行离线验证无 records、无 cursor 及固定状态，不把 fixtures 当解析正确性的证明。没有 `tests/` 或额外测试运行时。

## 范围与依据

本包结构依据任务说明书及其“假设和缺项”、`option-ta-build-plan.md`“已定的第一版范围”（2026-11-16、2026-11-17）、`option-ta-tax-memo.md` 第 14 节（范围决定 2026-11-16）、`option-ta-p1/README.md`（2026-11-17 美东 04:29—04:40）和 `option-ta-p1/mail-samples/` 的虚构结构样例（2026-11-17）。没有重新核验税法或盘中行情。fixtures 为依这些结构重新缩写的合成数据，不含真实邮件，不携带真实名单，不从 theta 导入私人资料。

当前未完成所有真实取数、确定性计算、成交解析与校验查重、账本、税务、年末快照采集、IV 回填和主动风险提醒；不能生产使用。概念解释和 stock-ta 已开放接口可独立降级使用，提供方实际可用性以调用为准。模块保持停用；完整实现、检查与审阅前不要启用。
