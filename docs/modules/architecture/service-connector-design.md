# 模块之间的服务连接器（设计稿 C4）

状态：第 2 版，2026-11-16。第 1 版经两个对抗复查，改动见末尾「复查改了什么」。使用者 2026-11-16 定了五件事（下一节）。权限上的取舍单独写在 ADR-0030。还有一件要使用者定的事（「待定」第 1 条），它挡着 C4c。

## 为什么要做

stock-ta 是 option-ta 的底层。option-ta 的「方向与价位」专家要正股的趋势、支撑阻力、信号，stock-ta 已经有，背后是土拨鼠引擎和专家知识。option-ta 再做一套简化版，既重复又更差。

可模块是扁平且隔离的（ADR-0018）：任务只用得到本模块的能力。使用者否决了两条路：
- 经幕僚长中转：幕僚长要保持轻量；中转靠模型转述，数字会转错；会诊被拖长。
- option-ta 自己做简化版：重复。

选定的做法：一个模块可以把自己的几个**只读工具**开放出来，别的模块按名字调用，宿主替它在提供方那边运行。这和 `mail` 连接器是同一个思路：mail 连接器共享一种外部服务，服务连接器共享一个模块的只读能力。

## 使用者已定（2026-11-16）

1. **推断任务、feed 开的任务也能调别的模块开放的只读工具。** 理由和风险写在 ADR-0030，它部分取代 ADR-0018「几个决定」第二条的理由。
2. **`earnings-date` 进开放清单。** 它和 stock-ta 自己共用 Finnhub 的额度（下面「额度」一条）。
3. **规则 6「有私密数据的模块不开放」保留。** 理由补上：工具代码能读整个模块的数据，只能按整个模块来挡。
4. **`tools/note` 不开放。**
5. **方向不变。** 模块之间扁平隔离，外部服务经宿主共享。

## 规则

### 1. 提供方声明开放哪些

`module.json` 加 `exports`，列出开放的工具：

```json
{ "name": "stock-ta", "exports": ["tools/structure", "tools/signals", "tools/prices", "tools/quote", "tools/earnings-date"] }
```

- 只能开放 `effect` 是 `read` 的工具，或不写 `effect` 的纯计算工具。开放 `write` 工具，检查报错。
- 数据集合、知识、技能、专家、feed、规则都不开放。
- `tools/note` 不开放。它按 `sources` 取笔记原文，原文是 stock-ta 的知识，使用方要的是结论。
- 检查（`src/modules/validate.ts`）今天拒绝 `module.json` 里不认识的键，所以 `exports` 要加进 `readManifest` 的可选键。

### 2. 使用方在专家的 `uses` 里写全名

格式是 `<模块>/tools/<名字>`：

```yaml
uses: knowledge, tools/chain, stock-ta/tools/structure, stock-ta/tools/signals
```

考题（`evals/*.md`）的 `uses` 也可以写全名，表示这道题要用到这个外部工具。

**包检查要改。** 今天 `crossCheck` 的 `resolves` 把 `use` 按 `/` 拆成三段，第三段存在就判为不认识，所以 `stock-ta/tools/structure` 会报 `uses "…", which this package does not have`。专家和考题共用这一段，两处都报错。C4a 把它改成：形如 `<模块>/tools/<名字>`、模块名合法、不是本模块的，算外部工具，只给一行提醒（「外部工具，检查不了提供方有没有开放它」），不报错。检查只看得到这一个包，不知道装了哪些别的模块，所以不能查提供方。模块随时会装上、拿掉，宿主在调用时才判断（规则 6）。

### 3. 谁能调哪些外部工具

外部工具只来自使用方模块包里专家的 `uses`。网关按任务钉住的那份副本（`caller.pin`）读 `uses`，不按提供方读。

| 调用者 | 能调的外部工具 |
|---|---|
| 专家（`member` 是名字） | 它自己 `uses` 里的外部工具 |
| 领队（`member === null`，模块带 `agents/`） | 本队全部专家 `uses` 里外部工具的并集 |
| 单个助手（`member === null`，宿主没有派活台，`crew` 是空的） | 和领队一样，取并集 |
| 没有 `agents/` 的模块的助手 | 不能调外部工具 |

