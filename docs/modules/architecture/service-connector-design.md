# 模块之间的服务连接器（设计稿 C4）

状态：第 2 版，2026-11-16。第 1 版经两个对抗复查，改动见末尾「复查改了什么」。使用者 2026-11-16 定了七件事（下一节），后两件是看过第 2 版以后定的，改动也记在末尾。开 PR 后又经一次独立复查，在 `origin/main` c201c19 上核过行号，改动记在末尾。权限上的取舍单独写在 ADR-0030。没有挡着分期的待定事项。

## 为什么要做

stock-ta 是 option-ta 的底层。option-ta 的「方向与价位」专家要正股的趋势、支撑阻力、信号，stock-ta 已经有，背后是土拨鼠引擎和专家知识。option-ta 再做一套简化版，既重复又更差。

可模块是扁平且隔离的（ADR-0018）：任务只用得到本模块的能力。使用者否决了两条路：
- 经幕僚长中转：幕僚长要保持轻量；中转靠模型转述，数字会转错；会诊被拖长。
- option-ta 自己做简化版：重复。

选定的做法：一个模块可以把自己的几个**只读工具**开放出来，别的模块按名字调用，宿主替它在提供方那边运行。这和 `mail` 连接器是同一个思路：mail 连接器共享一种外部服务，服务连接器共享一个模块的只读能力。

## 使用者已定（2026-11-16）

1. **推断任务、feed 开的任务也能调别的模块开放的只读工具。** 理由和风险写在 ADR-0030，它部分取代 ADR-0018「几个决定」第二条的理由。
2. **`earnings-date` 进开放清单。** 它和 stock-ta 自己共用 Finnhub 的额度（下面「额度」一条）。
3. **第 1 版的规则 6「有私密数据的模块不开放」保留**（第 2 版是规则 7）。理由补上：工具代码能读整个模块的数据，只能按整个模块来挡。
4. **`tools/note` 不开放。**
5. **方向不变。** 模块之间扁平隔离，外部服务经宿主共享。
6. **stock-ta 的 `holdings` 改成 `shareable`（第 2 版「待定」第 1 条的 A）。** 理由：没有 feed 往它写，`private` 今天对它不起作用。规则 7 不变。改 `class` 是包的改动，排在 C4c 做，连带后果见规则 7。
7. **没有专家（`agents/`）的模块也能调外部工具。** 取消第 2 版「没有 `agents/` 的模块不能调」那条默认。使用者认为没有特别理由限制；原来限制只是因为这种模块没有地方写 `uses`。改成在 `module.json` 写模块级的 `uses`（规则 3）。

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

### 2. 使用方在 `uses` 里写全名

带专家的模块写在专家的 `uses` 里，没有专家的模块写在 `module.json` 的 `uses` 里（规则 3）。格式是 `<模块>/tools/<名字>`：

```yaml
uses: knowledge, tools/chain, stock-ta/tools/structure, stock-ta/tools/signals
```

考题（`evals/*.md`）的 `uses` 也可以写全名，表示这道题要用到这个外部工具。

**包检查要改。** 今天 `crossCheck` 的 `resolves` 把 `use` 按 `/` 拆成三段，第三段存在就判为不认识，所以 `stock-ta/tools/structure` 会报 `uses "…", which this package does not have`。专家和考题共用这一段，两处都报错。C4a 把它改成：形如 `<模块>/tools/<名字>`、模块名合法、不是本模块的，算外部工具，只给一行提醒（「外部工具，检查不了提供方有没有开放它」），不报错。`module.json` 的 `uses` 也走这一段（规则 3 写了它另外的两条检查）。`crossCheck` 今天只有报问题的 `report`，提醒只来自 `structureChanges` 的 `notes`，所以 C4a 要给它接上 `notes`。这一步也要紧，因为宿主的 `copyOf` 遇到检查不过的副本就当它不存在（`gateway.ts` 的 `copyOf`）。检查只看得到这一个包，不知道装了哪些别的模块，所以不能查提供方。模块随时会装上、拿掉，宿主在调用时才判断（规则 6）。

### 3. 谁能调哪些外部工具

外部工具只来自使用方模块包里写的 `uses`：专家的 `uses`，或没有专家的模块在 `module.json` 写的 `uses`。网关按任务钉住的那份副本（`caller.pin`）读 `uses`，不按提供方读。

