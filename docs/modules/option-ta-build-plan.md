# option-ta 构建流程（草案）

使用者的目标：用模块工坊从头做一个期权分析模块，和 stock-ta 并列。起初以为没有土拨鼠那样的现成代码、也没有专家文档，只能做简版。后来使用者指出旧项目 theta（wheel 策略期权 agent）可以参考。theta 只是参考：option-ta 不是从 theta 迁移，也不是在 theta 上扩展（使用者 2026-11-14 明确）。option-ta 也不是 Wheel 策略，每段仓位有自己的意图，交易可以从买入开始，成败看赢的金额而不是胜率。术语见 `option-ta-glossary.md`。

## 已知事实

- 现在的 Massive 行情 key 能读期权数据（2026-11-14 实测）。合约列表 `/v3/reference/options/contracts`、期权链快照 `/v3/snapshot/options/<标的>`、单个合约的日线 `/v2/aggs/ticker/O:.../prev` 都回 200。期权链快照每行带 `greeks`、`implied_volatility`、`open_interest`、`last_quote`、`last_trade`、`break_even_price`、`underlying_asset`。数据不是瓶颈，瓶颈是领域知识。
- 模块工坊（`modules/module-builder`）的访谈最多问三个问题，缺的按常理补上。这对读书笔记够用，对期权不够：管哪些策略、做买方还是卖方、要不要主动提醒，这些决定了整个模块。
- 模块工坊还没在一个真实模块上实战过（审计 2026-11-14「模块工坊试用题目再想」）。option-ta 正好当它的第一次实战。
- 期权的具体数字（公式、合约规则）最容易被模型编错。数字由代码算，模型只转述。

## 可参考的 theta

theta 在 `LearnTypeScript2PiAgent/playground/theta/app`，下面记作 T。2026-11-14 只读盘点的结论：

- **数据**：T 的期权链来自 `/v3/snapshot/options/<标的>`，和 Massive key 能用的端点一样，换基址就行。T 的网络调用都在 Python sidecar 里；option-ta 照 stock-ta 的做法用 TS 直接调，不搬 sidecar。
- **纯计算**（`T/src/lib`，基本没有 IO）：options-math（BS、指派概率、年化）、first-passage（触及概率）、strike-scoring、liquidity、premium-quality（硬闸加权打分，硬闸不能被分数抵消）、premium-targets、scenario-pl、cc-yield、iv-crush、net-gamma-walls、oi-term-structure、limit-price。T 没有单元测试，只有离线 smoke 脚本，搬过来时要补 `cases.json` 和测试。
- **不自包含**：iv-history 依赖 T 本地三年的期权收盘缓存。option-ta 在标的加进期权自选时用期权日线回填一年，之后每天收盘后存原始输入（`option-ta-spec.md`「IV 历史」）。
- **theta 的规则**（只作参考，不照搬）：13 个技能带阈值，比如 pre-sto、premium-richness、roll-decision、btc-decision（固定 50/80 止盈）、assignment-cc（CC 行权价不低于成本）、earnings-cross。它们就是这个模块的专家知识。
- **知识文档**：`T/docs/research/digests/` 38 篇 digest，主要引用 tastylive 和 CBOE 并带链接；`scout-sources.md` 是信任源白名单。书籍只有署名加一两句意译，没有全文。
- **私人数据，一样都不搬**：positions.json、accounts/、state/、book-roc/、reports/、briefs/、advisories/、本机私有的成交邮件样例目录。持仓只借数据形状（Position 带 roll 链和入场上下文）。
- **T 自己的教训**：决策数学写成确定性代码，模型只叙事；阈值写成命名常量并注明出处；数据缺失标 UNRESOLVED，不静默通过；动态止盈回测输给固定 50%，已退回固定值。

## 名字

用 `option-ta`，不用 `simple-option-ta`。「简版」是成熟度，不是身份。成熟度写在 `version`（0.x）和 `title`（「期权分析（简版）」）里。模块名会写进状态目录、实例数据目录、`config.json` 的开关、规则的「来源: option-ta/<feed>」、页面和 Telegram 的标记里，改名要搬这些东西。以后升级是往同一个包里加知识和工具，走工坊「改已有模块」那条路，再用 `module check --previous` 查兼容。

## grill-with-docs 放在哪里

grill-with-docs 就是两个技能合用：grilling（按决策树一轮轮拷问，每题带推荐答案）和 domain-modeling（术语一定下来就写进 glossary，难反悔的决定写 ADR）。

它不放进模块工坊里面。工坊跑在宿主上，用 Codex 模型，不能和使用者来回多轮对话。它放在工坊**前面**，在 Claude Code 里和使用者一起做，产出三样东西交给工坊：

