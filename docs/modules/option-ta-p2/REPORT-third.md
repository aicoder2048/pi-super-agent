# option-ta P2 第三次：验证工坊第二轮修复和预演静默

日期：2026-11-17（美东上午，盘前）。代码：main `fd6becdc`（#177 启动日志分开写检查中的模块；#178 修第二次暴露的工坊毛病；#179 预演里 feed 样例交回的触发和提醒不交出去；#180 build plan 第 5 步写 `"feedFixtures": "rows-only"`）。目的：用和前两次相同的环境、同一句话、同样的材料再跑一次 P2，看第二次没修完的两条、第二次的新毛病 A、C、D 和第一次的九条。操作员只发话、记录、验收，不改工坊交出的包。第一次的记录在 draft PR #173 的 `docs/modules/option-ta-p2/REPORT.md`，第二次在 draft PR #176 的 `REPORT-rerun.md`。这次取代 #176。

## 结论

- 工坊交出了包和汇报，没有用 report（blocked）提问。
- `just module check` 打印 `ok option-ta@0.1.0`，十行外部 `uses` 提醒（专家五行、考题五行），没有 description 超长、长题面、本机路径提醒。在仓库里重跑，digest `2bba3ea3c1a9`，和工坊最后一次相同。
- `description` 原样复制说明书那句，58 字。修好。
- `expect` 六道全是工具字面量 `NOT_IMPLEMENTED`，没有自造短语，没有为考题改给使用者看的措辞。修好（预演第 1 轮就全过，FAIL 后的规矩这次没机会验）。
- 预演静默（C）修好：预演输出有 `[预演] … 丢掉 N 条触发` 行，考题记录里没有成交核对之类的无关插话；P2 宿主本身是 rows-only，只开了工坊这一个任务，stock-ta 样例没开任务。剩一处：每道题记录里的 Router 行是上一道题的转述（新毛病 G，在 `module try`，不在工坊）。
- 考题覆盖（D）基本修好：6 道，两位用外部工具的专家都有题调到 stock-ta 五个工具，记成交、查询各有题。缺「维护期权自选、改意图」这类写入意图的题。
- `module try` 三轮：工坊第 1 轮 6/6；操作员第 2、3 轮都是 5/6，挂的题不同。挂的原因都是考题 `uses` 列了模型不一定会调的东西（新毛病 F）。
- stock-ta 在预演里真调了 `quote`、`prices`、`structure`、`signals`、`earnings-date` 五个，三轮都调到（第 2 轮那道题挂在没读 knowledge，五个外部工具都调到了）。
- 用时 32.1 分钟，任务合计 3.81M 输入（含缓存 3.47M）、61k 输出、41 次工具调用。第二次 30.6 分钟、6.88M、77k、55 次。输入少了约 45%，时长持平。各只跑一次，不能当成稳定的结论。
- 新毛病五条，最要紧的两条：工坊没照说明书给 `fills` 接 `mail`（E），考题 `uses` 堆得太多导致预演不稳（F）。

## 环境

和前两次相同，只改了 `feedFixtures`。

| 项 | 做法 | 核对 |
|---|---|---|
| 代码 | `git worktree add --detach` 到临时目录（`origin/main` `fd6becdc`），链主目录的 `node_modules` | 主工作目录没切分支、没改文件 |
| 状态目录 | `mktemp -d`，权限 700 | 没碰真实状态目录，没碰老 Mac |
| 模型 | router `openai-codex/gpt-6.1-terra`，worker 和 fallback `openai-codex/gpt-6.1-sol` | 起宿主前 grep 临时 `config.json`，`anthropic` 0 处；宿主启动行也是这三个模型 |
| 密钥文件 | `secretsFile` 是临时目录里新建的空文件 | 没有 `TELEGRAM_BOT_TOKEN`、Gmail 授权、GitHub token |
| Telegram | `config.json` 没有 `telegram` 段 | 宿主日志 0 处 Telegram |
| 网页 | `webPort: 4597` | 起之前本机 4597 没有监听，本机没有别的宿主在跑 |
| feed | `"feedFixtures": "rows-only"` | 宿主日志 `[预演] stock-ta/quotes 样例 nvda-down-5：丢掉 1 条触发、2 条提醒，没交出去`；全程 `tickets` 只有工坊一行 |
| stock-ta | 复制包、`just module setup stock-ta`（ta-trading 装上了）、合成夹具 `ta.sqlite`、两把 key 经管道写进临时 `modules-data/stock-ta/.env`（600，值不经屏幕）、`just module on stock-ta` | `just modules` 显示 stock-ta「运行中」；预演开头没有「stock-ta 现在没开」 |

