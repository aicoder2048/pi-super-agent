# S4：旧 Mac 上装 stock-ta 的记录

2026-11-13（美东 11-12 晚上）在旧 Mac（Intel Xeon E5-1620 v2，macOS 12）上做。只记命令输出的摘要，不写机器名、用户名和路径。

| 步骤 | 结果 |
|---|---|
| 部署前 | 旧 Mac 在 b82a4eb（#91），工作区干净，服务运行中，us-market、module-builder、pi-pi 打开，没有 uv |
| `just redeploy` | 更新到 7129edd（含 G5、S1 到 S3），心跳正常，网页有应答，Telegram 已连上 |
| `git ls-remote`（store 凭据） | 打印 c9e7536，没有问密码 |
| 装 uv（官方脚本） | uv 0.13.8 |
| `just module setup stock-ta` | 12 秒装好（含下载 CPython 3.12.16 和 numpy、pandas 的 wheel），`files/venv-abf4c80c67b8` 161 MB |
| 密钥 | 密钥文件里有 `POLYGON_API_KEY`，没有 `TA_ROOT`（只查了有没有这一行） |
| 导入笔记 | 18 份都导入了 |
| `just module check` | `ok stock-ta@0.1.0 ... knowledge=19 data=3 tools=7 skills=3 feeds=2 agents=5 evals=2` |
| 自选股 | 照 us-market 的自选股写了 9 只：META TSLA NVDA AAPL MSFT AMZN GOOGL SPY QQQ |
| `just module on stock-ta` | 4 秒后第一拍开始，约 73 秒后 `scan-runs` 一行：交易日 2026-11-12，换上，9 只，新信号 5321，没有出错 |
| 日线 | 9 只各 502 根，2024-11-12 到 2026-11-12 |
| `structure` NVDA（直接调工具） | `data_end` 2026-11-12T21:00Z（最近一个交易日收盘）；热身一次后连调 10 次，中位数 5872 毫秒（5752 到 5957） |
| 重装服务（`just redeploy --no-pull`） | 服务 PATH 里有 uv 的目录，stock-ta 仍在运行，没有起 `ta` |
| 从宿主问「NVDA 现在的支撑阻力和动量怎么样」 | 领队派给结构与形态和趋势与动量，约 112 秒出汇报，13 次工具调用；汇报写出 11-12 收盘的数据时间，引了 TA09、TA01、TA02、TA52 的原文 |

## 和计划的预算比

- setup 12 秒，预算 10 分钟，通过。
- 第一次扫描约 73 秒，预算 5 分钟，通过。
- `structure` 中位数 5.9 秒，预算 3 秒，**没通过**。本机同一份工具中位数约 1.1 秒（S3）。旧 Mac 上 Python 起来加 import pandas 只要 0.5 秒左右，剩下是 `ta` 在这颗 2013 年的 CPU 上算结构的时间。后果是一份技术分析汇报要两分钟左右，功能不受影响。

## 还没做

- 计划的 lane 9 要「下一拍按 cursor 提前返回」。feed 每小时一拍，重装服务后要等下一拍，没有在这次记录里。
- lane 10 要使用者自己从手机问一次。
