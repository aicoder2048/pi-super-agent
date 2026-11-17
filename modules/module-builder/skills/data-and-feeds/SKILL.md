---
name: data-and-feeds
description: 数据集合（data/）、feed（feeds/）和密钥怎么写，带一个 mail 连接器的示例包。写或改这几样之前读
---
# 数据集合、feed 和密钥

模板里没有这几样。照着写的现成包：`$PSA_REPO/docs/modules/examples/mail/`（mail feed、发件人名单；它的名单是 `shareable`，存成交这类私密往来的模块写 `private`），`$PSA_REPO/docs/modules/examples/stock-ta/`（自己取数据的 feed、带密钥的工具）。检查的原话在 `$PSA_REPO/src/modules/validate.ts`。

## 数据集合：`data/<名字>/collection.json`

- 必填 `title`、`kind`、`class`、`fields`。`kind` 是 `record`（一行一件事）或 `series`（按时间的序列，只有它能写 `watch`）。改名时写 `was`（旧名）。
- `fields` 的每个字段写 `type`（text、number、date、blob）和 `title`，可选 `unit`。字段名字母开头，只用字母、数字、下划线；不能叫 `id`，它是行的键；只差大小写的两个名字算同一个。
- `class` 是 `shareable` 或 `private`。存使用者私密内容的写 `private`：信件、成交、持仓、账户、发件人名单。拿不准就写 `private`。
- 包里有 `private` 集合，`module.json` 就不能在 `exports` 列工具（package-layout 的 `exports` 一节）。
- 集合的行存在宿主的 `data.db`，工具和 feed 的代码只读它，只往 `$PSA_MODULE_DATA/files/` 写文件。要写行：feed 用 `records`；任务里由专家调 `data` 工具，专家的 `uses` 写 `data/<名字>`。
- 已经存了数据的集合不改 `kind`，字段不改 `type` 和 `unit`。改名在新名字上写 `was`，集合和字段都可以。拿掉的集合和字段，存着的值留着、只是看不到。

## feed：`feeds/<名字>/feed.json`

- 必填 `title`。`connector`、`handler` 至少一个；`into`（写进本模块哪个集合）、`notice`（`{{名字}}` 取 notice 的 `fields`）至少一个。每条 notice 都交给幕僚长，是一次模型调用；只记账的 feed 只写 `into`，不写 `notice`。
- `handler` 是同一文件夹里的代码，例如 `index.ts`。只有 `handler`、没有 `connector` 的 feed 必须写 `every`（`30s`、`15m`、`6h`、`1d`）。`limit` 是一次最长跑多久，不写是 20 秒，最多 `10m`；要联网多次的 feed 写上。`when: "us-market-hours"` 只在美股交易时段跑。
- `reads` 列本模块的集合，那些行放进 handler 的 `input.rows`，每个集合最多 500 行，新的在前。`settings` 是对象，原样交给 `input.settings`。
- `line` 是发到 Telegram 的最多 3 行，只给 `into` 是 `private` 集合的 feed 用，只能用 `notice` 里有的 `{{名字}}`。`line` 放出的字段算非私密，也以非私密交给幕僚长：金额、成交、持仓、账户别放进去。

### handler

默认导出一个函数，收一个对象，回一个对象：

- 收：`items`（连接器送来的东西，例如 mail 的信）、`cursor`（上次交回的）、`now`（ISO 时间）、`settings`、`rows`（`reads` 的集合，每行 `{ id, from, fields }`，`id` 是宿主的行号）。
- 回：`records`（写进 `into` 的行，其余键必须是 `into` 的字段。每行带文字 `id`，它是这个 feed 的去重键：同一个 `id` 只写第一次，以后再交回就跳过，不覆盖。`id` 不进任何字段，以后要在 `rows` 里认出这一行，把它另存进一个字段）、`notices`（`{ id, fields, thread }`，`fields` 的值都是文字，`thread` 可选）、`cursor`（文字，下次原样送回）。`alerts`、`problem` 见 stock-ta 的 `feeds/quotes/index.ts`。
- 抛异常就是这一次失败，那句话只进宿主日志，使用者看不到。使用者要知道的事（缺 key、数据源坏了）回 `{ records: [], problem: { id, text } }`，`text` 写明缺什么、用什么命令补，见 stock-ta `feeds/quotes/index.ts` 的 `NO_KEY`。

### 样例：`feeds/<名字>/fixtures/<样例>.json`

- 每个文件是 `{ "input": {...}, "responses": {...} }`。`input` 盖掉 handler 收到的同名键，`settings` 按键合并。`responses` 按完整 URL 回 `fetch`，没列的 URL 直接报错，所以样例不联网。
- `module check` 每次都跑全部样例：handler 抛异常或交回的格式不对，检查就不过。检查不强制有样例，工坊的规矩是每个带 handler 的 feed 至少一个。
- 样例不给 `now` 就是跑检查的那一刻，用到 `now` 的 handler 样例都给 `now`。自己取数据的 feed 再给 `settings`、`rows` 和 `responses`，见 stock-ta 的 `feeds/quotes/fixtures/`。
- 工具的 `cases.json` 一样：联网的工具每条用例都写 `responses`，不写就真联网。读模块文件的工具用 `data` 指包里的夹具文件夹，见 stock-ta 的 `tools/structure/cases.json`。

## mail 连接器的 feed