和前两次比的两处变化：

- 宿主启动日志第一行现在写「检查中：stock-ta」，不再写「停用」（#177）。
- stock-ta 的 `quotes` 样例不再开任务。第一、二次各开了一个，用了 29 万、37 万 token。这次 `usage_daily` 全天 3,902,622，就是工坊加 Router。

## 发话

用 `src/cli/say.ts say`（`just say` 的同一条命令），和前两次一字不差，路径换成这次的临时代码 worktree：

> 用模块工坊做一个新模块 option-ta。说明书和术语表在附上的文件里，按说明书做、不用问我，缺的按默认值并在汇报里写明。材料（绝对路径）：说明书 …/option-ta-spec.md；术语表 …/option-ta-glossary.md（放进包的 knowledge/glossary/，license bundled，authority reference）；税务口径看 …/option-ta-tax-memo.md 第 14 节；期权接口实测看 …/option-ta-p1/README.md；成交回信的虚构样例在 …/option-ta-p1/mail-samples/；已定范围和提醒门槛看 …/option-ta-build-plan.md 的「已定的第一版范围」。从 theta 移植计算代码不归这次，工具先写能过检查的最简实现，在汇报里列出哪些还没做。

Router 22 秒后回「已交给模块工坊制作 option-ta……」，任务开到 `module-builder`。

## 时间线和 token

时刻是美东时间。成员用量从各成员的会话记录加总（输入含缓存读）。六份加起来 3.81M，和任务行的 `tokens_in` 对得上。

| 时刻 | 步骤 | 用时 | 输入 / 缓存读 / 输出 / 工具调用 |
|---|---|---|---|
| 08:12:53 | 领队开工，自己把说明书逐字复制成 `spec.md` | | |
| 08:13:14 | 访谈：只在末尾补「假设和缺项」 | 2.0 分 | 126k / 79k / 3.4k / 9 |
| 08:15:44 | 搭结构，和整理知识并行 | 11.7 分 | 1,301k / 1,228k / 30.6k / 88 |
| 08:15:44 | 整理知识 | 3.3 分 | 564k / 520k / 7.5k / 26 |
| 08:27:46 | 出考题 | 3.9 分 | 488k / 403k / 6.9k / 40 |
| 08:32:00 | 领队删掉模板留下的 `knowledge/getting-started` | | |
| 08:32:13 | 检查：跑到 ok | 1.0 分 | 73k / 43k / 2.4k / 13 |
| 08:33:22 | 领队后台起预演；预演跑着时，领队自己往 `knowledge/tax-basis/tax.md` 补了一节 §1256 与年末快照（08:34），再跑检查、写汇报 | | |
| 约 08:44 | 预演结束：6/6 | 约 10 分 | 不计入（独立临时宿主） |
| 08:44:58 | 汇报（ready），任务关 | 合计 32.1 分 | 任务合计 3.81M / 3.47M / 61k / 41（领队自己 1.26M） |

成员合计约 2.55M，领队约 1.26M。第二次成员约 5.30M、领队约 1.6M。搭结构从 16 分钟降到 11.7 分钟、2.75M 降到 1.30M，主要因为这次没写 `fills` 的真解析（第二次写了 10.8 KB 的 `parser.ts` 和 14 份夹具）。领队这次没有改包轮次：预演一次就全过。

## 三次对照