代码里领队和单个助手是同一种调用者：`src/host/workers.ts` 的 `#gatewayCall` 都传 `member: null`，`memberRefusal` 对 `null` 直接放行，所以今天领队能调本模块的全部工具，不看谁的 `uses`。外部工具不照搬这条：领队取并集，因为外部工具是另一个模块的能力，要有一处写出来，并集让领队和它派的专家看到同一份清单。

没有 `agents/` 的模块就没有地方写 `uses`。C4 不在 `module.json` 加一处模块级的 `uses`（YAGNI）。今天唯一的使用方 option-ta 带专家。真有不带专家的模块要用，再加。

### 4. 在提供方那边运行

外部调用的解析不走 `callerCopy`。`callerCopy` 按调用方的模块和钉住的版本找副本，用在外部调用上就会到使用方自己的包里找 `tools/structure`。外部调用的顺序是：

1. 在调用方钉住的副本里查成员（或并集）的 `uses` 有没有这个全名（规则 3）。没有就回 `not-in-uses`。`memberRefusal` 比对的是全名 `stock-ta/tools/structure`，不能拼成本模块的 `tools/structure`。
2. 读提供方当前在服务的版本：`ports.serving(提供方)`。每次调用都读，不缓存。
3. `copyOf(提供方, serving(提供方))` 取提供方的副本。
4. 在这份副本里找工具，并查它的 `module.json` 的 `exports` 有没有列它。
5. 对照权威表（`AUTHORITY`）。开放的工具都是只读的，所有调用者都过（规则 5）。
6. 调 `runTool(提供方副本, 工具, 输入)`。代码在提供方的副本里跑，数据目录是 `ports.dataDir(提供方)`，时限照旧是 `LIMIT_MS`。

2 到 4 任何一步不成立，回 `provider-absent`（规则 6）。调用方的任务钉住的是它自己模块的版本，外部工具不跟着钉。

**密钥。** 今天 `ports.secret(name)` 从全局 `secretsFile` 取值，外部调用照用即可：ADR-0019 的归属表让 stock-ta 点名的 `POLYGON_API_KEY`、`FINNHUB_API_KEY` 在全局文件里。C2 落地以后，宿主只从模块自己的 `.env` 给模块代码取密钥（`connectors-and-secrets-design.md` 第 3 节），`ports.secret` 要带模块名，外部调用传**提供方**的模块名，取提供方 `.env` 里的值。使用方的 `.env` 里不必有、也不该有提供方的密钥。

**额度。** `earnings-date` 和 stock-ta 自己的任务共用一份 Finnhub 免费额度，`quote` 和 stock-ta 的报价 feed 共用 Massive 的额度。宿主不替它们排队（`design.md` 第 10 节「宿主不再统一管额度」）。option-ta 的会诊把一次问答变成几次外部调用，额度用得更快。先不加排队，额度真不够时再按密钥名加。

### 5. 权限：只读，谁都能调

开放的工具都是只读的，按权威表 `read` 一行，所有调用者都能调：只听过使用者的请求任务、其他请求任务、规则任务、推断任务、模块 feed 开的任务。这是使用者 2026-11-16 定的，为什么现在可以接受、风险是什么写在 ADR-0030。

「只读」靠工具的 `effect` 声明和作者自律，代码层面不保证。工具代码在一个普通进程里跑，和宿主同一个系统用户，没有沙箱（`design.md` 第 9 节），能写提供方的 `files/`、能联网、能读状态目录。stock-ta 的 `ta.ts` 每次调用都先把数据库复制一份再读，因为 `ta` 读的时候也会写 SQLite 文件头。这种事检查器查不出来，靠作者。单人自用的 MVP 不防恶意模块。

### 6. 提供方不在时

**新拒绝码 `provider-absent`。** 以下几种情况回它，带一个固定的原因：

| 情况 | 原因（`note`） |
|---|---|
| 提供方没装 | `<提供方> 没装` |
| 提供方关着，或正在检查、调整数据结构（`serving` 是 `undefined`） | `<提供方> 没开` |
| 提供方当前版本的 `exports` 没有这个工具，或没有这个工具 | `<提供方> 现在没有开放 <工具>` |
| 提供方的副本带 `py/uv.lock`，数据目录里没有装好对应的环境 | `<提供方> 的运行环境还没装好` |

`refusalText` 给它专门的一句：「`<原因>`，这部分没做。在汇报里写明哪部分没做、为什么，其余照常做完」。不能沿用 `module-disabled` 那句「本任务所属模块已停用……然后收尾」：停的是提供方，使用方的任务照常运行。

