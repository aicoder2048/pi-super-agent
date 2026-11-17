# 共享连接器和模块自己的密钥（设计稿）

状态：草稿第 2 版，2026-11-16。使用者同意方向；第 1 版经两个对抗复查（不同模型）找出 11 个能复现的问题，本版逐条改过，见文末「复查改了什么」。C1 见 ADR-0029；C2 已按第 3 节落地，见 ADR-0031，取代 ADR-0019 的归属表。

## 为什么要改

option-ta 要从券商的成交确认邮件里记成交。今天读 Gmail 的代码和授权都在 `mail` 模块里，密钥按 ADR-0019 归 `mail`，别的模块用不了。照现状，option-ta 只能再写一遍读 Gmail 的代码、再抄一份 Gmail 授权。

这不是设计的本意。`design.md` 第 3 节写着：外部服务由宿主的连接器提供，几个模块可以用同一个连接器，各有各的设置和进度。做 Gmail 时先让 `mail` 自带代码，「连接器可以等第二个模块也要同一种服务时再做」（`docs/multi-channel/research.md`）。option-ta 就是第二个模块。

## 使用者定下的原则（2026-11-16）

1. **模块之间扁平且隔离。** 一个来源的触发只进同一个模块的任务，规则只写本模块的来源，任务只用本模块的能力（ADR-0018 不变）。
2. **外部服务是共享的基础设施。** 谁需要谁来拿，经宿主的连接器拿。`mail` 不用知道 option-ta 存在，幕僚长不参与转交。
3. **密钥分两类。**
   - **身份类**：代表使用者本人的账号和授权，例如 Gmail 授权、X 账号、大模型的 key、Telegram 机器人。归宿主，只存一份，经连接器或宿主自己使用，不交给模块代码。
   - **业务类**：领域用到的数据服务的 key，例如 Polygon/Massive 行情、Finnhub。归模块，每个模块自己存一份，值相同也可以。

   判断方法：它代表的是「你这个人」，还是「这个领域买的一项数据服务」？

## 设计

### 1. 宿主的 `mail` 连接器

**授权。** 连接器用宿主的身份类密钥（`GMAIL_READ_REFRESH_TOKEN` 和 OAuth 客户端），`just google-auth read` 照旧写进宿主的 `secretsFile`。`google.ts` 从 `mail` 模块挪进宿主。

**feed 怎么用它。** feed 写 `"connector": "mail"`，同时**必须**带 `handler`。连接器按 feed 的过滤条件取信，把信（头、正文、附件清单）交给 handler；handler 交回行、触发和它自己的进度。声明式（不带 handler）的 mail feed 这一版不支持：今天 `mail/inbox` 的触发要按 Gmail 会话分线程、要拼出发件人、要裁剪长度，这些只有 handler 做得了（复查 A1）。

**过滤条件。** 写在 `feed.json` 的 `settings` 里：一组发件人地址或域名，或者 `"senders": "<本模块的集合名>"`，表示读本模块这个集合当名单（`mail` 的名单就是集合 `senders`）。

**节拍。** 用 `mail` 连接器的 feed 必须写 `every`，检查不通过就报错。今天调度器遇到没写 `every` 的 feed 什么都不跑，也不报（复查 A7）。

**两格进度。** feed 的状态从一格 `cursor` 变成两格：
- `connectorCursor`：连接器的 Gmail `historyId`，handler 看不见、改不了。
- `cursor`：handler 自己的进度，和今天一样。

一拍里，连接器先按 `connectorCursor` 取新信交给 handler。handler 成功，宿主存下行、触发、`cursor`，最后推进 `connectorCursor`。handler 失败或超时，`connectorCursor` 不动，下一拍重取同一批；连续 3 次失败的同一封信挪进拒收，和 `inbox` 连接器的规则一样（复查 A2）。

**私密。** 用 `mail` 连接器的 feed 一律算私密，`into` 必须是 `private` 集合，不写 `into` 或写了可分享的集合，检查报错。今天私密与否只看 `into`，不看连接器（复查 A4）。私密 feed 只放出它点名的字段（ADR-0020 不变）。

