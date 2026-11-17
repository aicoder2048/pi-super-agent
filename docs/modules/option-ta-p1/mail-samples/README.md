# option-ta 成交邮件样例（P1，2026-11-17）

`fills` feed 的测试素材。这里的 4 封信是照真实成交邮件的结构重新生成的虚构邮件：人名、地址、券商、账户短码、标的、数量、价格都是编的，地址只用 `example.com`、`example.net`。原文不进仓库。本文只描述结构。解析规则以 `../../option-ta-spec.md`「成交邮件（`fills`）」一节为准。

| 文件 | 编号 | 测什么 |
|---|---|---|
| `cc-open-put-close-unfilled.eml` | 样例 1 | 一串往来里两张表只取最新的；空行不算成交 |
| `csp-partial-underlyings.eml` | 样例 2 | 一只标的成交，另一只没有、表里也没有它的行 |
| `mixed-with-stock-and-working.eml` | 样例 3 | 股票行跳过；挂单不算成交；描述里带 `&` |
| `cp1252-executed-at-nested.eml` | 样例 4 | windows-1252 和 quoted-printable；多一列 `Executed At`；表套表 |

每封信配一份 `<名字>.expected.json`：期望解析出的成交行（`fills`）和跳过的行（`skipped`）。它是按虚构数据直接写出的草稿，不是解析器的输出。成交行的 `id` 按 spec「订单键和 `id`」拼成（`<订单键>:cum<累计成交张数>`）；这批样例都是整单成交、库里没有已记的行，所以每行的张数就是 `cum`，价格就是均价。

## 1. 这批邮件是什么

- 不是券商系统自动发的成交确认单。是券商交易台（trade desk）的人工回信：使用者发邮件下单，交易台在回信里贴一张「非正式更新」表格，说明哪些成交了、哪些还挂着。表格下面有交易台的签名和免责声明，声明里写明「不是正式确认单，以对账单为准」。
- 4 封都是手动转发来的，主题前加了 `[SAMPLE] FW:`。转发是内联的：没有 `message/rfc822` 附件，原邮件头写在正文里。生产上不走手动转发，走工作邮箱的「重定向」规则，保留交易台做发件人（spec「成交邮件（`fills`）」）。做 fixture 时把 `from` 写成交易台的虚构地址。
- 每封都是一整串往来（2 到 5 封信），最新的在最上面。

## 2. MIME 结构（4 封一样）

```
multipart/related
├── multipart/alternative
│   ├── text/plain
│   └── text/html
└── image/png 或 image/jpeg（inline，签名里的图，靠 Content-ID 引用）
```

| 样例 | text 部分字符集和编码 | 换行 | inline 图片 | 往来封数 | 交易表张数 |
|---|---|---|---|---|---|
| 1 | utf-8，base64 | CRLF | 1 张 png | 5 | 2 |
| 2 | utf-8，base64 | CRLF | 1 张 png | 4 | 1 |
| 3 | utf-8，base64 | CRLF | 4 张 jpeg + 1 张 png | 2 | 1 |
| 4 | windows-1252，quoted-printable | LF | 1 张 png | 2 | 1（套在一张外层表里） |

- 顶层头字段：`Received`、`Return-Path`、`From`、`To`、`Subject`、`Thread-Topic`、`Thread-Index`、`Date`、`Message-ID`、`References`、`In-Reply-To`、`Accept-Language`、`Content-Language`、`X-MS-*` 若干、`MIME-Version`、`Content-Type`。没有 DKIM、ARC。
- 顶层 `From` 和 `To` 都是使用者自己。交易台的地址只出现在正文里的转发头中。
- 样例 2 的 `Subject` 含长破折号，用 RFC 2047 的 B 编码。
- 正文里的非 ASCII 字符：全角空格 U+2003（签名）、长破折号、弯引号（包括 `"…”` 这种左右不配对的写法）、项目符号 `•`。样例 4 用 windows-1252，这些字符按 cp1252 解码才对。

## 3. 正文版式

### 转发头和引用头