| 调用者 | 能调的外部工具 |
|---|---|
| 专家（`member` 是名字） | 它自己 `uses` 里的外部工具 |
| 领队（`member === null`，模块带 `agents/`） | 本队全部专家 `uses` 里外部工具的并集 |
| 单个助手（`member === null`，模块带 `agents/`，宿主没有派活台，`crew` 是空的） | 和领队一样，取并集 |
| 没有 `agents/` 的模块的助手（`member === null`） | `module.json` 的 `uses` 里的外部工具 |

代码里领队和单个助手是同一种调用者：`src/host/workers.ts` 的 `#gatewayCall` 都传 `member: null`，`memberRefusal` 对 `null` 直接放行，所以今天领队能调本模块的全部工具，不看谁的 `uses`。外部工具不照搬这条：外部工具是另一个模块的能力，要有一处写出来。领队取并集，让领队和它派的专家看到同一份清单。

**模块级的 `uses`。** `module.json` 加可选键 `uses`，是外部工具全名的列表：

```json
{ "name": "mail", "uses": ["stock-ta/tools/quote"] }
```

检查给它两条规则，和规则 2 那一行提醒一起。`readManifest` 只把 `uses` 收为可选键、核对它是字符串列表；它只读 `module.json`，不知道包里有没有 `agents/`，所以两条规则都放在 `crossCheck`，和 `needs "team"` 同处：

- 只收外部工具全名 `<模块>/tools/<名字>`，不能是本模块。写 `knowledge`、`tools/x`、`data/x` 报错：本模块的能力，`member === null` 的调用者今天全都调得到，写了也没有意思。
- 模块带 `agents/` 时写 `uses` 报错（「外部工具写在专家的 `uses` 里」）。

网关对 `member === null` 只有一条：取模块级 `uses` 和全部专家 `uses` 里外部工具的并集。有 `agents/` 时模块级的是空的，没有 `agents/` 时专家的是空的，所以上表后三行是同一段代码。拒绝码照旧是 `not-in-uses`，可今天的 `{ code: "not-in-uses"; member: string }`（`protocol.ts`）带的是成员名，`refusalText` 写成「成员 <名> 的 uses 没有列这一项」。C4a 让 `member` 可以是 `null`，`null` 时写成「本模块没有在 uses 里列这个外部工具」。

带 `agents/` 的模块不收模块级 `uses`，理由：

- **一个模块只有一处写。** 两处都能写，就要再定模块级的给不给专家用。给，专家的 `uses` 就不再是它能调的全部，按 `uses` 分工（`design.md` 第 2 节「专家团队」一段）被打穿；不给，它只多出「领队能调、专家都不能调」的工具，领队派活时派不出去。
- **和 `team` 同一个形状。** `team` 只在带 `agents/` 时写，`uses` 只在不带时写，检查今天已经这样查 `team`（`validate.ts` 的 `needs "team"`、`has "team" but agents/ has no members`）。
- **以后要放开容易。** 真有带专家的模块要领队独用一个外部工具，去掉这条检查即可，网关的并集不用改。

今天没有不带专家的模块写模块级 `uses`。`mail` 是第一个可能写的：它是私密使用方（`inbox` feed 写私密集合），写了以后它的任务能把邮件里的内容当参数传给会联网的提供方工具。这条风险写在 ADR-0030「风险」一节。

### 4. 在提供方那边运行

**名字。** 目录里外部工具的名字就是全名 `stock-ta/tools/structure`，Worker 调 `domain_tool` 时原样传这个名字。今天 `Request` 的 `tool.name` 是本模块的工具名，`useOf` 拼成 `tools/<名字>`。C4a 在网关入口按 `<模块>/tools/<名字>` 拆开：带模块前缀的是外部调用，拆出提供方和工具名；不带的照旧。

外部调用的解析不走 `callerCopy`。`callerCopy` 按调用方的模块和钉住的版本找副本，用在外部调用上就会到使用方自己的包里找 `tools/structure`。外部调用的顺序是：

