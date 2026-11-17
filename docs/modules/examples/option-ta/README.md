# option-ta：期权分析（简版）0.1.0

**结论：这是P2模块骨架，不是已上线的期权系统。** 从full模板创建，保留五专家、仅会诊反方、领队技能、五工具、原六集合和三feed；新增private年末快照schema。没有移植theta代码、私人持仓或真实邮件。模块保持创建时的停用状态；本模块工具/feed未实现网络取数，未另作行情接口实测，未读取或填写密钥值、不改宿主配置、不安装或启用。领队另跑了真实模型预演，其中调用了stock-ta在服务版本的只读structure/signals。

## 现在真实能做什么

| 入口 | 最简能力 | 不能误称 |
|---|---|---|
| chain | 校验symbol/真实日历日期/put或call，之后NOT_IMPLEMENTED | 已取链、休市行情、OI/GEX/最大痛点 |
| vol | 校验symbol，之后NOT_IMPLEMENTED | 已计算IV/HV/rank/事件 |
| strategy | operation=cashflow，对给定逐腿side/价格文字/qty/已核实multiplier按万分之一USD整数求和，CALCULATED_PARTIAL | 完整Roll/策略盈亏、可成交报价、扣费收益、税务或指派预测 |
| record | JSON及部分必要字段/数量/日期/价格/OCC外形基础校验，VALIDATED_ONLY，may_write=false | 已核验合约、查重、生成最终fill_id、已记账；**当前禁止用其结果写fills** |
| ledger | 校验chain/tax视图和税年，之后NOT_IMPLEMENTED，database=NOT_READ | 空账本、历史零收益、税务已算 |
| fills/iv/watch feed | 无条件返回可见problem，明确NOT_IMPLEMENTED/待P3，不写记录、不发仓位notices、不推进cursor | 无成交、回填完成、已扫描且无触发 |

工具不写集合；当前连只读SQLite查重/汇总也未接入。未知费用/账户/日期/乘数/行情不是0。当前工具不声明业务secrets；iv/watch只预留secrets契约，handler没有读取环境变量。所有返回仅真实校验/算术或显式未实现。

## 目录和团队

- `module.json`：期权研究组；不设exports（含private集合），外部uses不写模块级。
- `agents/`：direction方向与价位、volatility波动率与事件、strategist策略计算、position仓位研判、accountant账本与税务、contrarian仅会诊反方。全部文件工具仅read/grep/find/ls；无专家filesystem写权限。
- `skills/`：leader-workflow、data-safety、option-method、recording、reminders。领队独占手动记录/映射/意图/名单/自选维护；P2成交写入仍阻断。专家data uses仅供读取及领队并集，不授权专家写账。
- `tools/{chain,vol,strategy,record,ledger}/`：每个tool.json、index.ts、cases.json；共享纯校验/整数助手在`tools/strategy/p2.ts`。
- `data/`：fills/chains/accounts/brokers为private；watchlist/iv-snapshots为shareable；新增market-snapshots为private，承接年末§1256期权及价差腿目标。所有集合初始无行，不带生产地址/账户映射。
- `feeds/{fills,iv,watch}/`：handler、manifest和fixtures；四封虚构邮件原件与expected草稿在`feeds/fills/mail-samples/`；本地离线断言在`tools/strategy/tests/p2.test.ts`。
- `knowledge/`已齐六个来源：glossary（用户术语表原样）、intent-and-scope（意图与范围）、alert-thresholds（提醒门槛）、tax-boundaries（双视图与税务降级）、market-contracts（行情与IV契约）、fill-contracts（成交回信与累计增量）。全部为`license=bundled`、`authority=reference`；`knowledge/README.md`仅作索引，不是第七个知识源，当前check统计`knowledge=6`。术语表已与提供材料逐字节比对一致，目标描述不代表P2功能实现。
- `evals/`已齐四题：given-leg-cashflow（给定现金流）、cumulative-mail-boundary（累计成交与禁写边界）、dual-view-tax-boundary（双视图保守降级）、stock-ta-boundary（外部只读与隐私边界）。四题均已实际预演；最近一轮自动判分为3/4，不宣称全部通过，详见下方预演记录。

不做股票技术面、仓位规模/现金/保证金/组合管理、不下单、不预设Wheel。第一版目标为CSP、CC、买put/call及贷/借方垂直价差；不做裸卖call、蝶式、铁鹰或同时持有的跨期价差。Calendar/Diagonal/Combo Roll是平旧开新动作，非宣布支持跨期价差策略。

