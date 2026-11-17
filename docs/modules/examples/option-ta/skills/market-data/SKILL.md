---
name: market-data
description: 读取期权链、IV、波动率或策略计算前读：行情契约、缺字段、历史口径与计算默认
---
# 行情与计算契约
数字由确定性代码产生；工具NOT_IMPLEMENTED原样转述，不借模型补公式结果。支持CSP、CC、买put/call、贷/借方垂直价差及三类Roll，不建议仓位大小。未知费用不是0。到期价内概率不等于真实指派概率，BS对美式提前行权只是近似。

## 取数（P1实测2026-11-17）
期权由本模块Massive取，不移植theta代码或私有状态。只留details.ticker以O:<标的>开头且exercise_style=american，过滤O:B1二元期权；默认美式个股/ETF，不扩展指数期权链。窄查询带contract_type、expiration_date、strike_price.gte/lte。整条链遇next_url必须跟完，每页重带Authorization头；分页不全不得输出完整GEX/OI墙/最大痛点。
缺IV/greeks不能当0：有有效bid/ask时可由代码按中间价反解并标自算；无报价或不收敛标无数据；自算与供应方不同列。bid=0、last_trade/day空对象可正常发生，不能编成交。异常成交量今日/历史都用合约日线v，不混快照day.volume。
休市IV/greeks用停滞期权报价和移动正股价重算，必须标休市和取数时刻，绝不当收盘IV；正股可延迟15分钟，期权实时。HTTP429、5xx、应答体ERROR、缺字段、休市应保留可识别原因。

## 一致IV序列
iv-snapshots只存原始输入：symbol、交易日、选中OCC合约、行权价、到期、合约日线收盘、正股日线收盘、日常报价中间价（回填缺）、取数时刻、method版本和缺项。序列IV由同一公式反解，不存供应方IV；中间价IV仅对照。
新自选回填最近一年，合约列表含expired=true；回填和日常同选法、价格、时间、公式。选中合约无日线则当日无数据，不临时换约或价格补洞。改口径整段重算，不接在旧序列后。有效样本数与覆盖日期随结果给出，不足一年不称完整一年。
默认常量（工作spec假设，不冒称theta原行为）：RISK_FREE_RATE=0，DIVIDEND_YIELD=0；年数按美东到期16:00终点、日历时间/365天；TARGET_DTE=30天，标准put，先选到期最接近30日、再最接近正股收盘行权价，同差先早到期再低行权价。日常默认美东16:30之后短间隔重试，仅所需两份日线已齐才记有效输入；早收市须按日历，不把失败标已采集日期。
HV20：20个日对数收益的样本标准差×√252。IV rank用一年有效IV极差，极差0则无数据；百分位用历史有效值严格低于当前IV的占比；缺样本不当0。这些口径仅在代码得到可核验结果后输出数值。

## 外部数据边界
stock-ta开放的prices实际是“缓存最新价”，不是日线接口；structure给data_end/levels/momentum而非原始日线。不能声称已拿到日线/HV样本。quote须保留price/at/session及close/closePending，earnings-date只回未来120天已公布日期，未公布不等于无财报。
外部调用只传短代码与契约必要过滤，不传账户、成本、仓位、邮件或整句请求；提供方缺失只降级相关部分；内部来源或写操作转“请对 stock-ta 说……”。
