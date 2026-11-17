# option-ta P2 运行记录：模块工坊构建

日期：2026-11-17（美东凌晨，休市）。代码：main `ce75a580`。按 `option-ta-build-plan.md` 的 P2，在本机一个临时宿主上让模块工坊（`module-builder`）照说明书从头做出 option-ta。操作员只发话、记录、验收，不改工坊交出的包。

## 结论

- 工坊交出了包和汇报，没有用 report（blocked）提问。
- `just module check` 打印 `ok option-ta@0.1.0`，另有七行外部 `uses` 提醒（检查看不到提供方，按设计只提醒）。
- 包是 P2 骨架：五个工具里只有 `strategy` 算了「给定腿价的权利金现金流」，`record` 只做格式校验；`chain`、`vol`、`ledger` 和三个 feed 都明确回 `NOT_IMPLEMENTED`，不伪造数据。这符合发话里的「工具先写能过检查的最简实现」，也符合 build plan「移植代码不交给工坊，那是 P3」。
- `module try` 跑了三轮，每轮 3/4，三轮挂的题不完全相同（见「预演」）。stock-ta 在预演里在服务，`structure`、`signals` 真调成功；预演开头没有「stock-ta 现在没开」。
- 用时 48.7 分钟（任务开到关），token 约 8.4M（其中缓存读约 7.7M），不含三轮预演里的用量。

## 环境

| 项 | 做法 | 核对 |
|---|---|---|
| 代码 | `git worktree add --detach` 到临时目录，链主目录的 `node_modules`（package 文件与 origin/main 无差异） | 主工作目录没切分支、没改文件 |
| 状态目录 | `mktemp -d`，权限 700 | 没碰真实状态目录，没碰老 Mac |
| 模型 | router `openai-codex/gpt-6.1-terra`，worker 和 fallback `openai-codex/gpt-6.1-sol` | 临时 `config.json` grep 无 `anthropic`；宿主自己也禁 `anthropic`（`src/models.ts` 的 `BANNED_PROVIDERS`） |
| Codex 授权 | 走本机 Pi 的登录，不需要 key | `secretsFile` 是临时目录里新建的空文件 |
| Telegram | 临时 `config.json` 不写 `telegram` 段，`secretsFile` 里没有 `TELEGRAM_BOT_TOKEN` | 宿主只在有 `telegram` 段时起客户端（`src/host/config.ts`）；日志里没有 Telegram 行 |
| 网页 | `webPort: 4597` | 本机原本没有宿主在跑 |
| feed | `"feedFixtures": true` | stock-ta 的 `quotes`、`scan` 只跑了自己的样例，连接器不跑 |
| stock-ta | build plan 第 1 到 4 步：复制包、`just module setup stock-ta`（ta-trading 装上了）、合成夹具 `ta.sqlite`、两把 key 用 `docs/deploy/home-mac.md` 的管道写法写进临时 `modules-data/stock-ta/.env`（600，值不经屏幕）、`just module on stock-ta` | `just modules` 显示 stock-ta「运行中」 |

一个副作用：`quotes` 的样例 `nvda-down-5` 起宿主时触发一次，开了一个 stock-ta 任务（rule），用了约 29 万 token。这是 `feedFixtures` 的已知行为，不影响工坊。

## 发话

用 `just say`（TUI 客户端和它走同一个 socket，最接近真实使用）。原话（路径省略）：

> 用模块工坊做一个新模块 option-ta。说明书和术语表在附上的文件里，按说明书做、不用问我，缺的按默认值并在汇报里写明。材料（绝对路径）：说明书 …/option-ta-spec.md；术语表 …/option-ta-glossary.md（放进包的 knowledge/glossary/，license bundled，authority reference）；税务口径看 …/option-ta-tax-memo.md 第 14 节；期权接口实测看 …/option-ta-p1/README.md；成交回信的虚构样例在 …/option-ta-p1/mail-samples/；已定范围和提醒门槛看 …/option-ta-build-plan.md 的「已定的第一版范围」。从 theta 移植计算代码不归这次，工具先写能过检查的最简实现，在汇报里列出哪些还没做。

宿主没有附件入口，材料用绝对路径给。`request` 任务没有读目录限制（`src/worker/tools.ts`），工坊读得到。Router 一句话就把任务开到了 `module-builder`。

## 时间线和 token

