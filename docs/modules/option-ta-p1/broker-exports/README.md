# option-ta 券商导出文件导入（设计和样例，2026-11-17）

使用者要把 JPM 门户和 eTrade 导出的交易记录 CSV 交给 option-ta，作为成交的最终账：补齐交易台邮件和手动记录缺的手续费、交割日、交易编号，补上到期和指派，不重复记账。本目录是给模块工坊的材料：两份虚构样例、期望结果、账户别名表样例和下面的规则。

样例里的名称、账号、编号、金额、CUSIP 全是编的，原文件不进仓库。本文只描述结构，结构是对照使用者 2026-11 的真实导出量出来的。`fills` 的字段以 `../../examples/option-ta/data/fills/collection.json` 为准，成交行的 `id` 写法沿用 `../../option-ta-spec.md`「订单键和 `id`」。

| 文件 | 内容 |
|---|---|
| `jpm-sample.csv` | JPM 门户导出的虚构样例：UTF-8 带 BOM，CRLF，23 行数据 |
| `jpm-sample.expected.json` | 空库导入 `jpm-sample.csv` 应得的 `fills`、`skipped`、`needs_confirmation` |
| `jpm-sample.reconcile.json` | 库里已有邮件、手动、上次导入的行时，再导入 `jpm-sample.csv` 应得的动作 |
| `etrade-sample.csv` | eTrade 导出的虚构样例：无 BOM，CRLF，开头说明行、结尾免责声明行 |
| `etrade-sample.expected.json` | 空库导入 `etrade-sample.csv` 的期望结果，含一次指派和被叫走的股票 |
| `account-aliases.sample.json` | 虚构的账户别名表：已登记账户和导出、邮件里的各种叫法 |
| `make-samples.py` | 生成上面所有文件。在仓库根目录跑 `uv run --no-project python docs/modules/option-ta-p1/broker-exports/make-samples.py` |

期望结果和 CSV 由同一张虚构表生成，写的是导入器应该给出的结果，不是导入器的输出。每个结果行带 `line`，是它在 CSV 里的行号（从 1 数，含说明行和表头）。

## 1. JPM 门户导出

**文件。** UTF-8 带 BOM，CRLF，第一行是表头，没有说明行和合计行。33 列，每行列数一样，含逗号的格子加双引号。一份导出是用户选的一段时间（真实样本是一个月），按成交日从新到旧排。

**导入用到的列：**

| 列 | 写法 | 用途 |
|---|---|---|
| `Trade Date` | `MM/DD/YYYY` | 成交日。到期行是入账日，见第 4 节 |
| `Settlement Date` | `MM/DD/YYYY` | 交割日。期权一般 T+1，到期行等于 `Trade Date` |
| `Account Name`、`Account Type`、`Account Number` | 名称全大写；类型是 `Margin`、`Asset`、`Invt Mgmt`；号码是 `...` 加 4 位 | 三个合起来认账户，见第 3 节 |
| `Type` | 见下表 | 行类型 |
| `Description` | 见第 2 节 | 合约和交易编号 |
| `Ticker` | 标的代码；债券为空 | 期权行是标的，不是期权代码 |
| `Price USD` | 每股价格，整数或小数 | 成交价。到期行不用 |
| `Quantity` | 带符号：卖为负，买为正 | 张数取绝对值 |
| `Amount USD` | 带符号的净额 | 算 `fees` |
| `Commissions USD` | 佣金，非负 | `commission` |
| `Tran Code` | 数字 | 和 `Type` 互相核对 |

不用的列：`Post Date`、`Cusip`、`Security Type`（真实样本里全空）、`Local Currency`、各 `Local` 列、`Cost USD`、`G/L` 各列、`Income` 列、`Balance`、`Broker`、`Check Number`、`Tax Withheld`。

**行类型：**

| `Type` | `Tran Code` | 处理 |
|---|---|---|
| `Write option` | 166 | 卖开，FILL，`side` = STO |
| `Buy back option` | 671 | 买平，FILL，`side` = BTC |
| `Expired option` | 668 | 到期作废，EVENT，`type` = EXPIRE |
| `Purchase`、`Sale` | 651、151 | 不是期权。股票、货币基金、债券都跳过并写原因；疑似指派交割的股票行进待确认，见第 4 节 |
| 其他（如出现 `Assigned`、`Exercise`、买开或卖平的类型） | | 真实样本里还没见过，进待确认，原因 `unknown-row-type`，不猜 |

`Type` 和 `Tran Code` 对不上时也进待确认。