**问题提示按连接器报一次。** 授权失效、隔了太久没查，是连接器的问题，不是某个 feed 的。宿主按连接器去重，只发一条提醒，写明影响哪些 feed。名单为空、名单写法不对这类是 feed 自己的问题，照旧按 feed 报（复查 A7）。

**附件。** 工具在 `tool.json` 写 `"fetch": "mail.attachment"`，宿主在运行工具代码**之前**按参数里的信件编号和附件编号，把附件下载进这次调用的临时目录，把路径交给工具。工具读本地文件，不再联网、不再要 Gmail 密钥。`fetch` 和 `port` 可以同时写，所以 `read-attachment` 仍能用 `ocr`（复查 A3）。

### 2. `mail` 模块改成用连接器

- `mail/inbox` 改成 `"connector": "mail"` 加 handler，过滤条件是集合 `senders`。handler 里拼通知、分线程、裁剪的代码不变，只是不再自己取信。使用者看到的通知、三行摘要、线程、名单、问题提示都不变。
- `read-attachment` 改成 `"fetch": "mail.attachment"` 加 `"port": "ocr"`。
- `mail` 的样例（`fixtures/`，main 上 10 个）改成「连接器交来的信」的形状，继续给 handler 当用例，`just module check mail` 照旧跑它们。实现（PR #158）留下 8 个 handler 样例，另有 10 个 parity 回放把 main 上的 10 个样例经连接器重放一遍，对照通知不变。连接器本身的取信、进度、拒收，在宿主的测试里用假 Google 服务覆盖（复查 A1 附注）。

### 3. 模块自己的 `.env`

- 位置：`<stateDir>/modules-data/<模块>/.env`。属于实例数据，不进模块包，不会进公开仓库。拿掉模块包时原样留着；`just module purge` 时随数据目录一起删。
- 模块的 feed 和工具在 `secrets` 里点名，宿主只从这个模块自己的 `.env` 取值。文件不存在当作空，feed 和工具照旧报「缺密钥」，不能抛异常（复查 B3；今天的读法遇到不存在的文件会抛 `ENOENT`）。
- 宿主自己用的身份类密钥照旧从全局 `secretsFile` 读，包括写草稿的 `GMAIL_DRAFT_REFRESH_TOKEN`（`googlePort`）和连接器的授权。只有交给模块代码的那一路改成按模块读（复查 B3）。
- 模块代码不再读全局 `secretsFile`，所以不再需要 ADR-0019 的归属表和 `<模块>__` 前缀。
- 包里点名了身份类密钥名（例如 `GMAIL_READ_REFRESH_TOKEN`、`TELEGRAM_BOT_TOKEN`、模型 key），检查给一行提醒，说明它应该走连接器。是提醒，不拦截。
- **预演。** `just module try` 把真实的 `modules-data/<模块>/.env` 复制进临时状态目录，预演里的工具照旧拿到真 key（复查 A5、B2）。
- 写 `.env`：手动编辑，或 `just module secret <模块> <名字>` 交互写入（不回显，权限 600）。

### 4. 模块之间的关系不变

见原则 1。等真出现一个领域模块要读另一个领域模块数据的需求，再单独讨论。

## 迁移

- **stock-ta 的 key 是复制，不是移走。** 把 `POLYGON_API_KEY`、`FINNHUB_API_KEY` 复制进 `modules-data/stock-ta/.env`，全局 `secretsFile` 里的留着：宿主的 `just market-smoke` 还从全局读这两个（`src/sources/market/key.ts`）（复查 B4）。
- **提示文字跟着改。** stock-ta 的 `massive.ts`、`tools/earnings-date/index.ts`、`feeds/quotes/index.ts`、`feeds/scan/index.ts` 里「在宿主的密钥文件里加一行」改成指向模块的 `.env`；`docs/modules/stock-ta.md`、`docs/deploy/home-mac.md` 同步；`tests/integration/stock-ta.test.ts` 里断言「密钥文件」的三处跟着改（复查 A6、B4）。
- **部署。** `just redeploy` 只拉代码、重装服务，不会复制 key。C2 上老 Mac 时，部署步骤是先建 `modules-data/stock-ta/.env`，再 `just redeploy`，再查 stock-ta 的 feed 有没有报缺密钥（复查 A6）。