| 时刻（美东） | 步骤 | 用时 | 输入 / 缓存读 / 输出 |
|---|---|---|---|
| 02:32 | 访谈：写过程说明书 `spec.md`（见 `interviewer-spec.md`） | 5 分 | 167k / 557k / 12k |
| 02:38 | 搭结构：`module new --template full`，写全部文件 | 14 分 | 82k / 1.79M / 34k |
| 02:52 | 整理知识、出考题并行 | 7 分、6 分 | 63k / 760k / 18k；75k / 1.22M / 10k |
| 02:59 | 检查：跑到 ok | 4 分 | 52k / 569k / 9k |
| 03:03 | 领队预演第 1 轮：3/4，税务题挂 | | |
| 03:08 | 领队改知识和技能，第 2 轮：3/4，税务题挂在一个空格 | | |
| 03:14 | 领队改考题 `expect`，第 3 轮：3/4，现金流题挂 | | |
| 03:21 | 汇报，任务关 | 合计 48.7 分 | 任务合计 8.52M 输入（含缓存 7.69M）、104k 输出，60 次工具调用 |

当天全部用量 8,678,721 token（`usage_daily`），减去 stock-ta 样例任务约 29 万，工坊约 8.39M。成员合计约 5.3M（含缓存），其余约 3.2M 是领队自己，主要花在三轮预演之间的改包。预演起的是独立临时宿主，用完即删，用量没有落进这个状态目录，上表不含。

## 交出的包

`docs/modules/examples/option-ta/`，77 个文件。和工坊交出的唯一差别：`README.md` 第 85 行原来写着临时状态目录的绝对路径，换成了 `<状态目录>`，因为本机路径不能进公开仓库。改后 `module check` 仍是 ok（digest 随之变化）。

| 组成 | 数量 | 内容 |
|---|---|---|
| 专家 | 6 | direction、volatility、strategist、position、accountant、contrarian（反方），每份 1.8 到 2.0 KB |
| 技能 | 5 | leader-workflow（三档、会诊、五段输出）、option-method（意图默认值）、recording、reminders、data-safety |
| 知识 | 6 | glossary（与仓库术语表逐字节一致）、intent-and-scope、fill-contracts、market-contracts、tax-boundaries、alert-thresholds |
| 集合 | 7 | 说明书的 6 个，外加 `market-snapshots`（private） |
| 工具 | 5 | chain、vol、strategy、record、ledger，各带 `cases.json`（共 23 条）；`tools/strategy/tests/p2.test.ts` 36 条测试全过 |
| feed | 3 | fills、iv、watch |
| 考题 | 4 | cumulative-mail-boundary、dual-view-tax-boundary、given-leg-cashflow、stock-ta-boundary |

工坊自己的汇报原样（只换了路径）在 `workshop-report.md`，访谈写的过程说明书在 `interviewer-spec.md`。

## 验收逐项

| 检查项 | 结果 |
|---|---|
| `module check` 打印 ok | 是 |
| 外部 `uses` 写在专家里 | 是。direction：`stock-ta/tools/structure`、`signals`、`prices`、`quote`；volatility：`stock-ta/tools/earnings-date`。和说明书的表一致 |
| 没有模块级 `uses` | 是 |
| 没有 `exports` | 是 |
| 集合 class | fills、chains、accounts、brokers 是 private；watchlist、iv-snapshots 是 shareable。多出的 `market-snapshots` 是 private |
| `fills` feed | `"connector": "mail"`、`settings.senders: "brokers"`、`into: fills`、`reads: ["fills"]`。handler 是占位，回 `problem`，不解析也不写行，不推进 cursor。「优先读 `html`」只写在技能 recording 和知识 fill-contracts 里，代码里还没有。fixtures 由四封虚构信转成，带 `html` |
| 部分成交和业务键 | 写在技能和知识里：`order_key=<OCC>:<side>:<trade_date>:<account_ref>`，`fill_id=<order_key>:cum<累计>`，增量公式、万分之一精度、`partial_fill` 旧行不改、同表重复键进 `duplicate-order-key`。代码没实现，`record` 不拼 `fill_id`、不查重 |
| `watch` 不写 `into` | 是 |
| 专家提示词的三条 | direction 和 volatility 都有：提供方缺席照常做完其余部分、「请对 stock-ta 说……」、只传必要代码 |
| 考题 | 4 道，2 道用 `knowledge`，1 道用 `stock-ta/tools/structure`、`signals` |
| `module try` | 见下节 |

## 预演

| 轮 | cumulative-mail-boundary | dual-view-tax-boundary | given-leg-cashflow | stock-ta-boundary |
|---|---|---|---|---|
| 1 | PASS | FAIL：没有「QCC 待确认」 | PASS | PASS |
| 2 | PASS | FAIL：没有「QCC 待确认」（答的是「QCC待确认」） | PASS | PASS |
| 3 | PASS | PASS（`expect` 已拆开） | FAIL：没有「未扣费」（答的是「费用未知、未扣除」） | PASS |

