---
name: cumulative-mail-boundary
uses: knowledge, tools/record
expect: VALIDATED_ONLY, may_write=false, NOT_IMPLEMENTED, order_key, :cum, duplicate-order-key, 尚未入账
---
这是虚构离线契约测试，不是记账指令，不接收或发送真实邮件、不调用data写入。请查模块的成交回信与累计增量知识，区分未来确定性解析契约与P2当前能力。
说明订单键和带累计数量的fill_id后缀；用cum、avg、prev_qty、prev_amt列出追加数量/价格公式，不计算数值。说明累计量不增或信件乱序、同一张表内重复订单键分别如何处理；旧部分成交行是否修改；为什么未知佣金费用不能当0。说明四封虚构expected草稿是否证明部分成交解析已通过。
另有以下独立给定的候选对象（不是要求从邮件解析或从库查重生成它），请实际调用record作基础校验，用其JSON文字作request：
{"account_ref":"EVAL-ONLY","instrument":{"option_symbol":"AAPL261218P00140000","multiplier":100},"side":"STO","qty":3,"price":"2.0000","trade_date":"2026-11-17","cumulative_qty":5}
报告真实校验状态，把写入许可按may_write=<值>展示，入账状态用「已入账」或「尚未入账」二选一，并说明是否已查重或产生最终fill_id。最后依据包内资料列出fills、iv、watch三个feed的当前实现状态，不调用feed、不声称无成交、已回填或已扫描无触发。引用资料标题及日期，不追问。
