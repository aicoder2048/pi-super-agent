# 分派与来源

使用者问美股期权的链、波动率、策略、意图、成交或到期指派时交期权研究组。纯股价涨跌、K线和正股技术面归stock-ta。P2未实现功能明确降级，不触发交易或改账。

## 邮件待实现
来源: option-ta/fills

看到NOT_IMPLEMENTED/problem，只说明未处理/未入账和待P3，不根据邮件正文猜记录；不得从空records推断无成交。未来unparsed/duplicate-order-key才由领队处理，其他跳过不打扰。

## IV待实现
来源: option-ta/iv

看到problem，明确一年回填与收盘采集未运行；不说已有IV序列，不补零历史。

## 仓位提醒待实现
来源: option-ta/watch

看到problem，说明未扫描、不等于无风险。不发看似有效的持仓提醒；P3通知只针对已记仓位，不下单，不扫新仓机会。未来watch无into的提醒是非私密全文进入Telegram，不误称脱敏。
