---
name: package-layout
description: 新布局模块包里每个文件放什么、怎么写。写或改包里的文件前读
---
# 模块包的布局

完整说明在 `$PSA_REPO/docs/modules/architecture/design.md` 第 2 节。三个模板在 `$PSA_REPO/src/modules/templates/`，每个都带 README.md。

| 文件 | 写什么 |
|---|---|
| `module.json` | `schema` 写 1，`name` 等于文件夹名，`version`，`title`（中文名），`description`（照说明书那一句，见表下），有专家时写 `team`（队名，不和已有的队重名）。开放工具给别的模块时写 `exports`；没有专家、又要用别的模块的工具时写 `uses`（见下面两节） |
| `knowledge/<名字>/source.json` | `title`、`version`、`published`、`authority`（authoritative 或 reference）、`license`、`origin`（出处） |
| `knowledge/<名字>/*.md` | `license` 是 bundled 时的正文，按 `##` 标题切段。user-import 的包里只有 source.json |
| `skills/<名字>/SKILL.md` | front matter 写 `name`（等于文件夹名）和 `description`（什么时候读），正文是做法 |
| `agents/<名字>.md` | front matter 写 `name`、`title`、`description`、`tools`、`uses`，正文是这位专家的提示词，1 到 2 KB |
| `evals/<名字>.md` | 见技能 write-evals |
| `tools/<名字>/` | `tool.json`、`index.ts`、`cases.json`，照 `full` 模板 |
| `data/<名字>/collection.json`、`feeds/<名字>/` | 见技能 data-and-feeds |
| `rules.md` | 有 feed 的模块在这里写规则，「来源:」写 `<模块>/<feed>`。没有来源的模块也可以写一条分派说明，告诉幕僚长什么话开到这个模块；它不授权任何事。两样都不需要就不写 |

- `tools` 只能从 read、bash、edit、write、grep、find、ls、web_get 里选，用逗号分隔。只读的专家只给 read、grep、find、ls。
- `uses` 写这位专家要用的模块能力：`knowledge`、`tools/<名字>`、`data/<名字>`，别的模块开放的工具写全名 `<模块>/tools/<名字>`。本模块里没有的写了会被检查拒绝。
- `uses` 按最小需要列：只写这位专家的做法里真要调的。`class` 是 `private` 的集合（账户、成交、私密的发件人名单）只给真要读写它的专家。领队本来就调得到本模块的知识、工具和数据，不用为领队把能力塞进哪位专家的 `uses`；只有别的模块的工具，领队才取全部专家 `uses` 的并集。
- `description` 原样复制说明书那一句，一字不改。幕僚长按它分派任务，说明书那句里点名的事（管什么、归别的模块的那半句）都是路由要的词。不写施工进度、版本、哪些还没做，这些写进汇报。
- 不自己数字数，也不预先压缩：模型数中文常数错。长度交给 `module check` 判，它按 JavaScript 的 `.length` 数，超过 60 才报一行 `"description" is the Router's roster line, at most 60 characters`。要先量，用 bash 跑 `node -e 'console.log(process.argv[1].length)' "<句子>"`，打印的数就是检查数的数：中文一个字、英文一个字母、一个空格、一个标点各算 1。
- 只有 `module check` 报 description 超长时才压缩：先删空格和「的」，再删冒号，顿号、分号和点名的事都留着，删了什么写进汇报；还超，回复领队，由领队用 report（blocked）问使用者要一句 60 字以内的。
- 专家转述工具结果时，要拿来当考题 `expect` 的字面量（状态码、合约代码、算出来的数），提示词写明「原样照抄工具回的 X，不加千分位、不四舍五入」。工具回 `NOT_IMPLEMENTED` 这类固定状态时，专家原样转述这个状态，不换成「还没做好」之类的说法：桩工具大多回它，考题靠它判分。
- 名字都用英文小写和连字符。
- 包里的文件不写本机绝对路径（主目录、状态目录、临时目录下的完整路径）：包可能进公开仓库，路径也只在这一台机器上有。命令里写 `$STATE`、`$PSA_REPO`，说明文字写 `<状态目录>`。`module check` 见到会给一行提醒。也不引用宿主源码路径（`src/...`），宿主的实现会变，要讲就写做法本身或 `docs/` 里的文档。
- 包里不放测试文件（`tests/`、`*.test.ts`）：`module check` 和 `just test` 都不跑它们。工具要验的输入输出写进 `cases.json`，feed 写成 `fixtures/` 里的样例，`module check` 每次都跑。
- 工具照 `full` 模板的 `tools/` 写，要带 `cases.json`。数据集合、feed 和密钥模板里没有，照技能 data-and-feeds 写。

## 开放工具给别的模块：`exports`

别的模块要用这个模块的只读能力（例如 option-ta 要 stock-ta 的现价），在 `module.json` 写 `exports`，列出开放的工具：

```json
"exports": ["tools/quote", "tools/structure"]
```

- 没有别的模块要用就不写。
- 只能列工具，写成 `tools/<名字>`。数据集合、知识、技能、专家、feed 都不开放。
- 只能开放 `effect` 是 `read` 或不写 `effect` 的工具。列了 `write` 工具，检查报错。
- 包里有 `class` 是 `private` 的数据集合，`exports` 列了工具就报错：工具代码读得到整个模块的数据。写空列表 `[]` 不报错。
- 开放的工具就是对外接口。以后改它的 `input`、`output`，或从 `exports` 拿掉，别的模块的专家可能就用错了。检查会给兼容提醒，见技能 build-module 的「改已有模块」。
- 开放的工具带 `cases.json`。没有用例，兼容提醒比对不了输出。
- 工具收自由文本参数、又会联网的，先别开放：别的模块可能把它的私密内容当参数送出本机（ADR-0030「风险」）。要开放，汇报里写明，请使用者定。