最后一行是宿主在运行前查的：`lockOf(提供方副本)` 有值、`venvInstalled(提供方数据目录, lock)` 是假，就不运行。所以新版换了 `uv.lock` 还没跑 `just module setup` 时，使用方拿到的是这一行，不是 stock-ta 自己的提示（`ta.ts` 的「先跑 just module setup stock-ta」「包里钉的 ta 版本变了」）。那两句是写给 stock-ta 的使用者看的，带进 option-ta 的汇报会让人以为要对 option-ta 做什么。

工具跑了但失败，照旧回 `provider-failed`，`note` 是工具自己的错误。宿主在前面加「`<提供方>` 的工具出错：」，让专家分清是哪个模块的错。

**工具目录照列。** 助手和专家启动时拿到的 `domain_tool` 目录（`catalogue`）照列 `uses` 里的外部工具。提供方在时，说明取自提供方当前服务的副本里的 `tool.json`。提供方不在时，名字照列，说明写成「`<提供方>` 现在用不了，调用会回原因」。这样专家知道有这一项，调了以后拿到原因，在汇报里写明。

### 7. 有私密数据的模块不开放

模块里有 `private` 集合时，`exports` 检查报错。

理由：工具代码拿得到模块的整个数据目录，能打开任何集合、读 `files/` 里的任何文件，网关看不出它读了哪个（`design.md` 第 5 节第 5 条）。只读工具可能把私密内容带给别的模块的任务，这正是 ADR-0018 要挡的事。宿主没法按工具挡，只能按整个模块挡。

stock-ta 今天有一个 `private` 集合 `holdings`（持仓，PR #146 加的）。按这条规则，stock-ta 开放不了。第 1 版写「stock-ta 没有私密集合」，和代码不符。怎么办见「待定」第 1 条。

### 8. 访问记录

**今天没有工具的访问记录。** 模块 `data.db` 里的 `_access` 表只记 `data` 和 `watch` 的调用：时间、谁、集合、操作、行数、结果。工具调用只在宿主日志里有一行 gateway。

**C4a：日志行加调用方。** gateway 那一行的格式今天是 `[gateway] <模块> <能力> <任务> <成员或 helper> <依据> <结果> <毫秒> ms`。外部调用时前五段照旧（第一段写提供方，第二段写提供方里的能力名），只在末尾追加 `from=<调用方模块>`：

```
[gateway] stock-ta tools/structure tkt_… direction inference ok 5960 ms from=option-ta
```

本模块的调用不带 `from=`，格式一字不变。读这一行的有两处：

- `src/modules/rehearse.ts` 的 `usedBy` 用正则 `\[gateway\] (\S+) (\S+) (\S+) \S+ \S+ ok \d+ ms` 取前三段，正则没锚在行尾，追加的 `from=` 不影响匹配。但它按 `from === module`（第一段等于预演的模块）过滤，外部调用的第一段是提供方，会被滤掉。`judge` 要改成认考题里的全名：`stock-ta/tools/structure` 对上第一段 `stock-ta`、第二段 `tools/structure`、任务相同、`from=` 是预演的模块的那一行。本模块的 `uses` 只认不带 `from=` 的行。
- `tests/integration/wiring.test.ts` 第 413 行断言日志以 `[gateway] personal-tax tools/env-probe` 开头。那是本模块的调用，不受影响。C4a 加一条外部调用的断言，钉住 `from=` 在行尾。

**C4b：提供方的访问记录表。** 在提供方的 `data.db` 加一张表 `_tool_calls`：时间、调用方模块、任务、成员、依据、工具、结果、毫秒。本模块的工具调用也记，「谁在用我开放的工具」按调用方模块不等于本模块筛。模块页的「谁在用」从这张表算。表由宿主建、宿主写，和 `_access` 一样。在 C4b 之前，要看谁在用，从宿主日志里数 `from=` 的行。

### 9. 预演

`just module try` 今天只把被预演的包复制进临时宿主（`src/cli/module-try.ts` 的 `rehearse`），用 `cloneFiles` 带上它的 `files/`。提供方不在临时宿主里，外部调用都会回 `provider-absent`。

C4b 改成：