- 三轮开头都没有「stock-ta 现在没开」或「在临时宿主里没有打开」。
- stock-ta-boundary 每轮都真调了 `structure` 和 `signals`，参数只有 `{"symbol":"NVDA"}`，回了合成库的结构和 20 条信号；note 不开放时转成「请对 stock-ta 说……」。`quote`、`earnings-date`、`prices` 没有考题，预演没调到。
- given-leg-cashflow 前两轮 PASS、第三轮 FAIL，这道题包没改。挂的原因是同一道题模型两次措辞不同，说明 `expect` 选了能换说法的短语。
- 三轮的完整输出在 `try-logs/`（临时路径已换成占位符）。

## 操作员替使用者做的判断

1. 发话加了一句「从 theta 移植计算代码不归这次，工具先写能过检查的最简实现，在汇报里列出哪些还没做」。依据：build plan P2「移植代码不交给工坊，那是 P3 的工程活」。代价：工具几乎全是占位，P2 测不到工坊写真实工具代码的能力。
2. 发话里写明 glossary 的落点（`knowledge/glossary/`、bundled、reference）。依据：build plan「grill-with-docs 放在哪里」第 2 条。
3. 材料用绝对路径给，指向临时代码 worktree 里的文件。宿主没有附件入口，`just say` 只收文字。
4. 工坊没有提问，没有替使用者回答任何问题。
5. 只给 stock-ta 写了 key；没给 option-ta 写 `.env`。option-ta 的 feed 和工具都没联网，用不上。
6. 没有另跑一轮 `module try`。工坊跑了三轮，日志齐全，再跑只多花一轮 token。
7. `README.md` 里的本机绝对路径换成 `<状态目录>`。这是包里唯一一处改动，为了不把本机路径推进公开仓库；不是帮包过检查（改前改后都是 ok）。
8. 预演日志、过程说明书、工坊汇报里的临时路径同样换成占位符后才提交。

## 工坊的毛病（按严重程度）

### 高

1. **考题写成了给答题者的操作脚本，不是使用者会问的话。** 现象：四道题正文 0.9 到 1.5 KB，写满「请实际调用 record」「不调用 data 写入」「把写入许可按 may_write=<值> 展示」「入账状态用『已入账』或『尚未入账』二选一」。证据：`examples/option-ta/evals/*.md`。后果：考题测的是模型照不照题面指令做，测不到专家和技能本身会不会这样做；说明书的「五个典型问题」一道都没用上。建议修工坊：write-evals 技能加一条「正文用使用者的口吻，一两句话；不在题面里写调用哪个工具、怎么排版，那是专家和技能的事」，并要求优先从说明书「典型问题」挑题。checker 量正文长度，超过约 300 字提醒。
2. **为过预演改考题的 `expect`。** 现象：第 2 轮税务题因为「QCC待确认」和「QCC 待确认」差一个空格判 FAIL，领队把 `expect` 拆成 `QCC`、`待确认` 两项；拆开以后两个词各自出现就算过，断言变弱了。第 3 轮又挂在「未扣费」。证据：`workshop-report.md`「模型预演：未全过」，`try-logs/`。工坊在汇报里如实写了，没有宣称全过，这点是对的。建议修工坊：write-evals 技能写明「`expect` 挑工具输出里固定的字面量（状态码、数字），不挑模型自己组织的中文短语」；预演 FAIL 时改包，改考题判据要在汇报里单列「改了哪道题的判据、为什么」。
3. **`description` 写进了施工状态。** 现象：`美股期权链、波动率、策略与成交分析；P2骨架，行情记账提醒待实现，正股技术面归stock-ta`。说明书给的一句是「美股期权的链、隐含波动、希腊值、策略盈亏和你的期权成交：开仓、Roll、平仓、到期、指派；问股价涨跌和技术面的归 stock-ta」。证据：`examples/option-ta/module.json`。后果：幕僚长按这句分派，「P2骨架」对分派没用，P3 做完还得记得改；「Roll、到期、指派」也丢了。建议修工坊：package-layout 技能写明 `description` 照说明书那一句抄，不写成熟度和施工状态，成熟度只放 `version` 和 `title`。

### 中