宿主的 `mail` 连接器读使用者的 Gmail（ADR-0029），只把名单上发件人的信交给 handler。`items` 每封信有 `id`、`threadId`、`messageIdHeader`、`from`（`name`、`address`）、`replyTo`、`subject`、`date`、`snippet`、`body`、`attachments`。`body` 是纯文字；信里有 HTML 时另带 `html`（按 charset 解好的原文，最多 256 KB，不剥标签），没有就不带这个键。表格里的空格子只在 `html` 里分得清。`html` 以「[HTML 超过 256 KB，后面截掉了」结尾就是不全，最后几行别当真记账；抛错的话进日志，不要引用 `body` 或 `html`。检查要求：

- `"connector": "mail"`，必须有 `handler` 和 `every`。
- `into` 必须是 `private` 集合。
- `settings.senders` 写本模块一个集合的名字。那个集合要有文字字段 `address`（`a@example.com` 或 `@example.com`，不认通配符），可选 date 字段 `addedAt`、`removedAt`：划掉写 `removedAt`，不删行。不在包里直接写地址列表：包会进公开仓库。
- 不点名 Gmail 的密钥，授权归连接器。

## 密钥

- 工具在 `tool.json`、feed 在 `feed.json` 的 `secrets` 里点名，名字全大写，例如 `["POLYGON_API_KEY"]`。feed 要带 `handler` 才能点名。
- 宿主从模块自己的 `<状态目录>/modules-data/<模块>/.env` 取同名的值，放进进程的环境变量（ADR-0031）。代码读 `process.env["POLYGON_API_KEY"] ?? ""`。
- 缺 key 时宿主不报错：feed 拿到空串，工具拿不到这个变量。代码自己查：工具抛一句话，调用方会收到；feed 回 `problem`（上面 handler 一节）。两种都写明缺哪个、用 `just module secret <模块> <密钥名>` 补。见 stock-ta 的 `tools/quote/tool.json`、`tools/quote/index.ts` 和 `massive.ts` 的 `MISSING_KEY`。
- `cases.json` 和样例里不写 key：检查跑它们时，每个点名的密钥都是假值 `fixture`。key 放请求头（例如 `Authorization: Bearer <key>`），不放 URL，`responses` 的 URL 才和真实调用一样。
- Gmail、Telegram、模型 key 这类身份密钥不点名，检查会提醒。

## 示例包：`bill-mail`

收名单上商家的账单邮件，记进私密集合，每封发一条通知，Telegram 上只放发件人和主题。`gmailId` 另存 feed 的 `id`，以后在 `rows` 里认得出是哪封信。代码块上的 `file=<包>/<路径>` 是那个文件在包里的位置。

```json file=bill-mail/module.json
{
  "schema": 1,
  "name": "bill-mail",
  "version": "0.1.0",
  "title": "账单邮件",
  "description": "名单上的商家发来的账单邮件：发件人、主题、收到的时间"
}
```

```json file=bill-mail/data/bills/collection.json
{
  "title": "账单邮件",
  "kind": "record",
  "class": "private",
  "fields": {
    "gmailId": { "type": "text", "title": "Gmail 的消息 id" },
    "fromAddress": { "type": "text", "title": "发件人地址" },
    "subject": { "type": "text", "title": "主题" },
    "date": { "type": "date", "title": "Gmail 收到的时间（UTC）" },
    "snippet": { "type": "text", "title": "开头一句" }
  }
}
```

```json file=bill-mail/data/senders/collection.json
{
  "title": "账单发件人名单",
  "kind": "record",
  "class": "private",
  "fields": {
    "address": { "type": "text", "title": "发件人地址，或 @域名" },
    "addedAt": { "type": "date", "title": "加进名单的时间，带时区的完整 ISO" },
    "removedAt": { "type": "date", "title": "划掉的时间，带时区的完整 ISO" }
  }
}
```

```json file=bill-mail/feeds/inbox/feed.json
{
  "title": "账单收件箱",
  "connector": "mail",
  "handler": "index.ts",
  "every": "5m",
  "settings": { "senders": "senders" },
  "into": "bills",
  "notice": "{{from}} 发来账单：{{subject}}",
  "line": "{{from}}\n{{subject}}"
}
```

```ts file=bill-mail/feeds/inbox/index.ts
type Letter = { id: string; threadId: string; from: { name: string; address: string }; subject: string; date: string; snippet: string };

const short = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);

export default function inbox(input: { items: Letter[] }) {
	const records = input.items.map((letter) => ({ id: letter.id, gmailId: letter.id, fromAddress: letter.from.address, subject: letter.subject, date: letter.date, snippet: letter.snippet }));
	const notices = input.items.map((letter) => ({ id: letter.id, thread: letter.threadId || letter.id, fields: { from: short(letter.from.name || letter.from.address), subject: short(letter.subject) } }));
	return { records, notices };
}
```

```json file=bill-mail/feeds/inbox/fixtures/one-letter.json
{
  "input": {
    "items": [
      { "id": "m-1", "threadId": "t-1", "messageIdHeader": "<m-1@example.com>", "from": { "name": "电力公司", "address": "bill@power.example.com" }, "replyTo": "", "subject": "11 月电费账单", "date": "2026-11-13T08:00:00.000Z", "snippet": "本期电费 86.20 美元", "body": "本期电费 86.20 美元。", "attachments": [] }
    ]
  }
}
```
