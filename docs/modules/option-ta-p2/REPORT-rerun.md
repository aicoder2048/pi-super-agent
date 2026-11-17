# option-ta P2 重跑记录：验证工坊修复

日期：2026-11-17（美东凌晨，休市）。代码：main `80c627eb`（#174 修了第一次 P2 暴露的九条工坊毛病；#175 把说明书的一句话改到 58 字）。目的：用和第一次相同的环境、同一句话、同样的材料重跑 P2，逐条看九条毛病还在不在。操作员只发话、记录、验收，不改工坊交出的包。第一次的记录在 draft PR #173 的 `docs/modules/option-ta-p2/REPORT.md`，下文称「第一次」。

## 结论

- 工坊交出了包和汇报，没有用 report（blocked）提问。
- `just module check` 打印 `ok option-ta@0.1.0`，六行外部 `uses` 提醒，没有长题面提醒，没有本机路径提醒。
- 九条毛病：七条修好，两条部分修好（第 2 条 `expect`、第 3 条 `description`）。
- `module try` 共四轮：工坊第 1 轮 2/3（改包前），工坊第 2 轮 3/3，操作员加跑两轮都是 3/3。后三轮用的都是最终包。
- stock-ta 在预演里真调了：`earnings-date` 每轮都调到，回了 Finnhub 的真实财报日。`structure`、`signals` 这次没有考题，预演没调到（第一次调到了）。
- 用时 30.6 分钟（第一次 48.7 分钟），任务合计 6.88M 输入（含缓存 6.47M）、77k 输出、55 次工具调用（第一次 8.52M、104k、60 次）。各只跑了一次，差距不能当成稳定的提速。
- 新毛病四条，见「新出现的毛病」。最要紧的一条：考题的固定短语是工坊自己定的，和税务 memo 原文差一个空格，预演挂了以后工坊去改产品提示词迁就它。

## 环境

和第一次相同。

| 项 | 做法 | 核对 |
|---|---|---|
| 代码 | `git worktree add --detach` 到临时目录，链主目录的 `node_modules` | 主工作目录没切分支、没改文件 |
| 状态目录 | `mktemp -d`，权限 700 | 没碰真实状态目录，没碰老 Mac |
| 模型 | router `openai-codex/gpt-6.1-terra`，worker 和 fallback `openai-codex/gpt-6.1-sol` | 起宿主前 grep 临时 `config.json`，`anthropic` 0 处；宿主启动行也是这三个模型 |
| 密钥文件 | `secretsFile` 是临时目录里新建的空文件 | 没有 `TELEGRAM_BOT_TOKEN`、Gmail 授权、GitHub token |
| Telegram | `config.json` 没有 `telegram` 段 | 日志里没有 Telegram 行 |
| 网页 | `webPort: 4597` | 起之前本机没有宿主在跑 |
| feed | `"feedFixtures": true` | stock-ta 的 `quotes`、`scan` 只跑了自己的样例 |
| stock-ta | 复制包、`just module setup stock-ta`（ta-trading 装上了）、合成夹具 `ta.sqlite`、两把 key 用 `docs/deploy/home-mac.md` 的管道写法写进临时 `modules-data/stock-ta/.env`（600，值不经屏幕）、`just module on stock-ta` | `just modules` 显示 stock-ta「运行中」；预演开头没有「stock-ta 现在没开」 |

和第一次一样，`quotes` 的样例 `nvda-down-5` 起宿主时开了一个 stock-ta 任务，用了约 37 万 token。宿主启动日志第一行仍写「停用 stock-ta」，`just modules` 却显示运行中。这处日志和实际开关不一致的问题还在，第一次已记，和工坊无关。

## 发话

用 `just say`，和第一次一字不差（路径换成这次的临时代码 worktree）：