0. 调用方自己的模块照旧要在服务：`ports.serving(调用方)` 是 `undefined` 时回 `module-disabled`，和今天一样。使用方停了，它的任务也调不了外部工具。
1. 在调用方钉住的副本里查成员（或 `member === null` 时的并集）的 `uses` 有没有这个全名（规则 3）。没有就回 `not-in-uses`。`memberRefusal` 比对的是全名 `stock-ta/tools/structure`，不能拼成本模块的 `tools/structure`。
2. 读提供方当前在服务的版本：`ports.serving(提供方)`。每次调用都读，不缓存。
3. `copyOf(提供方, serving(提供方))` 取提供方的副本。
4. 在这份副本里找工具，并查它的 `module.json` 的 `exports` 有没有列它。
5. 对照权威表（`AUTHORITY`）。开放的工具都是只读的，所有调用者都过（规则 5）。
6. 调 `runTool(提供方副本, 工具, 输入)`。代码在提供方的副本里跑，数据目录是 `ports.dataDir(提供方)`，时限照旧是 `LIMIT_MS`。

2 到 4 任何一步不成立，回 `provider-absent`，原因按规则 6 的表。调用方的任务钉住的是它自己模块的版本，外部工具不跟着钉。

**密钥。** C2 已落地（ADR-0031）：宿主只从模块自己的 `.env` 给模块代码取密钥，`ports.secret(module, name)` 带模块名，网关传的是被运行的副本的模块（`copy.module`）。外部调用运行的是提供方的副本，所以取的是提供方 `.env` 里的值。使用方的 `.env` 里不必有、也不该有提供方的密钥。

**额度。** `earnings-date` 和 stock-ta 自己的任务、`scan` feed 共用一份 Finnhub 免费额度，`quote` 和 stock-ta 的 `quotes`、`scan` 两个 feed 共用 Massive 的额度。宿主不替它们排队（`design.md` 第 10 节「宿主不再统一管额度」）。option-ta 的会诊把一次问答变成几次外部调用，额度用得更快。先不加排队，额度真不够时再按密钥名加。

### 5. 权限：只读，谁都能调

开放的工具都是只读的，按权威表 `read` 一行，所有调用者都能调：只听过使用者的请求任务、其他请求任务、规则任务、推断任务、模块 feed 开的任务。这是使用者 2026-11-16 定的，为什么现在可以接受、风险是什么写在 ADR-0030。option-ta 自己就是私密使用方：它的 `fills` feed 用 `mail` 连接器，按 C1 的规则写进私密集合（`connectors-and-secrets-design.md` 第 1 节），所以「私密内容进了开放工具的参数」是第一对模块就有的事，不是以后的事。

「只读」靠工具的 `effect` 声明和作者自律，代码层面不保证。工具代码在一个普通进程里跑，和宿主同一个系统用户，没有沙箱（`design.md` 第 9 节），能写提供方的 `files/`、能联网、能读状态目录。stock-ta 的 `ta.ts` 每次调用都先把数据库复制一份再读，因为 `ta` 读的时候也会写 SQLite 文件头。这种事检查器查不出来，靠作者。单人自用的 MVP 不防恶意模块。

### 6. 提供方不在时

**新拒绝码 `provider-absent`。** 以下几种情况回它，带一个固定的原因：

| 情况 | 原因（`note`） |
|---|---|
| 提供方没装、关着，或刚打开还没检查完（`serving` 是 `undefined`）；或者 `serving` 有值，可 `copyOf` 拿不到这份副本（副本缺失，或检查不过被当成不存在） | `<提供方> 没装或没开` |
| 提供方当前版本的 `exports` 没有这个工具，或没有这个工具 | `<提供方> 现在没有开放 <工具>` |
| 工具跑失败，而提供方的副本带 `py/uv.lock`、数据目录里没有装好对应的环境 | `<提供方> 的运行环境还没装好` |

`refusalText` 给它专门的一句：「`<原因>`，这部分没做。在汇报里写明哪部分没做、为什么，其余照常做完」。不能沿用 `module-disabled` 那句「本任务所属模块已停用……然后收尾」：停的是提供方，使用方的任务照常运行。

`ports.serving` 对没装和关着都回 `undefined`（`src/host/wiring.ts` 的 `serving`），所以第一行合成一句；要分开得给网关多一个端口，不值得。`serving` 有值而副本取不到，是宿主自己的状态不一致（例如副本目录被删了），对使用方来说和提供方不在没有区别，也并进第一行，不另起一句。升级时新版在检查或调整数据结构，旧版照旧在服务，`serving` 不是 `undefined`，外部调用照常用旧版。