纯文本里，每封被引用的信以一段头开始，两种写法混用：

- 微软邮件客户端移动版：前面一行 32 个下划线，然后 `From:`、`Date: Thursday, March 5, 2026 at 16:20`、`To:`、`Cc:`、`Subject:`。
- 微软邮件客户端桌面版：`From:`、`Sent: Thursday, March 5, 2026 9:12 AM`、`To:`、`Cc:`、`Subject:`。`Cc` 里的人用分号隔开，名字可能带括号后缀。

HTML 里，移动版是 `div#mail-editor-reference-message-container` 加 `<hr>` 加 `<b>From: </b>` 一行一个字段；桌面版是带上边框的 `div`，`<b>From:</b>` 后面跟值。

### 交易表

HTML 是微软邮件客户端生成的 `table.MsoNormalTable`，每格一个 `td.MsoNormalTable > p.MsoNormal > span`，表头格多一层 `<b>`。列名（原样）：

`Account`、`Side`、`Position`、`Security`、`Security Description`、`Exe Qty`、`Avg Price`、`Open Qty`、`Price Instructions`、`Trade Date`、`Settlement Date`，样例 4 多一列 `Executed At`。

各列的写法：

| 列 | 写法 | 例（虚构） |
|---|---|---|
| Account | 账户短码，不是完整账号。两种形状：4 个大写字母加 4 个小写字母，或 4 个大写字母加 1 个小写字母加 4 位数字 | `QRSTalfa`、`QRSTa1001` |
| Side | `Sell Put`、`Buy Put`、`Sell Call`、`Buy Call`；股票行只有 `Sell` | |
| Position | `Open` 或 `Close`；股票行为空 | |
| Security | 标的代码 | `AAPL` |
| Security Description | 期权：`<发行人全名> PUT|CALL MM/DD/YYYY @ <行权价>`；股票：发行人全名，可能带 ` - ADR` | `APPLE INC CALL 03/20/2026 @ 250` |
| Exe Qty | 已成交数量，可能带千分位逗号；没成交为空 | `12`、`4,500` |
| Avg Price | 成交均价，2 到 4 位小数；没成交为空 | `3.15`、`24.1375` |
| Open Qty | 还挂着的数量；已全部成交或已失效为空 | `15` |
| Price Instructions | `<限价> Limit` | `3.15 Limit` |
| Trade Date、Settlement Date、Executed At | `DD-Mon-YYYY` | `05-Mar-2026` |

一行的状态由三列数量决定：

| Exe Qty | Open Qty | 含义 |
|---|---|---|
| 有 | 空 | 成交（这批样例里都是整单成交） |
| 空 | 有 | 挂单中，不是成交 |
| 空 | 空 | 没成交、单已失效 |
| 有 | 有 | 部分成交（样例里没见到，列的语义允许）。照记增量，见 spec「订单键和 `id`」 |

## 4. 每封的内容和动作（按术语表）

| 样例 | 往来 | 最新一张表 | 动作 |
|---|---|---|---|
| 1 | 先下单买平 put；后来改价并加开备兑 call；交易台先回「已挂单」表，再回「最终」表；使用者最后回一句「继续挂」 | 6 行：4 行 call 成交，2 行 put 空着 | STO call（CC）4 行，两个行权价、两个账户；BTC put 2 行没成交 |
| 2 | 下单卖开两只标的的 put；交易台回「已挂单」（无表）；使用者问成交没有；交易台回表 | 2 行，都成交 | STO put（CSP）2 行；另一只标的的单没成交，表里没有它的行 |
| 3 | 一封信里下三类单：按批次卖股票做税损、买平 call（GTC）、卖开 put；交易台回表 | 12 行 | STO put 3 行成交；BTC call 3 行挂单中；股票 Sell 6 行成交 |
| 4 | 下单卖开 put，三个账户；交易台回「已成交」表 | 3 行，均价高于限价 | STO put 3 行成交，带 `Executed At` |

