# 读 Gmail 的是宿主的连接器，模块只拿到自己名单上的信

2026-11-16 按使用者的决定拟定（`docs/modules/architecture/connectors-and-secrets-design.md` 第 1、2 节，分期的 C1）。取代 ADR-0019 归属表里的一行：`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`GMAIL_READ_REFRESH_TOKEN` 的主人从 `mail` 改成宿主。ADR-0019 的其余部分不变，模块自己的 `.env` 和归属表的去留是 C2。在 ADR-0026 的警报编号里加一种 `connector:<连接器>`。ADR-0018、ADR-0020 不变。

## 问题

option-ta 要从券商的成交确认邮件里记成交。读 Gmail 的代码（`docs/modules/examples/mail/google.ts`）和读邮件的 token 都在 `mail` 模块里，按 ADR-0019 这三个密钥属于 `mail`，别的模块点不了。照这样，option-ta 只能再写一遍读 Gmail 的代码，再抄一份授权。

读邮件的 token 能读你整个邮箱，它代表的是你这个人，不是某个领域买的一项服务。两个模块各拿一份，就有两份代码拿着你的身份，撤销和重新授权也要做两遍。

## 决定

**连接器和读邮件的授权归宿主。** `src/modules/connectors/gmail.ts` 从宿主的 `secretsFile` 读 OAuth 客户端和 `GMAIL_READ_REFRESH_TOKEN`，换 access token（不存）。`just google-auth read` 照旧写这一行。`SECRET_OWNERS` 把这三个密钥记成宿主的，包里点名它们，`just module check` 报错并写明主人。模块的 feed 和工具都拿不到这个 token。`google.ts` 已从 `mail` 包里删掉。

**feed 写 `"connector": "mail"`，只拿到自己放行的信。** 这样的 feed 必须写 `handler`、`every`、写进私密集合的 `into`，以及 `settings.senders`：一组地址和 `@域名`，或者本模块一个集合的名字，这个集合要有文字字段 `address`（可选 `addedAt`、`removedAt`）。缺哪一样，包的检查（`validate.ts`）报错。连接器先只取每封新信的 `From`，名单外的信到此为止，正文不取，handler 看不到。名单内的信取全文，一次调用交一封，`items: [letter]`。信的形状见 `src/modules/connectors/letter.ts`：编号、会话、`Message-ID`、发件人、Reply-To、主题、时间、开头一句、纯文字正文（最多 64 KB）、附件清单。

过滤放在连接器里，是为了守住 ADR-0018 的隔离。一个模块只收到自己 feed 点名的信，它开的任务只进本模块。`mail` 不知道 option-ta 存在，也不转交信，幕僚长不参与。两个模块都收同一个发件人时，各收一份，各开各的任务。

**两格进度，失败重取，三次拒收。** 每个 feed 有两格：`connectorCursor` 是 JSON `{historyId, at}`，存在模块 `data.db` 的另一张表 `_feed_connectors`（`source`、`cursor`），不交给 handler。`_feeds` 的列不变，回退到旧代码时它照旧按三个值写 `_feeds`，新表它不读。`cursor` 是 handler 自己的进度，和以前一样。一批信全部处理完或拒收以后，`connectorCursor` 才往前走。handler 出错或超时，这一拍算失败，下一拍重取同一批信，这一批里已经处理过的信在内存里记着，跳过。同一封信失败 3 次就拒收：宿主把它的编号、发件人、主题和 handler 的错误写进本机的 `<stateDir>/inbox/<模块>/<feed>/rejected/<gmailId>.json`，错误文字可能引用信的内容，所以只留在本机。再发一行通知，只写哪个 feed、Gmail 编号、试了几次，不带错误文字，也不带主题和正文。这一批照常往前走。这和 `inbox` 连接器的拒收规则一样：它的通知只写 feed、文件名和次数，错误写在本机 `rejected/` 里的 `<文件名>.error.txt`。没到 3 次的那几拍算这个 feed 失败，连着失败满 `feedFailuresBeforeAlarm` 拍会亮警报。mail feed 一律私密，私密 feed 的警报不写错误原文，只写「错误可能引用私密数据，只记在本机的 host.log」，原文只进本机的 `host.log`，原因（鉴权、网络等）仍按原文分。

**mail feed 一律私密。** `into` 必须是 `private` 集合，不写或写了可分享的集合，检查报错。以前私密与否只看 `into`，现在连接器也要求它。哪些字段能出本机仍由 ADR-0020 定，只有 `line` 点名的几个。

**问题分两层报。** 名单是空的、名单里有通配符、划掉的地址读不出来、名单到了 500 行，是这个 feed 自己的问题，照旧作为这个 feed 的警报，文字用集合的标题（`mail` 的是「邮件名单」，所以文字不变）。授权失效（Google 回 `invalid_grant`）和隔了 24 小时以上没查，是连接器的问题，handler 经 `FeedPorts.connectorProblem` 交给宿主。宿主（`src/host/host.ts` 的 `#connectorHealth`）只拉响一个警报 `connector:mail`，文字后面列出这个连接器上的全部 feed，例如「（影响：邮件 收件箱）」。哪一拍换到了 token，这个警报就解除。断档是一行通知，每个连接器一小时内只发一次。连接器这一侧的 Gmail 请求（换 token、查 history、取信）每拍合计限 1 分钟，超时这一拍算失败，`connectorCursor` 不动，下一拍重取。