1. `spec.md`，格式和工坊访谈写的一样。工坊拿到后按「不用问我，按默认做」直接开工，访谈那一步就只是誊写。
2. 期权术语表。写成模块包里的知识 `knowledge/glossary/`（使用者自己的资料，`license: bundled`，`authority: reference`），不写进仓库根目录的 `GLOSSARY.md`，因为那份是白宫产品本身的用语。
3. 难反悔的决定写 ADR，用当时下一个空号。名字这一条可能够格。

还有一层更重要。没有专家文档时，**使用者自己做期权的习惯就是专家知识**。拷问的过程就是把这些习惯问出来、写下来，作为模块的第一份知识。公共的定义和规则（合约乘数、行权、到期）只引用权威出处，比如 OCC 的《Characteristics and Risks of Standardized Options》，写明版本和章节。

## 阶段

### P0 拷问（Claude Code，使用者在场）
- **产出**：`spec.md`、术语表草稿、需要的 ADR。
- **完成标准**：决策树的前沿问题都问完了，使用者确认「理解一致」。

### P1 数据摸底和 theta 移植清单（Claude Code，自动）
- 定下要搬的 lib 和技能，逐个记出处（T 的路径和提交）。digest 进公开仓库前查一遍，只留意译和链接，长段原文删掉。

- **产出**：期权接口的字段说明、限流情况、休市时字段是否还在、有没有隐含波动的历史；录几份真实应答当工具的 `cases.json` 样本。
- **完成标准**：每个打算用的字段都有实测样本。
- **产出位置**：`option-ta-p1/README.md` 和 `option-ta-p1/samples/`（2026-11-17）。

### P2 模块工坊构建（真实产品路径）
- **前置条件**：C2（模块自己的 `.env`，ADR-0031，已合并）、C4a、C4b、C4c、C4d 都合并以后才开工，分期见 `architecture/service-connector-design.md`。option-ta 的专家要调 stock-ta 开放的工具：C4a 之前包检查把外部 `uses` 当错误；C4b 之前 `just module try` 的预演不带 stock-ta 的副本，外部调用全回 `provider-absent`，P3 用真模型跑 `module try` 就测不到专家调 stock-ta；C4c 之前 stock-ta 没有开放任何工具；C4d 之前工坊的技能不会写外部 `uses` 和「请对 stock-ta 说」的转述。
- 工坊负责包的骨架、技能、专家、知识、考题。移植代码不交给工坊，那是 P3 的工程活。
- 在临时 `PSA_STATE_DIR` 起宿主，对幕僚长说一句话，带上 `spec.md` 和术语表，任务开到 `module-builder`。
- **环境要求：临时状态目录里要有在服务的 stock-ta。** 工坊跑 `module try` 时，预演从这个临时 `PSA_STATE_DIR` 取提供方：stock-ta 在这里打开、检查通过、正在服务，预演才带上它在服务的那一版、它的 `files/`（`ta/ta.sqlite` 和 Python 环境的链接）和 `.env`。不然预演开头打印「stock-ta 现在没开」，外部调用全回 `provider-absent`，用到 stock-ta 的考题都判「没用到」，P2 就测不到专家调 stock-ta。集合里的行（自选股等）预演不带。起宿主之前，在仓库根目录、`PSA_STATE_DIR` 指向临时目录时准备：
  1. `mkdir -p "$PSA_STATE_DIR/modules" && cp -R docs/modules/examples/stock-ta "$PSA_STATE_DIR/modules/"`（目录不存在时 cp 会把包拷成 `modules/` 本身），再 `just module setup stock-ta`（要拿得到私有仓库 ta-trading）。
  2. 日线库：首选真实库的副本，把 `modules-data/stock-ta/files/ta/ta.sqlite` 复制到临时目录的同一路径。没有真实库时，复制合成夹具 `docs/modules/examples/stock-ta/tools/structure/fixtures/data/files/ta/ta.sqlite`（只有 NVDA、QQQ、SPY，价格是编的。它的同步日期旧了一天以上，`structure` 不算，回「把它加进自选股，等下一次 scan 扫完再问」，因为预演里没有自选股的行）。合成库只够判「用到了」，考题的 `expect` 别指望它的数。
  3. 密钥：`just module secret stock-ta POLYGON_API_KEY`、`just module secret stock-ta FINNHUB_API_KEY`，写进临时目录的 `modules-data/stock-ta/.env`。`quote`、`earnings-date` 在预演里真联网。
  4. `just module on stock-ta`，起宿主，用 `just modules` 确认 stock-ta 已经打开。工坊的预演开头没有「stock-ta 现在没开」或「在临时宿主里没有打开」，才算准备好。
  5. 副作用：临时宿主里 stock-ta 的 feed 用真 key 跑，命中规则会发提醒、开任务，扣同一份额度。交易时段 `quotes` 每 60 秒调一次 Massive；`scan` 不分时段，临时目录里的 cursor 是空的，宿主一起来它就扫最近一个已收盘的交易日，之后到下一个交易日收盘 20 分钟后再扫。所以只说「收盘后做」避不开真 key 调用。首推在临时 `config.json` 里写 `"feedFixtures": "rows-only"`（每个 feed 只把自己的样例跑一次，连接器都不跑；样例的行照写，交回的触发和提醒不交给 Router，不开任务、不混进工坊的对话，PR #179）。不写的话，收盘后起宿主，等 `scan` 把当天扫完一次再开工。
  6. 用完删掉整个临时 `PSA_STATE_DIR`：里面 `modules-data/stock-ta/.env` 有真 key。