> 用模块工坊做一个新模块 option-ta。说明书和术语表在附上的文件里，按说明书做、不用问我，缺的按默认值并在汇报里写明。材料（绝对路径）：说明书 …/option-ta-spec.md；术语表 …/option-ta-glossary.md（放进包的 knowledge/glossary/，license bundled，authority reference）；税务口径看 …/option-ta-tax-memo.md 第 14 节；期权接口实测看 …/option-ta-p1/README.md；成交回信的虚构样例在 …/option-ta-p1/mail-samples/；已定范围和提醒门槛看 …/option-ta-build-plan.md 的「已定的第一版范围」。从 theta 移植计算代码不归这次，工具先写能过检查的最简实现，在汇报里列出哪些还没做。

Router 一句话把任务开到了 `module-builder`，17 秒回复。

## 时间线和 token

时刻是美东时间。成员用量从各成员的会话记录加总。

| 时刻 | 步骤 | 用时 | 输入 / 缓存读 / 输出 |
|---|---|---|---|
| 03:57:52 | 领队开工，自己把说明书逐字复制成 `spec.md` | | |
| 03:58 | 访谈：只在末尾补「假设和缺项」 | 2 分 | 69k / 113k / 5k |
| 04:01 | 搭结构，和整理知识并行 | 16 分 | 81k / 2.75M / 36k |
| 04:01 | 整理知识 | 6 分 | 52k / 992k / 13k |
| 04:17 | 出考题（含 04:24 第二次派活） | 约 4 分加 1 分 | 76k / 905k / 7k |
| 04:20 | 检查：跑到 ok | 1.5 分 | 61k / 201k / 3k |
| 04:22 | 领队预演第 1 轮：2/3，QCC 题挂 | | |
| 04:24 | 出考题第二次：强化三处提示词，不动 `expect` | | |
| 04:25 | 领队预演第 2 轮：3/3 | | |
| 04:28:28 | 汇报（ready），任务关 | 合计 30.6 分 | 任务合计 6.88M 输入（含缓存 6.47M）、77k 输出，55 次工具调用 |

成员合计约 5.30M（含缓存），领队自己约 1.6M。第一次领队约 3.2M，主要花在三轮预演之间的改包；这次领队只改了一轮。当天全部用量 7,388,360 token（`usage_daily`），减去 stock-ta 样例任务约 37 万，工坊约 7.02M（第一次约 8.39M）。预演起的是独立临时宿主，用量不落进这个状态目录，上面的数都不含预演。

两次各只有一次运行，没有方差。时长少了 18 分钟，主要来自两处：访谈从 5 分钟降到 2 分钟（誊写代替重写），预演之间的改包从两轮降到一轮。这两处都和 #174 改的内容对应，但单次运行里模型自己的波动也能造成这个量级的差，不能据此说工坊稳定变快。

## 交出的包

`docs/modules/examples/option-ta/`，73 个文件，和工坊交出的逐字节相同，没有替换任何东西（包里没有本机路径）。在仓库里重跑 `just module check docs/modules/examples/option-ta`，digest `611e4b4b7e59`，和工坊最后一次检查相同。

| 组成 | 数量 | 内容 |
|---|---|---|
| 专家 | 6 | direction、volatility、strategy、position、ledger-tax、opponent（反方），1.8 到 2.4 KB |
| 技能 | 5 | triage（三档、会诊、五段输出）、market-data、record-workflow、ledger-tax、watch-thresholds |
| 知识 | 6 | glossary（与仓库术语表逐字节一致）、trading-rules、ledger-model、tax-boundaries、market-data-notes、fill-evidence |
| 集合 | 6 | 和说明书完全一致 |
| 工具 | 5 | chain、vol、strategy、record、ledger，全部回 `{"status":"NOT_IMPLEMENTED"}`，各带 `cases.json` |
| feed | 3 | `fills` 写了真解析（`parser.ts` 10.8 KB，14 份夹具，`module check` 跑过）；`iv`、`watch` 回 `problem` 占位 |
| 规则 | 4 | option-routing、fills-review、iv-status、watch-review |
| 考题 | 3 | cc-qcc-boundary、roll-earnings-unimplemented、yearly-ledger-unimplemented |