1. 从被预演的包里收集全部专家和考题 `uses` 里的外部模块名。
2. 每个外部模块，在真实状态目录里找它**当前在服务的副本**（`module-store/<模块>/<digest>`），复制进临时状态目录的 `modules/<模块>`，打开它的开关。不在服务的提供方不带，预演照常跑，外部调用回 `provider-absent`，打印一行「`<提供方>` 现在没开，预演里调不到它的工具」。
3. 用 `cloneFiles` 带上提供方的 `files/`，Python 环境照旧链接不复制。C2 之后再复制提供方的 `.env`，和被预演的模块自己一样（`connectors-and-secrets-design.md` 第 3 节「预演」）。
4. 等提供方也到「运行中」再出题，和等被预演的模块一样。

两件事照旧：`cloneFiles` 只带 `files/`，不带 `data.db`。所以预演里提供方读集合的地方都是空的，例如 `structure` 判断「在不在自选股里」读 `data.db` 的 `watchlist`，预演里总说不在。临时宿主的配置是 `feedFixtures: true`，提供方的 feed 也按样例跑，写的是临时目录。

### 10. 热换版本

每次外部调用读提供方当前的 `serving`，不缓存结果。提供方升级以后，下一次调用就用新版。这样做有三个缺口，C4b 补前两个：

- **缺口一：回收会删掉正在用的副本。** `src/host/live-modules.ts` 的 `collect` 只保护当前服务的副本和任务钉住的副本（`pinnedCopies`）。外部调用不钉提供方，调用进行中提供方换了版本，旧副本既不在服务也没人钉，下一次 `collect` 就会删掉它，正在跑的工具进程读到一半的文件没了。C4b 让网关记下进行中的外部调用占用的副本，`collect` 把这组也加进保护集合，调用结束再放掉。
- **缺口二：助手的目录是启动时定的。** 助手启动时拿到一份 `domain_tool` 目录（`workers.ts` 的 `#catalogue(ticketId, null)`），之后不变。提供方后来才打开，它的工具在目录里只有「现在用不了」那一句；提供方升级改了输入输出，目录里的说明是旧的。专家不受影响：每次派活都重新算目录（`workers.ts` 第 541 行）。C4b 在目录里每个外部工具的说明后面加一句「说明取自启动时，以调用结果为准」。调用本身总是按提供方当前版本跑，提供方新开了，调用就成。不在任务中途重启助手去刷新目录。
- **缺口三：新版换了 `uv.lock` 还没装环境。** 回规则 6 那一行固定原因，不把 stock-ta 的 setup 提示带进使用方的汇报。

### 11. feed 的处理代码调不了外部工具

feed 的处理代码由 `src/modules/feed-runner.ts` 直接用 `runModuleCodeAsync` 运行，不经网关，所以调不了外部工具，也调不了本模块的工具。option-ta 的 feed 要正股数据，得自己取，或者开一个任务，由任务里的专家调。

### 12. 输出里的引用，使用方拿不到原文

开放工具的输出里有指向提供方内部的东西，使用方跟不过去：

- `signals` 每条带 `sources`，指向 stock-ta 的笔记编号，原文要 `tools/note` 取，`note` 不开放。
- `structure` 对不在自选股里的标的回「把它加进自选股，等下一次 scan 扫完再问」。使用方加不了：自选股是 stock-ta 的写操作。

使用方的专家汇报这类内容时，转成一句给使用者的话：「要看出处原文，请对 stock-ta 说」「要分析 TSLA 的结构，请对 stock-ta 说把它加进自选股」。C4d 把这条写进工坊的 `build-module` 技能，option-ta 的专家技能照写。

## 兼容

开放的工具就是对外接口。提供方改它的输入输出，可能弄坏使用方的技能。