| 项 | 第一次（#173） | 第二次（#176） | 第三次（本 PR） |
|---|---|---|---|
| main | `ce75a580` | `80c627eb` | `fd6becdc` |
| 用时（开到关） | 48.7 分 | 30.6 分 | 32.1 分 |
| 任务输入（含缓存） | 8.52M | 6.88M（缓存 6.47M） | 3.81M（缓存 3.47M） |
| 输出 | 104k | 77k | 61k |
| 工具调用 | 60 | 55 | 41 |
| 当天用量减 stock-ta 样例任务 | 约 8.39M | 约 7.02M | 3.90M（没有样例任务） |
| 领队 / 成员 | 约 3.2M / 5.3M | 约 1.6M / 5.3M | 1.26M / 2.55M |
| 工坊预演轮数 | 3（改包两轮） | 2（改包一轮） | 1 |
| `module try` | 3/4、3/4、3/4 | 2/3、3/3、3/3、3/3 | 6/6、5/6、5/6 |
| 考题数 | 4 | 3 | 6 |
| 调到的 stock-ta 工具 | structure、signals | earnings-date | quote、prices、structure、signals、earnings-date |
| description | 写进「P2骨架」 | 自写 44 字 | 说明书原句 58 字 |
| expect | 拆成 `QCC`、`待确认` | 自造 `QCC待确认` | 全部 `NOT_IMPLEMENTED` |
| 专家 / 技能 / 知识 | 见 #173 | 6 / 5 / 6 | 6 / 1 / 4 |
| `fills` | 占位 | HTML 真解析，接 `mail` | 占位，**不接 `mail`** |

三次各跑一次，没有方差。token 降的方向和修复对得上（预演改包轮次从 2 降到 0），但搭结构少写一个解析器就占了约 1.4M，这一项是工坊对「最简实现」的不同取舍，不是修复带来的。

## 交出的包

`docs/modules/examples/option-ta/`，59 个文件，和工坊交出的逐字节相同（`diff -r` 无差异）。包里没有本机路径，没有替换任何东西。

| 组成 | 数量 | 内容 |
|---|---|---|
| 专家 | 6 | direction、volatility、strategy、position、ledger、critic（反方），1.9 到 2.1 KB |
| 技能 | 1 | option-lead（领队：分档、会诊、写入、五段输出），5.6 KB |
| 知识 | 4 | glossary（与仓库术语表逐字节一致）、operating-rules、tax-basis、market-data-limits |
| 集合 | 6 | 和说明书完全一致 |
| 工具 | 5 | chain、vol、strategy、record、ledger，全部 return `{"status":"NOT_IMPLEMENTED"}`，不 throw；`cases.json` 合计 24 条 |
| feed | 3 | `fills`、`iv`、`watch` 都是回状态的占位；`iv`、`watch` 的 `settings` 写了口径和门槛默认值；`fills` 没有 `"connector": "mail"`（毛病 E） |
| 规则 | 3 | 三个 feed 的状态各一条，文件头一段写路由 |
| 考题 | 6 | 见下 |

工坊汇报原样（只换临时路径）在 `third/workshop-report.md`，过程说明书在 `third/interviewer-spec.md`，三轮预演日志在 `third/try-logs/`，检查输出在 `third/module-check.log`。

## `module check`

```text
note agents/direction.md: uses "stock-ta/tools/structure", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/signals", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/prices", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/quote", another module's tool; this check cannot see whether stock-ta exports it
note agents/volatility.md: uses "stock-ta/tools/earnings-date", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/structure", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/signals", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/prices", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/quote", another module's tool; this check cannot see whether stock-ta exports it
note evals/private-entry-external.md: uses "stock-ta/tools/earnings-date", another module's tool; this check cannot see whether stock-ta exports it
ok option-ta@0.1.0 | knowledge=4 data=6 tools=5 skills=1 feeds=3 agents=6 evals=6 | rules=3 | data-classes=shareable:2,private:4 | secrets=FINNHUB_API_KEY,POLYGON_API_KEY | digest=2bba3ea3c1a9
```

## 考题

| 文件 | 题面字数 | 来源 | `uses` | `expect` |
|---|---|---|---|---|
| uses-tool | 61 | 典型问题 1 | tools/chain | NOT_IMPLEMENTED |
| position-buyback | 122 | 典型问题 2 | knowledge、tools/ledger、tools/strategy | NOT_IMPLEMENTED |
| roll-net-credit | 148 | 典型问题 3 | tools/strategy | NOT_IMPLEMENTED |
| record-unknown-fees | 121 | 典型问题 4（记成交） | tools/record | NOT_IMPLEMENTED |
| cites-knowledge | 107 | 典型问题 5 | knowledge、tools/ledger | NOT_IMPLEMENTED |
| private-entry-external | 124 | 说明书「全员会诊」的开仓 | knowledge、tools/vol、tools/strategy、stock-ta 五个工具 | NOT_IMPLEMENTED |

