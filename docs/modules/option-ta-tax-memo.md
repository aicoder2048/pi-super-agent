# option-ta 税务专题备忘：期权权利金、成本基础和 Roll 在美国联邦税下怎么算

> **先读这一段。** 这份备忘录解释美国联邦所得税的规则，目的是给 option-ta 的记账设计找依据。它不是税务建议。报税前请和税务专业人士确认，并以券商出具的 Form 1099-B 为准。规则会变，每一条都附了读过的原文出处和版本；标「未证实」的地方，原文里没找到，不能当结论用。

使用者要让 option-ta 只记一套原始成交和事件记录，再从中推出两个视图。一个是按交易链看的盈亏（开仓，任意次 Roll，最后平仓、到期、被指派或行权），另一个是美国税务视图。这份备忘录回答的问题是，税法怎么对待权利金、成本基础和 Roll，原始记录要记哪些字段，两个视图才都能算出来，而且不变成两套账。

术语沿用 `option-ta-glossary.md`：STO、BTO、BTC、STC、Roll（BTC+STO 或 STC+BTO）、CSP、CC、垂直价差和各种意图。

## 1. 范围、出处和读法

本文只讲美国联邦所得税，纳税人是个人投资者，不是期权做市商，也不是选了 §475 按市价计税的交易者（trader）。州税、IRA 账户内部的损益、外币不在范围内。

读过的原文和版本：

| 出处 | 版本 | 用途 |
|---|---|---|
| IRS Publication 550 | 2025 年版，用于 2025 年报税 | 期权、跨式、wash sale、持有期、§1256 的主要说明 |
| Instructions for Form 1099-B | 2026 年版 | 券商报什么、怎么报 |
| Instructions for Form 8949 | 2025 年版 | 和 1099-B 对不上时怎么调整 |
| 26 U.S.C. §1091、§1092、§1222、§1233、§1234、§1234A、§1256 | Cornell LII 现行文本 | 法条原文 |
| Treas. Reg. §1.1012-1、§1.1091-1、§1.1092(b)-2T、§1.1092(c)-1、§1.1092(c)-2、§1.1092(c)-4、§1.6045-1 | Cornell LII 现行文本 | 条例原文 |
| Rev. Rul. 85-87 | Tax Notes 收录的摘要页 | 卖出深度价内 put 和 wash sale |

完整链接见文末「参考资料」。引用原文时只摘短语，并链接到小节锚点。

本文的标注：

- 「原文」：直接出自上表的出处。
- 「推论」：由原文推出，原文没有逐字这么写。
- 「未证实」：读过的原文里找不到依据。第 15 节汇总了所有未证实的点。

## 2. 四条底层规则

后面所有情形都是这四条规则的组合。