最后一行是工具跑完以后查的：工具失败，并且 `lockOf(提供方副本)` 有值、`venvInstalled(提供方数据目录, lock)` 是假，宿主把工具的错误换成这一行固定原因。不在运行前挡：环境是整个模块一份，`quote`、`earnings-date` 不用它，没装环境时照样能用。所以新版换了 `uv.lock` 还没跑 `just module setup` 时，使用方拿到的是这一行，不是 stock-ta 自己的提示（`ta.ts` 的「先跑 just module setup stock-ta」「包里钉的 ta 版本变了」）。那两句是写给 stock-ta 的使用者看的，带进 option-ta 的汇报会让人以为要对 option-ta 做什么。

其余的失败照旧回 `provider-failed`，`note` 是工具自己的错误。外部调用的 `provider-failed` 由 `refusalText` 写成「`<提供方>` 的工具这一次出错：……」，让专家分清是哪个模块的错。`note` 本身不加前缀，免得和「工具这一次出错」叠成两层。

**工具目录照列。** 助手和专家启动时拿到的 `domain_tool` 目录（`catalogue`）照列 `uses` 里的外部工具，`member === null` 的按规则 3 的并集列。提供方在时，说明取自提供方当前服务的副本里的 `tool.json`。提供方不在时，名字照列，说明写成「`<提供方>` 现在用不了，调用会回原因」。这样专家知道有这一项，调了以后拿到原因，在汇报里写明。

### 7. 有私密数据的模块不开放

模块里有 `private` 集合时，`exports` 检查报错。

理由：工具代码拿得到模块的整个数据目录，能打开任何集合、读 `files/` 里的任何文件，网关看不出它读了哪个（`design.md` 第 5 节第 5 条）。开放以后，只读工具可能把私密内容带进别的模块的任务。宿主对私密数据的保护按任务的领域查（ADR-0018 V11：领域装着 feed 带进来的私密数据时，宿主来源开的任务不能落在这个领域），外部调用的任务领域是使用方，绕过了这一层。宿主没法按工具挡，只能按整个模块挡。

stock-ta 今天有一个 `private` 集合 `holdings`（持仓，PR #146 加的）。按这条规则，stock-ta 现在开放不了。第 1 版写「stock-ta 没有私密集合」，和代码不符。使用者定了把 `holdings` 改成 `shareable`（「使用者已定」第 6 条），C4c 在加 `exports` 之前改。

**`holdings` 改成 `shareable` 以后变了什么。** 对照 `origin/main` c201c19 的代码（已含 C1 的宿主 mail 连接器），宿主看集合 `class` 的地方只有下面几处：

| 地方 | 改了以后 |
|---|---|
| feed 是不是私密（`manifest.ts` 的 `feedClass`，`modules.ts` 的 `private`）：决定通知到不到 Telegram 和网页（`feed-runner.ts` 的 `reachOf`）、`line` 能不能写（`validate.ts`）、领域的 `privateFeed`，也就是宿主来源的任务能不能带这个领域（`kernel.ts`，ADR-0018 V11） | 不变。三处都只看 feed 写进的集合，stock-ta 的 `quotes` 写 `quotes`、`scan` 写 `scan-runs`，没有 feed 写 `holdings`。stock-ta 今天就没有 `privateFeed`（`source-ticket-tools.test.ts` 第 438 行） |
| mail 连接器的 feed 必须写私密集合（`src/modules/connectors/mail.ts` 第 97 行的 `mailFeedProblems`） | 不变。只查用 mail 连接器的 feed 的 `into`，stock-ta 没有 mail feed |
| 持仓提醒在 Telegram、网页上怎么显示 | 不变。宿主没有按集合 `class` 收起显示的代码。持仓提醒行带成本和止损价，今天就照全文到 Telegram，因为它是 `quotes` feed 的提醒；给幕僚长的触发不写持仓数字，是模块代码守的（`stock-ta-rules-design.md` 第 333 行） |
| `data`、`watch` 的回复和 `domain_tool` 目录 | 回复里的 `class` 字段（`instance-data.ts`）和目录里集合的说明（`src/modules/gateway.ts` 第 198 行，「record，private」）从 `private` 变成 `shareable`。这是给模型看的字，没有代码按它分支。模型会不会因此对持仓少一分小心，没验证过，是猜测 |
| `just module check` 的摘要行 | `data-classes=` 那一段从 `shareable:N,private:1` 变成 `shareable:N+1,private:0` |
| 已存的行 | 不变。`structureChanges` 和 `data.check` 不比对 `class`，换版本不报问题、不迁移，行原样留着。包的 digest 变了，按普通升级走 |
| 备份 | 不变。宿主代码里没有按 `class` 区分的备份 |
| 规则 7 和 C4c 的 `exports` | stock-ta 没有私密集合了，检查放行它的 `exports` |