和第一次比：第一次 `strategy` 算了给定腿价的现金流、`fills` 是占位。这次反过来，五个工具全是占位，`fills` 的 HTML 解析写出来了（第一张 Account 表、按列名取值、累计增量、万分之一美元整数、`fill_id` 和 `order_key`、重复与乱序跳过）。纯文本后备没写。

工坊汇报原样（只换临时路径）在 `rerun/workshop-report.md`，过程说明书在 `rerun/interviewer-spec.md`，四轮预演日志在 `rerun/try-logs/`，检查输出在 `rerun/module-check.log`。

## `module check`

```text
note agents/direction.md: uses "stock-ta/tools/structure", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/signals", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/prices", another module's tool; this check cannot see whether stock-ta exports it
note agents/direction.md: uses "stock-ta/tools/quote", another module's tool; this check cannot see whether stock-ta exports it
note agents/volatility.md: uses "stock-ta/tools/earnings-date", another module's tool; this check cannot see whether stock-ta exports it
note evals/roll-earnings-unimplemented.md: uses "stock-ta/tools/earnings-date", another module's tool; this check cannot see whether stock-ta exports it
ok option-ta@0.1.0 | knowledge=6 data=6 tools=5 skills=5 feeds=3 agents=6 evals=3 | rules=4 | data-classes=shareable:2,private:4 | secrets=FINNHUB_API_KEY,POLYGON_API_KEY | digest=611e4b4b7e59
```

#174 新加的两种提醒（题面超过 300 字、本机绝对路径）都没有出现。

## 预演

| 轮 | 谁跑的 | 包 | cc-qcc-boundary | roll-earnings-unimplemented | yearly-ledger-unimplemented |
|---|---|---|---|---|---|
| 1 | 工坊 | 改前 | FAIL：写成「QCC 待确认」 | PASS | PASS |
| 2 | 工坊 | 最终 | PASS | PASS | PASS |
| 3 | 操作员 | 最终 | PASS | PASS | PASS |
| 4 | 操作员 | 最终 | PASS | PASS | PASS |

- 最终包连续三轮 3/3。三道题里两道的 `expect` 是工具写死的 `NOT_IMPLEMENTED`，判分不随模型措辞变，稳定是意料之中。
- 四轮开头都没有「stock-ta 现在没开」。`earnings-date` 每轮都真调了，回「NVDA 财报 2026-11-17 盘后」，专家拿它和新到期日 2027-01-15 比。`structure`、`signals`、`prices`、`quote` 没有考题，预演没调到。
- 第 3 轮的 QCC 题回答里同时有「QCC待确认」和「QCC 待确认」，判 PASS 靠的是前者。
- 每轮预演里，Router 都插进三四条和考题无关的话，让使用者「在 Gmail 原邮件中核对」某条成交。来源是 `fills` 的异常夹具（截断、缺列、重复订单键等）在预演宿主里也跑，产生 notice，命中工坊写的 `fills-review` 规则。见新毛病 C。

## 九条毛病逐条对照

