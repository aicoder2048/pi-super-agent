---
name: principle-freshness
description: 解释行情时间、时效敏感信号、缺少信号或缓存不新时使用。区分数据时间与发现时间，并保留延迟和未知范围。
---

# 延迟与不确定性

## 步骤

核对 data_start、data_end、discovered_at 与 delay_minutes。本模块的工具只读模块自己的日线数据库，不联网。这个库由 scan feed 每个交易日收盘后扫一次自选股和 QQQ、SPY 写成，每次扫描在 scan-runs 里记一行：先用 data query scan-runs（limit 写 1，最新的排在最前）看最近一次扫描的 tradingDate、outcome 和 errors，outcome 是「失败」或者 errors 里有要问的标的时，直接说明这只的数据停在哪天。用 prices 看缓存的 data_time 和 stale，structure 的 data_end 就是它用到的最后一根完整 K 线。不在自选股里的标的没有日线，请使用者先加进自选股，等下一次扫描。现价看 quotes：自选股的 Massive 快照，交易时段每分钟一行，at 是数据时间，比现在晚约 15 分钟；不在自选股里的股票没有这一行。查一只的现价用 data query quotes，where 写 { symbol: "NVDA" }，limit 写 1，最新的一行排在最前。缓存不是最新交易日时直接说明，不宣称已经更新行情。

## 证据

回答注明数据时间和行情延迟，默认 15 分钟。保留 time_sensitive 与 warning。数据不足、预热不足、结果被裁剪或工具失败时，直接说明证据范围。

## 局限

发现时间不是实时行情时间。第一次扫描补齐两年数据时，历史信号的发现时间都是那次扫描的时间，说「最近的信号」只按 data_end 算。未返回信号不证明市场没有风险。缓存覆盖不到的时间段，不能拿来验证当时的触发。