**金额。** 期权行：总额 = 价格 × 张数 × 100。`commission` 取 `Commissions USD`。`fees` 是佣金以外的监管费，表里没有单列，按净额倒推：卖开 `fees` = 总额 − 佣金 − 净额；买平 `fees` = |净额| − 总额 − 佣金。真实样本里倒推出的费用每张约 2 美分，都是正数。倒推结果为负或超过总额的 1% 时不写 `fees`，进待确认，原因 `amount-mismatch`。

## 2. JPM 期权描述

真实导出里见过这几种写法（括号里是样例行号）：

| 写法 | 例（虚构） |
|---|---|
| 交易编号在末尾 | `APPLE INC PUT 10/30/26 @ 230.0 JUNO: EXAMPLEABC20261020001`（13） |
| 末尾先重复 PUT/CALL 再给编号 | `... PUT 10/30/26 @ 470 PUT JUNO: EXAMPLEABC20261027003`（6） |
| 交易编号在开头 | `PUT JUNO: EXAMPLEABC20261007001 APPLE INC PUT 10/16/26 @ 220.0`（22） |
| 带 `OPTION`，有编号或没有编号 | `... CALL 11/20/26 @ 270 CALL OPTION JUNO: ...`（18）、`... CALL 11/20/26 @ 270.0 CALL OPTION`（16） |
| 到期行：重复合约 | `... PUT 10/23/26 @ 475 PUT DIA 10/23/26 475`（7） |
| 到期行：带 `EXPIRE` | `... PUT 10/23/26 @ 475 EXPIRE UNEXERCISED PUT`（9） |

规则：

- 合约取第一处 `(PUT|CALL) MM/DD/YY @ <行权价>`。到期日的年份是两位，按 20YY 读。行权价可以是整数或带小数。
- 标的取 `Ticker` 列，不从发行人名里猜。OCC 代码由标的、到期日、PUT/CALL、行权价拼出，和邮件解析一样。
- 交易编号取 `JUNO:` 后面那一段，写进 `order_id`。没有就留空。编号在描述里的位置不固定，不能按位置切。
- `Expired option` 的 `Price USD` 有时是 0，有时是行权价（样例第 9、15 行），一律不用。

## 3. 账户识别

option-ta 的 `accounts` 集合已登记的 `account_ref`（形如 `JPM-NORT-4411`，样例虚构）是账户的唯一名字。导出和邮件里账户的叫法不同，要靠别名对到登记名。

**别名放哪。** 给 `accounts` 每行加一个文字字段 `aliases`，存 JSON 列表，每项是一种叫法：

| `kind` | 内容 | 例（虚构） |
|---|---|---|
| `jpm-export` | `account_name`、`account_type`、`account_number` 三个都要对上 | `NORTHWIND HARBOR LTD-MGN`、`Margin`、`...0101` |
| `email` | 交易台邮件 `Account` 列的短码 | `NORTx4411`、`NORTxxxx` |
| `etrade-export` | eTrade 导出说明行里的账户标签 | `Orbit -5150` |

完整样例见 `account-aliases.sample.json`。

**规则：**

- **JPM 的 `...0101`。** JPM 导出里保证金账户的号码不是网页上显示的后 4 位，真实样本里两个不同主体的保证金账户都写成 `...0101`。所以 JPM 导出只能用「名称 + 类型 + 号码」三个一起认，不能只看号码。样例第 4、5 行就是两个都写 `...0101` 的账户。
- **邮件短码。** 两种形状：`<4 字母前缀>x<后 4 位>`，或 `<前缀>xxxx` 不带后 4 位。前缀只对应一个账户时，`xxxx` 形状也能认。
- **一个前缀对应两个账户。** 样例里 `BLUExxxx` 同时是 `JPM-BLUE-5522` 和 `JPM-BLUE-3301` 的别名，查到两个就是认不出：记「待确认账户」，问使用者是哪个（使用者 2026-11-17 同意）。导入时若候选账户里恰好有一行导出能对上，把它作为建议附在问题里，仍然等使用者确认。
- **对不上任何账户。** 期权行进待确认，原因 `unknown-account`，问使用者是新账户还是别名漏了。非期权行照常跳过。
- 导出里有些账户从来没有期权（样例里的 `NORTHWIND HARBOR CAPITAL` 投资管理账户、`RIVERSTONE LLC`）。它们不用登记，行都是非期权，按原因跳过。

## 4. 到期、指派、行权