**工具读附件经 `fetch`。** 工具在 `tool.json` 写 `"fetch": "mail.attachment"`。它要和 `"effect": "read"` 一起写，同一个模块里要有一个 mail 连接器的 feed，可以再写 `"port": "ocr"`。运行工具代码之前，网关建一个临时目录，宿主（`src/modules/connectors/attachment.ts`）查输入里的 `messageId` 和 `partId`，先只取这封信的 `From`，查它此刻能不能过本模块某个 mail feed 的名单，过不了就拒绝，正文不取；过了才取全文。换 token 和取信合计限 10 秒，附件不存在或超过 10 MB 也拒绝。下载附件另限 10 秒，结果交给工具的 `input.fetched`：`{file, filename, mimeType, contentType, size}`。调用结束，临时目录删掉。工具不点名任何密钥，只读本地文件。

## 没有采用的做法

- **`mail` 把收到的信转给别的模块，或者由幕僚长转交。** 一个模块的触发会开另一个模块的任务，这正是 ADR-0018 拦的。`mail` 还得知道有谁要信。
- **option-ta 自己再带一份读 Gmail 的代码和 token。** 不改宿主，但身份类密钥有了两份，撤销、换 token 都要做两遍。
- **连接器的位置和 handler 的进度放一格。** handler 交回新进度时会把 `historyId` 盖掉，失败时也说不清该从哪里重取（设计稿复查 A2）。
- **不带 handler 的声明式 mail feed。** 宿主拼不出 `mail/inbox` 今天的触发：要按会话分线程、拼出发件人、裁剪长度，这只有 handler 做得了（设计稿复查 A1）。
- **把 token 交给工具，让工具自己下载附件。** 身份类密钥就进了模块代码。在运行前由宿主下载，工具只读文件。
- **授权失效时每个 feed 各报一次。** 一个 token 坏了，几个 feed 就有几条警报，修一处要等几条一起解除（设计稿复查 A7）。

## 代价

- 类型不支持的附件（Office 文件、压缩包这类）现在先下载再被工具拒绝，拒绝的文字不变。多一次最多 10 MB 的下载。
- 发件人从名单上划掉以后，他以前的信还在 `messages` 里，但附件读不了：宿主按此刻的名单判断。
- 每个 feed 各自按自己的 `connectorCursor` 问 Gmail，两个 mail feed 就是两份请求。
- 一批里哪些信已经处理过只记在内存里。宿主在重取之前重启，这些信会再交给 handler 一次。行按 `id` 去重，触发按来源和外部编号去重，所以不会多出通知。
- 上线后每个 feed 的第一拍没有 `connectorCursor`，会重读最近一天的信，同样靠去重不多发通知。
- 名单仍然只认 `From` 头，不验证发件人，和以前一样（`docs/modules/mail.md` 的「设计上的限制」）。
