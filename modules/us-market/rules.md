# 美股行情模块的规则

## big-move
来源: us-market
专家：market-analyst, technical-analyst, news-researcher
个股涨跌到达 5% 档或更高，或 SPY、QQQ 到达 2% 档或更高时，开一个任务核实这次波动：用 lookup 查报价和分钟 K 线，先看大盘是否同向，必要时读公开新闻找原因，再用一两句话汇报结论，写明报价时间（行情可能延迟）。任务订阅触发所在的线程，也就是这只股票当天的行情线程，当天之后的波动直接交给它。

## small-move
来源: us-market
个股 3% 档、SPY 和 QQQ 1.5% 档、放量，这些只是背景。没有别的理由时可以忽略，不必为它们开任务。