没见到的：BTO、STC、Roll 的成对单、到期作废、指派、行权。样例 3 的下单信里用文字提到某批股票来自 put 被指派，表里没有事件行。

## 5. 解析要点和坑

1. **纯文本分不清数量列。** 2026-11-17 时宿主 `mail` 连接器（`src/modules/connectors/letter.ts` 的 `bodyText`）有 `text/plain` 就只交纯文本。纯文本里交易表被压成一格一行，空格子直接没了，分不出一个数字是 `Exe Qty` 还是 `Open Qty`。使用者已定：连接器交出 HTML 版正文（宿主改动另有 PR），handler 优先按 HTML 的列名取值，纯文本只作后备。后备按规律推：描述行之后、`<价> Limit` 之前，两个值是「成交量 + 均价」，一个整数是「挂单量」，没有值是没成交，三个值是部分成交。一旦出现 `Market` 单或列顺序变了就会错，推不出来就进 `skipped`、问使用者。
2. **一串往来里可能有好几张表**（样例 1 有「已挂单」和「最终」两张）。只取最新一张，也就是 HTML 文档顺序的第一张；旧表只作参考。再靠 `id`（订单键加累计成交量）去重，防止同一张表进来两次。
3. **按列名取值，不按列号。** 样例 4 多一列 `Executed At`，以后可能还会多列或少列。
4. **样例 4 的交易表套在外层表的一个格子里。** 找表时要找「第一行是 `Account` 的那张」，不能只看最外层。
5. **转发包装。** 这几封样例的顶层 `From` 是使用者自己，不是交易台。`brokers` 名单按顶层 `From` 过滤，手动转发来的信一封都收不到。所以生产上走「重定向」（保留原发件人），名单写交易台的发信地址，见 spec。
6. **股票行。** `Position` 为空、描述里没有 `PUT`/`CALL`。第一版不记普通股票买卖（术语表「被指派产生的股票」），handler 跳过这些行并记下跳过原因。
7. **缺的字段。** 表里没有订单号、成交时间、佣金和费用。`trade_time`、`order_id`、`commission`、`fees` 只能留空；税务视图要成交时间时，标「待确认」或之后用正式确认单补。表里也没有金额列，金额由 `张数 × 均价 × 100` 算。
8. **账户。** 表里是账户短码，不是账号。信里还会出现「账号尾号四位」和账户名。handler 先原样记短码 `account_ref`；映射成匿名 `account_key` 是下一步，映射表放私密集合。真实短码不进公开仓库，样例里的短码是编的。
9. **日期格式三种并存。** 表里 `DD-Mon-YYYY`；描述里 `MM/DD/YYYY`；主题和正文里 `YYYY/MM/DD`、`YYYY-MM-DD`、`MM/DD` 都有。到期日以描述里的为准。
10. **行权价可能带小数**（如 `@ 252.5`），描述里的发行人名可能含空格、连字符和 `&`（HTML 里写成 `&amp;`）。按「最后一个 `PUT|CALL` + 日期 + `@`」从右往左切，比从左边猜发行人名稳。
11. **OCC 代码只在使用者原信里出现**（`AAPL260320C00250000` 这种连写形状），表里没有。handler 应当由「标的 + 到期 + 方向 + 行权价」自己拼出 OCC 代码。
12. **字符集。** 要按 part 的 `charset` 解码；样例 4 的 windows-1252 用 UTF-8 解会把 `•` 解坏。`letter.ts` 的 `decodeText` 已经按 charset 解码。
13. **免责声明和签名很长**，纯文本正文 4 到 11 KB，在连接器 64 KB 正文上限以内。原 HTML 正文 35 到 93 KB，样例 1 的 HTML 约 70 KB，超过 `letter.ts` 纯文本的 64 KB 上限。交 HTML 的宿主 PR 要单独定 HTML 的上限，或保证截断时留住第一张交易表。

## 6. 做成 `fills` feed fixtures 的建议形状

P3 照下面的形状把每封信做成一个 fixture，文件名沿用上表的名字。