| # | 第一次 | 这次 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 题面是给答题者的操作脚本，0.9 到 1.5 KB，没用说明书的五个典型问题 | 三道题 52、93、117 字，使用者口吻，没写调哪个工具、怎么排版。分别取典型问题 5、4、3，各补了一两句事实（账户 anon-a、两腿价格、「没记股票批次」） | 修好 | `evals/*.md` |
| 2 | 预演挂了就拆 `expect`，断言变弱 | `expect` 只有 `NOT_IMPLEMENTED`（两道）和 `QCC待确认`。第 1 轮 FAIL 后没动 `expect`，汇报单列「expect 改动：无」。六位专家都写了「状态码、合约、数字原样照抄」。但 `QCC待确认` 不是工具字面量，是出考题自己定的短语，比税务 memo 原文「QCC 待确认」少一个空格；FAIL 后改的是产品提示词 | 部分 | `evals/cc-qcc-boundary.md`；`skills/triage/SKILL.md` 第 26 行、`skills/ledger-tax/SKILL.md` 第 12 行、`agents/ledger-tax.md` 第 13 行；memo 第 250、509 行 |
| 3 | `description` 写进「P2骨架」，丢了 Roll、到期、指派 | 没有施工状态了。但仍不是说明书原句。说明书那句 58 字（检查按 `.length` 数也是 58），访谈却判它「超过 60 字」，自己写了一句 44 字的「分析美股期权与策略盈亏，记录成交和交易链，提醒持仓风险；正股技术面归 stock-ta。」，链、IV、希腊值、开仓、Roll、平仓、到期、指派都没了。技能规定的「先删空格和『的』，还超就 report（blocked）问使用者」也没走 | 部分 | `module.json`；`rerun/interviewer-spec.md`「假设和缺项」第 4 条；`rerun/workshop-report.md` 默认值第 2 条 |
| 4 | 多了 `market-snapshots` 集合 | 集合正好是说明书的 6 个，工具 5 个、feed 3 个也一致。年末快照写进了假设，不进包 | 修好 | `data/`；`interviewer-spec.md` 假设 |
| 5 | README 写了临时状态目录的绝对路径 | 包里没有本机路径，检查没有路径提醒 | 修好 | `grep` 和 `module-check.log` |
| 6 | 访谈重写了 31 KB 的 `spec.md` | `spec.md` 前 28,406 字节和说明书逐字节相同，只在末尾补「假设和缺项」（约 8 KB）。复制是领队自己做的，访谈只写假设 | 修好 | 前缀比对；`interviewer-spec.md` |
| 7 | accountant 的 `uses` 有 `data/brokers`、`data/market-snapshots` | 没有专家用 `brokers`。账本税务是 knowledge、`tools/ledger`、`data/fills`、`data/chains`、`data/accounts`；反方只有 knowledge | 修好 | `agents/*.md` |
| 8 | 包里有 `tools/strategy/tests/p2.test.ts`，仓库不跑 | 包里没有测试文件。`fills` 的解析靠 14 份 feed 夹具验，`module check` 会跑夹具 | 修好 | `find -name '*.test.*'` 为空 |
| 9 | 知识引用 `src/modules/connectors/letter.ts` | 知识、技能、专家里都没有 `src/` 路径 | 修好 | `grep -rn 'src/'` 为空 |

## 新出现的毛病

按严重程度。

### 中

A. **考题的固定短语是工坊自己定的，和来源差一个空格，挂了以后改产品提示词迁就它。** 税务 memo 写「QCC 待确认」（第 250、509 行）。出考题把 `expect` 写成 `QCC待确认`，并按 #174 的规矩把「原样照抄」写进了技能。#174 说中文固定短语要「说明书或技能钉住」才能当 `expect`，这里是出考题自己往技能里钉，等于自己给自己发许可。第 1 轮模型照 memo 写了带空格的版本，判 FAIL；出考题第二次派活又在三处提示词里加「必须原样输出固定机器可检验标记`QCC待确认`，不插入空格」。结果是产品提示词里多了为考题服务的「机器可检验标记」字样，使用者看到的回答里同一个标记有时有空格、有时没有（第 3 轮两种都有）。建议修工坊：write-evals 写明中文固定短语照来源文件原样抄（含空格），不在技能里另造写法；来源里没有的短语不当 `expect`。

B. **`description` 字数数错，跳过了规定的压缩和提问。** 说明书那句 58 字，访谈在假设里写它超过 60 字，搭结构照这个假设自己写了一句短的。技能 package-layout 写明「照说明书那一句原样写」「超过 60 字先删空格和『的』，还超就问使用者」，两步都没做，汇报里把重写当成默认值报了。这是第 3 条没修完的直接原因。建议修工坊：让代码替模型数字。例如 package-layout 要求用 `node -e` 量长度，不靠模型自己数；或者由检查对比说明书那句和 `description`，不一致就提醒。