C4c 同时要改的，除了 `data/holdings/collection.json` 第 4 行的 `class` 本身（对照 c201c19 用 `git grep` 搜 holdings、持仓和私密、private 同一行出现的地方得出）：

- 文字九处：`docs/modules/examples/stock-ta/skills/holdings/SKILL.md` 第 8 行（这一处 Worker 每次记持仓都读）；`GLOSSARY.md` 第 64 行（「持仓」词条）；`docs/modules/stock-ta.md` 第 17 行；`docs/modules/stock-ta-cookbook.md` 第 258 行和第 277 行；`docs/modules/stock-ta-rules-design.md` 第 32 行、第 316 行、第 333 行（小标题「私密数据怎么走」，正文讲的是触发不写持仓数字，小标题改成照实说）。
- 注释一处：`docs/modules/evidence/p4-live.ts` 第 7 行写 holdings 是 private 集合。
- 测试一条：`tests/integration/stock-ta-holdings.test.ts` 第 31 行断言 `class` 是 `private`，改成 `shareable`，第 25 行测试名里的「私密的」一起改。
- 保留一处：`stock-ta-rules-design.md` 第 480 行的「ADR-0023 以后不按私密收起」讲的是 ADR-0023，改了 `class` 以后仍然对，不动。

改完用同一条命令再搜一遍：`git grep -n -i -E "(holdings|持仓).*(私密|private)|(私密|private).*(holdings|持仓)" -- . ':!docs/modules/architecture/service-connector-design.md'`，结果只剩第 480 行。这份稿子本身记的是改之前的事，不算在内。

代价是「持仓是私密数据」这个标签没了：以后给 `private` 加新含义时，持仓不受它保护。`files/hits` 里持仓命中的提醒行带成本和止损价，`hits` 工具读得到（`stock-ta-rules-design.md` 第 480 行）。`hits` 不在开放清单里，不会经开放工具出去，但说明「工具代码能读整个模块」这句话在 stock-ta 里是真的：以后往开放清单里加工具，要看它读不读 `holdings` 和 `files/hits`。

### 8. 访问记录

**今天没有工具的访问记录。** 模块 `data.db` 里的 `_access` 表只记 `data` 和 `watch` 的调用：时间、谁、集合、操作、行数、结果。工具调用只在宿主日志里有一行 gateway。

**C4a：日志行加调用方。** gateway 那一行的格式今天是 `[gateway] <模块> <能力> <任务> <成员或 helper> <依据> <结果> <毫秒> ms`。外部调用时格式不变，段数不变，`basis` 照旧在第五段。只是第一段写提供方（今天写的是调用方模块，外部调用时这一段的意思变了），第二段写提供方里的能力名，末尾追加 `from=<调用方模块>`：

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

1. 从被预演的包里收集专家、考题和 `module.json` 的 `uses` 里的外部模块名。
2. 每个外部模块，从真实 `state.db` 的 `module_records` 读出它当前在服务的 digest，找到**这份副本**（`module-store/<模块>/<digest>`），复制进临时状态目录的 `modules/<模块>`，打开它的开关。不在服务的提供方不带，预演照常跑，外部调用回 `provider-absent`，打印一行「`<提供方>` 现在没开，预演里调不到它的工具」。
3. 用 `cloneFiles` 带上提供方的 `files/`，Python 环境照旧链接不复制。C2 之后再复制提供方的 `.env`，和被预演的模块自己一样（`connectors-and-secrets-design.md` 第 3 节「预演」）。
4. 等提供方也到「运行中」再出题，和等被预演的模块一样。