4. **说明书外加了集合。** 现象：多了 private 的 `market-snapshots`，理由是税务 memo 的 §1256 年末快照。说明书「模板」一节只列 6 个集合，build plan 也说开 CC 时的行情快照不进第一版。证据：`workshop-report.md`「新增private年末快照集合」。建议修工坊：build-module 技能写明「说明书列了集合、工具、feed 的，照列，不增不减；觉得缺的写进汇报的建议，不进包」。
5. **README 写本机绝对路径。** 现象：`README.md` 的命令块写死了临时状态目录。包可能进公开仓库。建议修工坊：package-layout 技能写明包里的文件不写绝对路径，命令里用 `$STATE`、`$PSA_REPO`。更稳的是 `module check` 对 `/var/`、`/Users/`、`/home/` 开头的路径报一行。
6. **过程说明书不是誊写。** 现象：使用者给了完整说明书、说了「不用问我」，访谈仍重写了一份 31 KB 的 `spec.md`（原文 28 KB），改了结构和措辞，还加了「P2 骨架」「最终包的唯一目标目录」这些过程信息。证据：`interviewer-spec.md`。build plan 写的是「访谈那一步就只是誊写」。改写处可能悄悄改了意思，例如 description 被压短（上面第 3 条的来源）。建议修工坊：interviewer 写明「使用者给了 spec.md 的，原样复制，只在末尾追加『假设和缺项』一节」。
7. **专家的 `uses` 偏宽。** 现象：accountant 的 `uses` 有 `data/brokers`（发件人名单）和 `data/market-snapshots`，算账和税务用不上发件人名单。证据：`agents/accountant.md`。建议修工坊：scaffolder 的「`tools` 只给它要的」同样写到 `uses`，尤其是 private 集合。

### 低

8. **测试文件放在包里但仓库不跑。** `tools/strategy/tests/p2.test.ts` 只有手动 `node --test` 才跑，`just test` 不收。建议修工坊：写明工具测试放哪里、怎么跑，或者由 `module check` 顺带跑包内测试。
9. **知识里引用宿主源码路径。** `knowledge/fill-contracts/fill-contracts.md` 写「核对宿主磁盘源码 `src/modules/connectors/letter.ts`」。知识是给专家和使用者读的，宿主实现会变。建议修工坊：knowledge-curator 只引用文档和 ADR，不引用源码。

和工坊无关、顺带看到的：宿主启动日志第一行写「停用 stock-ta」，10 秒后 stock-ta 的 feed 照常跑，`just modules` 也显示运行中。起宿主前已经 `just module on stock-ta`。那一行日志和实际开关不一致，值得另查。

## 交给 P3 的清单

工坊没写或按发话没写的代码部分：

1. **`chain`**：Massive 链快照取数、二元期权过滤、分页（取 `next_url` 再带 `Authorization`）、按行权价范围取、缺 IV 时 BS 自算并标「自算」或「无数据」、休市标注、紧凑输出。现在回 `NOT_IMPLEMENTED`。
2. **`vol`**：ATM IV、IV/HV、IV rank 和百分位、期限结构、偏斜、预期波幅。现在回 `NOT_IMPLEMENTED`。
3. **`strategy`**：现在只算给定逐腿价格的权利金现金流（万分之一美元整数，不默认乘数 100）。缺盈亏平衡、到期盈亏、年化、指派概率、三种 Roll 比较、流动性。theta 的 options-math、scenario-pl、cc-yield、limit-price 等按 P1 移植清单搬。
4. **`record`**：现在只做格式校验，回 `VALIDATED_ONLY`、`may_write=false`。缺拼 `order_key` 和 `fill_id`、只读打开 `data.db` 按 `fill_id` 查重、交回规整好的一行。
5. **`ledger`**：交易链盈亏和税务视图都没做，没有读库。
6. **`fills` feed**：HTML 优先、纯文本后备的解析（取第一张 `Account` 表、按列名取值、嵌套表、cp1252）、`Exe Qty`/`Open Qty` 四种情形、累计增量和精度、`skipped` 原因、notice。四封 `mail-samples` 和 `expected.json` 已在 `feeds/fills/mail-samples/` 和 `fixtures/`，可以直接写成失败的测试。
7. **`iv` feed**：一年回填、收盘后存原始输入、cursor 按交易日去重（照 stock-ta `feeds/scan`）、选约和公式的命名常量。
8. **`watch` feed**：到期临近、接近或穿过行权价、权利金五成八成、财报、除息（含预计除息日推算）、到期日 09:45 判断。
9. **`cases.json`**：现在 23 条全是离线输入校验，没有一条带 `responses`。缺休市、缺字段、`status: "ERROR"`、HTTP 429 和 5xx（宿主已支持回放 HTTP 状态，#171）。
10. **考题**：按上面毛病 1、2 重写成使用者口吻，补 `quote`、`earnings-date` 各一道，`expect` 用工具字面量。
11. **包内清理**：`description` 换回说明书原句；`market-snapshots` 去掉或经使用者同意保留；accountant 的 `uses` 收窄；各处「P2 未实现」的字样在实现后删。

## 清理

- 临时宿主已停（SIGTERM，日志「已停止」），`ps` 查不到宿主、临时状态目录或预演目录的残留进程。
- 临时状态目录整个删除（里面有 stock-ta 的真 key）。
- 临时代码 worktree 删除，`node_modules` 链接随之删除。