1. **卖方收到的权利金先挂起，不算当期收入。** Pub 550 说卖方 "do not include the amount you receive for writing it in your income at the time of receipt"，要 "Carry it in a deferred account"，直到期权到期、被行权或平仓（[Writers of puts and calls](https://www.irs.gov/publications/p550#en_US_2025_publink100010630)）。所以收入记在**结束那天**的税年，不是开仓那天。
2. **卖方的平仓盈亏和到期收益一律是短期。** §1234(b)(1) 规定，卖方 "gain or loss from any closing transaction with respect to, and gain on lapse of, an option" 按 "a capital asset held not more than 1 year" 处理（[26 U.S.C. §1234](https://www.law.cornell.edu/uscode/text/26/1234)）。期权开了多久都不影响。
3. **买方的期权是一项资本资产，长短期看期权本身持有了多久。** 卖掉时按持有期分长短期；到期作废视为在到期日卖出（§1234(a)(2)："deemed to have been sold or exchanged on the day it expired"）。
4. **被行权或被指派时，期权不单独结算，权利金并进股票这一笔。** 卖出的 put 被指派，股票成本减去权利金；卖出的 call 被指派，卖股所得加上权利金；买入的 call 行权，权利金加进股票成本；买入的 put 行权，卖股所得减去权利金（[Table 4-3](https://www.irs.gov/publications/p550#id879)）。

这四条规则直接决定了 Roll 的结果。Roll 里平掉的每一腿都按规则 2 或 3 当场实现盈亏；只有最后一腿如果被指派或行权，才按规则 4 进股票成本。第 6 节有完整算例。

## 3. 卖出的 put（STO put，含 CSP）

| 结局 | 税务处理 | 损益性质 | 记在哪一天 | 出处 |
|---|---|---|---|---|
| 到期作废 | 收到的权利金全部是收益 | 短期资本利得 | 到期日 | Pub 550 [Writers of puts and calls](https://www.irs.gov/publications/p550#en_US_2025_publink100010630)："the amount you received for writing the call or put is short-term capital gain" |
| BTC 平仓 | 买回价与收到的权利金之差 | 短期资本利得或损失 | BTC 成交日 | 同上："is a short-term capital gain or loss"；§1234(b)(1) |
| 被指派，按行权价买入股票 | 期权本身不产生损益；股票成本 = 行权价 × 股数 − 收到的权利金 | 卖股时再看股票持有期 | 指派日买入股票 | 同上："decrease your basis in the stock by the amount you received for the put" |

**被指派后股票的持有期从哪天开始。** Pub 550 原文："Your holding period for the stock begins on the date you buy it, not on the date you wrote the put."（同上）。计数规则是从买入日的**次日**开始数，卖出那天算在内，持有 "more than 1 year" 才是长期（[Long-term or Short-term](https://www.irs.gov/publications/p550#en_US_2025_publink100010541)）。上市证券用成交日（trade date），不用交割日（[Securities traded on an established market](https://www.irs.gov/publications/p550#en_US_2025_publink100010543)）。

「买入日」在被指派时具体是哪一天，原文没细说。实务上以券商确认单上的指派成交日为准。这一点是**推论**，模块应直接取券商报的日期，不要自己算。

卖出 put 的时间不算进股票持有期。CSP 开了 11 个月才被指派，股票仍然从指派日起重新计时。

## 4. 卖出的 call（STO call，含 CC）

| 结局 | 税务处理 | 损益性质 | 记在哪一天 | 出处 |
|---|---|---|---|---|
| 到期作废 | 权利金全部是收益 | 短期资本利得 | 到期日 | Pub 550 [Writers of puts and calls](https://www.irs.gov/publications/p550#en_US_2025_publink100010630) |
| BTC 平仓 | 买回价与权利金之差 | 短期资本利得或损失（例外见第 8 节） | BTC 成交日 | 同上；§1234(b)(1) |
| 被指派，按行权价卖出股票（CC） | 卖股所得 = 行权价 × 股数 + 收到的权利金 − 卖出费用 | 看**股票**的持有期 | 指派日 | 同上："increase your amount realized on the sale of the stock by the amount you received for the call ... long-term or short-term depending on your holding period of the stock" |

**卖方损益是否不论开多久都算短期。** 是。§1234(b)(1) 把卖方的平仓损益和到期收益固定为 "held not more than 1 year"。有两处例外：

- 合格备兑 call（qualified covered call）的损失，在一定条件下算长期损失，见第 8 节（§1092(f)(1)）。
- §1256 合约（例如 SPX 期权）按 60/40 拆分，见第 10 节。

**被指派的 CC 是股票交易，不是期权交易。** 它的长短期取决于股票持有了多久。但 CC 可能让股票的持有期暂停或重新起算，见第 8 节。

## 5. 买入的 put 和 call（BTO）

| 结局 | 买入的 call | 买入的 put | 出处 |
|---|---|---|---|
| STC 卖出 | 卖出所得与成本之差；长短期看期权持有期 | 同左 | Pub 550 [Holders of puts and calls](https://www.irs.gov/publications/p550#en_US_2025_publink100010628)："depending on how long you held it" |
| 到期作废 | 成本全部是资本损失；持有期在到期日结束 | 同左 | 同上："its cost is either a long-term or short-term capital loss, depending on your holding period, which ends on the expiration date"；§1234(a)(2) |
| 行权 | 期权成本加进股票成本 | 卖股所得减去期权成本 | 同上："add its cost to the basis of the stock you bought"，"reduce your amount realized ... by the cost of the put" |

**期权本身的持有期。** 从买入次日数到卖出日或到期日。持有超过 1 年（例如 LEAPS）可以是长期。

**行权得到的股票。** 持有期从行权日的次日开始（[Option exercised](https://www.irs.gov/publications/p550#en_US_2025_publink100010556)），期权的持有期不并入股票。

**买入的 put 和手里的股票（买保险）。** Pub 550 说买 put "is generally treated as a short sale"（[Put option as short sale](https://www.irs.gov/publications/p550#en_US_2025_publink100010629)）。如果买 put 时股票只持有了 1 年或更短，或者买 put 之后才买股票，那么：

- put 行权、卖出或到期产生的收益一律是短期（§1233(b)(1)）。
- 股票的持有期改为从这几个日期中最早的一天重新开始：卖掉股票、行权、卖掉 put、put 到期（同上，§1233(b)(2)）。

同一天买股票和 put，并把这批股票标明为行权用的股票（married put），不适用上面这条。put 没行权就作废时，put 的成本加进这批股票的成本（§1233(c)，[26 U.S.C. §1233](https://www.law.cornell.edu/uscode/text/26/1233)）。

股票加保护性 put 同时也是跨式（straddle），跨式规则也管持有期和损失递延，见第 7 节。§1233(e)(2)(A) 写明 §1233(b) 和 (d) 的 "property" 不包括 "any position to which section 1092(b) applies"。两套规则在保护性 put 上谁优先，读过的原文没给出逐条答案，**未证实**。模块不该自己裁定，只标记「这笔股票有保护性 put，持有期和损失可能受影响」。

## 6. Roll：每一腿各自结算

### 6.1 规则

Roll 在税法里不是一个动作。卖方 Roll（BTC + STO）是两笔交易：

- BTC 是旧期权的平仓，当场实现短期损益（§1234(b)(1)）。
- STO 是新期权的开仓，权利金进入新的挂起账户（规则 1）。

买方 Roll（STC + BTO）同理。STC 实现损益，长短期看旧期权持有了多久；BTO 的成本是新期权的成本。

Calendar、Diagonal、Combo 三种 Roll 在税务上没有区别。原文里也没有把 Roll 当作一笔交易的规定。**推论**：Pub 550 只给了到期、平仓、行权三种结局（[Puts and Calls](https://www.irs.gov/publications/p550#id874)），Roll 的 BTC 就是其中的平仓。

由此得出，一条链 Roll 了 N 次然后被指派：

- 前 N 腿各自在 BTC 那天实现短期损益，记在 BTC 所在的税年。
- 只有第 N+1 腿（最后一腿）的权利金影响股票成本。
- 链视图里的「整条链净收权利金」不是任何一笔股票的税务成本。

### 6.2 算例：CSP Roll 两次后被指派，再卖 CC 被指派

假设一个账户、1 张合约（100 股），标的是虚构的 XYZ。每次成交的佣金和费用合计 $0.65，指派不收费。所有数字都是演示用，不代表任何真实行情。

**原始记录（模块唯一要存的东西）：**

| # | 成交日 | 动作 | 合约 | 价格 | 毛额 | 费用 | 净额 |
|---|---|---|---|---|---|---|---|
| 1 | 2026-03-02 | STO | XYZ 2026-03-20 100 P | 2.00 | +200.00 | 0.65 | +199.35 |
| 2 | 2026-03-19 | BTC | XYZ 2026-03-20 100 P | 3.50 | −350.00 | 0.65 | −350.65 |
| 3 | 2026-03-19 | STO | XYZ 2026-04-17 95 P | 4.20 | +420.00 | 0.65 | +419.35 |
| 4 | 2026-04-16 | BTC | XYZ 2026-04-17 95 P | 1.10 | −110.00 | 0.65 | −110.65 |
| 5 | 2026-04-16 | STO | XYZ 2026-05-15 95 P | 2.40 | +240.00 | 0.65 | +239.35 |
| 6 | 2026-05-15 | 被指派 | XYZ 2026-05-15 95 P | 事件 | | 0 | |
| 7 | 2026-05-15 | 买入股票（由 #6 产生） | XYZ 100 股 | 95.00 | −9,500.00 | 0 | −9,500.00 |
| 8 | 2026-05-18 | STO | XYZ 2026-06-26 100 C | 1.50 | +150.00 | 0.65 | +149.35 |
| 9 | 2026-06-26 | 被指派 | XYZ 2026-06-26 100 C | 事件 | | 0 | |
| 10 | 2026-06-26 | 卖出股票（由 #9 产生） | XYZ 100 股 | 100.00 | +10,000.00 | 0 | +10,000.00 |

#2 和 #3 是一次 Diagonal Roll，#4 和 #5 是一次 Calendar Roll。链记录把 #1 到 #10 串成一条链，把 #2/#3、#4/#5 各标成一个 Roll 组。

**同一批记录推出的两个视图：**

| 项目 | 链视图 | 税务视图 |
|---|---|---|
| #1/#2 第一腿 put | 计入链的累计权利金 | 2026-03-19 实现短期损失 199.35 − 350.65 = **−151.30** |
| #3/#4 第二腿 put | 计入链的累计权利金 | 2026-04-16 实现短期收益 419.35 − 110.65 = **+308.70** |
| #5 第三腿 put | 计入链的累计权利金 | 不产生损益，权利金 239.35 进股票成本 |
| 股票成本 | 「有效成本」9,500 − 净收权利金 396.75 = 9,103.25（每股 91.0325） | 9,500 − 239.35 = **9,260.65**（每股 92.6065） |
| 股票持有期 | 不适用 | 从 2026-05-16 起算 |
| #8 CC | 计入链的累计权利金 | 不单独产生损益（被指派） |
| 卖股 | 链结束 | 卖股所得 10,000 + 149.35 = 10,149.35；成本 9,260.65；2026-06-26 实现短期收益 **+888.70** |
| 总计 | 净收权利金 396.75 + 149.35 = 546.10；股票价差 10,000 − 9,500 = 500；**合计 +1,046.10** | −151.30 + 308.70 + 888.70 = **+1,046.10**，全部是 2026 年短期 |

链视图里的净收权利金 396.75 来自 199.35 + 419.35 + 239.35 − 350.65 − 110.65。

**两个视图的对账恒等式：**

- 链视图的净收权利金 = 前几腿已实现的期权损益之和 + 最后一腿进入股票成本的权利金。本例是 396.75 = 157.40 + 239.35。
- 税务股票成本 − 链视图有效成本 = 前几腿已实现的期权损益之和。本例是 9,260.65 − 9,103.25 = 157.40。
- 整条链结束且全部落在同一税年时，两个视图的总盈亏相等（本例都是 +1,046.10）。

两个视图的差别只在**时点**和**性质**，不在总额：

- 链跨年时，前几腿的损益记在各自 BTC 的那一年，最后一腿的权利金要等股票卖掉才实现。假设股票拿到 2027 年才卖，2026 年税务上只有 +157.40，其余在 2027 年。
- 股票持有超过 1 年再卖，卖股那部分变成长期，期权腿那部分仍是短期。
- 某一腿的损失可能被 wash sale 或跨式规则推迟（第 7、9 节），链视图不受影响。

所以模块绝不能把「有效成本 9,103.25」写成股票的成本。它是链视图的派生数，税务成本只能从原始记录按规则重算。

**本例中 #8 的 CC 是否「合格」。** 2026-05-18 开仓，2026-06-26 到期，相隔 39 天，超过 30 天；行权价 100 高于开仓前一日收盘价（假设 93.80），不是深度价内；在交易所交易。按第 8 节的条件，它是合格备兑 call，股票和 CC 不构成跨式，股票持有期不受影响。如果 #8 改成 2026-06-12 到期（25 天），它就不是合格备兑 call，见第 8.3 节。

## 7. 价差和保护性 put：跨式规则

### 7.1 什么时候构成跨式（straddle）

§1092(c)(1) 把跨式定义为 "offsetting positions with respect to personal property"（[26 U.S.C. §1092](https://www.law.cornell.edu/uscode/text/26/1092)）。几个要点：

- 期权本身是 personal property。Pub 550："It includes stock options and contracts to buy stock but generally does not include stock."（[Personal property](https://www.irs.gov/publications/p550#en_US_2025_publink100010633)）
- 股票在一种情况下也算：股票活跃交易，且至少一个对冲仓位是这只股票的期权或 "substantially similar or related property"（§1092(d)(3)(A)(i)；[Straddle rules for stock](https://www.irs.gov/publications/p550#en_US_2025_publink100010634)）。
- 推定对冲的情形包括同一标的且价值反向变动、"sold or marketed as offsetting positions, whether or not the positions are called a straddle, spread, butterfly"，以及合并保证金低于分开保证金（[Presumed offsetting positions](https://www.irs.gov/publications/p550#en_US_2025_publink100010638)；§1092(c)(3)）。
- 配偶持有的仓位算作本人持有（[Related persons](https://www.irs.gov/publications/p550#en_US_2025_publink100010639)）。

按这些条件，下面几种仓位都落在跨式里（**推论**，原文没有逐一点名）：

| 仓位 | 为什么是跨式 |
|---|---|
| 垂直价差（贷方或借方） | 同一标的的两腿期权价值反向变动，按价差下单、保证金合并计算 |
| 股票 + 买入的保护性 put（买保险） | 股票是活跃交易的股票，对冲仓位是它的期权 |
| 股票 + 卖出的 call（CC） | 同上；只有合格备兑 call 例外，见第 8 节 |
| 单独的 CSP | 只有一条腿，没有对冲仓位，不是跨式 |
| 单独买 put 看跌、单独买 call 看涨 | 同上 |

### 7.2 跨式的三个后果

**损失递延。** 平掉跨式中的一腿实现损失时，只能扣除超过其他对冲腿年末「未实现收益」的部分，其余顺延到下一年（§1092(a)(1)；[Loss Deferral Rules](https://www.irs.gov/publications/p550#id888)）。未实现收益按当年最后一个交易日的公允价值算。Pub 550 的例子：亏损 $15,000，对冲腿年末未实现收益 $12,750，当年只能扣 $2,250。

**持有期。** 跨式中仓位的持有期 "shall not begin earlier than the date the taxpayer no longer holds ... an offsetting position"（[Treas. Reg. §1.1092(b)-2T(a)(1)](https://www.law.cornell.edu/cfr/text/26/1.1092(b)-2T)）。建立跨式前已经持有超过 1 年的仓位不受影响（同条 (a)(2)）。所以持有不到 1 年的股票加上保护性 put 或不合格的 CC 后，股票的持有期要等这腿期权结束才开始算。

**损失可能被改成长期。** 建立亏损腿时已持有对冲仓位，而且跨式中有仓位当天卖出会是长期，那么亏损腿的损失算长期损失（§1.1092(b)-2T(b)(1)；[Loss treatment](https://www.irs.gov/publications/p550#en_US_2025_publink100010668)）。

还有一条与 wash sale 协调的规则：跨式中的股票亏损卖出，前后 30 天内又买了相同股票，损失顺延（Rule 1）；之后再看后继仓位和对冲仓位的未实现收益（Rule 2）（[Coordination of Loss Deferral Rules and Wash Sale Rules](https://www.irs.gov/publications/p550#id901)）。

### 7.3 对价差的实际影响

价差的每一腿在券商那里各自成交、各自报 1099-B。税务上每一腿各自算损益，然后套跨式规则：

- 两腿在同一税年内一起平掉时，损失递延只看年末仍未平的仓位，两腿都已平，当年总额通常不受影响（**推论**）。
- 价差跨年时，如果年底前先平了亏损腿，另一腿年末有未实现收益，亏损腿的损失要递延。
- 垂直价差的两腿通常都是短期仓位，持有期规则影响不大。

**例外。** 交易者可以在买入当天收盘前把跨式记为「已标识跨式」（identified straddle），并标明哪腿对冲哪腿。标识后不适用一般的损失递延，改为把亏损加到对冲腿的成本上（[Identified straddle](https://www.irs.gov/publications/p550#en_US_2025_publink100010646)；§1092(a)(2)）。标识必须当天做，事后补不了。模块如果要支持，标识就是一条原始记录，要带时间戳。

### 7.4 保护性 put 和 married put

保护性 put 同时触发第 5 节的「put 视为卖空」规则和本节的跨式规则。两者的共同结论是，持有不到 1 年的股票加上 put 后，股票的持有期会重新起算，长期资格往后推。股票已经持有超过 1 年再买 put，持有期不受影响（§1.1092(b)-2T(a)(2)；§1233(d) 规定这时 put 的损失算长期）。

## 8. Covered call 和跨式规则

### 8.1 合格备兑 call 的条件

股票加卖出的 call 是跨式，除非 call 是合格备兑 call（qualified covered call，下称 QCC），且这个跨式不是更大跨式的一部分（§1092(c)(4)(A)）。QCC 的条件（§1092(c)(4)(B)；[Treas. Reg. §1.1092(c)-1](https://www.law.cornell.edu/cfr/text/26/1.1092(c)-1)；[Pub 550](https://www.irs.gov/publications/p550#en_US_2025_publink100010648)）：

1. 在全国性证券交易所或财政部认可的市场交易。
2. 开仓日距到期日**超过 30 天**。
3. 开仓日距到期日不超过 12 个月。用调整后的股价确定基准时可放宽到 33 个月（§1.1092(c)-1(b)）。
4. 不是深度价内（deep-in-the-money）。
5. 卖方不是在做市业务中卖出。
6. 期权的损益是资本损益。

**深度价内的判断。** 行权价低于「最低合格基准」（lowest qualified bench mark，LQB）就是深度价内。LQB 是低于「适用股价」的最高可用行权价。期限超过 90 天且行权价高于 $50 时，LQB 取低于适用股价的**第二高**行权价。适用股价是开仓前一个交易日的收盘价；如果开仓当天的开盘价高于这个收盘价的 110%，就用开盘价。适用股价 $25 及以下时，LQB 不低于适用股价的 85%；$150 及以下时，LQB 不低于适用股价减 $10（§1092(c)(4)(C)、(D)、(G)）。

Pub 550 的例子：2025-05-08 收盘 $130.25，卖出 9 月到期、行权价 $120 的 call，可用行权价 110 到 135。期限超过 90 天，LQB 取第二高的 $125。$120 低于 $125，是深度价内，不是 QCC，"the loss deferral rules apply"。

模块要判断 QCC，需要的原始数据是：开仓日、到期日、行权价、开仓前一日收盘价、开仓当天开盘价、开仓当天这个到期日的全部可用行权价。后三项是行情快照，不在成交记录里，要在开仓时落盘。

### 8.2 价内 QCC：持有期暂停，损失可能是长期

QCC 的行权价低于适用股价（价内但不是深度价内）时，§1092(f) 有两条特别规定：

- 期权的损失，在实现时股票若卖出会是长期，就算长期损失（§1092(f)(1)）。这是第 4 节「卖方损益一律短期」的例外。
- 股票的持有期 "shall not include any period during which the taxpayer is the grantor of such option"（§1092(f)(2)）。也就是说，卖着这张 call 的日子不算进股票持有期。

价外的 QCC 没有这两条后果。

### 8.3 不合格的 CC：按跨式处理

不合格的 CC 有两种常见来源：

- **距到期 30 天或更短**（周度 CC、短期 CC）。条件 2 不满足。
- **深度价内**。条件 4 不满足。

后果就是第 7.2 节的三条：

- BTC 平仓亏损时，如果股票年末有未实现收益，亏损要递延。
- 持有不到 1 年的股票，持有期要等这张 call 结束才开始。
- 损失可能被改成长期。

**对模块的含义。** 使用者如果常卖短期 CC，股票的长期资格可能一再被推后。模块应在开每张 CC 时就判断 QCC，不合格的打标记。这个标记是从原始数据算出的派生值，不是另一套账。

### 8.4 年末特别规则

QCC 的豁免在下面三条同时成立时失效，跨式的损失递延仍然适用（§1092(c)(4)(E)；[Special year-end rule](https://www.irs.gov/publications/p550#en_US_2025_publink100010651)）：

1. 在某个税年平掉 QCC 或亏损卖出股票。
2. 股票或期权的收益要计入下一个税年。
3. 平仓或卖出后，股票或期权没有继续持有满 30 天。

典型情形是 12 月 BTC 亏损平掉 CC，股票有浮盈，1 月初就卖股票。

### 8.5 ETF 上的 CC 能否算 QCC

§1092(c)(4)(B) 说 QCC 是 "any option granted by the taxpayer to purchase stock held by the taxpayer"。§1.1092(c)-4(b)(4) 在定义「标准条款股票期权」时写的是 "has stock in a single corporation as its underlying security"。QQQ、SPY 是基金份额，算不算这里的 "stock"，读过的原文没有给出答案，**未证实**。在确认之前，模块对 ETF 上的 CC 不应自动判定为 QCC，应标「QCC 资格待确认」。

## 9. Wash sale 和期权

### 9.1 规则

亏损卖出股票或证券，前后各 30 天内（共 61 天）买入「实质相同」（substantially identical）的股票或证券，或者 "has entered into a contract or option so to acquire" 实质相同的股票或证券，这笔亏损不能扣除（§1091(a)，[26 U.S.C. §1091](https://www.law.cornell.edu/uscode/text/26/1091)；[Treas. Reg. §1.1091-1](https://www.law.cornell.edu/cfr/text/26/1.1091-1)）。

被禁的亏损加到新买的股票或证券的成本上，新仓位的持有期并入旧仓位的持有期（[Wash Sales](https://www.irs.gov/publications/p550#id854)；§1091(d)；[holding period, wash sales](https://www.irs.gov/publications/p550#en_US_2025_publink100010557)）。买的数量少于卖的，按买入顺序逐股配对（§1.1091-1(c)）。

触发范围不限于同一个账户。Pub 550 列出的触发情形还包括：配偶或本人控制的公司买入，以及为本人的 IRA 或 Roth IRA 买入。IRA 这种情形的亏损不能加到新股成本上（Pub 550 原文："except in (4) above"）。

### 9.2 期权怎么套进来

| 情形 | 结论 | 依据 |
|---|---|---|
| 亏损卖股，30 天内 BTO 同一股票的 call | 构成 wash sale | Pub 550："Acquire a contract or option to buy substantially identical stock" |
| 期权本身亏损（STC 亏损、BTC 亏损、买入的期权作废） | 期权也是「股票或证券」，可以被 wash sale 规则禁扣 | §1091(a) 末句："the term 'stock or securities' shall ... include contracts or options to acquire or sell stock or securities"；Pub 550 [Options and futures contracts](https://www.irs.gov/publications/p550#en_US_2025_publink100010604)："The wash sale rules apply to losses from sales or trades of contracts and options to acquire or sell stock or securities" |
| 亏损卖股，30 天内 STO 同一股票的 put | 该裁定只处理了深度价内的情形。put 深度价内、卖出时 "there was no substantial likelihood that the put would not be exercised"，就视为取得了买股合约，构成 wash sale。不是深度价内的 put 是否触发，没有读到依据，**未证实** | [Rev. Rul. 85-87](https://www.taxnotes.com/research/federal/irs-guidance/revenue-rulings/loss-on-corporate-stock-sale-is-not-allowed-if-in/dbsv)，1985-1 C.B. 268（页码取自检索摘要） |
| 期权亏损后 30 天内开同一标的的另一张期权（不同行权价或到期日） | 两张期权是否「实质相同」，读过的原文没有规定 | **未证实** |
| 卖出 put 亏损（BTC）后 30 天内被指派买入股票，或买入股票 | 股票与已平掉的 put 是否「实质相同」，读过的原文没有规定 | **未证实** |
| 替换仓位是卖出的期权（没有成本）时，被禁的亏损加到哪里 | 读过的原文没有规定 | **未证实** |

### 9.3 对 Roll 的含义

卖方 Roll 时 BTC 常常是亏损的，同一天又 STO 同一标的的新期权。按上表：

- 新卖的 put 深度价内时，Rev. Rul. 85-87 的思路可能适用（**推论**，该裁定处理的是股票亏损，不是期权亏损）。
- Calendar Roll（行权价不变、只换到期日）的两张期权是否实质相同，**未证实**。
- 券商的 1099-B 只在同一账户、同一 CUSIP 时必须报 wash sale（第 13 节）。不同期权系列的代码不同，所以 Roll 引起的 wash sale 问题通常不会出现在 1099-B 上。

模块能做的，是在 61 天窗口内发现「亏损腿」和「同一标的的新开仓或买股」时打标记，把判断交给使用者和税务专业人士。模块不要自动禁扣亏损，也不要改成本。

## 10. Section 1256：哪些期权按 60/40 年末计价

### 10.1 规则

§1256 合约在年末持有时，视为在当年最后一个交易日按公允价值卖出，盈亏计入当年；之后真正平仓时，按已计入的部分调整（§1256(a)(1)、(2)，[26 U.S.C. §1256](https://www.law.cornell.edu/uscode/text/26/1256)）。所有盈亏 40% 算短期、60% 算长期，"regardless of how long you actually held the property"（[60/40 rule](https://www.irs.gov/publications/p550#en_US_2025_publink100010338)）。到期、行权、被指派等结束方式同样适用（§1256(c)(1)）。

### 10.2 哪些期权是 §1256 合约

§1256 合约包括 "nonequity option"。nonequity option 是 "any listed option which is not an equity option"（§1256(g)(3)）。equity option 是买卖 "stock" 的期权，或价值取决于股票或窄基指数的期权（§1256(g)(6)）。Pub 550 说 nonequity option 包括 "broad-based stock index options"，并以标普 500 指数为例（[Nonequity option](https://www.irs.gov/publications/p550#en_US_2025_publink100010330)）。

| 期权 | 分类 | 依据 |
|---|---|---|
| SPX（标普 500 指数期权） | nonequity option，是 §1256 合约，60/40，年末计价 | Pub 550 点名标普 500 指数 |
| 其他宽基指数期权（如 NDX） | 只要 SEC 认定指数为宽基，就是 nonequity option | Pub 550 [Cash-settled options](https://www.irs.gov/publications/p550#en_US_2025_publink100010331)。具体哪个指数是否宽基，没有逐一核对，**未证实** |
| 个股期权 | equity option，不是 §1256 合约 | §1256(g)(6)(A)；§1.6045-1(m)(4)(iv) Example 2 写明单一公司股票的期权 "is an equity option described in section 1256(g)(6)" |
| QQQ、SPY 等 ETF 期权 | 按法条文字是「买卖 stock 的期权」，行权交割的是 ETF 份额，归 equity option，不是 §1256 合约 | **推论**。IRS 没有逐个产品的清单，第三方资料也这样说（TradeLog："the IRS does not provide a comprehensive product-by-product list"）。最终以券商 1099-B 的归类为准 |

所以 QQQ、SPY 的期权和个股期权一样，按第 3 到 9 节处理。卖方短期，买方看持有期，也没有年末计价。SPX 期权按本节处理。

### 10.3 算例

2026-12-01 BTO 1 张 SPX put，成本 $3,000。2026-12-31（当年最后一个交易日）市值 $2,400。2027-01-08 STC 收 $2,700。

| 税年 | 计入的盈亏 | 长期 60% | 短期 40% |
|---|---|---|---|
| 2026 | 年末计价 2,400 − 3,000 = −600 | −360 | −240 |
| 2027 | 平仓 2,700 − 2,400 = +300 | +180 | +120 |

链视图只看到 −300 一个数。税务视图要用到年末那天的市值，所以模块要在每年最后一个交易日给仍持有的 §1256 期权落一次收盘价快照。这是行情事实，不是账。

**§1256 期权的行权。** §1234(c)(1) 规定 §1256 合约期权行权时确认盈亏。SPX 是现金结算，不交割股票。

**wash sale 是否适用于 §1256 合约。** 读过的 IRS 原文没有直接说。Pub 550 只说跨式与 wash sale 的协调规则不适用于 "a straddle consisting only of section 1256 contracts"（[Exceptions](https://www.irs.gov/publications/p550#en_US_2025_publink100010665)）。第三方资料说 wash sale 不适用，**未证实**。

**券商怎么报。** §1256 期权在 1099-B 的 8 到 11 栏汇总报一个年度总数，不逐笔报（第 13 节）。

## 11. 多账户分配

一笔订单分配到几个账户，税务上就是每个账户各自的成交和各自的税务批次（lot）。依据：

- 券商按账户计算成本。成本基础的起点是证券 "acquired in an account" 那天的初始成本，券商 "not required to consider transactions or events occurring outside the account"（[Treas. Reg. §1.6045-1(d)(6)(i)](https://www.law.cornell.edu/cfr/text/26/1.6045-1)；[Instructions for Form 1099-B, Adjusted basis](https://www.irs.gov/instructions/i1099b#en_US_2026_publink1000283170)）。
- 均价法逐账户适用，"you may not average together the basis of identical stock held in separated accounts"（1099-B 说明 [Average basis method](https://www.irs.gov/instructions/i1099b#en_US_2026_publink1000283153)；§1.1012-1(e)(10)）。均价法只适用于基金（RIC）份额和股息再投资计划的股票，不适用于期权和个股。
- 一张确认单里同一天分几次成交的同一股票，按均价算成本，除非纳税人书面要求按实际价格（§1.1012-1(c)(1)(ii)）。分到不同账户后，每个账户有自己的确认单（**推论**）。

但纳税人层面的规则跨账户适用：

- wash sale 看纳税人本人、配偶和 IRA 的所有账户（第 9 节）。
- 跨式看纳税人本人和配偶持有的所有仓位（第 7 节）。

**对模块的含义：**

- 每一行成交、每一个事件都要带账户。分配到 3 个账户的订单存 3 行成交，用同一个订单编号串起来。
- 佣金和费用按券商确认单上每个账户分到的数额记，不要模块自己分摊。
- 指派按账户发生。同一订单的几个账户，可能只有一部分被指派。这一点是**推论**，依据是券商按账户报事件；券商内部怎么把指派分给客户账户，没有读到原文，**未证实**。
- 账户要带「税务归属人」和「账户税务类型」（应税账户或 IRA）。wash sale 和跨式按归属人汇总，1099-B 对账按账户。
- 交易链建议按账户建。跨账户的「同一笔订单」只用订单编号做展示上的关联。这是设计建议，不是税法要求。

## 12. 佣金和费用

| 情形 | 处理 | 依据 |
|---|---|---|
| BTO 买期权的佣金和费用 | 加进期权成本 | §1.6045-1(m)(4)(ii)：买入期权的成本是 "the premium paid plus any costs (for example, commissions)"；Pub 550 [Stocks and Bonds](https://www.irs.gov/publications/p550#id599)：成本是 "purchase price plus the costs of purchase, such as commissions" |
| STO 卖期权的佣金和费用 | 从收到的权利金里减掉 | 1099-B 说明 [Box 1d](https://www.irs.gov/instructions/i1099b#id42)："You must reduce the proceeds by commissions and transfer taxes related to the sale" |
| BTC、STC 平仓的佣金和费用 | BTC 加进买回成本；STC 从卖出所得里减掉 | Pub 550 [Amount realized](https://www.irs.gov/publications/p550#en_US_2025_publink100010429)：所得是 "everything you receive ... minus your expenses related to the sale" |
| 被指派的 put（买入股票）收的指派费 | 加进股票成本 | Pub 550 Stocks and Bonds（**推论**：指派费按买股成本处理） |
| 被指派的 call（卖出股票）收的指派费 | 从卖股所得里减掉 | Pub 550 Amount realized（**推论**） |
| 期权被指派时，开仓时的佣金 | 净权利金（扣过佣金后）进股票成本或卖股所得 | **推论**：§1.6045-1(m)(4)(i) 要求券商 "adjust the basis of the acquired asset or the gross proceeds amount as appropriate to account for any payment related to the option, including the premium" |

监管费、交易所费、OCC 清算费、SEC 费这些小额收费，原文没有分别规定，**未证实**。按交易成本处理是常见做法。模块应原样存每一类费用，不要合并成一个数，以便对上 1099-B。

## 13. Form 1099-B：券商报什么，和链视图哪里不同

模块要**对上** 1099-B，而不是另立一套账。1099-B 是券商报给 IRS 的数，Form 8949 以它为起点，有出入时在 8949 上调整（[Instructions for Form 8949](https://www.irs.gov/instructions/i8949)："always report the proceeds (sales price) shown on the form ... If any correction or adjustment to these amounts is needed, make it in column (g)"）。

### 13.1 券商对期权的报法

- **2014 年起开的期权是 covered security**，券商要报成本（[covered security](https://www.irs.gov/instructions/i1099b#en_US_2026_publink100014775)："Certain debt instruments or options that are specified securities acquired for cash in an account after 2013"）。
- **到期、行权、平仓都算 "sale"**（[Closing transactions](https://www.irs.gov/instructions/i1099b#en_US_2026_publink1000104107)："A closing transaction is a lapse, an expiration, a settlement, an abandonment, or other termination of a position"）。
- **卖出期权的平仓。** §1.6045-1(m)(4)(iv) Example 1：收权利金 $100，花 $110 买回平仓，券商报 "gross proceeds ... -$10 ... and report $0 in the basis box"，并报短期损失。所以 1099-B 上卖方平仓那一行，「所得」是净额（可能是负数），「成本」是 0。不同券商的版面可能不同（**未证实**）。
- **被指派或行权（实物交割）。** 券商 "must adjust the basis of the acquired asset or the gross proceeds amount as appropriate to account for any payment related to the option, including the premium"（§1.6045-1(m)(4)(i)）。被指派的 put 会体现在新股票批次的成本里，被指派的 call 体现在卖股所得里，并在 Box 6 勾选（[Box 1d](https://www.irs.gov/instructions/i1099b#id42)）。
- **§1256 期权。** 按期货的办法汇总报在 8 到 11 栏，包括当年平仓的盈亏和年初、年末的未实现盈亏（§1.6045-1(m)(3)；[Boxes 8 Through 11](https://www.irs.gov/instructions/i1099b#id54)）。
- **Box 1c 报成交日**，不报交割日（[Box 1c](https://www.irs.gov/instructions/i1099b#id41)）。

### 13.2 1099-B 不管、模块要另外标记的事

| 事项 | 1099-B 怎么做 | 依据 |
|---|---|---|
| Roll 前几腿 | 每腿一行，各自是短期平仓。不会把它们并进股票成本 | 和第 6 节税务视图一致。链视图的「有效成本」不会出现在 1099-B 上，也不该出现 |
| 被指派的股票成本 | 只减最后一腿的权利金 | §1.6045-1(m)(4)(i)；和第 6 节税务视图一致 |
| wash sale | 只在同一账户、同一 CUSIP 时必须报，跨账户、股票和期权之间、不同期权系列之间都可以不报 | [Box 1g](https://www.irs.gov/instructions/i1099b#id46)："if both the sale and purchase transactions occur in the same account with respect to covered securities with the same CUSIP number"。Pub 550："you cannot deduct a loss from a wash sale even if it is not reported on Form 1099-B" |
| 跨式的损失递延和持有期调整 | 券商不必套用 §1092 | 1099-B 说明 Adjusted basis 和 [Box 2](https://www.irs.gov/instructions/i1099b#id47)："You are also not required to apply ... section 1092 (straddles)" |
| QCC 的持有期暂停（§1092(f)） | 不在券商必须调整的范围内（属于 §1092） | 同上（**推论**） |
| 账户之间 | 每个账户各自报 | §1.6045-1(d)(6)：券商不看账户以外的交易 |

### 13.3 对账的做法

模块按账户、按税年从原始记录算出税务视图，逐行和 1099-B 比对。差异只应落在四类：

1. 跨式规则引起的递延或持有期变化（券商不处理）。
2. 跨账户、股票和期权之间的 wash sale（券商不处理）。
3. 费用归类或四舍五入的小额差。
4. 券商报错。纳税人在 Form 8949 用代码 B 调整成本（[Instructions for Form 8949](https://www.irs.gov/instructions/i8949)，表格 "How To Complete Form 8949, Columns (f) and (g)"），权利金没反映在 1099-B 上时用代码 E（Pub 550 [How to report](https://www.irs.gov/publications/p550#en_US_2025_publink100010626)）。

落不进这四类的差异，说明原始记录缺了或错了，要回头修原始记录，不要在派生数上打补丁。

另外，Pub 550 说卖出的期权到期时，在 Form 8949 上把到期日填在 (b) 栏（取得日），在 (e) 栏写 "Expired"（同上，How to report）。所以 1099-B 和 8949 上卖方期权那一行的「取得日」「卖出日」可能和直觉相反。模块对账时按合约和金额匹配，不要按日期栏位匹配。

## 14. 对数据模型的含义

### 14.1 原始记录：只存发生过的事实

模块只存下面这些记录。它们都是券商确认单、成交邮件、对账单或行情里能看到的事实，写进去后不改（更正用新记录冲销）。

**账户（Account）**

| 字段 | 说明 |
|---|---|
| `account_key` | 模块内部的匿名键。仓库是公开的，不存真实账号 |
| `tax_owner_key` | 税务归属人的匿名键。wash sale 和跨式按它汇总 |
| `tax_type` | 应税账户或 IRA |

**合约（Instrument）**

| 字段 | 说明 |
|---|---|
| `underlying` | 标的代码，如 QQQ |
| `underlying_kind` | 个股、ETF 或指数 |
| `option_symbol` | OCC 期权代码。股票为空 |
| `right` | put 或 call |
| `strike`、`expiry` | 行权价和到期日 |
| `multiplier`、`deliverable` | 合约乘数和交割物。公司行动调整后的合约会变 |
| `settlement` | 实物交割或现金交割 |
| `exercise_style` | 美式或欧式 |
| `tax_class` | equity option 或 nonequity option（§1256）。取自合约类别，用 1099-B 核对 |

**成交（Fill）**。一个账户的一次成交一行。

| 字段 | 说明 |
|---|---|
| `fill_id` | 唯一键 |
| `order_id` | 券商订单编号。一笔订单分到几个账户时，几行共用它 |
| `account_key` | 账户 |
| `instrument` | 合约 |
| `side` | 期权用 STO、BTO、BTC、STC；股票用 BUY、SELL |
| `qty` | 张数或股数 |
| `price` | 每股价格 |
| `trade_date`、`trade_time` | 成交日和时间（美东）。税年、持有期、wash sale 窗口都用它 |
| `settle_date` | 交割日。只用于现金对账，不决定税年 |
| `commission`、`fees` | 每一类费用分开存，币种 USD |
| `source` | 来源：成交邮件、确认单或对账单 |
| `caused_by_event` | 由指派或行权产生的股票成交，指向那个事件 |

**事件（Event）**。不由成交产生的结束。

| 字段 | 说明 |
|---|---|
| `event_id`、`account_key`、`instrument`、`qty` | 同上 |
| `type` | EXPIRE、ASSIGNED、EXERCISED、CASH_SETTLED |
| `event_date` | 券商报的日期 |
| `fees` | 指派费、行权费 |

**链和意图**

| 记录 | 字段 | 说明 |
|---|---|---|
| 链成员（ChainLeg） | `chain_id`、`fill_id` 或 `event_id`、`seq` | 一条链属于一个账户 |
| Roll 组（RollGroup） | `roll_id`、平仓那行、开仓那行、`kind`（Calendar、Diagonal、Combo） | 只服务链视图。税务视图不读它 |
| 意图变更（IntentChange） | `chain_id`、意图、时间、原因 | 和税务无关 |

**税务相关的选择和快照**

| 记录 | 说明 |
|---|---|
| 批次指定（LotSelection） | 卖股时告诉券商卖哪一批。按 §1.1012-1(c)(8)，最晚在交割日前做出才有效，所以要带时间 |
| 跨式标识（StraddleIdentification） | 只在使用者选择已标识跨式时存。必须当天收盘前，带时间戳 |
| 行情快照（MarketSnapshot） | 卖 CC 时的前一日收盘价、当天开盘价、可用行权价（判断 QCC）；每年最后一个交易日仍持有的 §1256 期权和跨式仓位的收盘价（算年末计价和未实现收益） |
| 1099-B 导入（BrokerReport） | 券商年度报表逐行导入，只作对账的参照，不参与计算 |

### 14.2 派生数：每次都从原始记录重算，不另立账本

下面这些数都可以由原始记录按本文规则算出来。可以缓存，但缓存必须能删掉重算，而且不能被手工改。

| 派生数 | 归哪个视图 |
|---|---|
| 每腿的已实现盈亏、长短期、所属税年 | 税务 |
| 股票批次的调整后成本（含被指派的权利金、wash sale 加回） | 税务 |
| 持有期起点和长期日期（含跨式和 QCC 的暂停） | 税务 |
| QCC 判定、跨式标记、wash sale 标记 | 税务 |
| §1256 年末计价和 60/40 拆分 | 税务 |
| 链的累计权利金、净收权利金、有效成本 | 链视图 |
| 链的成败（按意图） | 链视图 |
| 模块数和 1099-B 的差异及分类 | 对账 |

**不变量：**

- 两个视图读同一组成交和事件。任何一个视图都不往原始记录里写数。
- 链视图的有效成本永远不写成股票批次的成本。
- 税务视图不读 Roll 组。Roll 组删掉，税务结果不变。
- 同一税年里一条链全部结束时，链视图的总盈亏等于税务视图里这条链各行之和（第 6.2 节的恒等式）。跨年、wash sale、跨式递延只改变时点和性质。这条可以写成自动检查。
- 模块不自动禁扣 wash sale 亏损、不自动递延跨式亏损。它只打标记，附上依据，交给使用者和税务专业人士。

## 15. 未能证实的点

读过的原文里找不到依据，下面这些不能当结论用：

1. 被指派时股票的「买入日」具体取哪一天。本文按券商确认单处理。
2. 保护性 put 上，§1233（put 视为卖空）和 §1092 跨式规则哪个优先。§1233(e)(2)(A) 排除了适用 §1092(b) 的仓位，但逐条结论没找到。
3. 远价外的卖出 call 是否「实质性降低」持有股票的风险，从而构成跨式。法条有推定，但推定可以反驳，属事实判断。
4. QQQ、SPY 等 ETF 上的 CC 能否算合格备兑 call（"stock" 是否包括 ETF 份额）。
5. QQQ、SPY 期权是 equity option 而不是 §1256 合约。这是按法条文字的推论，IRS 没有产品清单。以券商 1099-B 为准。
6. NDX 等 SPX 以外的指数期权是否宽基。没有逐一核对 SEC 的认定。
7. 两张同一标的、不同行权价或到期日的期权是否「实质相同」（影响 Roll 的 wash sale）。
8. 卖出 put 平仓亏损后 30 天内买入或被指派股票，是否构成 wash sale。
9. wash sale 的替换仓位是卖出的期权（没有成本）时，被禁的亏损怎么处理。
10. Rev. Rul. 85-87 的思路能否延伸到「期权亏损后再卖深度价内 put」。该裁定处理的是股票亏损。
11. §1256 合约是否适用 wash sale 规则。
12. 监管费、OCC 费、SEC 费等小额收费的税务归类。
13. 券商在 1099-B 上对卖方期权平仓行的具体版面（所得记净额、成本记 0，还是分开记）。条例示例是前者。
14. 券商把指派分配到客户账户的方式。
15. 亏损卖股后 30 天内卖出不是深度价内的 put，是否触发 wash sale。

## 16. 免责声明

本文是为 option-ta 的记账设计整理的规则说明，不是税务、法律或投资建议。本文只讲美国联邦所得税的一般规则，不涵盖州税、做市商、§475 交易者、IRA 内部损益和外币。法条、条例和 IRS 出版物会修订，引用的是 2026-11-16 能读到的版本。具体申报以券商 Form 1099-B 和税务专业人士的意见为准。算例中的标的、价格和日期都是虚构的。

## 参考资料

以下是本文实际读过的全部出处。

**IRS 出版物和表格说明**

- IRS Publication 550 (2025), Investment Income and Expenses. https://www.irs.gov/publications/p550
  - Options：https://www.irs.gov/publications/p550#id865
  - Puts and Calls：https://www.irs.gov/publications/p550#id874
  - Holders of puts and calls：https://www.irs.gov/publications/p550#en_US_2025_publink100010628
  - Put option as short sale：https://www.irs.gov/publications/p550#en_US_2025_publink100010629
  - Writers of puts and calls：https://www.irs.gov/publications/p550#en_US_2025_publink100010630
  - Table 4-3. Puts and Calls：https://www.irs.gov/publications/p550#id879
  - Straddles：https://www.irs.gov/publications/p550#id883
  - Loss Deferral Rules：https://www.irs.gov/publications/p550#id888
  - Qualified covered call options and optioned stock：https://www.irs.gov/publications/p550#en_US_2025_publink100010648
  - Special year-end rule：https://www.irs.gov/publications/p550#en_US_2025_publink100010651
  - Coordination of Loss Deferral Rules and Wash Sale Rules：https://www.irs.gov/publications/p550#id901
  - Holding Period and Loss Treatment Rules（跨式）：https://www.irs.gov/publications/p550#id905
  - Wash Sales：https://www.irs.gov/publications/p550#id854
  - Holding Period：https://www.irs.gov/publications/p550#id785
  - Section 1256 Contracts Marked to Market：https://www.irs.gov/publications/p550#id526
  - Stocks and Bonds（成本）：https://www.irs.gov/publications/p550#id599
  - Amount realized：https://www.irs.gov/publications/p550#en_US_2025_publink100010429
- Instructions for Form 1099-B (2026). https://www.irs.gov/instructions/i1099b
- Instructions for Form 8949 (2025). https://www.irs.gov/instructions/i8949

**法条（26 U.S.C.，Cornell LII）**

- §1091 Loss from wash sales of stock or securities：https://www.law.cornell.edu/uscode/text/26/1091
- §1092 Straddles：https://www.law.cornell.edu/uscode/text/26/1092
- §1222 Other terms relating to capital gains and losses：https://www.law.cornell.edu/uscode/text/26/1222
- §1233 Gains and losses from short sales：https://www.law.cornell.edu/uscode/text/26/1233
- §1234 Options to buy or sell：https://www.law.cornell.edu/uscode/text/26/1234
- §1234A Gains or losses from certain terminations：https://www.law.cornell.edu/uscode/text/26/1234A
- §1256 Section 1256 contracts marked to market：https://www.law.cornell.edu/uscode/text/26/1256

**条例（26 CFR，Cornell LII）**

- §1.1012-1 Basis of property：https://www.law.cornell.edu/cfr/text/26/1.1012-1
- §1.1091-1 Losses from wash sales of stock or securities：https://www.law.cornell.edu/cfr/text/26/1.1091-1
- §1.1092(b)-2T Treatment of holding periods and losses with respect to straddle positions：https://www.law.cornell.edu/cfr/text/26/1.1092(b)-2T
- §1.1092(c)-1 Qualified covered calls：https://www.law.cornell.edu/cfr/text/26/1.1092(c)-1
- §1.1092(c)-2 Equity options with flexible terms：https://www.law.cornell.edu/cfr/text/26/1.1092(c)-2
- §1.1092(c)-4 Definitions：https://www.law.cornell.edu/cfr/text/26/1.1092(c)-4
- §1.6045-1 Returns of information of brokers and barter exchanges（(d)(6) 和 (m)）：https://www.law.cornell.edu/cfr/text/26/1.6045-1

**裁定和第三方资料**

- Rev. Rul. 85-87, 1985-1 C.B. 268（Tax Notes 收录页，只读到标题、事实摘要和结论）：https://www.taxnotes.com/research/federal/irs-guidance/revenue-rulings/loss-on-corporate-stock-sale-is-not-allowed-if-in/dbsv
- TradeLog, ETFs and ETNs: Tax Treatment and Reporting for Traders（第三方，只用于「IRS 没有 ETF 期权产品清单」这一点）：https://tradelog.com/education/etfs-etns/