- 记下工坊做到哪一步、哪里卡住、用了多少 token。工坊自己的毛病另开 PR 修，不在 option-ta 里绕开。
- **完成标准**：工坊交出包和汇报，`module check` 打印 ok。工坊写不好的代码部分记下来交给 P3。

### P3 补强（Claude Code）
- 独立复查工坊的包。从 T 移植纯计算到 `tools/`，先用 T 的 smoke 用例写成失败的测试，再搬代码。真模型跑 `module try`。
- **完成标准**：检查 ok，考题全部 PASS，工具的 `cases.json` 覆盖休市、缺字段、应答体 `status: "ERROR"`、HTTP 429 和 5xx（宿主回放 HTTP 状态见 PR #171）。`fills` feed 的样例用 `option-ta-p1/mail-samples/` 的四封虚构信做。

#### P3 分步

每步一个 PR，从 main 开。P3-0 合并后开 P3-a。P3-b、P3-d 用 P3-a 的公式，等 P3-a 合并再开；P3-c 不依赖 P3-a，可以和它并行。P3-e 等前面几步都合并。每步都要 `just module check docs/modules/examples/option-ta` 打印 ok、全量 `just test` 通过；工具实现了，就把考题里对应的 `NOT_IMPLEMENTED` 换成工具输出的字面量（规则见 `module-builder` 的 `write-evals` 技能）。P3-e 之前不跑真模型。

- **P3-0 底座。**把第三次 P2 的包（draft #181）原样放进 `docs/modules/examples/option-ta/`，三次 P2 的记录放进 `option-ta-p2/` 留档，按说明书和 #183 以后的工坊规则修包：`fills` 接 `mail`，解析没做时有信就抛固定的话、样例只放没有信的一份、`brokers` 留空；考题一题一件事。不做功能。完成标准：`module check` 打印 ok，提醒只剩外部 `uses`。
- **P3-a 纯计算。**从 T 移植 P1 清单里「搬」的纯计算：options-math、first-passage、scenario-pl、strategy-economics、cc-yield、liquidity、limit-price、roll-credit-gate、iv-crush、iv-history（只搬 `selectAtmContract`、`ivRank`、`ivPercentile`）、`impliedVolPut`（补 call 版）、hv20 和 vol-regime、net-gamma-walls、oi-term-structure、pin-risk-check、check-assignment-risk 的纯函数、contract-deliverable。每一项先把 T 的 smoke 用例写成失败的测试，再搬代码；P1 清单写了「要补」的（买方策略、call 版反解、价格和 put-call 平价）一并补用例。T 的门槛常量（roll-credit-gate 的 10%、pin-risk 的门槛）换成说明书和 build plan 定的值，没定的问使用者。接进 `strategy` 工具：权利金、参考价、盈亏平衡、到期盈亏、年化、指派概率、流动性和三种 Roll。完成标准：移植的每项都有从 smoke 转来的测试且通过，`strategy` 的 `cases.json` 用算出来的数断言，Roll 考题的 `expect` 是工具算出的净收。
- **P3-b 行情。**`chain`、`vol` 工具接 Massive：滤掉二元期权，按行权价范围取，跟分页，缺 IV 或希腊值时用 P3-a 的公式自算并标注「自算」，休市时标注休市。`vol` 读 `iv-snapshots`，用 P3-a 的 rank、百分位和 HV。完成标准：两个工具的 `cases.json` 覆盖休市、缺字段、应答体 `status: "ERROR"`、HTTP 429、5xx，夹具取自 P1 样本，回放写法照 #171；缺 key 时回一句话和 `just module secret` 命令。
- **P3-c 成交。**`fills` feed 的 HTML 解析写成纯函数（输入信和已记的 `fills` 行，回 `fills` 和 `skipped`）：只取最新一张交易表，判定成交、挂单、没成交、股票行，算订单键和累计增量，标部分成交。先用 `option-ta-p1/mail-samples/` 的脱敏样例写成失败的夹具和测试，再实现；第二次 P2 的 `parser.ts`（#176 分支）可以拿来审，期望值要独立核对。解析通过以后 handler 不再抛错，`fills` 的样例换成这几封信。`record`（校验、拼 `fill_id`、只读查重、交回规整行）和 `ledger`（交易链盈亏和税务视图两种视图，税务口径按 tax memo 第 14.3 节的第一版范围，要股票批次的一律「待确认」）。完成标准：解析的测试对 `fills` 和 `skipped` 都断言，四封虚构信的夹具通过；`record`、`ledger` 的 `cases.json` 覆盖缺账户、费用未知、重复 `fill_id`、部分成交合计；README 写清什么时候往 `brokers` 加地址。
- **P3-d 盯盘。**`iv` feed：期权自选加进新标的时回填一年，每个交易日收盘后存一行原始输入，cursor 按交易日记、同一交易日不重存（写法照 stock-ta 的 `feeds/scan/index.ts`），取数时刻用补录的收盘后样本定。`watch` feed：四种提醒的门槛（到期临近、接近或穿过行权价、权利金达标、到期前的财报和除息），到期日 09:45 以后的第一次检查，预计除息日的推算（「主动提醒的两处细节」）。完成标准：两个 feed 的样例覆盖空自选、回填、当天已存、休市、缺 key，`watch` 的每种门槛有触发和不触发的样例；P2 访谈假设的默认值（收盘后 30 分钟、目标 30 天、21 到 45 天等）和使用者或 T 对过一遍。
- **P3-e 收尾。**用真模型跑 `just module try` 全部 PASS，模型只用 `openai-codex/*`。独立复查整个包。做 P4 入库上线的准备（部署说明、使用者要设的 key 和名单），不打开模块开关。完成标准：考题全部 PASS 的日志留档，复查的意见处理完。

