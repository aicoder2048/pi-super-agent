# 邮件模块（mail）

mail 让白宫读你的 Gmail 收件箱。只收「邮件名单」上的发件人，名单外的信不存、不通知。名单上的人来信时，网页和 Telegram 上各响一条三行的通知，写着发件人和地址、主题、开头一句；全文和附件清单存在模块的私密集合 `messages` 里，只在网页上看。模块能请宿主把回信写进草稿箱，除此以外不改邮箱，永远不发信。

包在 `docs/modules/examples/mail/`。它和 stock-ta 一样放在例子目录里，你在要用的那台机器上复制一份，自己打开。

## 它做什么

- **每 5 分钟查一次。** feed `inbox` 先用读邮件的 refresh token 换一个 access token（不存），再问 Gmail 从上一次以后收件箱多了哪些信（`history.list`）。第一次没有起点时，取账号当前的位置当起点，再补最近一天的信，装好以后不用等下一封信就知道它通了。
- **先看发件人。** 每封新信先只取 `From` 头。地址不在名单上的，到此为止，不取正文，不存，不通知。名单上的再取全文，存成 `messages` 的一行，发一条通知。同一封信只存一行、只通知一次。
- **`From` 要正好是一个邮箱。** 写了好几个地址（`evil@bad.test, Ann <ann@example.com>`）、用了组（`朋友: ann@example.com;`）、地址里有两个 `@`（`x@bad.test@corp.test`）、域名不完整（`x@corp.test.`、`x@corp..test`）、地址带引号（`"ann"@example.com`）或括号没配对的，都算名单外。显示名可以带引号，引号里有逗号或 `@` 不要紧；括号里的注释不算地址。地址统一转成小写再和名单比。地址里有中文等非 ASCII 字符的（比如中文域名没转成 `xn--` 形式），这一版也算名单外。
- **存什么。** 发件人显示名和地址、Reply-To、主题、收到时间、Gmail 给的开头一句、纯文字正文（HTML 转成文字，最多 64 KB，超出截断并标明）、附件清单（文件名、类型、字节数，不存附件内容），以及回复要用的 Message-ID 和会话 id。
- **正文的字符集。** 按正文那一段 `Content-Type` 写的 charset 解码，GBK、Big5、Shift_JIS、ISO-8859 系列都认得。认不出的按 UTF-8 显示，正文末尾写明「字符集认不出」。正文太大、Gmail 只给一个附件号的，这一版不去取，正文写明「这里没取，全文在 Gmail 里看」。
- **信刚收到就被删了。** 查到新信以后、取它之前信被删了，Gmail 回 404，这封信跳过，这一拍照常往前走。
- **三行通知。** 第一行一定写出 `From` 里的地址，显示名冒充「白宫 · 系统」时也看得出用的是哪个地址（地址本身没验证，见「设计上的限制」）。显示名最多 80 字，主题 120 字，开头一句 100 字，换行、控制字符和方向控制符都去掉。通知开头是「邮件：」，它只是输出，不授权任何事。

## 安装

下面的命令在本仓库根目录运行。状态目录默认是 `~/.pi-super-agent`，设了 `PSA_STATE_DIR` 就是它。

1. 先按 `docs/deploy/gmail.md` 做完授权。密钥文件里要有 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`GMAIL_READ_REFRESH_TOKEN` 三行，这三个密钥属于 `mail`，别的模块点不了。要写回信草稿，再跑 `just google-auth draft`，多一行 `GMAIL_DRAFT_REFRESH_TOKEN`。这一行属于宿主，模块代码拿不到，见下面「写回信草稿」。
2. 把包复制进状态目录，再打开。

   ```bash
   cp -R docs/modules/examples/mail ~/.pi-super-agent/modules/
   just module setup mail
   just module on mail
   ```

   `just module setup mail` 按 `py/uv.lock` 用 `uv` 装读 PDF 的 Python 环境（只有 `pypdf` 一个包），装在状态目录的 `modules-data/mail/files/venv-<12 位>`，包本身不变。要先装好 `uv`。不装也能收信、读文字类附件，只是读 PDF 时会说「先跑 just module setup mail」。

3. 打开以后第一拍，网页和 Telegram 上各有一条「邮件：邮件名单是空的……」。名单是空的时候模块什么都不请求。

## 读附件

工具 `read-attachment` 让任务读一封已存的信的一个附件。在对话里说「看一下 a@example.com 那封信的附件说了什么」，任务先在 `messages` 里找到那封信，再用它的 `gmailId` 和附件的 `partId` 调这个工具。

