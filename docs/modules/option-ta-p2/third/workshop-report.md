# option-ta 制作汇报

## 交付与边界

模块绝对路径：`<状态目录>/modules/option-ta/`

新模块 `option-ta@0.1.0`，中文标题「期权分析」，模板 `full`；领队加五位领域专家、会诊反方，共七个角色。包内有六集合、五工具、三个 feed、四份知识、一份领队技能、六道考题。路由 description 原样保留说明书句子，实测 58 字符，未压缩。没有移植 theta 代码或私人资料，也没有启用模块、配置密钥或修改代码仓库。

**这是本轮要求的安全最简骨架，不是可用于实盘分析、自动记账或监控的成品系统。** 五工具 `chain`、`vol`、`strategy`、`record`、`ledger` 均返回固定 `NOT_IMPLEMENTED`；三 feed 不写记录、不更新 handler cursor，只报告能力状态。专家和领队禁止模型补算或将该状态说成成功。

## 资料处理

- `knowledge/glossary/glossary.md` 原样复制用户术语表，逐字节一致，SHA-256 为 `d71edc0ee5f5b3ab09186f4935393c7f572773b70a3c0b9d1490c975587ee8b6`。
- `knowledge/operating-rules/` 收录第一版范围、提醒门槛、预计除息和邮件累计量假设。
- `knowledge/tax-basis/` 根据 tax memo 第 14 节整理双视图、指派/行权、股票批次降级、§1256 60/40 与年末快照边界。
- `knowledge/market-data-limits/` 整理 P1 的二元期权过滤、分页、延迟、缺字段及 IV 一致口径。
- 四份来源均 `license: bundled`、`authority: reference`。只收用户资料及原创整理，没有外部受保护全文，无需执行知识导入命令。税务依据未重新独立联网核验。

## 检查

工具 cases 24 条；feed fixtures 8 份；考题 6 道。它们目前验证桩状态与安全不入账，不证明行情、公式、异常恢复、邮件解析或提醒能力已完成。HTTP 429/5xx 素材虽然保留，桩不 fetch，不能说异常路径已测通。

最终检查输出：

```text
ok option-ta@0.1.0 | knowledge=4 data=6 tools=5 skills=1 feeds=3 agents=6 evals=6 | rules=3 | data-classes=shareable:2,private:4 | secrets=FINNHUB_API_KEY,POLYGON_API_KEY | digest=2bba3ea3c1a9
```

全部提醒行如下。已另行读取提供方当前磁盘包的 exports 与工具契约，确认列出的五工具开放；单包检查自身不能作此确认。实际服务版本、数据和环境仍以调用为准。特别是 `prices` 实际是缓存最新价，不是日线历史接口。

```text
note agents/direction.md: uses "stock-ta/tools/structure", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/signals", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/prices", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/quote", another module's tool; this check cannot see whether stock-ta exports it
note agents/volatility.md: uses "stock-ta/tools/earnings-date", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/structure", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/signals", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/prices", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/quote", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/earnings-date", another module's tool; this check cannot see whether stock-ta exports it
```

## 预演

`just module try option-ta` 退出码 0，**6/6 道考题通过**：

```text
PASS cites-knowledge
PASS position-buyback
PASS private-entry-external
PASS record-unknown-fees
PASS roll-net-credit
PASS uses-tool
6/6 道考题通过；临时状态目录已删
```

没有出现提供方没开或未开放工具的提示；外部工具题通过，运行中实际取得 stock-ta 的五项输出，且对盘前延迟价和旧缓存价的冲突明确降级。各题对 NOT_IMPLEMENTED 均未伪装计算或入账成功。

所有 expect 为工具返回的 `NOT_IMPLEMENTED`，本轮没有修改、放宽或拆分 expect。知识、私密参数隔离、写入安全和税务细节不能仅靠该字面量自动判定，预演通过不等于完整审计或生产能力达标。预演使用启动时的包快照；启动后只补足税务知识中 §1256 与年末快照说明，未改工具、专家、技能和考题；上面的最终 module check 已覆盖该补充，未再次预演这一纯知识增补。预演临时目录已由命令自动清理。

