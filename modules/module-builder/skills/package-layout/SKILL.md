---
name: package-layout
description: 新布局模块包里每个文件放什么、怎么写。写或改包里的文件前读
---
# 模块包的布局

完整说明在 `$PSA_REPO/docs/modules/architecture/design.md` 第 2 节。三个模板在 `$PSA_REPO/src/modules/templates/`，每个都带 README.md。

| 文件 | 写什么 |
|---|---|
| `module.json` | `schema` 写 1，`name` 等于文件夹名，`version`，`title`（中文名），`description`（一句话，幕僚长按它分派任务，不超过 60 字），有专家时写 `team`（队名，不和已有的队重名）。开放工具给别的模块时写 `exports`；没有专家、又要用别的模块的工具时写 `uses`（见下面两节） |
| `knowledge/<名字>/source.json` | `title`、`version`、`published`、`authority`（authoritative 或 reference）、`license`、`origin`（出处） |
| `knowledge/<名字>/*.md` | `license` 是 bundled 时的正文，按 `##` 标题切段。user-import 的包里只有 source.json |
| `skills/<名字>/SKILL.md` | front matter 写 `name`（等于文件夹名）和 `description`（什么时候读），正文是做法 |
| `agents/<名字>.md` | front matter 写 `name`、`title`、`description`、`tools`、`uses`，正文是这位专家的提示词，1 到 2 KB |
| `evals/<名字>.md` | 见技能 write-evals |
| `rules.md` | 有 feed 的模块在这里写规则，「来源:」写 `<模块>/<feed>`。没有来源的模块也可以写一条分派说明，告诉幕僚长什么话开到这个模块；它不授权任何事。两样都不需要就不写 |

- `tools` 只能从 read、bash、edit、write、grep、find、ls、web_get 里选，用逗号分隔。只读的专家只给 read、grep、find、ls。
- `uses` 写这位专家要用的模块能力：`knowledge`、`tools/<名字>`、`data/<名字>`，别的模块开放的工具写全名 `<模块>/tools/<名字>`。本模块里没有的写了会被检查拒绝。
- 名字都用英文小写和连字符。
- 数据、工具和 feed 照 `full` 模板写，工具要带 `cases.json`。

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

## 用别的模块的工具：外部 `uses`

别的模块在 `exports` 开放的工具，写全名 `<模块>/tools/<名字>` 就能调，例如 `stock-ta/tools/quote`。只写在一处，看包里有没有专家：

| 包 | 写在哪 | 谁调得到 |
|---|---|---|
| 有 `agents/` | 用它的那位专家的 `uses` | 这位专家；领队取全部专家 `uses` 的并集 |
| 没有 `agents/` | `module.json` 的 `uses`，一个列表，只写外部工具全名 | 这个模块的助手 |

- 有 `agents/` 又在 `module.json` 写 `uses`，检查报错。要领队也调得到，就写进某位专家的 `uses`。
- `module.json` 的 `uses` 只收外部工具。写 `knowledge`、`tools/x`、`data/x` 报错：没有专家时，本模块的能力不写也都调得到。
- 考题的 `uses` 也可以写全名，表示这道题要用到这个外部工具。
- 检查只看这一个包，看不到提供方有没有开放这个工具，所以外部工具只给一行提醒，不报错。提供方没装、没开、没开放这个工具，是调用时才知道的。

## 两个示例包

两个包都只用 stock-ta 开放的 `quote`。每个代码块上写着 `file=<包>/<路径>`，就是那个文件在包里的位置。

**带专家：`quote-desk`。** `uses` 写在专家文件里，`module.json` 没有 `uses`。

```json file=quote-desk/module.json
{
  "schema": 1,
  "name": "quote-desk",
  "version": "0.1.0",
  "title": "报价台",
  "description": "问一只或几只美股、ETF 现在的价格和涨跌",
  "team": "报价台"
}
```

```markdown file=quote-desk/agents/pricer.md
---
name: pricer
title: 报价
description: 查一只或几只美股、ETF 的现价、昨收和涨跌幅
tools: read
uses: stock-ta/tools/quote
---
你是报价台的报价。用 `stock-ta/tools/quote` 查价，`symbols` 只填股票代码，逗号分隔，不填别的话。

- 回复先写每只的代码、现价、涨跌幅和数据时间，再写时段。工具回的 `missing` 照列，写明行情服务没给这几只。
- 工具回「stock-ta 没装或没开」这类原因时，汇报写明这部分没做、为什么，其余照常做完。
- 要 stock-ta 那边才做得了的事（加自选股、看笔记原文），写成「请对 stock-ta 说……」，你自己不做。
```

```markdown file=quote-desk/evals/quote-now.md
---
name: quote-now
uses: stock-ta/tools/quote
expect: NVDA
---
NVDA 现在多少钱？比昨天收盘涨了还是跌了？
```

**不带专家：`quote-glance`。** 没有 `agents/`，`uses` 写在 `module.json` 里，做法写在技能里。

```json file=quote-glance/module.json
{
  "schema": 1,
  "name": "quote-glance",
  "version": "0.1.0",
  "title": "看一眼价格",
  "description": "一句话问某只美股现在多少钱",
  "uses": ["stock-ta/tools/quote"]
}
```

```markdown file=quote-glance/skills/glance/SKILL.md
---
name: glance
description: 使用者问某只美股、ETF 现在多少钱时读
---
# 看一眼价格

用 `stock-ta/tools/quote` 查，`symbols` 只填股票代码。回一句话：代码、现价、涨跌幅、数据时间。

工具回不来时，写明价格没查到和工具给的原因。要 stock-ta 才做得了的事，写成「请对 stock-ta 说……」。
```