这三种写 EVENT 行，形状照 `../../examples/option-ta/tools/ledger/fixtures/seed.json`：`event_id` = `<OCC>:<type>:<event_date>:<account_ref>`，`trade_date` 写成 `event_date`。

- **到期（EXPIRE）。** `event_date` 写合约到期日，不写 JPM 的入账日。JPM 在到期后的下一个交易日（周一）入账，真实样本里三行都是这样。到期作废按税法视为在到期日卖出（tax memo 第 2 节第 3 条，第 3、4 节表格的「到期作废」行），年末那周的周五到期如果按周一入账日记，会记错税年。样例第 7 到 9 行：10/23 周五到期，10/26 周一入账，`event_date` 是 `2026-10-23`。
- **指派（ASSIGNED）。** eTrade 有单独的 `Option Assigned` 行，后面跟一行交割股票的 `Sold`（被叫走）或 `Bought`（被行权买入）。`event_date`：到期时被指派的（`Activity/Trade Date` 在合约到期日之后 4 天以内），写合约到期日，理由同 EXPIRE；提前被指派的（在到期日之前），写 `Activity/Trade Date`（使用者 2026-11-17 定）。交割股票写一行 FILL：`side` 是 SELL 或 BUY，`instrument` 没有期权字段、乘数 1，`caused_by_event` 指向那条 ASSIGNED。股票行认作交割的条件：同账户、同标的、股数 = 张数 × 100、价格 = 行权价、日期等于指派行。样例 `etrade-sample.csv` 第 8、9 行是一对；第 12 行是普通股票卖出，跳过。
- **JPM 的指派。** 真实样本这个月没有指派，JPM 导出里指派怎么写还没见过。`Purchase`/`Sale` 股票行满足下面全部条件时，不跳过，进待确认（原因 `possible-assignment`），问使用者：同账户在导出或库里有一张这个标的的卖出期权；股票成交日就是这张期权的到期日；价格等于行权价；股数等于张数 × 100。样例第 11 行按这个假设形状造了一行（第 23 行是对应的卖开）。见到真实的 JPM 指派行以后，按它定正式规则。
- **行权（EXERCISED）。** 第一版只卖期权，没有自己行权的行。见到了进待确认。

## 5. eTrade 导出

**文件。** 无 BOM，CRLF。前 6 行是说明：第 1 行标题，第 3 行 `Account Activity for  <账户标签> from LAST <N> Days`（标签和 `from` 之间是两个空格；标签形如 `Orbit -5150`），第 5 行 `Total:,<合计>`，中间是空行。第 7 行是表头，然后是数据行，按日期从新到旧。数据后面是 3 个空行，再是 4 段免责声明，每段一行、段间空一行，多数用双引号包起来，里面的双引号写成两个。文件末尾是两个空行。

读法：找第一行以 `Activity/Trade Date` 开头的作表头，读到第一个空行为止。账户从第 3 行取标签，对 `etrade-export` 别名。`Total` 不用。

**列：** `Activity/Trade Date`（成交日）、`Transaction Date`、`Settlement Date`、`Activity Type`、`Description`、`Symbol`（标的）、`Cusip`（`--`）、`Quantity #`（带符号，一位小数，如 `-5.0`）、`Price $`、`Amount $`（带符号净额）、`Commission`、`Category`（`--`）、`Note`（`--`）。

**行类型：**

| `Activity Type` | 处理 |
|---|---|
| `Sold Short` | 卖开，FILL，STO |
| `Bought To Cover` | 买平，FILL，BTC |
| `Option Assigned` | EVENT，ASSIGNED。价格为空，金额和佣金为 0 |
| `Sold`、`Bought` | 是指派交割（第 4 节条件）就写股票 FILL，否则跳过，原因 `stock-trade-out-of-scope` |
| 其他（如到期 `Option Expired` 之类） | 还没见过，进待确认，原因 `unknown-row-type` |

**描述。** 期权是定宽的 `PUT  SPY    10/23/26   575.000`：PUT/CALL 占 5 格，标的占 7 格，然后到期日、3 个空格、3 位小数的行权价。按空白切成 4 段读，不按列位置。

**金额。** 真实样本里每行都正好是 净额 = 总额 − `Commission`（卖）或 −(总额 + `Commission`)（买），没有另外的监管费。所以 `commission` 取 `Commission`，`fees` 留空。

**日期的怪处。** 真实样本里 `Option Assigned` 行的 `Settlement Date` 比 `Activity/Trade Date` 早 3 天（看起来是到期那个周五），交割股票行两个日期相同。样例第 8 行照样复现。按第 4 节的规则，到期时被指派写合约到期日。

