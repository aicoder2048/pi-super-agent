# R6 旧 Mac 部署记录

计划 `docs/modules/us-market-retirement-plan.md` 的 R6。2026-11-13（周五）美东 17:56 收盘后，使用者放行后在旧 Mac 上部署。步骤照 `docs/modules/stock-ta.md` 的「旧 Mac 部署」。这里只写条数、种类和 SHA，不写盯盘条件的代码和数值，不写机器名和路径。时间都是 UTC。

## Lane 1 部署前预检（r6-before）

- 代码 `07d2114`，工作区干净。
- `just modules`：us-market 已停用，mail 运行中，stock-ta 运行中。
- stock-ta `_conditions` 1 行，种类 `day-move`。预检脚本按 `symbol` 列分组，那一列不存在，查询报错；随后在备份前读整行补上，备份里的 `data.db` 也是 1 行 `day-move`。
- stock-ta 自选股 11 行，9 只不同代码（从部署前备份的 `data.db` 只读查）。
- `config.json` 的键：`models`、`secretsFile`、`sources`、`telegram`、`webHosts`。`sources` 只有 `us-market` 一项（`everySeconds: 300`）。
- 当天到部署前的提醒和通知行：`mail/inbox` 8、`module:stock-ta` 1（alert）、`notify` 3、`us-market` 1（alert）。
- 当天到部署前的触发：`conversation` 14、`mail/inbox` 7、`us-market` 3。最后一条 `us-market` 触发在 15:30。

## Lane 2 形状检查（r6-shape）

三项都对。`config.json` 比 R5 期望的多出的只有 `sources.us-market`，没有 `modules.us-market`；us-market 开关是关；`_conditions` 1 行 `day-move`。

## Lane 3 删配置、旧代码重启（r6-config）

- 备份 `config.json`，用 `sqlite3 .backup` 备份 `state.db` 和 stock-ta 的 `data.db`，备份目录带时间戳，权限 700。
- 删掉 `sources.us-market`，`sources` 删空后整项删掉。之后的键：`models`、`secretsFile`、`telegram`、`webHosts`。
- `just redeploy --no-pull` 用 `07d2114` 重启，看门狗运行中，心跳 1 秒前。`just modules` 和删之前一样（us-market 已停用，mail、stock-ta 运行中）。

## Lane 4 换代码（r6-modules）

- `just redeploy` 拉到 `e222bb9`（R5 合并后的 main），服务运行中，心跳 1 秒前。
- `cp -R` stock-ta 包、`just module setup stock-ta` 以后，`just modules` 只有 mail 和 stock-ta 两行，没有 us-market。stock-ta 运行中，版本 0.1.0（`036959d812aa`），和 `just module check docs/modules/examples/stock-ta` 的 `digest=036959d812aa` 相同。

## Lane 5 部署后的条件（r6-conditions）

`_conditions` 1 行，种类 `day-move`，编号和参数与 lane 2 读到的整行相同。

## Lane 6 报价 feed（r6-feed）

`modules/stock-ta/feeds/quotes/feed.json` 里 `every` 是 60s；档位个股 5、8，SPY、QQQ 2、3；没有放量设置。

## Lane 7 测试通知（r6-notify）

`just notify` 发了一行「R6 部署完成」。2026-11-14 00:07 只读查 `state.db`，`telegram_messages` 里这一行 1 条，`sent_version` 1，有 `message_id`，没有 `gave_up`，写入时间 22:56:39。使用者看到后回一句确认即可。

## 部署后到 2026-11-14 00:07 的只读查看

- 提醒和通知行：`mail/inbox` 2、`notify` 1，没有 `us-market` 来源的新行。
- 触发：`conversation` 1、`mail/inbox` 2，没有 `us-market` 来源的新触发。
- 这段时间是收盘后，没有档位提醒是预期的。

## 还没做的

- Lane 8 网页截图（r6-page.png）。截图要用网页 token 打开页面，token 不离开旧 Mac 就截不到，旧 Mac 上又不写东西。等使用者打开网页看一眼，「来源」没有「美股行情」，stock-ta 卡片有「今日提醒」和报价两行，以前 us-market 的任务点得开。
- Lane 9、10 和性能要部署后第一个交易日（2026-11-16 周一）收盘后只读查看。