每道题都取了典型问题原句，再补账户 `acct-blue`、日期、价格这类事实。出考题的回复逐题写了 `expect` 取自哪个工具的 `index.ts`，没给专家补「原样照抄」（专家和领队技能本来就写了）。

## 预演

| 轮 | 谁跑的 | 包 | cites-knowledge | position-buyback | private-entry-external | record-unknown-fees | roll-net-credit | uses-tool |
|---|---|---|---|---|---|---|---|---|
| 1 | 工坊 | 补 §1256 前 | PASS | PASS | PASS | PASS | PASS | PASS |
| 2 | 操作员 | 最终 | PASS | PASS | FAIL：没用到 knowledge | PASS | PASS | PASS |
| 3 | 操作员 | 最终 | PASS | FAIL：没用到 tools/ledger | PASS | PASS | PASS | PASS |

- 工坊的第 1 轮用的是起预演时的包快照，之后领队补了一节知识，没再预演（汇报里写了）。操作员第 2、3 轮测的是最终包。
- 三轮开头都没有「stock-ta 现在没开」。三轮开头各有 9 行 `[预演] … 丢掉 N 条触发、M 条提醒，没交出去`（option-ta 的 8 个样例加 stock-ta 的 `nvda-down-5`）。
- private-entry-external 三轮都调到了 stock-ta 五个工具：`quote` 回盘前延迟 15 分钟的价（157.91、157.7、157.15），`prices` 回合成库 202.37、`stale=true`，`structure`、`signals` 回合成库的结构和信号，`earnings-date` 回「NVDA 财报 2026-11-17 盘后」。专家把盘前价和旧缓存价的冲突明说出来，没有混算。第 2 轮挂在专家没读 knowledge，外部工具全调到了。
- 两次 FAIL 都是 `uses` 里多列的一项没被调到，`expect` 都过了。模型回答的内容是对的：第 3 轮 position-buyback 用使用者口述的价位，没去 ledger 查，也合理。见毛病 F。
- 六道题的回答都把 `NOT_IMPLEMENTED` 原样说出来，没有编数字。
- 题目记录里没有和考题无关的插话。每道题下面的 Router 行，第一行是上一道题的结论转述，第二行才是这道题的「我会……」。见毛病 G。

## 第二次没修完的两条

| # | 第二次 | 这次 | 结论 | 证据 |
|---|---|---|---|---|
| 3 description | 访谈判它超 60 字，自写 44 字 | 访谈没提长度。`module.json` 的 `description` 和说明书第 10 行冒号后那句逐字相同；`node -e` 按 `.length` 量是 58；检查没报超长；汇报写「原样保留说明书句子，实测 58 字符，未压缩」 | 修好 | `module.json`；`workshop-report.md`「交付与边界」 |
| 2 expect | 自造 `QCC待确认`，FAIL 后改三处提示词 | 六道全是 `NOT_IMPLEMENTED`，各取自对应工具 `index.ts` 的 `status`。包里搜不到「机器可检验」「不插入空格」「原样输出」。专家和技能里的「原样照抄」都是针对工具状态码、合约代码、数字，#178 允许。预演第 1 轮全过，没有 FAIL 后改措辞的机会；出考题和领队都没动 `expect` | 修好（FAIL 后的路径没被触发，没验到） | `evals/*.md`；`grep -rn '原样照抄'` |

## 第二次的新毛病

| 毛病 | 这次 | 结论 |
|---|---|---|
| A 自造短语、改产品提示词迁就考题 | 没有自造短语，没有改提示词。`expect` 只用工具字面量 | 修好 |
| B description 字数数错 | 同上表第 3 条 | 修好 |
| C 预演里 Router 插话 | 没有成交核对类的插话；`[预演]` 丢弃行齐全；P2 宿主只开了工坊一个任务。剩下的错位是 `module try` 记录的问题（G） | 修好（另有 G） |
| D 考题覆盖 | 6 道（4 到 6 之内）。方向专家的四个外部工具、波动率专家的 `earnings-date` 都在 private-entry-external 里调到；记成交（record-unknown-fees）、查询（uses-tool 等）各有题；有 knowledge 题。缺维护期权自选、改意图这类领队写入的意图 | 基本修好（缺写入类意图） |

## 第一次的九条

