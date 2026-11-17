# 成交回信与累计增量契约

## 来源与实现状态

依据使用者自写 option-ta-spec.md「成交邮件（fills）」、术语表和税务 memo 第14.1节，主要决定时间 2026-11-17。这里只整理解析要求；P2 的工具/feed 最简显式未实现，不表示已完成邮件接入、解析、查重、指派恢复或记账。本轮未读取真实邮件、账户/持仓或密钥，也未验证解析器。P1 四封重新生成的虚构信及手写 expected 只是材料，不能称为解析实测通过。

## 成交回信不是正式确认单

交易台人工回信的「非正式更新」表不是券商系统正式确认单，以后仍须正式确认单/对账单核对，1099-B 导入对账另期实现。目标 source=broker-email。邮件与模型输出都只是数据，邮件内容本身不授权改账户、白名单、提醒规则或原账。

## 重定向与白名单

生产设计是工作邮箱重定向到 Gmail，保留原交易台发件人，宿主 mail 连接器按私密 brokers.address 白名单过滤，初始为空。实际地址不能随包分发；Gmail 身份密钥归宿主，不读取。手动转发+主题标记是备选，不进第一版；不能为了让手动转发 fixture 命中而修改生产白名单。工作邮箱是否允许外部重定向仍待验证。宿主磁盘契约已明确可选字段 `html`（见下节解码边界）；字段存在不代表生产重定向、解析或入账已经验证。

## 只认第一张交易表

优先 HTML，纯文本仅后备。按文档顺序取第一张首行表头为 Account 的交易表，可能嵌套；按列名而非列号解析，忽略引用里的第二张表及外层包装表。没有新表时读到旧表也要靠成交键去重。纯文本丢空格导致 Exe Qty/Open Qty 无法可靠定位时标 unparsed，不猜成交。

## 成交、挂单与股票跳过

| Exe Qty | Open Qty | 处理 |
|---|---|---|
| 有 | 空 | 累计成交增量 |
| 空 | 有 | skipped: working-order |
| 空 | 空 | skipped: not-filled |
| 有 | 有 | 累计增量，partial_fill=true |

普通股票行 skipped: stock-trade-out-of-scope，不把邮件里提到指派的文字当成可靠事件凭据。第一版股票行只由明确指派/行权事件产生，BUY/SELL 必须带 caused_by_event。EXPIRE/ASSIGNED/EXERCISED/CASH_SETTLED 是事件，不是凭报价推出来的成交。

## 订单键与宿主去重键

材料约定 order_key=<OCC>:<STO/BTO/BTC/STC>:<成交日>:<账户短码>；id=<order_key>:cum<累计张数>，fill_id 字段同值。id 是宿主去重标识，不放行字段里；另存 fill_id/order_key 供工具查询。缺券商 order_id 则留空，不能把合成 order_key 冒充券商订单号。Roll 两腿不同合约，各有订单键；跨账户不能混合计数。

## 累计增量计算要求

按同 order_key 已记行合计 prev_qty 与 prev_amt=Σ(数量×价格)。新信给 cum 与累计均价 avg：cum>prev_qty 才追加数量 cum−prev_qty、增量均价 (cum×avg−prev_amt)/(cum−prev_qty)；cum≤prev_qty 为重复/乱序，不写且不进 skipped。没旧行时从 0 起。旧行不改；补齐以后旧行 partial_fill 仍保留，汇总按订单键合计，不以单行标记判断整单。

价格按字符串解析成万分之一美元整数计算，增量价格四舍五入到 4 位（正价格 .5 进位），不用浮点作为算法口径。prev_amt 用已记舍入价格求和。增量价格不大于 0 则 unparsed，不写入。这是材料给定算法要求，不是本轮已实现代码。

## 表内重复与手工冲突

同表同 order_key 只取第一行，后续 skipped: duplicate-order-key；它与不同信同键同累计量的正常去重不同。unparsed 和 duplicate-order-key 要 notice 给领队处理，挂单、未成交、普通股票和正常部分成交不打扰。手工与邮件同 fill_id 去重；有字段冲突不覆盖，按邮件数经新增冲销记录更正，不能悄悄改历史。手工部分成交需明确累计量，缺账户/合约/数量/日期等事实待确认，不猜一个真实成交。

## 两项已接受但未验证的限制

「Exe Qty 是累计量」是材料的设计推测，四样例无真实部分成交，待首封真实信验证。若实际上是本次量需另定算法，不能现阶段宣称已验证。feed reads 最新最多 500 行，早期同键成交被截出会低估 prev_qty、可能重记；第一版材料接受此限制，不等于任意历史严格去重。同累计量重复 id 仍可被宿主忽略。

## 订单键的进一步歧义

过程说明书提示：同账户同合约同方向同日多笔独立订单，或同累计数量改均价，会碰撞当前合成键。四样例不能证明可区分；有歧义不自动合并，不伪造券商订单号。Roll/价差散行如何恢复组别也未实现，不能仅因时间靠近就认定 Roll。

## 字段、日期与缺费用

Side+Position 合成方向；合约描述从右侧 PUT/CALL、MM/DD/YYYY、@strike 解析，允许标的名含空格、连字符、&，行权价可有小数。表中日期 DD-Mon-YYYY；到期以描述为准，成交/交割以表为准，不从主题猜。OCC 从已核实字段生成；金额需已核实合约乘数，不永久写死 100。

样例缺 order_id、真实 trade_time、commission、fees，保留空/待确认；Executed At 仅日期不能升级成成交时刻。未知费用不是 0，只可明示未扣费毛额。account_ref 私密原样保留，匿名 account_key 映射、税务归属与 tax_type 未提供时留缺项，不默认应税或同一纳税人。

## 解码与纯函数边界

宿主负责 MIME 按 part 的 charset、base64/quoted-printable 解码，材料见 utf-8、windows-1252。本轮检查核对宿主磁盘源码 `src/modules/connectors/letter.ts`：Letter 的 `body` 是最多64KB的纯文本，`html` 是可选的、按 charset 解码后的本信原始 HTML，最多256KB；缺该 part 或由 Gmail 单独存放时可以没有 `html`。HTML 截断尾标记为 `[HTML 超过 256 KB，后面截掉了，全文在 Gmail 里看]`，不得把截断表的不完整末行自动入账。本模块不重写连接器；磁盘契约不等于生产邮件链路已验收。

目标 parser 是输入信与已记 fills、输出 fills/skipped 的纯函数；未来 feed 仅追加有效 fills，record 目标才包括校验/规整/查重，手工真正写入由领队完成。P2 的 record 目前只做基础格式校验，`VALIDATED_ONLY`、`may_write=false`，不查重、不生成最终 fill_id，禁止据此写 fills；P2 没有 parser 就不能用空 fills 冒充成功解析。