### 低

C. **`fills` 的异常夹具在预演里触发规则，Router 往对话里插话。** 每轮三四条「请在 Gmail 原邮件中核对……」，和考题无关，还占 Router 的 token。夹具本身写得对（异常就该有 notice），问题在预演宿主也跑 feed 夹具、规则又把 notice 开成任务。归属不清：可能该由宿主在 `module try` 里不跑 feed 夹具，或者不让夹具的 notice 走规则。记在这里，另查。

D. **考题覆盖变窄。** 三道题，没有一道用到方向专家的 stock-ta 工具（`structure`、`signals`、`prices`、`quote`），也没有一道考记成交。第一次有一道题真调了 `structure` 和 `signals`。如果要求每个外部工具至少一道题，应写进 write-evals。

另记一处不算毛病的变化：第一次 `strategy` 写了给定腿价的现金流，这次五个工具全是 `NOT_IMPLEMENTED`，工夫花在了 `fills` 解析上。两者都符合发话里的「最简实现」。

## 操作员替使用者做的判断

1. 发话和第一次一字不差，包括「从 theta 移植计算代码不归这次……」那句。依据：两次要可比。
2. 材料用绝对路径给，指向这次的临时代码 worktree。宿主没有附件入口。
3. stock-ta 的日线库用合成夹具，不用真实库副本。依据：第一次用的合成库，两次可比；预演判「用到了」不需要真实数据。
4. 工坊没有提问，没有替使用者回答任何问题。
5. 只给 stock-ta 写了 key，没给 option-ta 写 `.env`。option-ta 的工具和 feed 都不联网。
6. 加跑了两轮 `module try`（第 3、4 轮）。依据：要求跑 2 到 3 轮看稳定性，工坊的两轮里只有一轮是最终包。代价是两轮预演的 token（独立临时宿主，没有计入上表）。
7. 包没改一个字节。包里没有本机路径，不需要替换。
8. 工坊汇报、过程说明书、预演日志、检查输出里的临时路径换成 `<状态目录>`、`<仓库>`、`<预演临时目录>` 再提交。
9. 产出放在 `docs/modules/option-ta-p2/REPORT-rerun.md` 和 `docs/modules/option-ta-p2/rerun/`。第一次的 `REPORT.md` 在 #173 分支上，这个分支从 main 开，不带它。
10. 毛病 C 记成「归属不清，另查」，没有判成工坊的错。

## 交给 P3 的清单（相对第一次的更新）

1. **`chain`**、**`vol`**：同第一次，都没做。
2. **`strategy`**：比第一次少了给定腿价的现金流，全部要做。
3. **`record`**：只回 `NOT_IMPLEMENTED`，连格式校验也没有（第一次有）。拼 `order_key` 和 `fill_id`、只读查重、交回规整行都要做。
4. **`ledger`**：同第一次，没做。
5. **`fills` feed**：HTML 解析已有，14 份夹具。剩纯文本后备、真实投递验证、500 行以上历史查重。P3 要先审 `parser.ts`：夹具是工坊自己写的，期望值没有独立核对过。
6. **`iv`**、**`watch`** feed：同第一次，回 `problem` 占位。
7. **`cases.json`**：每个工具只有一条固定状态，休市、缺字段、`status: "ERROR"`、HTTP 429 和 5xx 都没有。
8. **考题**：补 `structure`/`signals`、`quote` 各一道；补一道记成交（典型问题 4 的原意）；`cc-qcc-boundary` 的 `expect` 改回 memo 原文「QCC 待确认」，同时删掉三处提示词里的「固定机器可检验标记」字样（毛病 A）。
9. **包内清理**：`description` 换回说明书原句（58 字，检查收得下）。第一次清单里的 `market-snapshots`、accountant `uses` 两项这次已经不需要。

## 清理

临时宿主停止、无残留进程、临时状态目录（含 stock-ta 真 key）整个删除、两个临时 worktree 删除。核对结果写在 PR 描述里。