`fills` 是 mail 连接器上的 feed，fixture 应当照 `docs/modules/examples/mail/feeds/inbox/fixtures/*.json` 的形状：`input.items` 是连接器交出的 `Letter`（`id`、`threadId`、`messageIdHeader`、`from`、`subject`、`date`、`body`、`attachments`），再加期望的行。

建议每封一对文件：

```
feeds/fills/fixtures/
  cc-open-put-close-unfilled.json   # 样例 1：两张表只取最新、空行不算成交
  csp-partial-underlyings.json      # 样例 2：一只标的成交、另一只没有
  mixed-with-stock-and-working.json # 样例 3：股票行跳过、挂单不算成交
  cp1252-executed-at-nested.json    # 样例 4：字符集、多一列、表套表
```

每个 fixture：

```json
{
  "input": { "items": [ { "id": "s-1", "from": { "name": "EXB Desk", "address": "exb.desk@example.net" }, "subject": "...", "body": "<cc-open-put-close-unfilled.eml 的 text/plain>", "attachments": [] } ] },
  "expect": {
    "rows": [ { "id": "AAPL260320C00250000:STO:2026-03-05:QRSTalfa:cum12", "fill_id": "AAPL260320C00250000:STO:2026-03-05:QRSTalfa:cum12", "order_key": "AAPL260320C00250000:STO:2026-03-05:QRSTalfa", "account_ref": "QRSTalfa", "side": "STO", "instrument": { "underlying": "AAPL", "option_symbol": "AAPL260320C00250000", "right": "call", "strike": 250, "expiry": "2026-03-20", "multiplier": 100 }, "qty": 12, "partial_fill": false, "price": 3.15, "trade_date": "2026-03-05", "settle_date": "2026-03-06", "trade_time": null, "order_id": null, "commission": null, "fees": null, "source": "broker-email" } ],
    "skipped": [ { "reason": "not-filled", "account_ref": "LMNObeta" } ]
  }
}
```

- 宿主的 feed 样例今天只认 `input` 和 `responses`，`module check` 只查 handler 不抛异常、交回的格式对，不比对期望。`expect` 由 P3 的测试读来断言。
- 行字段对齐 tax memo 第 14.1 节的「成交（Fill）」表。`account_ref` 是邮件里的短码，映射成 `account_key` 是下一步的事。
- `id` 是 feed 交给宿主的去重键，宿主不把它存成字段。`fill_id` 是存进 `fills` 的文字字段，值和 `id` 相同，`record`、`ledger` 靠它认行。`order_key` 是 `id` 去掉 `:cum<n>` 的部分，handler 按它合计已记的张数和金额。`partial_fill` 是这一行在表里 `Open Qty` 还有没有值，这批样例都是 `false`。
- `skipped` 把「为什么不是成交」写成断言（`working-order`、`not-filled`、`stock-trade-out-of-scope`、`duplicate-order-key`、`unparsed`，含义见 spec），这样漏判、多判都会让测试失败。
- `<名字>.expected.json` 是按这个形状写的草稿，`fills` 一栏到时候改名成 feed 的 `records`。
- 连接器交出 HTML 以后，HTML 版本放进它的字段（字段名等宿主那个 PR 定），期望不变。HTML 和纯文本各跑一遍，能直接比出纯文本推断法错在哪里。

## 7. 虚构样例和原文的差别

- 交易表的 HTML 标签、class、style 照原文的样子写，列名、单元格写法、空格子的写法（`<td>` 里没有 `<p>`）、表套表都保留。
- 表外的部分（转发头、引用头、签名、免责声明）按原文的版式重写，文字是虚构的、比原文短。原文的长免责声明、品牌链接、外部图片链接都没有保留。
- inline 图片换成纯灰色的小图，类型、文件名形状、Content-ID 形状、在 HTML 里用 `cid:` 引用的方式保留。
- 样例 3 的描述里多了一个 `&`（`S&P`），原文没有。这是有意加的坑，见第 5 节第 10 条。
- 原文的 `Thread-Index`、`Received`、`Message-ID` 等可追溯头都换成了虚构值。
