---
name: recording
description: 手动成交、邮件解析、累计部分成交、事件交割、查重更正或账户映射任务时读
---
# 记账契约与P2阻断

**P2解析、查重、累计增量、账本计算完全未实现。** record只基础格式校验，VALIDATED_ONLY + may_write=false禁止直接入账；fills feed对所有邮件回NOT_IMPLEMENTED problem，不保存记录、不推进cursor。说「已校验部分格式，尚未入账」，不能说「已记」或把四封expected草稿当实测。

## 未来确定性入口
生产工作邮箱重定向到Gmail，保留交易台顶层from；brokers初始空，只领队录入实际交易台地址。包里的example.net仅虚构fixture，不能预填生产白名单。手动转发+主题标记不进第一版。宿主负责MIME/charset解码；handler输入body纯文本和可选html（<=256KB），优先HTML，截断标记见data-safety。

按文档顺序首张第一行表头为Account的交易表，可嵌套，按列名不按列号。纯文本空单元格无法判断则unparsed。Exe Qty有且Open Qty空=成交；仅Open Qty=working-order；都空=not-filled；都有=部分成交。股票普通行stock-trade-out-of-scope；文字提到指派不是事件凭据。

## 累计增量与不可变记录（P3验收）
order_key=<OCC>:<side>:<trade_date>:<account_ref>；fill_id及feed id为<order_key>:cum<累计数量>。缺券商order_id留空，不用合成键冒充它。cum>同键已记qty合计才记增量，增量均价=(cum×avg−既记金额)/(cum−既记qty)，所有价格用万分之一USD整数，最后四舍五入4位；非正增量价格unparsed。cum<=已记qty重复/乱序不写且不进skipped。

同表同order_key只取首行，后续duplicate-order-key；unparsed及duplicate-order-key才通知领队。合法部分成交、股票跳过、working-order、not-filled不打扰。部分成交partial_fill旧行不改；ledger按order_key汇总，不拿旧partial_fill判断最终状态。

reads最多最新500行，早期增量可能被截出，第一版接受风险但不能宣称任意历史严格查重。同日同合约方向账户的独立订单会键碰撞，累计量相同但均价变更也歧义，不能自动合并；首封真实部分成交仍需验证Exe Qty是否累计。

## 原始事实
缺账户、合约、数量、成交/事件日期、乘数/交割物不猜、不入账。保留account_ref，匿名account_key下一步映射，不默认税务归属/账户类型。价格规范字符串；费用、trade_time、order_id未知留空不是0。Executed At只有日期不能升为时刻。调整合约不能固定100。

被指派/行权股票BUY/SELL必须caused_by_event关联ASSIGNED/EXERCISED；EXPIRE/CASH_SETTLED也为事件。更正新增reverses指向旧记录，附原因，不更新/删旧行。手动/邮件同fill_id去重，冲突数以邮件为准仍经新增冲销，不覆盖原始记录。领队维护链、Roll、意图/时间/原因；税务派生标记不写回原始记录。