| # | 第一次的毛病 | 这次 | 结论 |
|---|---|---|---|
| 1 | 题面是操作脚本 | 61 到 148 字，使用者口吻。private-entry-external 写了「结合正股实时与缓存价格、趋势关键位、近期信号、IV 和到期前财报」，近乎点名要调哪几样，是边缘写法（见 I） | 保持（一处边缘） |
| 2 | 拆 `expect` | 没拆没删 | 保持 |
| 3 | `description` 写施工状态 | 说明书原句 | 保持 |
| 4 | 多集合 | 6 个，和说明书一致 | 保持 |
| 5 | README 有本机路径 | 包里 `grep` 不到 `/Users/`、`/var/folders`；检查没有路径提醒 | 保持 |
| 6 | 访谈重写 `spec.md` | `spec.md` 前 28,406 字节和说明书逐字节相同，访谈只在末尾补「假设和缺项」（约 5.6 KB） | 保持 |
| 7 | 专家 `uses` 多了 brokers、market-snapshots | 没有专家 `uses` brokers；ledger 的正文写「不读 brokers」 | 保持 |
| 8 | 包里有测试文件 | `find -name '*.test.*'` 为空 | 保持 |
| 9 | 知识引用 `src/` 路径 | `grep -rn 'src/'` 为空 | 保持 |

## 新出现的毛病

按严重程度。

### 中

E. **`fills` 没照说明书接 `mail`。** 说明书「模板」写死 `fills`：`"connector": "mail"`，`settings.senders` 写 `"brokers"`。工坊的 `feeds/fills/feed.json` 有 `senders` 却没有 `connector`，标题改成「成交邮件安全占位（未接 mail）」。理由写在汇报「未完成项」第 3 条和 `rules.md`：解析没实现，空的成功返回会推进 mail 连接器的 cursor，真信就被吞了。这个顾虑本身成立（解析器没写之前接上 mail，开了模块、填了 brokers 就会漏信）。但发话说「按说明书做」，说明书明确写了，偏离应该走 report（blocked）问，或照说明书接上、在汇报里写清「解析没实现前别填 brokers、别开模块」。工坊把它当默认值报了。建议修工坊：build-module 写明「说明书写死的结构（connector、集合、`uses`）不改；觉得有风险，照写并在汇报里提醒，或 blocked 问」。是否修宿主让空成功不推进 cursor，另议。

F. **考题 `uses` 堆了模型不一定调的东西，预演不稳。** 判分要求 `uses` 每一项都用到。position-buyback 列了 knowledge、ledger、strategy，private-entry-external 列了 knowledge 加七个工具。第 2 轮 private-entry-external 没读 knowledge，第 3 轮 position-buyback 没调 ledger（使用者口述了价位，不查账本也合理），各挂一道。#178 的「覆盖」一节说「一道自然的问题本来就同时满足几条的，算一道」，出考题照这个把多项塞进一道题的 `uses`，和「一道题只考一件事」冲突。建议修工坊：write-evals 写明 `uses` 只列这道题不调就答不了的那一两项；knowledge 只在专考知识的那道里列。

### 低

G. **`module try` 的 Router 行错位一道。** `src/cli/module-try.ts` 每道题只收「发问到汇报落库」之间的 Router 回复。Router 转述汇报在汇报落库之后，于是落进下一道题的窗口；最后一道题的转述丢了。判分不受影响（判的是任务和汇报），但读日志的人会以为 Router 在插话。这是第二次毛病 C 剩下的那一半，归 `module try`，不归工坊。建议等汇报落库后再等 Router 的那条转述，或按任务号归属回复。

H. **领队在预演跑着时改了知识，没再预演。** 08:34 领队补了 `tax-basis/tax.md` 的 §1256 与年末快照一节，汇报写明「未再次预演这一纯知识增补」。如实说了，但交出的包没有被工坊自己预演过。操作员第 2、3 轮补上了。建议 build-module 写明改包后要重跑预演，或预演前定稿。

I. **一道题面近乎点名工具。** private-entry-external 列出「正股实时与缓存价格、趋势关键位、近期信号、IV 和到期前财报」，正好对应 quote、prices、structure、signals、vol、earnings-date。这道题本来就是凑来覆盖外部工具的，不在五个典型问题里。题设「已持有 200 股 NVDA」和卖 put 无关，专家都指出了。属于第一次毛病 1 的边缘，记下观察。

