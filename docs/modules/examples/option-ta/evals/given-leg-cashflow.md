---
name: given-leg-cashflow
uses: tools/strategy
expect: CALCULATED_PARTIAL, -63.7500, 60.1000, -3.6500, 未扣费
---
只做给定输入的权利金现金流校验，不做开仓或Roll建议。这是虚构离线算术用例，张数已指定，两腿乘数均明确给定为10，不得默认100，也不代表工具核验了真实合约。请实际调用strategy，用下列对象的JSON文字作为request：
{"operation":"cashflow","legs":[{"side":"BTC","price":"2.1250","qty":3,"multiplier":10},{"side":"STO","price":"3.0050","qty":2,"multiplier":10}]}
转述工具状态、两腿有符号现金流和合计，单位USD，保留四位小数，并说明净收还是净付。佣金费用未知，说明结果口径以及为什么不是整链盈亏、税务结果或可成交报价；不要把未知费用写成0。不查行情、不写集合、不代替工具心算、不追问。