## 分期

顺序改了：先做连接器，再做模块 `.env`。反过来做，中间那段 `mail` 的收件和读附件都会因为拿不到 Gmail 密钥而停（复查 B1）。

| 期 | 内容 | 验证 |
|---|---|---|
| C1 | 宿主 `mail` 连接器：过滤、两格进度、失败重取和拒收、私密、按连接器去重的问题提示、`fetch: mail.attachment`。`mail/inbox` 和 `read-attachment` 改走连接器 | 假 Google 服务回放：`mail` 的通知、线程、名单、问题提示和今天逐条一致；两个 feed 共用连接器、各自进度；handler 失败后同一批信重取；token 失效只发一条提醒；`just module check mail` 跑样例 |
| C2 | 模块自己的 `.env`；宿主只从它给模块代码取密钥；文件不存在当空；预演复制 `.env`；身份类密钥名的提醒；stock-ta 迁移和提示文字；新 ADR 取代 ADR-0019 的归属表 | stock-ta 只有自己 `.env` 时照常扫描；模块没有 `.env` 时报缺密钥而不是出错；`just module try stock-ta` 的工具拿到真 key；`googlePort` 照常写草稿 |
| C3 | option-ta 的 `fills` feed 用 `mail` 连接器 | 并入 option-ta 的构建 |

## 待定

1. 模块 `.env` 放 `modules-data/<模块>/.env`，还是放模块包目录里、用 `.gitignore` 挡住。草稿选前者。
2. 身份类密钥的清单今天是 Gmail 授权、Telegram、模型 key、GitHub token。X 账号等接入时再加。

## 复查改了什么

两个复查（A：opus；B：会话模型）各自在 `origin/main` 5c99224 上跑探针。下面每条都有能复现的输出，协调者抽查重跑过其中 7 条（ENOENT、私密只看 `into`、单格进度、预演只复制 `files/`、stock-ta 四处提示文字、调度器跳过没写 `every` 的 feed、`read-attachment` 已占用 `port: ocr`）。

| 编号 | 问题 | 本版的改法 |
|---|---|---|
| B1 | 先做模块 `.env` 再做连接器，中间 `mail` 拿不到 Gmail 密钥，收件和读附件都停 | 分期倒过来，先连接器 |
| A1 | 声明式 mail feed 的触发没有线程、拼不出发件人、不裁剪，`mail` 的行为会变 | mail feed 必须带 handler |
| A2 | 连接器的 historyId 和 handler 的进度挤在一格，handler 会把它盖掉；失败时怎么办没写 | 两格进度；handler 成功后才推进；失败重取，三次拒收 |
| A3 | 工具没有取连接器数据的办法，`port` 只能写一个且 `read-attachment` 已占用 `ocr` | 新增 `fetch: mail.attachment`，运行前由宿主下载附件，可和 `port` 并用 |
| A4 | 私密只看 `into`，「连接器的信默认私密」不成立 | mail 连接器的 feed 必须写进私密集合，检查报错 |
| A5 / B2 | 预演只复制 `files/`，不带 `.env`，工具在预演里拿不到 key | 预演复制 `.env` |
| B3 | 读一个不存在的 `.env` 会抛 `ENOENT`；`googlePort` 也走同一个读密钥口子 | 不存在当空；宿主自用的身份类密钥照旧读全局 |
| A6 / B4 | stock-ta 四处提示文字、两份文档、三处测试写死「宿主的密钥文件」；`market-smoke` 还读全局 key；`redeploy` 不会复制 key | 迁移清单补全；复制不移走；部署先建 `.env` |
| A7 | 连接器 feed 不写 `every` 能过检查但永远不跑；token 失效每个 feed 各报一次 | mail 连接器 feed 必须写 `every`；连接器问题按连接器去重 |