## 缺项的默认值

以下是实现口径的默认声明，不是已实现算法，也不是 P1 实测结论：

- IV 在美东正式收盘后 30 分钟开始尝试，提前收盘日同样处理；回填 365 日。选择标准美式 put，目标到期 30 天、候选 21—45 天，按最近目标期限、最近正股收盘价的行权价选择，并列取较早到期和较低行权价。
- 命名口径 `option-ta-iv-close-v1`：合约日线收盘价进入序列，中间价只作对照；利率、连续股息率均 0，ACT/365，到期日美东 16:00。HV20 为 20 个交易日对数收益率样本标准差、252 日年化。无数据不补零、不混用供应方 IV。
- 提醒每 5 分钟检查；同账户/仓位/类型/交易日去重，升级可另触发。卖 put/call 默认收租、买 put 默认买保险、买 call 默认看涨，贷方/借方价差默认限定风险收租/限定成本看方向，均标待确认；不据此假定已持股覆盖。
- `Exe Qty` 暂按累计量处理，接受说明书的最新 500 行窗口假设，实际部分成交信仍须验证。账户短码映射稳定匿名键，税务归属人与应税/IRA 未知留空，不合并猜测。佣金、费用未知留空，不当零。
- 年末期权收盘观察复用私密 `fills` 的 `MARKET_SNAPSHOT` 类型，不增加集合；包括仍持有的 §1256 和价差腿。行情取链的美式过滤不决定税务类别。

用户已定的提醒门槛另存知识：到期前 5 个交易日静音；到期日 09:45 后首次检查离行权价不足 3% 响铃；卖方离行权价不足 2% 静音、进入价内响铃；权利金五成静音、八成响铃（不是强制平仓）；入仓发现到期前财报立即提醒、前 2 个交易日再提醒；价内卖 call 的到期前除息，前 2 个交易日响铃，预计未宣布仅静音。**本轮尚未执行这些门槛。**

## 未完成项与安全降级

1. 真实期权取数、分页过滤、BS/IV/希腊值、策略盈亏与概率、流动性、OI/GEX/最大痛点/异常成交均未实现，不允许模型代算。
2. 成交邮件解析、累计增量的整数精度、查重与冲突处理、账户映射及正式成交校验未实现；领队在 record 返回 `NOT_IMPLEMENTED` 时停止记账。
3. `fills` **暂不设置 `connector: mail`**：宿主连接器 cursor 独立，空成功会消费邮件，抛错耗尽重试也可能推进。仅不返回 handler cursor 不能保证保留真实信，所以当前完全不接 mail，不会把虚构样例当真成交。恢复连接前必须实现解析与失败保留/重放机制。手动转发加主题标记不扩进第一版。
4. 交易链、按订单汇总、两种视图和税务标记未实现；QCC、独立股票批次相关跨式/§1233/wash sale、长期买 put 及缺年末快照等仍属待确认边界。1099-B 对账本来不在本轮范围。
5. 一年 IV 回填、日常存储、交易日历、预计除息计算、行情时刻对齐、主动提醒与去重未实现。不能依赖本模块防漏提醒。
6. 私密集合使 `exports` 保持空。未来 watch 的持仓细节通知会按已接受范围全文发到用户自己的 Telegram；本轮只有无持仓明细的能力状态通知。

## 下一步与使用者操作

无新增说明书外集合、feed、工具或策略。建议按既定 P3 独立补强工程与回归测试，不在此轮移植 theta。先补关键计算和成交安全路径，再接真实数据与提醒。

用户资料已 bundled，无需导入。业务能力实现后，由使用者自行设置模块业务密钥（本轮未代跑）：

```sh
just module secret option-ta POLYGON_API_KEY
just module secret option-ta FINNHUB_API_KEY
```

Gmail 授权归宿主 mail 连接器，本包不读取或声明 Gmail 密钥。当前不要填真实 brokers 名单来试跑。除模块目录、任务过程目录、成品目录及预演临时目录外，没有主动写入其他位置；没有修改仓库和宿主配置。

新模块停在已停用，你看过以后运行 `just module on option-ta` 打开。