另记一处不算毛病的观察：rows-only 的正式宿主（P2 宿主，不是预演）日志里丢弃行也带 `[预演]` 前缀。行为对，前缀让人误以为在跑预演。可以改成按宿主角色打前缀。

## 操作员替使用者做的判断

1. 发话和前两次一字不差，路径换成这次的临时代码 worktree。依据：三次要可比。
2. stock-ta 日线库用合成夹具。依据：前两次都用合成库；判「用到了」不需要真数据。
3. 两把 stock-ta key 从本机真实状态目录的配置只读取出，经管道写进临时 `.env`，值不经屏幕；没给 option-ta 写 `.env`（它的工具和 feed 都不联网）。
4. 工坊没有提问，没有替使用者回答任何问题。
5. 加跑两轮 `module try`（第 2、3 轮）。依据：要求跑 3 轮看稳定性；工坊那一轮测的不是最终包。代价是两轮预演的 token（独立临时宿主，没计入上表），每轮约 10 分钟。
6. 包一个字节没改，包括 E 的 `fills` 偏离。依据：操作员不是作者，偏离记成毛病交给工坊修和 P3 决定。
7. E 定为「中」：工坊的顾虑成立，但偏离说明书该问。没有替使用者决定接不接 `mail`。
8. D 定为「基本修好」：外部工具和数量达标；「设提醒」在 option-ta 里是自动提醒，不算使用者发起的意图，所以只把维护期权自选、改意图记成缺口。
9. G 归 `module try`，不归工坊，也不算 C 没修好：插话的来源（feed 样例的 notice）已经没了，剩下的是记录归属。
10. 第 2 条（expect）判「修好」但注明 FAIL 后的路径没被触发。
11. 工坊汇报、过程说明书、预演日志、检查输出里的临时路径换成 `<状态目录>`、`<预演临时目录>`、`<仓库>` 再提交。
12. 产出放在 `docs/modules/option-ta-p2/REPORT-third.md` 和 `docs/modules/option-ta-p2/third/`。前两次的记录在 #173、#176 分支上，这个分支从 main 开，不带它们。
13. 临时目录里另有一个 2026-11-16 18:30 留下的 `psa-try-SuGv2s`（只有空的 `modules-data/`，没有 `.env`），不是这次产生的，没动。

## 交给 P3 的清单（相对第二次的更新）

1. **`chain`**、**`vol`**、**`strategy`**、**`record`**、**`ledger`**：全部只回 `NOT_IMPLEMENTED`，全部要做。`record` 的 `order_key`、`fill_id`、只读查重、交回规整行；`strategy` 的权利金、盈亏平衡、年化、指派概率和三种 Roll。
2. **`fills` feed**：没有解析器，也没接 `mail`（毛病 E）。要先定：照说明书接 `mail`；解析失败时不推进 cursor 的办法（宿主还是 handler）。第二次工坊写过一版 HTML 解析（#176 分支 `docs/modules/examples/option-ta/feeds/fills/parser.ts`，14 份夹具），可以拿来审，期望值没有独立核对过。
3. **`iv`**、**`watch`** feed：回状态的占位。`settings` 里写了口径和门槛默认值（收盘后 30 分钟、目标 30 天、21 到 45 天、零利率零股息、HV20、5 分钟检查等），都是访谈的假设，P3 要和使用者或 theta 对一遍。
4. **`cases.json`**：24 条，只有固定状态和输入校验，休市、缺字段、`status: "ERROR"`、HTTP 429 和 5xx 都没有。
5. **考题**：收窄 `uses`（毛病 F）；补一道维护期权自选或改意图；工具实现以后把 `NOT_IMPLEMENTED` 换成算出来的字面量。
6. **知识**：tax-basis、operating-rules、market-data-limits 是整理稿，不是原文，要对 tax memo 第 14 节和 build plan 核一遍。只有 glossary 是原文。
7. **技能**：只有领队一份（第二次有五份）。专家各自的方法目前写在专家文件里，P3 看是否要拆。
8. 第二次清单里的 `description` 一项已经不需要。

## 清理

临时宿主停止，无残留进程，4597 没有监听；临时状态目录（含 stock-ta 真 key）整个删除；代码 worktree 删除。核对结果写在 PR 描述里。