### P4 入库上线
- 包放进 `docs/modules/examples/option-ta/`，开 PR，独立复查，合并，按常设授权部署老 Mac。
- 打开开关 `just module on option-ta` 由使用者来做。

## 已定的第一版范围（拷问记录）

- 意图、动作、价差范围见 `option-ta-glossary.md`；税务口径见 `option-ta-tax-memo.md`。
- 第一版记期权成交（含到期、指派、行权），外加被指派产生的股票和买方行权交割的股票（2026-11-16 使用者选 B）。股票的其余买卖不记。按账户记、按合约汇总；不做仓位管理（现金、保证金、仓位大小、组合配置）。
- 要独立股票批次或持有期的税务判断（合格备兑 call、股票和期权的跨式、§1233 买 put 视为卖空、涉及股票的 wash sale）第一版一律标「待确认」。1099-B 导入、开 CC 时的行情快照、批次指定、跨式标识不进第一版。哪些判断降级、以后补要哪些数据，见 `option-ta-tax-memo.md` 第 14.3 节。
- 一套原始成交，算出交易链和税务两种视图。和 1099-B 对账以后再做，要先能导入 1099-B。
- 成交默认从券商交易台的成交回信记，也接受使用者手动说；按订单（合约、方向、成交日、账户）记累计成交的增量，部分成交也记，数以邮件为准，含糊就问。信怎么进来、怎么解析见 `option-ta-spec.md`「成交邮件（`fills`）」。
- 主动提醒（只针对记下的仓位）：
  - 到期临近：到期前 5 个交易日静音提醒一次；到期日开盘时正股离行权价不到 3%，响铃（在美东 09:45 以后的第一次检查判断，09:30 读到的还是盘前价）。
  - 接近或穿过行权价（只限卖出的期权）：离行权价不到 2% 静音；穿过进入价内响铃。
  - 权利金达标（卖出的期权）：赚到五成静音，赚到八成响铃。
  - 财报和除息：记下仓位时到期前有财报，马上提醒；财报前 2 个交易日再提醒；卖出的 call 在价内且到期前有除息，除息前 2 个交易日响铃；除息还没宣布的，按预计除息日同样判断，只静音提醒（`option-ta-spec.md`「主动提醒的两处细节」）。
- 标的加进期权自选时回填一年 IV，之后每天收盘后存原始输入；基于 IV 的机会提醒放第二版（2026-11-17 使用者再次确认）。
- stock-ta 同一时刻开出的多个任务维持现状，不归并（2026-11-16 使用者决定）。