两件事照旧：`cloneFiles` 只带 `files/`，不带 `data.db`。所以预演里提供方读集合的地方都是空的，例如 `structure` 在库里没有足够新的日线、要提示「加进自选股」时，读 `data.db` 的 `watchlist` 判断在不在自选里，预演里总说不在。`ta.sqlite` 在 `files/ta/` 下，会被带上，所以 `structure` 多数时候照常出结果。临时宿主的配置是 `feedFixtures: true`，提供方的 feed 也按样例跑，写的是临时目录。

### 10. 热换版本

每次外部调用读提供方当前的 `serving`，不缓存结果。提供方升级以后，下一次调用就用新版。这样做有三个缺口。缺口一在 C4a 补：C4a 一合并就能发起外部调用，合并后就会部署，不能留着回收删掉正在用的副本的口子等 C4b。缺口二在 C4b 补。缺口三按规则 6 在 C4a 处理。

- **缺口一：回收会删掉正在用的副本。** `src/host/live-modules.ts` 的 `collect` 只保护当前服务的副本和任务钉住的副本（`pinnedCopies`）。外部调用不钉提供方，调用进行中提供方换了版本，旧副本既不在服务也没人钉，下一次 `collect` 就会删掉它，正在跑的工具进程读到一半的文件没了。网关在 `src/host/wiring.ts` 里建，`collect` 在 `live-modules.ts` 里，是两个对象。C4a 加一个两边共用的「进行中副本」集合：网关在外部调用开始时放进提供方副本，结束时拿掉，`collect` 把这组也加进保护集合。
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

- **先补用例。** 开放的五个工具（`structure`、`signals`、`prices`、`quote`、`earnings-date`）今天都没有 `cases.json`，stock-ta 只有 `risk-reward` 有。它们写了 `effect: read`，检查允许不带用例（`design.md` 第 2 节）。没有用例，兼容提醒比对不了输出。C4c 先给它们补 `cases.json`：`structure`、`signals`、`prices` 读一个放在测试夹具里的 `ta.sqlite`，`quote`、`earnings-date` 用已有的 `fixtures/` 回放网络应答。补用例要让检查能带一个夹具数据目录：今天 `scratchData` 给一次检查的全部用例一个临时数据目录，只链接真实目录里的 Python 环境，没有数据。这是宿主侧的改动，算在 C4c 里。
- **兼容提醒。** `just module check --previous <旧包>` 对比新旧两版，开放的工具出现下列任一情况就给提醒，写明「这个工具开放给了别的模块」：从 `exports` 里拿掉了；`tool.json` 的 `input` 或 `output` 少了字段、改了字段的 `type` 或 `title`；`cases.json` 里同名用例的输出形状变了。是提醒，不报错。
- **宿主换版本时也提醒。** 第 1 版写「换版本时宿主也跑同一段检查」，和代码不符：`--previous` 只在命令行用，今天比对的只是数据结构（`structureChanges`）；宿主换版本时比对的是 `data.db` 里存的数据结构（`data.check`），不比工具。C4c 在宿主的「检查中」加一步：拿 `module-store` 里正在服务的副本当旧版，跑同一段开放工具的比对，结果写进模块页这一版的提醒。
- **谁在用。** 模块页列出「谁在用我开放的工具」，从 C4b 的 `_tool_calls` 算。

## 不做的

- 不开放数据集合。要别的模块的数据，经它开放的只读工具取。
- 不开放写工具。option-ta 要改 stock-ta 的自选股，由使用者在对话里对 stock-ta 说。
- 不做依赖声明（`requires`）和版本约束。只有一对提供方和使用方时用不上（YAGNI），第二对出现再说。
- 不缓存外部调用的结果。
- 不经幕僚长。

## 和 C2 的先后

C4 不依赖 C2，两者谁先落地都行。C2 先落地时，C4a 的网关直接按提供方模块取密钥。C4 先落地时，外部调用照今天从全局 `secretsFile` 取；C2 落地时把 `ports.secret` 改成带模块名，外部调用传提供方，预演多复制提供方的 `.env`。C2 的分期表要加一行验证：option-ta 的专家调 `stock-ta/tools/quote`，拿到的是 stock-ta `.env` 里的 key。