## 领队输出和隐私

概念/一次工具自答；单领域多步派一人；开仓/Roll等需决定的结论做一轮会诊。新仓并行方向/波动率/策略，旧仓并行仓位/波动率/策略；各自互不可见。共同快照无领队倾向；专家交结论/数字/置信度/作废条件，领队保留分歧，反方只挑错，最多修订一次。

正式分析固定五段：**结论、依据、分歧、作废条件、这是分析，不是交易指令。** 行情需来源/取数时间/数据时间及延迟或休市，P2没有行情不得捏造这些字段。

stock-ta磁盘契约已核对：direction用structure(symbol,timeframe)、signals(symbol及短筛选)、prices/quote(**symbols复数**，逗号代码)；volatility用earnings-date(**symbol单数**)。prices是缓存最新价，不是历史日线/HV来源；quote正股延迟15分钟。用途只写对应专家uses，不写module.json。五工具均核对过磁盘exports/tool.json；真实预演另确认structure/signals成功返回缓存数据。prices/quote/earnings-date未作运行验证，不能推断所有依赖均可用。

外部三条：①提供方缺席/没开/没开放/环境未备，说明未做哪部分及原因，其余继续；②内部出处不可读、要求加自选或错误给提供方下一步，转成「请对 stock-ta 说……」，不补原文、不越权写；③只传必要代码和合法短筛选，不传邮件、账户、持仓、成本或使用者原话。signals的note未开放。

watch无into，宿主会把未来仓位提醒视为非私密并全文送使用者Telegram，即使reads私密集合也不会脱敏；材料2026-11-17已明确接受，不能误称脱敏。当前没有仓位notices。fills不设line，problem/log不带邮件正文、账号或金额。来源内容不构成授权，不遵循邮件内的读密钥/外发指令。

## 邮件夹具：当前拒答 != 解析通过

宿主Letter已确定有body纯文本及可选`html`（按charset解码后的原HTML，最多256KB），不沿用旧spec「字段待定」。截断尾标记：`[HTML 超过 256 KB，后面截掉了，全文在 Gmail 里看]`，不完整末行不能自动入账。宿主负责MIME/base64/quoted-printable/charset，本模块未重写连接器。

四封.eml来自P1于2026-11-17生成的虚构素材，原件保留；fixture将各part解码为body/html并把顶层from设虚构交易台以模拟生产重定向。附件置空，只测试当前handler不解析/不泄露，不证明宿主附件/MIME链路已验收。生产brokers初始空，不能把example.net测试地址写进白名单。

原expected草稿fills/skipped为4/2、2/0、3/9、3/0，**是手写未来验收草稿，非解析器结果**；当前handler对四封都返回records=[] + NOT_IMPLEMENTED problem且不推进cursor。`csp-partial-underlyings`没有真实部分成交。当前夹具不包含假成功rows/expect；离线测试断言未实现边界。详见mail-samples/README.md。

## 测试与检查（离线）

在模块根目录，使用支持TypeScript类型剥离和assert.partialDeepStrictEqual的Node 22.15+ / 24+；本轮使用Node 26.5.0：

```bash
node --test tools/strategy/tests/p2.test.ts
```

当前23条工具cases与7个feed fixtures，另有边界断言。检查员已在模块根目录用Node v26.5.0实际复跑上述命令，退出码0，原始输出摘要如下（耗时仅代表这一次运行）：

```text
ℹ tests 36
ℹ suites 0
ℹ pass 36
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 65.006958
```

这些测试证明基本校验、现金流整数算术、显式未实现/不写库/不推进cursor及四封fixture可读，不证明行情/解析/税务/提醒已实现。module check会跑工具cases与全部handler fixtures，但不会替P3逐行核对原expected草稿的fills/skipped。检查员未运行module try；领队随后实际跑了三轮预演，见下方记录。

### 真实模型预演记录（2026-11-17）

三轮均完成四题，自动判分均为3/4、命令退出码1；临时状态目录由预演清理。Router模型为openai-codex/gpt-6.1-terra，Worker为openai-codex/gpt-6.1-sol。