## 6. 待入账（Pending）

刚成交、还没交割的交易，门户上 `Settlement Date` 显示「Pending」，导出文件里根本没有这些行。所以导入时，库里最近几天的手动或邮件成交在导出里找不到，不算矛盾：

- 记录的交割日（没有就按成交日 + 1 个交易日算）不早于导入日：标「待入账」，不问，下次导入再核。
- 交割日已经过了、导出里还是没有：进待确认，原因 `missing-from-export`，问使用者是没成交还是记错了。
- 成交日早于这份导出最早的 `Trade Date`：不在这份导出覆盖的范围里，不比较（`outside-export-window`）。

## 7. 和已记成交对账

导入不是盲目追加。每个导出行先找库里已有的行：

**怎么对。** 按「合约（OCC）、方向、成交日、账户、张数」对。账户先过别名，邮件行的 `NORTxxxx` 和导出的 `JPM-NORT-4411` 是同一个。同一订单在库里有几行（部分成交的增量），张数按订单合计比。EVENT 按 `event_id` 对。

| 情况 | 动作（`jpm-sample.reconcile.json` 里的名字） |
|---|---|
| 库里已有同 `id` 的行（上次导入过，或手动记的 EVENT 正好一样） | `already-recorded`，什么都不写 |
| 键全对上，库里的行缺手续费、交割日、交易编号或账户是邮件短码 | `enrich`：写一行 REVERSAL 冲销旧行，再写导出的完整行。成交行只追加、不改（spec「订单键和 `id`」），更正靠冲销（tax memo 第 14.1 节），`ledger` 已经会跳过被冲销的行 |
| 合约、方向、日期、账户对上，但张数或价格不同 | `conflict`：两边都不写，进待确认，问使用者 |
| 邮件行账户是「待确认账户」 | `account-unconfirmed`：附上建议账户，等使用者 |
| 库里没有 | `add`：写导出行，`source` 是 `broker-export` |

REVERSAL 行的 `id` 是 `<被冲销的 fill_id>:reversed-by-export`，`reversal_of` 指向旧行，`trade_date` 照旧行写，形状见 `jpm-sample.reconcile.json` 的 `reversal_example`。价格比较按万分之一美元的整数比，和邮件解析一样不经过浮点。

反过来，库里有、导出里没有的行按第 6 节处理。

## 8. 重复导入

同一份文件导两次，或者两份时间段重叠的导出，不能重复记账：

- 导出行的 `id` 由内容决定：FILL 是 `<OCC>:<方向>:<成交日>:<account_ref>:cum<张数>`，EVENT 是 `event_id`，股票交割是 `<标的>:<SELL|BUY>:<成交日>:<account_ref>:cum<股数>`。和宿主的「同 `id` 只写第一次」配合，重导不会多出行。
- 同一份文件里同一订单键有几行（同一天同一合约分几笔成交），先合并成一行：张数相加，价格按张数加权，佣金和费用相加。这样不管文件里怎么拆，`id` 都一样。
- REVERSAL 的 `id` 也是确定的，重导不会冲销两次。
- 测试要断言：把第一次导入写出的行加进库，再导一次同一文件，写出的行是空的（`jpm-sample.reconcile.json` 的 `rerun`）。

## 9. 输出和原因

导入写成纯函数：输入是 CSV 文本、导入日、库里的 `fills` 和 `accounts`，输出 `fills`（要写的行）、`skipped`、`needs_confirmation`。`needs_confirmation` 有内容就发 notice，由领队问使用者；`skipped` 不打扰。

`skipped` 的原因：`stock-trade-out-of-scope`、`money-market-fund`、`bond`。分类只是说明，判断很粗：描述里有 `FUND` 且代码以 `XX` 结尾算货币基金，没有代码且描述里有 `DTD` 算债券，其余算股票。

`needs_confirmation` 的原因：`unknown-row-type`、`unknown-account`、`account-unconfirmed`、`possible-assignment`、`amount-mismatch`、`conflict`、`missing-from-export`。

文件怎么交给模块（网页上传附件、Telegram 发文件）由工坊按宿主现有的入口定。

## 10. 待使用者确认

已定（使用者 2026-11-17）：EXPIRE 的 `event_date` 用合约到期日；到期时被指派的 ASSIGNED 用合约到期日，提前被指派的用实际日期；补齐用「REVERSAL + 新行」。

还没定：JPM 指派行的真实写法，见到第一份有指派的导出时再定。