## 分期

| 期 | 内容 | 验证 |
|---|---|---|
| C4a 宿主 | `exports` 的检查（只读、无私密集合）；包检查认外部工具名，只提醒；`module.json` 的 `uses`（`readManifest` 收为可选键，`crossCheck` 查只收外部全名、带 `agents/` 时报错）；网关按规则 4 的顺序解析外部调用；`member === null` 取模块级和全部专家 `uses` 的并集；`provider-absent` 和它的提示，含运行环境没装好；外部调用的 `provider-failed` 带提供方名；目录照列外部工具；`collect` 保护进行中的外部调用占用的副本（规则 10 缺口一）；日志行末尾加 `from=`；`judge` 认全名；改两处今天准确、落地后就不准的文字：`src/modules/protocol.ts` 头注释的「a ticket never reaches another module」，`design.md` 第 2 节「Worker 怎么用到这些」第 1 条「别的模块的东西根本不在目录里」，都补上开放工具这个例外 | 测试模块 A 开放一个只读工具，模块 B 的专家调用成功，数据来自 A 的数据目录；推断任务和模块 feed 开的任务也调得成；A 关掉、没装、没开放这个工具、`uv.lock` 没装时，B 拿到各自固定的原因，任务不出错；A 在服务但它的副本目录被删时，B 拿到「A 没装或没开」；A 的工具抛错时，B 拿到的提示写着「A 的工具这一次出错：……」，`note` 本身没有前缀；A 不在时 B 的专家拿到的 `domain_tool` 目录照列 `A/tools/x`，说明是「A 现在用不了，调用会回原因」；外部调用进行中 A 换版本并跑一次 `collect`，旧副本在调用结束前不被删，结束后下一次 `collect` 删掉它；A 开放写工具、或有私密集合时检查报错；B 的 `uses` 写外部工具只提醒；没有专家的模块 C 在 `module.json` 写 `uses` 后，它的助手调得成，没写的外部工具回 `not-in-uses`；带 `agents/` 的包写模块级 `uses`、或模块级 `uses` 写本模块能力时检查报错；`wiring.test.ts` 钉住 `from=` 那一行 |
| C4b 预演和运行 | `just module try` 按专家、考题和模块级的 `uses` 带上提供方当前副本、`files/`（C2 后加 `.env`）；目录说明加「以调用结果为准」；提供方 `data.db` 的 `_tool_calls` | 一个只用 A 的工具的临时模块预演通过，`judge` 认 `A/tools/x`；只在模块级 `uses` 写了 A 的模块，预演也带上 A；A 不在服务时预演照跑，打印「A 现在没开」那一行；助手目录里外部工具的说明带「以调用结果为准」；`_tool_calls` 有调用方 |
| C4c stock-ta | `holdings` 改成 `shareable`，连带改九处文字、一处注释和一条测试（规则 7）；检查能带夹具数据目录；先补五个开放工具的 `cases.json`（夹具数据库）；`exports`；`--previous` 和宿主换版本的兼容提醒；模块页的「谁在用」 | `just module check` 通过，摘要里 `private:0`；规则 7 那条 `git grep` 只剩写明保留的第 480 行；老 Mac 上已存的持仓行升级后原样在，持仓规则照常命中；一个只用 stock-ta 工具的临时模块，在临时宿主上由真模型调用 `stock-ta/tools/structure`，结果和 stock-ta 自己调用一致；改一个开放工具的输出字段，`--previous` 给提醒；临时宿主上把 stock-ta 换成改了开放工具输出字段的一版，「检查中」以后模块页这一版的提醒写着「这个工具开放给了别的模块」，没改开放工具的一版没有这条提醒；临时模块调过 `stock-ta/tools/quote` 以后，stock-ta 模块页的「谁在用」列出它，stock-ta 自己的调用不列 |
| C4d 工坊 | 模块工坊的技能 `package-layout`、`build-module` 写进 `exports`、外部 `uses`（专家的和 `module.json` 的，两处什么时候用哪处）、「请对提供方说」的转述 | 技能里给的两个示例包（一个带专家，`uses` 写在专家文件里；一个不带专家，`uses` 写在 `module.json` 里，都只用 `stock-ta/tools/quote`）放进测试夹具，测试照技能原文取出来跑 `just module check` 都通过；带专家的那个把 `uses` 挪到 `module.json`，检查报错；技能原文里有「请对提供方说」的转述规则 |