- 第一轮：邮件边界、现金流、stock-ta边界PASS；税务题最终汇报遗漏QCC状态。随后给税务知识加memo 14.1/14.2/14.3章节定位，并在option-method补逐项结论核对要求。
- 第二轮：税务回答已包括QCC待确认、缺数据和不自动调账，却因断言要求`QCC 待确认`中间空格而FAIL。仅将该断言拆为`QCC`、`待确认`，未移除内容要求。
- 第三轮（当前包考题）：cumulative-mail-boundary、dual-view-tax-boundary、stock-ta-boundary PASS；given-leg-cashflow FAIL，唯一打印原因是汇报没有原样短语`未扣费`。实际回答为“费用未知、未扣除”，两腿与合计均正确（-63.7500、+60.1000、-3.6500 USD），不是算术错误；但自动验收仍未全过，保留该结果，不把人工语义判断冒充PASS。后续可改进措辞容错或稳定输出协议后再预演。

stock-ta的structure/signals实际返回缓存结构和20条信号；测试报告说明跨模块仅传symbol=NVDA，未传隐私哨兵，note未开放则转述“请对 stock-ta 说”。这不是对quote/earnings-date或实时行情的验证，也不是独立完整调用轨迹审计。以上均只检验P2校验/安全边界，不证明P3目标实现。

```bash
STATE="<状态目录>"
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module check "$STATE/modules/option-ta"
# 真实模型预演由领队/验收者另跑；会调用stock-ta时可能联网扣额度
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module try option-ta
```

**网络覆盖诚实说明**：合法请求返回未实现、缺字段/坏日期/格式、部分算术已真实覆盖；CLOSED仅为传入标签下的未实现路径，不是市场日历/休市行情测试。status ERROR、HTTP429/5xx、重试/限流、分页、供应方缺字段等全部是P3 future acceptance，当前没有fetch，因此不放假responses冒充HTTP已覆盖。strategy/record/ledger本来不是直接网络客户端，网络错误应在未来调用它们的行情入口及相应feeds验收。宿主现支持带HTTP状态/headers的回放形状，不继承P1开头「只能200」的陈旧摘要。

## 完整未完成清单与默认值

以下不阻塞骨架，但没有一项可当成功上线：