- **先补用例。** 开放的五个工具（`structure`、`signals`、`prices`、`quote`、`earnings-date`）今天都没有 `cases.json`，stock-ta 只有 `risk-reward` 有。它们写了 `effect: read`，检查允许不带用例（`design.md` 第 2 节）。没有用例，兼容提醒比对不了输出。C4c 先给它们补 `cases.json`：`structure`、`signals`、`prices` 读一个放在测试夹具里的 `ta.sqlite`，`quote`、`earnings-date` 用已有的 `fixtures/` 回放网络应答。补用例要让检查能带一个夹具数据目录：今天 `scratchData` 给一次检查的全部用例一个空的临时数据目录。
- **兼容提醒。** `just module check --previous <旧包>` 对比新旧两版，开放的工具出现下列任一情况就给提醒，写明「这个工具开放给了别的模块」：从 `exports` 里拿掉了；`tool.json` 的 `input` 或 `output` 少了字段、改了字段的 `type` 或 `title`；`cases.json` 里同名用例的输出形状变了。是提醒，不报错。
- **宿主换版本时也提醒。** 第 1 版写「换版本时宿主也跑同一段检查」，和代码不符：`--previous` 只在命令行用，今天比对的只是数据结构（`structureChanges`）；宿主换版本时比对的是 `data.db` 里存的数据结构（`data.check`），不比工具。C4c 在宿主的「检查中」加一步：拿 `module-store` 里正在服务的副本当旧版，跑同一段开放工具的比对，结果写进模块页这一版的提醒。
- **谁在用。** 模块页列出「谁在用我开放的工具」，从 C4b 的 `_tool_calls` 算。

## 不做的

- 不开放数据集合。要别的模块的数据，经它开放的只读工具取。
- 不开放写工具。option-ta 要改 stock-ta 的自选股，由使用者在对话里对 stock-ta 说。
- 不做依赖声明（`requires`）和版本约束。只有一对提供方和使用方时用不上（YAGNI），第二对出现再说。
- 不缓存外部调用的结果。
- 不经幕僚长。
- 不在 `module.json` 加模块级的 `uses`（规则 3）。

## 和 C2 的先后

C4 不依赖 C2，两者谁先落地都行。C2 先落地时，C4a 的网关直接按提供方模块取密钥。C4 先落地时，外部调用照今天从全局 `secretsFile` 取；C2 落地时把 `ports.secret` 改成带模块名，外部调用传提供方，预演多复制提供方的 `.env`。C2 的分期表要加一行验证：option-ta 的专家调 `stock-ta/tools/quote`，拿到的是 stock-ta `.env` 里的 key。

## 分期

| 期 | 内容 | 验证 |
|---|---|---|
| C4a 宿主 | `exports` 的检查（只读、无私密集合）；包检查认外部工具名，只提醒；网关按规则 4 的顺序解析外部调用；领队和单个助手取并集，没有专家的模块不能调；`provider-absent` 和它的提示，含运行环境没装好；目录照列外部工具；日志行末尾加 `from=`；`judge` 认全名 | 测试模块 A 开放一个只读工具，模块 B 的专家调用成功，数据来自 A 的数据目录；推断任务和模块 feed 开的任务也调得成；A 关掉、没装、没开放这个工具、`uv.lock` 没装时，B 拿到各自固定的原因，任务不出错；A 开放写工具、或有私密集合时检查报错；B 的 `uses` 写外部工具只提醒；`wiring.test.ts` 钉住 `from=` 那一行 |
| C4b 预演和运行 | `just module try` 带上提供方当前副本、`files/`（C2 后加 `.env`）；`collect` 保护进行中的外部调用占用的副本；目录说明加「以调用结果为准」；提供方 `data.db` 的 `_tool_calls` | 一个只用 A 的工具的临时模块预演通过，`judge` 认 `A/tools/x`；外部调用进行中 A 换版本，旧副本在调用结束前不被删；`_tool_calls` 有调用方 |
| C4c stock-ta | 先补五个开放工具的 `cases.json`（夹具数据库）；`exports`；`--previous` 和宿主换版本的兼容提醒；模块页的「谁在用」。**挡在「待定」第 1 条** | 一个只用 stock-ta 工具的临时模块，在临时宿主上由真模型调用 `stock-ta/tools/structure`，结果和 stock-ta 自己调用一致；改一个开放工具的输出字段，`--previous` 给提醒 |
| C4d 工坊 | 模块工坊的技能 `package-layout`、`build-module` 写进 `exports`、外部 `uses`、「请对提供方说」的转述 | 工坊做 option-ta 时用到 |

## 待定

