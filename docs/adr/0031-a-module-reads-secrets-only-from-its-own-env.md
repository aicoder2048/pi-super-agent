# 模块代码只从模块自己的 `.env` 拿密钥

2026-11-16 按使用者的决定拟定（`docs/modules/architecture/connectors-and-secrets-design.md` 第 3 节，分期的 C2），使用者合并即确认。取代 ADR-0019 的归属表、`<模块>__` 前缀和「模块的密钥只从 `secretsFile` 取」这三部分，也取代 ADR-0029 里「包里点名这三个密钥，`just module check` 报错」那一句。ADR-0019 的其余决定（工具用例只用假密钥、一个 token 一个 scope）、ADR-0022、ADR-0029 的其余部分不变。

## 问题

ADR-0019 让模块代码和宿主共用一个 `secretsFile`，靠一张表管每个密钥能到哪个模块的代码里。表外的名字要带 `<模块>__` 前缀。这样每个新的业务密钥要么改宿主的表，要么用难看的前缀名；值相同的 key 两个模块也只能共用一行。更要紧的是隔离只靠检查：一个模块能拿到哪个值，取决于包的检查有没有拦住点名。

使用者 2026-11-16 定了密钥分两类。身份类（Gmail 授权、Telegram、模型 key、GitHub token）代表使用者本人，归宿主，只存一份，经连接器或宿主自己用。业务类（Polygon/Massive 行情、Finnhub）是某个领域买的数据服务，归模块，每个模块自己存一份，值相同也可以。

## 决定

**每个模块一个 `.env`。** 位置是 `<stateDir>/modules-data/<模块>/.env`，属于实例数据，不进模块包，也不会进公开仓库。拿掉模块包时原样留着，`just module purge` 时随数据目录一起删。

**宿主只从这个文件给模块代码取值。** feed 的 handler 和工具在 `secrets` 里点名，宿主（`src/secrets.ts` 的 `moduleSecretLookup`）按运行这段代码的模块找它的 `.env`，取同名的值，放进进程的环境变量。文件不存在当作空，点名的变量是空串（feed）或不设（工具），由模块自己报「缺密钥」，宿主不抛异常。每次调用都重新读文件，改了 `.env` 不用重启宿主。

**取值的口子带模块名。** 网关和 feed 调度器的 `secret` 是 `(module, name)`。网关传的是被运行的那份副本的模块（`copy.module`），不是调用方。C4 让一个模块调另一个模块开放的工具时，被运行的是提供方的副本，所以取的自然是提供方 `.env` 里的 key，使用方的 `.env` 里不必有。

**宿主自己的密钥照旧读全局 `secretsFile`。** 写草稿的 `googlePort`、`mail` 连接器的读授权、`just google-auth`、Telegram、`just market-smoke` 都照旧，经 `secretLookup`。这一路模块代码碰不到。

**模块代码不再读全局 `secretsFile`。** 归属表 `src/modules/secret-owners.ts` 和前缀规则删掉。包里点名什么名字都能过检查，因为它只能从自己的 `.env` 里读到值。

**点名身份类密钥只提醒。** `src/modules/identity-secrets.ts` 记着身份类的名字：`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`GMAIL_READ_REFRESH_TOKEN`、`GMAIL_DRAFT_REFRESH_TOKEN`、`TELEGRAM_BOT_TOKEN`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GITHUB_TOKEN`。包里点名它们，`just module check` 打印一行 `note`，说它应该走宿主的连接器，检查照常通过。X 账号等接入时再加。

**预演带上 `.env`。** `just module try` 把真实的 `modules-data/<模块>/.env` 复制进临时状态目录（权限 600），预演里的工具拿到真 key。工具的 `cases.json` 和 feed 的样例照旧只拿假值。

**写 `.env` 的命令。** `just module secret <模块> <名字>` 在终端里读一个值，不回显；从管道读时读整段输入。同名的行替换，其余的行不动，文件或目录不存在就新建，权限 600。

## 没有采用的做法

- **`.env` 放在模块包目录里，用 `.gitignore` 挡住。** 包会被复制进模块仓库、被 `just module check --previous` 比较、被算摘要。密钥放在包里，一次手误就进了公开仓库。实例数据目录本来就不进仓库。
- **身份类密钥名照旧拒绝。** C1 让检查拒绝包点名 Gmail 授权，那时模块代码还读全局 `secretsFile`，拒绝是唯一的防线。现在模块只读自己的 `.env`，点了名也拿不到宿主那一份，拒绝不再保护什么，反而挡住「使用者自己给某个模块另配一份」这种合法用法。所以改成提醒，这是规格第 3 节写明的。
- **按调用方的模块取密钥。** C4 的外部调用会拿使用方的 `.env` 去调提供方的服务，使用方就得抄一份提供方的 key。
- **`.env` 缺失时报错。** 一个刚装好的模块还没写 key 是常态，模块自己说「缺密钥、去哪里加」比宿主报一个文件错误有用（设计稿复查 B3）。

## 代价

- 业务类密钥两个模块都要用时要各存一份。值变了要改两处。
- 上线时 stock-ta 的 `POLYGON_API_KEY`、`FINNHUB_API_KEY` 要先复制进 `modules-data/stock-ta/.env`，全局里的留着（`just market-smoke` 还读全局）。`just redeploy` 不复制 key，步骤见 `docs/deploy/home-mac.md` 的「模块自己的密钥」。
- 没有限制谁能写 `.env`：使用者开的任务的 `bash` 读写得到状态目录（ADR-0021 记过），和 `secretsFile` 一样。