## 待定

没有。第 2 版的「待定」第 1 条使用者选了 A（「使用者已定」第 6 条）。带 `agents/` 的模块不收模块级 `uses`（规则 3）是按最简单、一致的写法定的，使用者要改，只动一条检查。

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
| 待定里有已经定了的 | 开放清单和私密规则两项清掉，写进「使用者已定」 |
| （写第 2 版时发现）stock-ta 有私密集合 `holdings` | 规则 7 写明 stock-ta 按现状开放不了；新的「待定」第 1 条 |
| （写第 2 版时发现）宿主换版本不跑 `--previous` | 「兼容」一节改写，宿主换版本时拿服务中的副本比对 |
| （写第 2 版时发现）专家的目录每次派活都重算 | 缺口二只说助手 |
| （开 PR 前的独立复查）解析顺序漏了调用方模块停用；没装和没开分不出；环境预检会挡掉不用环境的工具；外部工具名字格式没写；`provider-failed` 前缀会叠两层 | 规则 4 加第 0 步和「名字」一段；规则 6 合并前两种原因、环境检查改在失败以后、前缀放进 `refusalText` |
| （开 PR 前的独立复查）ADR-0030 拿没有专家的 `mail` 当调用方，漏了 option-ta 本身是私密使用方 | ADR-0030 的风险和「没有采用的做法」改写；规则 5 写明 option-ta 是私密使用方 |
| （使用者看过第 2 版后定）`holdings` 选 A | 「使用者已定」第 6 条；规则 7 写明改 `class` 的连带后果和要改的文字、测试；C4c 加这一步，不再挡着；「待定」清空 |
| （使用者看过第 2 版后定）没有 `agents/` 的模块也能调外部工具 | 「使用者已定」第 7 条；规则 3 加模块级 `uses`，带 `agents/` 的模块不收；规则 2、4、6、9 和分期跟着改；「不做的」删掉对应一条；ADR-0030 写明 `mail` 写了 `uses` 以后的风险 |
| （开 PR 后的独立复查）C4c 连带要改的文字漏了四处 | 对照 c201c19 用 `git grep` 补全：`GLOSSARY.md`、`stock-ta-cookbook.md` 第 277 行、`stock-ta-rules-design.md` 第 32 行和第 333 行、`p4-live.ts` 的注释；写明保留的第 480 行；C4c 验收加这条 `git grep`（规则 7） |
| （开 PR 后的独立复查）行号和基线是 5c99224 | 规则 7 改为对照 c201c19，`gateway.ts` 的行号改成 198，表里补 mail 连接器的 `mailFeedProblems`；其余行号在 c201c19 上核过，没变 |
| （开 PR 后的独立复查）模块级 `uses` 的两条检查写在 `readManifest` | `readManifest` 只读 `module.json`，不知道有没有 `agents/`；两条检查改放 `crossCheck`，和 `needs "team"` 同处（规则 3） |
| （开 PR 后的独立复查）规则 7 引了已被 ADR-0023 取代的 ADR-0018 一段 | 改引 `design.md` 第 5 节第 5 条，再说明外部调用绕过了按领域查的 V11 |
| （开 PR 后的独立复查）`serving` 有值但取不到副本时回什么没写 | 并进规则 6 表的第一行 |
| （开 PR 后的独立复查）分期验收不全、C4d 不可测；回收保护排在 C4b，可 C4a 合并后就会部署 | C4a 加外部调用出错的提示、目录写「现在用不了」、副本缺失、回收保护的验收；回收保护从 C4b 挪进 C4a（规则 10）；C4c 加宿主换版本的提醒和「谁在用」的验收；C4d 改成按技能示例包跑 `just module check` |
| （开 PR 后的独立复查）`protocol.ts` 头注释和 `design.md` 提前写了还没做的例外 | 两处恢复成 main 上的原文，原文今天仍准确；C4a 落地时一起改，列进 C4a 的内容 |
| （开 PR 后的独立复查）ADR-0030 没提 ADR-0018 否掉「受限任务保留 `web_get`」的理由 | ADR-0030「代价」加一条 |