1. **stock-ta 的 `holdings` 和规则 6。** 规则 6 按整个模块挡，stock-ta 有私密集合 `holdings`，开放不了，C4c 做不成。三个改法：
   - **A. 把 `holdings` 改成 `shareable`。** 今天 `private` 只管两件事：私密 feed 的通知，和领域里有 feed 往私密集合写时宿主来源的任务进不来（`design.md` 第 5 节）。`holdings` 是使用者自己在对话里记的，没有 feed 往里写，这两件事都碰不到它，所以标 `private` 今天没有任何效果。改成 `shareable` 只改一个词，规则 6 原样。代价是「持仓是私密数据」这个标签没了，以后给 `private` 加新含义时它不受保护。
   - **B. 规则 6 改成只看「有 feed 往私密集合写」。** 和 ADR-0018 的 V11 同一个条件，`mail` 照旧开放不了，stock-ta 能开放。理由是 ADR-0018 挡的是别人写进来的内容（邮件），使用者自己记的持仓本来就能被宿主来源的推断任务读到（它能选 stock-ta 领域经 `data` 读 `holdings`，还有 `web_get`）。开放 stock-ta 的只读工具没有让持仓多一条出去的路。代价是改了使用者刚定的规则。
   - **C. 把 `holdings` 和持仓规则搬出 stock-ta，单独成一个模块。** 规则 6 原样。代价最大：报价 feed 读 `holdings` 算持仓规则，搬走以后 feed 读不到别的模块的集合，持仓规则要一起搬，或者等 C4 让 feed 也能调外部工具（规则 11 说今天不能）。

   推荐 A。理由是 B 推翻刚定的规则，C 为一个今天没有效果的标签搬一大块代码。注意 `files/hits` 里持仓命中的提醒行带成本和止损价，`hits` 工具读得到（`stock-ta-rules-design.md` 第 480 行）。`hits` 不在开放清单里，选 A 也不会经开放工具出去，但说明了「工具代码能读整个模块」这句话在 stock-ta 里是真的。

## 复查改了什么

两个对抗复查都在 `origin/main` 5c99224 上读了代码。下表是第 2 版对两边共同结论的改法，最后几行是写第 2 版时对照代码另外发现的。

| 复查意见 | 第 2 版的改法 |
|---|---|
| 提供方不在时沿用 `module-disabled`，提示让使用方收尾 | 新拒绝码 `provider-absent` 和专门的提示（规则 6）；外部调用的解析不走 `callerCopy`，改用 `copyOf(提供方, serving(提供方))` 再走 `runTool`；`memberRefusal` 比对全名（规则 4） |
| 预演里没有提供方；日志行和 `judge` 对不上 | `just module try` 带上提供方当前副本、`files/`、C2 后的 `.env`（规则 9）；日志行前五段不变，末尾追加 `from=`；`judge` 认 `<提供方>/tools/x`；`wiring.test.ts` 的断言不受影响（规则 8） |
| 领队、单个助手、没有专家的模块能调什么没写 | 规则 3 的表；提供方不在时目录照列，调用回原因（规则 6） |
| 开放的工具没有 `cases.json`，兼容提醒比对不了 | C4c 先补用夹具数据库的 `cases.json`；兼容提醒同时比对 `tool.json` 的 `input`、`output`（「兼容」一节） |
| `uses` 写外部工具，包检查和考题检查都报错 | C4a 改 `crossCheck` 的 `resolves`，认外部路径，只提醒（规则 2） |
| 「只读」是什么保证 | 靠 `effect` 和作者自律，没有沙箱，不防恶意模块（规则 5） |
| 热换版本 | 每次读当前 `serving`、不缓存；回收保护进行中的副本；助手目录是旧的；`uv.lock` 没装时回固定原因（规则 10） |
| 访问记录今天不存在 | 写明 `_access` 只记集合和提醒条件；C4a 先从日志统计，C4b 加 `_tool_calls`（规则 8） |
| feed 的处理代码能不能调 | 不经网关，调不了（规则 11） |
| 输出里的引用 | 转成「请对 stock-ta 说」（规则 12） |
| C4 和 C2 的先后 | 「和 C2 的先后」一节 |
| 待定里有已经定了的 | 开放清单和规则 6 两项清掉，写进「使用者已定」 |
| （写第 2 版时发现）stock-ta 有私密集合 `holdings` | 规则 6 写明 stock-ta 按现状开放不了；新的「待定」第 1 条 |
| （写第 2 版时发现）宿主换版本不跑 `--previous` | 「兼容」一节改写，宿主换版本时拿服务中的副本比对 |
| （写第 2 版时发现）专家的目录每次派活都重算 | 缺口二只说助手 |