## 用别的模块的工具：外部 `uses`

别的模块在 `exports` 开放的工具，写全名 `<模块>/tools/<名字>` 就能调，例如 `stock-ta/tools/quote`。只写在一处，看包里有没有专家：

| 包 | 写在哪 | 谁调得到 |
|---|---|---|
| 有 `agents/` | 用它的那位专家的 `uses` | 这位专家；领队取全部专家 `uses` 的并集 |
| 没有 `agents/` | `module.json` 的 `uses`，一个列表，只写外部工具全名 | 这个模块的助手 |

- 有 `agents/` 又在 `module.json` 写 `uses`，检查报错。要领队也调得到，就写进某位专家的 `uses`。
- `module.json` 的 `uses` 只收外部工具。写 `knowledge`、`tools/x`、`data/x` 报错：没有专家时，本模块的能力不写也都调得到。
- 用外部工具的专家，提示词照技能 build-module「和别的模块连起来」的三条写：提供方不在时照常做完其余部分、请对提供方说、只传必要的参数。
- 考题的 `uses` 也可以写全名，表示这道题要用到这个外部工具。
- 检查只看这一个包，看不到提供方有没有开放这个工具，所以外部工具只给一行提醒，不报错。提供方没装、没开、没开放这个工具，是调用时才知道的。

## 两个示例包

两个包都只用 stock-ta 开放的 `quote` 取现价，自己做的是 stock-ta 不管的事：算仓位、排定投。示例的用途别和提供方的 `description` 重叠，不然幕僚长会把问题开到提供方去。每个代码块上写着 `file=<包>/<路径>`，就是那个文件在包里的位置。

**带专家：`position-sizer`。** `uses` 写在专家文件里，`module.json` 没有 `uses`。

```json file=position-sizer/module.json
{
  "schema": 1,
  "name": "position-sizer",
  "version": "0.1.0",
  "title": "仓位计算",
  "description": "按总资金、单笔风险比例和止损价，算一笔交易买多少股",
  "team": "仓位组"
}
```

```markdown file=position-sizer/agents/sizer.md
---
name: sizer
title: 算仓位
description: 按总资金、风险比例、止损价和现价，算一笔交易买多少股、占总资金几成
tools: read
uses: stock-ta/tools/quote
---
你是仓位组的算仓位。使用者给总资金、单笔愿意亏的比例和止损价；没给现价时，用 `stock-ta/tools/quote` 查。

## 怎么算

- 每股风险 = 现价 − 止损价。止损价不低于现价时，不算，回复说止损价要低于现价。
- 可亏金额 = 总资金 × 风险比例。股数 = 可亏金额 ÷ 每股风险，向下取整。
- 仓位占比 = 股数 × 现价 ÷ 总资金。超过 100% 时，股数改成总资金能买的最多股数，写明是资金不够，不是风险比例限制的。

## 调 stock-ta 的工具

- `symbols` 只填股票代码，不填资金、止损价这些数，也不填使用者的原话。
- 用工具回的 `price`，写明数据时间 `at` 和时段 `session`。代码在 `missing` 里时，写明行情服务没给这只的价格，请使用者自己给现价。
- 调用回「stock-ta 没装或没开」这类原因时，汇报写明现价没查到、为什么；使用者给了现价就照常算完，没给就只列公式。
- 要 stock-ta 那边才做得了的事（加自选股、看笔记原文），写成「请对 stock-ta 说……」，你自己不做。

## 回复

先写股数和仓位占比，再写现价、每股风险、可亏金额，最后写用了哪些假设。
```

```markdown file=position-sizer/evals/risk-sized.md
---
name: risk-sized
uses: stock-ta/tools/quote
expect: 每股风险
---
总资金 10 万美元，这笔最多亏 1%，NVDA 止损设在现价下方 5 美元。按现价能买多少股？占总资金几成？
```

**不带专家：`dca-plan`。** 没有 `agents/`，`uses` 写在 `module.json` 里，做法写在技能里。

```json file=dca-plan/module.json
{
  "schema": 1,
  "name": "dca-plan",
  "version": "0.1.0",
  "title": "定投计划",
  "description": "按每月定投金额和现价，算这个月每只买几股、剩多少钱",
  "uses": ["stock-ta/tools/quote"]
}
```

```markdown file=dca-plan/skills/monthly/SKILL.md
---
name: monthly
description: 使用者要排这个月的定投：每只买几股、剩多少钱时读
---
# 这个月的定投

1. 用 `stock-ta/tools/quote` 查每只的现价，`symbols` 只填股票代码。
2. 每只的金额 ÷ 现价，向下取整就是股数；金额减去股数 × 现价是剩下的钱。
3. 回一张表：代码、现价、股数、剩下的钱，表下写数据时间。

查不到价格的（在 `missing` 里，或调用回了原因），表里写「没查到」和原因，其余照常算。要 stock-ta 才做得了的事，写成「请对 stock-ta 说……」。
```