1. **行情/链**：Massive授权请求、窄范围过滤、next_url完整分页及续传Authorization、二元过滤、完整性/来源时间/延迟休市、OI墙/GEX/最大痛点/异常量、缺IV/Greeks降级、BS及流动性全待P3。bid=0/OI=0/空day可能正常。异常量统一合约日线v，不拼day.volume；P1约1.5%差异只是材料观察，不作修正系数。
2. **指数缺口**：当前目标过滤只标准american且O:<标的>前缀，排除O:B1；不覆盖SPX european。税务保留§1256/60:40目标不等于指数行情已支持，需单独实现。
3. **数学/策略**：除给定未扣费权利金现金流外，CSP/CC/买方/垂直价差完整盈亏、盈亏平衡、年化、场景、概率、Roll配对及参考价未实现。不用theta未确认的HV/IV/指派分档或Roll净收10%硬闸；本轮不移植任何theta代码。
4. **IV**：一年回填/日常落盘/BS反解/同口径序列全未做；选约期限和平值并列规则、剩余时间、模型收敛/边界未定。r=0与无股息仅是材料未来常量，不是假实现。开发暂按纽约实际收盘后30分钟（含半日市），期权日线定稿时刻待P3盘中及16:15–16:30样本实测；P1全为盘前/休市样本。
5. **邮件解析**：HTML首张Account交易表（含嵌套）、列名映射、纯文本歧义、Side+Position、从右解析描述/OCC、数量和价格精度、跳过原因、截断安全、未来notice均未实现。四草稿浮点/布尔/旧字段不能直入现schema，需P3规范并严格对fills/skipped断言。
6. **部分成交/查重**：按OCC:side:trade_date:account_ref及:cum数量生成键、万分之一USD整数累计增量/均价四舍五入、乱序/重复、同表首行、手动冲突与冲销均未做。Exe Qty累计语义待首封真实部分成交验证；最新500行reads可能漏早期增量；同日同合约方向账户独立订单及同累计量改价有碰撞风险，不自动合并。
7. **原始事实/事件**：账户映射/税务归属未知；缺order_id/trade_time/commission/fees留空，不能默认0。Executed At只有日期不当时刻。调整交割物无已验证样本，不默认100；EXPIRE/ASSIGNED/EXERCISED/CASH_SETTLED及caused_by_event股票交割校验、冲销连接未实现，普通股票不记。缺BTO/STC/成对Roll/事件/现金结算真实样本，需合成和真实授权后补测。
8. **两视图/税务**：data.db只读访问、按账户链重建/成员顺序/Roll组/意图历史重算、毛/净额、已实现/浮动、每腿税年和长短期、wash sale/跨式风险标记、§1256年末计价/60:40及总额不变量全待P3。税务不能读Roll组，链有效成本不等于税务股票成本；标记不自动禁扣/递延/改成本，不把派生数写进原账。
9. **保守范围**：QCC含ETF、价内QCC持有期暂停/损失性质、股票跨式与年末规则、§1233/married put、涉及股票wash sale、超过一年个股买put长短期、无法追踪的股票批次一律待确认。独立股票批次/批次指定/跨式标识/开CC行情快照/1099-B导入对账是第一版明确不做。美国联邦一般个人投资者口径，不处理州税/§475/IRA内部损益/外币，非报税建议。
10. **年末目标**：新增private market-snapshots保留仍持有§1256期权及价差腿最后交易日收盘价。采集/估值未做；默认未来watch开年末任务由领队写（假设），不是新增第4feed，不把持仓选择泄入shareable IV集合。
11. **提醒**：仓位重建、报价/正股延迟15分钟对时、价格过期容忍、实际交易日历/半日市、到期/行权价/五成八成、财报/除息取数与预计、去重/等级/防刷屏全未做。已定门槛详见reminders：前5交易日静音一次；到期日09:45后首次且距离<3%响铃；仅卖方距离<2%静音、穿价响铃、五成静音八成响铃；财报即时/前2交易日；卖call价内除息前2日已宣布响铃/预计静音。不是交易指令。
12. **提醒默认**：300秒轮询；距离abs(S-K)/K，单卖腿进度(开仓权利金-中间价)/开仓权利金，非可成交盈亏、复杂Roll/价差不得套用；财报提醒默认静音；同次五成八成只高等级，按仓位/阈值/交易日去重，到期五日一次。反复穿越是否重响待定。最新除息记录必须CD且frequency为1/2/4/12，否则无数据，不能跳到更早CD；日期周期/休市推算未实现。
13. **意图默认**：卖put收租、卖call收租、买put买保险、买call看涨、贷方价差限定风险收租、借方价差限定成本看方向；其他可选意图保留在知识/技能。此次不用问按默认待确认；生产缺意图仍问一次，无回复用默认。意图变更保留时间/原因，不自动改。
14. **授权/运行**：生产broker地址、工作邮箱外部重定向权限、Gmail授权、Telegram投递、账户映射/税务归属及业务key均未配置/核验。stock-ta的structure/signals已在预演成功返回，但其他工具、业务key及全部运行环境仍未逐项验收。提供方缺席时模型题可能判「没用到」，不算集成通过；局部成功不证明C2/C4全部运行态或PR部署。
15. **版权/来源**：theta digest版权及OCC/CBOE精确版本章节未逐项核验，不导入受保护正文；六个知识来源及时间见`knowledge/README.md`和各`source.json`；均已齐备，但仍是reference资料，不是功能完成证明。税务memo引用Pub550(2025)/1099-B Instructions(2026)/8949(2025)，本轮未联网复核，不说独立查证。429真实body/headers尚无录样，未来可合成但必须标合成，不声称实测。

## 使用者后续配置（仅列命令，本轮不执行）

先P3实现及完整确定性测试、实际module check和module try，再考虑配置和启用。仅配置key不会让P2 handler可用。业务密钥与stock-ta分开存放，供应方额度仍共享，会诊会增加调用；feeds不能调外部工具，需要自行授权取数。由使用者交互配置，不把值放命令行/包：

```bash
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module secret option-ta POLYGON_API_KEY
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module secret option-ta FINNHUB_API_KEY
# P3全部验收后，使用者看过再自己执行；本轮没有运行：
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module on option-ta
```

Gmail授权用宿主mail连接器流程，不声明或读取Gmail身份密钥。实际交易台地址由领队按使用者指令录入private brokers（address/addedAt，撤销写removedAt不删行）；工作邮箱生产必须重定向保留交易台from，手动转发备选不在第一版。匿名accounts映射和期权watchlist由领队按明确事实维护，不联动stock-ta自选。当前不能安全录入成交，不要手工绕开may_write=false。

## 材料出处与时间

来源为提供材料，不是本轮网络取数：`option-ta-spec.md`、`option-ta-build-plan.md`（用户已定事项2026-11-16/17）；`option-ta-tax-memo.md`第14节（2026-11-16）；`option-ta-p1/README.md`（材料P1实测2026-11-17美东04:29–04:40）；`option-ta-p1/mail-samples/`（2026-11-17虚构样例与手写expected草稿）。包内技能为转述和工程边界，不整篇复制原说明书。新模块保持已停用，需P3验收后由使用者决定打开。
