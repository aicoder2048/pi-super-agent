# 四封虚构邮件：未来解析器验收素材，不是实测

来源：提供材料 `docs/modules/option-ta-p1/mail-samples/`，P1制作日期2026-11-17。这里保留四封虚构.eml和原.expected.json草稿；人名、账户短码、地址、交易数字都是虚构，不是theta私人邮件。未复制原README里的过时HTML未定说明。

- 原expected草稿的fills/skipped数量：cc-open 4/2；csp-partial 2/0；mixed 3/9；cp1252 3/0。这些不是当前handler输出。csp-partial文件名不代表真实部分成交用例，四封都无部分成交。
- 原expected中的浮点价格、布尔partial_fill、limit/executed_at等属于旧草稿，不能直接作为当前collection入库形状。P3要规范价格为4位小数字符串、partial_fill为文字，核实未知字段和乘数，另写严格断言。
- `feeds/fills/fixtures/*.json`是当前宿主输入：MIME按各part charset/transfer encoding在构建时解码成body/html；顶层from改为虚构交易台以模拟生产重定向，而.eml原件仍保留手动转发形状。所有fixture都不配置生产brokers白名单。
- 宿主现已确定可选html（<=256KB）及截断标记；不是待定字段。附件在当前fixture置空，因为P2解析器不读附件，不代表已测试附件或宿主MIME连接器。
- **当前真实期望**：records=[]、可见problem.id=`option-ta-fills-not-implemented`、不推进cursor、没有成交/跳过行解析结果。`tools/strategy/tests/p2.test.ts`严格断言这个边界。module check只验证handler格式/不抛错；本地测试另断言未实现输出，不声称解析通过。

P3解析完成后才把原expected草稿审定为新schema的records与skipped断言，并补真正累计部分成交/增量均价精度/乱序/重复/同表重复键/手工冲突、BTO/STC/Roll、事件/调整交割物、纯文本歧义和HTML截断。禁止现在把原expected塞进feed输出充成功。