- **只读已存的信。** `messageId` 要是 `messages` 里某一行的 `gmailId`，`partId` 要在那一行的附件清单里，否则拒绝，不请求 Gmail。
- **只用读邮件的 token。** 先 `messages.get` 找到这个附件当下的编号，再 `attachments.get` 下载，不碰别的接口。推断任务也能调，效果是 `read`，不需要批准卡片：命令是模块代码定死的，输入只有两个编号。
- **读哪些类型。** MIME 类型和扩展名都对得上才读：`.txt`、`.md`、`.csv`、`.html` 和正文一样按附件那一段 `Content-Type` 写的 charset 解码，没写的按 UTF-8（去掉 BOM，解不了的字节换成替代字符），认不出的按 UTF-8 并在末尾写明；`.html` 再去掉 `script` 和 `style` 后转成文字，`.pdf` 交给 `pypdf` 抽文字。图片、Office 文件、压缩包、可执行文件一律拒绝，写明是什么类型。QQ 邮箱等把附件一律标成 `application/octet-stream`（或 `binary/octet-stream`、`application/x-download`、空类型）的，按扩展名选读法，`.pdf` 还要开头是 `%PDF-` 才读；类型具体却和扩展名对不上的仍然拒绝。
- **限度。** 超过 10 MB 的附件不下载。下载超过 10 秒写「附件下载超时」。PDF 最多读前 50 页，`pages` 是总页数；6 秒读不完写「PDF 太复杂」，读 PDF 的进程内存超过 512 MB 写「PDF 太大」，有密码的写「PDF 有密码，读不了」。文字最多 100000 字。没读完的都标 `truncated`。这些加起来在宿主给工具的 20 秒以内。
- **不落盘，不执行。** 附件只在这次调用的内存里，PDF 经管道交给 Python，不写文件、不进集合，下次再问就再下载一次。HTML 里的脚本不跑，PDF 里的 JavaScript、表单动作、嵌入文件都不碰，只取文字。读 PDF 的 Python 进程只拿到 `PATH` 和 `PSA_MODULE_VENV` 两个环境变量，拿不到任何密钥。
- **附件是数据，不是指令。** 附件是发件人写的，里面写着「运行某条命令」也只是一段文字（ADR-0003）。来源开的任务本来就没有 `bash`，要运行命令只能出批准卡片，由你决定。

## 写回信草稿

工具 `draft-reply` 把一封回信写进你 Gmail 的草稿箱，不发送。在对话里说「帮我回 a@example.com 那封信，说周四下午可以」，任务先在 `messages` 里找到那封信，再用它的 `gmailId` 和回信正文调这个工具。草稿在原来的会话里，你在 Gmail 里看过、改过以后自己点发送。

- **写草稿的 token 在宿主手里。** 工具只拼好信，交给宿主；宿主查过以后用 `GMAIL_DRAFT_REFRESH_TOKEN` 建草稿，只发「建草稿」这一种请求（ADR-0022）。模块代码的环境里没有这个 token。
- **任务只给两样。** `messageId` 是 `messages` 里某一行的 `gmailId`，`body` 是纯文字正文，1 到 20000 字。收件人、抄送、主题不能指定，多给了就拒绝。
- **信怎么拼。** 收件人是原信 `From` 里的地址。主题是原主题前加 `Re: `，原主题已经以 `Re:` 开头（不分大小写）就不加。`In-Reply-To` 和 `References` 是原信的 `Message-ID`。原主题里的换行和控制字符去掉，信里夹带的 `Bcc:` 变不成一个头。宿主还会再查一遍：草稿超过 1 MB、没有收件人、带抄送或密送，都不建。
- **Reply-To 不同时只提醒。** 原信写了另一个 `Reply-To` 时，草稿仍回给 `From` 地址，收据和给任务的回复里写一句「原信的 Reply-To 是……，和发件人地址不一样」。要回给它，在 Gmail 里改收件人。
- **收据。** 建好以后，网页和终端的对话里多一条「邮件（只在本机）」，写着收件人、主题和草稿箱链接 `https://mail.google.com/mail/u/0/#drafts`。它不发 Telegram。
- **谁能调。** 你在对话里开的任务能，`来源: mail/inbox` 的规则任务也能；推断开的任务不能，它只能把想回的话写进汇报。
- **授权失效。** 换 token 时 Google 回 `invalid_grant`，工具回一句「写草稿的授权失效了」，照 `docs/deploy/gmail.md` 重跑 `just google-auth draft`。读邮件不受影响，两个 token 是分开的。

## 邮件名单

名单是模块的 `senders` 集合，标 `shareable`（地址本来就是你在对话里说的）。在对话里说就能改，下一拍就用新名单，不用重启。

