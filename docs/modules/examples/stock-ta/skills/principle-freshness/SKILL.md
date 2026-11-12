---
name: principle-freshness
description: 解释行情时间、时效敏感信号、缺少信号或缓存不新时使用。区分数据时间与发现时间，并保留延迟和未知范围。
---

# 延迟与不确定性

## 步骤

核对 data_start、data_end、discovered_at 与 delay_minutes。本模块的工具只读技术分析项目的本机缓存，不联网：用 prices 看缓存的 data_time 和 stale，structure 的 data_end 就是它用到的最后一根完整 K 线。缓存不是最新交易日时直接说明，不宣称已经更新行情。

## 证据

回答注明数据时间和行情延迟，默认 15 分钟。保留 time_sensitive 与 warning。数据不足、预热不足、结果被裁剪或工具失败时，直接说明证据范围。

## 局限

发现时间不是实时行情时间。未返回信号不证明市场没有风险。缓存覆盖不到的时间段，不能拿来验证当时的触发。
