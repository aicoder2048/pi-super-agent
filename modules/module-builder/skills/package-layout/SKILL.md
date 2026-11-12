---
name: package-layout
description: 新布局模块包里每个文件放什么、怎么写。写或改包里的文件前读
---
# 模块包的布局

完整说明在 `$PSA_REPO/docs/modules/architecture/design.md` 第 2 节。三个模板在 `$PSA_REPO/src/modules/templates/`，每个都带 README.md。

| 文件 | 写什么 |
|---|---|
| `module.json` | `schema` 写 1，`name` 等于文件夹名，`version`，`title`（中文名），`description`（一句话，幕僚长按它分派任务，不超过 60 字），有专家时写 `team`（队名，不和已有的队重名） |
| `knowledge/<名字>/source.json` | `title`、`version`、`published`、`authority`（authoritative 或 reference）、`license`、`origin`（出处） |
| `knowledge/<名字>/*.md` | `license` 是 bundled 时的正文，按 `##` 标题切段。user-import 的包里只有 source.json |
| `skills/<名字>/SKILL.md` | front matter 写 `name`（等于文件夹名）和 `description`（什么时候读），正文是做法 |
| `agents/<名字>.md` | front matter 写 `name`、`title`、`description`、`tools`、`uses`，正文是这位专家的提示词，1 到 2 KB |
| `evals/<名字>.md` | 见技能 write-evals |
| `rules.md` | 只给有 feed 的模块用，「来源:」写 `<模块>/<feed>`。只在使用者开口时做事的模块不写 |

- `tools` 只能从 read、bash、edit、write、grep、find、ls、web_get 里选，用逗号分隔。只读的专家只给 read、grep、find、ls。
- `uses` 写这位专家要用的模块能力：`knowledge`、`tools/<名字>`、`data/<名字>`。包里没有的写了会被检查拒绝。
- 名字都用英文小写和连字符。
- 数据、工具和 feed 照 `full` 模板写，工具要带 `cases.json`。