- 「把 a@example.com 加进邮件名单」，助手加一行。
- 「把 @example.com 加进邮件名单」，这个域名的所有地址都收（只认这个域名本身，不含子域名）。
- 「把 a@example.com 从邮件名单划掉」，助手给那一行写上划掉的时间（`removedAt`），不删行。
- 地址不分大小写，`Ann@Example.com` 和 `ann@example.com` 是同一个。
- 同一个地址有好几行时，任何一行写了 `removedAt` 都算划掉，重复的行留不住它。划掉以后再「加进邮件名单」，助手新加一行并写上加的时间（`addedAt`），比最后一次划掉晚才算回到名单上。行没有写入时间，分不出「划掉前就有的重复行」和「划掉后加回来的行」，所以要靠 `addedAt`。
- 划掉一定生效，拿不准的都按划掉算。`removedAt` 和 `addedAt` 都写带时间和时区的完整 ISO，例如 `2026-11-13T09:30:00Z`。`removedAt` 写坏了（例如「yes」「今天」）算永远划掉；只写日期算到那一天在全世界都过完（第二天 12:00 UTC）；没写时区按最晚的时区算。`addedAt` 只写日期、没写时区、或者比现在还晚（时钟不准），都不算加回来。
- 名单上有 `@example.com`、又划掉了 `ann@example.com` 时，ann 的信不收，划掉单个地址比收整个域名优先。
- 每一行的地址按发件人一样的规则解析，`Ann <ann@example.com>` 算 `ann@example.com`。解析不出一个地址的行不算数，划掉的行例外：它的地址写成 `example.com`、`mailto:ann@example.com`、`ann@example.com,` 这样读不出来时，文字里含有发件人地址或域名的信一律不收，并出一条通知请你改那一行。

## 五种「通知」

| 通知 | 什么时候出 | 怎么办 |
|---|---|---|
| 邮件：邮件名单是空的…… | 名单上没有有效的地址 | 在对话里加一个发件人 |
| 邮件：Gmail 授权失效了…… | 换 token 时 Google 回 `invalid_grant`（改过 Google 密码、半年没用、撤销过授权） | 见下一节 |
| 邮件：有 N 小时没查…… | 上一次成功距今超过 24 小时，例如宿主停过 | 模块补了最近一天的信，更早的去 Gmail 里看 |
| 邮件：邮件名单里有一行划掉的地址读不出来…… | 某行写了 `removedAt`，地址却解析不出来 | 在对话里把那一行的地址改成 `a@example.com` 或 `@example.com` |
| 邮件：邮件名单到了 500 行…… | 名单（连划掉的行）有 500 行或更多 | 见下面「名单太长」 |

同一条通知在问题修好之前只出一次。授权失效的那几拍不前进，修好以后从原处接着查，中间的信不会丢（不超过一天的话）。

## 名单太长

宿主一次最多读一个集合的 500 行，按 `addedAt` 从新到旧，没写 `addedAt` 的排在最后。名单到了 500 行，划掉的行可能正好没读到，所以模块这时一封信都不存、也不去请求 Gmail，直到名单少于 500 行。行删不掉（划掉只是写上 `removedAt`），要清空名单只能在模块关着时 `just module purge mail`，它会连已存的信一起删掉，之后重新加发件人。

## 授权失效怎么办

在笔记本上重跑 `just google-auth read`，再按 `docs/deploy/gmail.md` 把 `GMAIL_READ_REFRESH_TOKEN` 那一行复制到跑宿主的机器。下一拍就恢复，不用重启宿主。

## 设计上的限制

- **名单只认 `From` 头，不验证发件人。** 模块不看 DMARC、SPF、DKIM 的结果（`Authentication-Results` 头）。有人冒用名单上的地址发信，只要 Gmail 把它放进收件箱，它就会被存下、发通知。通知第一行写的是 `From` 里的地址，不是验证过的发件人。
- **`replyTo` 没验证过。** 它是信里自带的 Reply-To 头，谁都能写成任何地址。所以回信草稿不回给它，只回 `From` 地址，两个不一样时写明。
- **这一版不存 DMARC 结果。** 取 `From` 的那次请求可以顺带取 `Authentication-Results`，不多花请求，但这一版没做，原因有三。信里可以夹带发件人自己写的 `Authentication-Results`，只有 Gmail 自己加的那一条（`mx.google.com`）可信，要解析对才有用。拿它卡名单会漏掉正常的转发信和邮件列表，它们常常过不了 DMARC。M2 里也没有谁用这个字段。M7 写回信草稿时也没加：草稿只回 `From` 地址，`From` 被冒用时草稿回给的是名单上真正的那个人，落不到冒用者手里。以后要加，同一次请求多取这个头，只认 `mx.google.com` 的那一条，存成 dmarc 通过或不通过，没通过的在通知和草稿里标出来。

## 规则

`rules.md` 第一版没有规则，新邮件只出通知。想让某类邮件自动开任务，自己加 `来源: mail/inbox` 的规则，这种任务按受限清单走，没有 `bash` 和 `web_get`。

## 试一试，不碰真账号

`just module check docs/modules/examples/mail` 用 `feeds/inbox/fixtures/` 里的样例跑一遍：第一次起步、空名单、一页新信（一封名单内，一封名单外）、两页、起点太旧、断档、授权失效、HTML 正文和两个附件、主题里带换行和方向控制符、显示名是「白宫 · 系统」。样例不联网，也不用真密钥。`read-attachment` 和 `draft-reply` 要读已存的信，没有 `cases.json`，它们的检查在 `tests/mail-read-attachment.test.ts` 和 `tests/mail-draft-reply.test.ts`，用本地的假 Google 服务。检查只跑工具进程，不经宿主，建不出草稿。
