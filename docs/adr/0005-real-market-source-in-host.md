# 真实行情来源跑在宿主里，模块只写数据，Worker 经宿主查数

美股行情（`us-market`）是第一个由宿主自己运行的来源。`modules/us-market/` 只有 `module.json` 和 `rules.md`：`module.json` 的来源条目多了 `title`、`description` 和 `feed: { kind: "massive-stocks", settings }`，宿主不加载模块目录里的任何代码。`feed.kind` 对应的代码在 `src/sources/market/`，所有 kind 登记在 `src/sources/feeds.ts` 一处。宿主启动时为每个声明了 `feed` 的来源建好它（模块里的 `settings` 是默认值，`stateDir/config.json` 的 `sources.<来源名>` 按字段覆盖，拼错字段直接报配置错误），随宿主启停，给它内核的 `submitTrigger` 和它自己名下的 `source_cursors` 一行。

轮询放在宿主里，是因为它要和宿主同生共死：宿主被 Watchdog 拉起时看盘也跟着回来，游标和触发在同一个 SQLite 里，先提交触发再写游标，外部 id 只由代码、纽约交易日和信号决定，崩在两步之间重放时内核按 `(source, externalId)` 只存一条。免费档每分钟只有 5 次请求，看盘和 Worker 查价必须共用一份额度，所以宿主里只有一个 `MarketClient`：串行队列、两次请求至少隔 12 秒、遵守 429 的 `Retry-After`、看盘请求排在查询前面。

密钥只在宿主里。来源依次是环境变量 `STOCK_HEATMAP_API_KEY`、`MASSIVE_API_KEY`、`POLYGON_API_KEY`，再是 `config.json` 里 `secretsFile` 指向的 `.env`（文件不存在时启动报错）。宿主不改自己的 `process.env`；隔离放在启动子进程的地方：宿主启动 Worker 和模块的 `prepare` 时，名字以 `_API_KEY`、`_ACCESS_KEY`、`_TOKEN`、`_SECRET`、`_PASSWORD` 结尾或以 `SECRET_` 开头的变量一律不传，行情的三个变量名都在其中。Worker 用的 Pi 从 `~/.pi/agent/auth.json` 读 openai-codex（OAuth）和 deepseek 的凭据，不需要其中任何一个变量，所以没有放行名单；只靠环境变量给模型密钥的配置，Worker 会拿不到。密钥只放在 `Authorization: Bearer` 头里，不进网址、日志和错误信息；错误信息是固定的中文，不带网址、头和响应正文。地址只允许 `https://api.massive.com` 和 `https://api.polygon.io`。没有密钥、401、403 时看盘停用，日志一行，页面「关注的来源」里写明原因（如「未配置行情密钥」）。网络错误、5xx、429 会重试；连续 15 分钟取不到行情时，用 watchdog 来源提交一条通知，由幕僚长告诉使用者一次，恢复后清零。

Worker 查数据用一个只读工具 `lookup { source, op, args }`，经已有的 Worker socket（按任务令牌校验）交给宿主，宿主转给对应来源。`us-market` 的操作只有 `quote`、`bars`、`session`，参数严格校验（代码、日期格式、枚举，多余字段拒绝），只回数字和合法代码，不回外部文本。这一点在客户端边界保证：快照里代码不是本次请求的那几只、价格或时间不是有限正数的行，K 线里任一字段不是有限数的根，都直接丢掉，所以触发正文、线程标题和查询结果里只有校验过的代码和数字。每种依据都有这个工具，包括推断任务；可查的来源和操作写在工具描述里，因为推断任务没有规则，不加载模块 skill。

## Considered Options

- **独立进程往投递目录写文件（像玩具行情）**：模块边界最干净，但要自己的保活、自己的状态文件、自己的额度；Worker 查价要么第二份密钥和额度，要么再开一条通道。
- **模块自带代码，宿主动态 import**：模块从「数据」变成「任意代码」，宿主要定义插件接口和版本，换不来什么。
- **给 Worker 一个读密钥的 bash 查价脚本**：密钥进了 Worker 能读到的地方，推断任务没有 bash 用不了，还绕过共享额度。

## Consequences

- 加一种行情或别的平台来源，是在 `src/sources/` 下加一个目录、在 `FEEDS` 里加一行，模块仍只写数据。
- 线程按代码按纽约交易日分（`thr_us-market:NVDA:2026-11-09`），当天后续波动直达订阅它的任务，第二天的波动回到 Router。
- 维护一张 NYSE 提前收盘表（`session.ts` 的 `EARLY_CLOSES`，2026 到 2028 年，取自 nyse.com/markets/hours-calendars：2026-11-27、2026-12-24、2027-11-26、2028-07-03、2028-11-24），这些天 13:00 收盘，之后的成交不算常规时段；每个日期配着下一个交易日，那天的放量均量按前一日 210 分钟算。表要每年按 NYSE 公布的日历补一次，没补的年份半天交易日会按 16:00 收盘处理。
- 全天休市不维护表：只认日期是今天、时间在常规时段内的报价；今天没见过新鲜报价、连续 5 轮都没有、并且开盘已过半小时，才按休市处理，当天不再请求。宿主 10:05 才起来时一次空响应不会让当天停看。
- 密钥仍在磁盘上，同一系统用户下有 bash 的 Worker 能读到 `secretsFile`；Worker 的 bash 是登录 shell，用户的 profile 里若导出了密钥，也会重新出现在命令的环境里。我们的代码路径保证它不进模型上下文和网址；更强的隔离要等 Worker 沙箱。
- 页面上的停用原因随快照送出，宿主运行中才出现的 401 要在网页重新连接后才看得到。
