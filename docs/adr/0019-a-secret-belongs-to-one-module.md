# 每个密钥属于一个模块

2026-11-13 在使用者授权的无人值守运行中拟定，使用者合并即确认。它是 Gmail 计划（`docs/multi-channel/gmail-plan.md`）的 M1。

## 问题

模块包在 `feed.json` 和 `tool.json` 的 `secrets` 里点名密钥，宿主就把 `secretsFile` 里同名的值放进模块代码的环境变量。今天点名不受限：任何一个包写 `"secrets": ["TELEGRAM_BOT_TOKEN"]`，它的代码就拿到 Telegram 机器人的 token。`mail` 要两个 Gmail token，读邮件的给 `mail` 模块，写草稿的（`gmail.compose`，也能发信）只在宿主手里（research.md 7.2 节）。点名不受限时，「写草稿的 token 不交给模块」就只是约定。

另外，`just module check` 跑工具的测试用例时，交给用例的是 `secretsFile` 里的真值。装模块、改模块、检查模块都会让工具拿真 token 发请求。

## 决定

**一张表定主人。** `src/modules/secret-owners.ts` 的 `SECRET_OWNERS` 把密钥名映射到一个模块名或 `"host"`：

| 密钥 | 主人 |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`GMAIL_READ_REFRESH_TOKEN` | `mail` |
| `POLYGON_API_KEY` | `stock-ta` |
| `GMAIL_DRAFT_REFRESH_TOKEN`、`TELEGRAM_BOT_TOKEN`、`MASSIVE_API_KEY`、`STOCK_HEATMAP_API_KEY`、`FINNHUB_API_KEY` | 宿主 |

包的检查（`src/modules/validate.ts`）对每个 feed 和工具点名的密钥查表。点名别的模块或宿主的密钥就报错，一行写明密钥名和主人。表里没有的名字，只有以本模块的前缀开头才放行：模块名转大写、`-` 换成 `_`，再加 `__`，例如 `MAIL__`、`STOCK_TA__`、`PERSONAL_TAX__`。新模块用自己前缀的密钥不用改宿主（计划 Appendix E 第 10 条的默认）。

前缀以两个下划线收尾，是因为单个 `_` 分不清主人：`MAIL_X_TOKEN` 既可能是 `mail` 的 X token，也可能是模块 `mail-x` 的 token，`stock` 也能点名 `STOCK_TA_KEY`。检查只看得到这一个包，不知道装了哪些别的模块，所以规则要只凭名字就能判定。模块名里的连字符只能单个出现在字母数字之间（`mail--x`、`mail-` 都拒绝），模块的大写名里就不会有 `__`，一个密钥名最多落在一个模块的前缀下。`just module check`、`just module try` 和宿主装包时的检查是同一段代码，所以三处一样拒绝；检查不过的包不会打开，它的代码就拿不到任何密钥。

**宿主自己读密钥不经过这张表。** 表只管值能到哪个模块的代码里。宿主自带的 `us-market` 来源也读 `POLYGON_API_KEY`（它是行情密钥的别名之一），这不和「属于 `stock-ta`」冲突：主人说的是哪个模块的包能点名它。宿主读 `TELEGRAM_BOT_TOKEN`、行情密钥，`just google-auth` 读 OAuth 客户端，M7 宿主用写草稿的 token，都照旧用 `readSecret`。

**工具的测试用例只用假密钥。** 工具的 `cases.json` 和 feed 的样例一样，拿到的是固定的假值（`fixtureSecrets`），不是 `secretsFile` 里的值。检查因此不再读 `secretsFile`，`scanPackage`、`runCasesAsync` 和宿主的模块表都去掉了读密钥的参数。

**一个 token 一个 scope。** `just google-auth read|draft` 每次只申请一个 scope，不带 `include_granted_scopes`。Google 返回的 `scope` 不正好是申请的那一个就拒绝，什么都不写。读和写草稿的 token 各自能撤。

## 没有采用的做法

- **前缀只加一个 `_`，再查装了的别的模块。** 名字好看（`MAIL_API_KEY`），但 `just module check` 要读状态目录才判得了，而且结果取决于装的先后：先装 `mail` 点名了 `MAIL_X_TOKEN`，后装的 `mail-x` 才被拦下。
- **表外的名字一律拒绝。** 每个新密钥都要在表里登记，是一个宿主 PR。计划 Appendix E 第 10 条的另一个选项，使用者可以改。
- **在运行时（gateway、feed 调度）再查一次表。** 检查不过的包不会打开，运行时只给打开的包的代码传值，再查一次是重复的防线。单人 MVP 不防恶意模块（`design.md` 第 9 节）。
- **保留检查时用真密钥，让工具用例能对真接口试一次。** 检查是找错，不是联调；用真 token 发请求的事应该由使用者显式去做（`just google-auth read --check`）。

## 代价

- 样例包 `personal-tax` 的 `EXAMPLE_BROKER_TOKEN` 改名为 `PERSONAL_TAX__BROKER_TOKEN`，包的摘要变了。别人照旧的样例写了不带前缀的密钥名，检查会报错，报错一行写明该用的前缀。
- 工具的用例不能再验证「拿到真密钥能连上接口」。要验证，用 `just module try` 的预演（临时宿主在运行时照旧拿 `secretsFile` 的值），或者模块自己的命令。
