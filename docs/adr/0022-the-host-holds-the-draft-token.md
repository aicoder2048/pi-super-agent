# 写草稿的 token 由宿主拿着，模块只能经宿主的一个口子建草稿

2026-11-13 在使用者授权的无人值守运行中拟定，使用者合并即确认。它是 Gmail 计划（`docs/multi-channel/gmail-plan.md`）的 M7，用 ADR-0019 的密钥归属表：`GMAIL_DRAFT_REFRESH_TOKEN` 属于宿主。

## 问题

使用者要白宫能把回信写进 Gmail 草稿箱，永远不发信。Google 没有「只建草稿」的 scope，建草稿要 `gmail.compose`，它同样能发信。token 交给模块代码，「不发信」就只靠模块代码自觉，读过邮件的模型还能影响模块的输入。

## 决定

**token 在宿主手里。** 宿主的 `src/modules/google-port.ts` 自己读 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET` 和 `GMAIL_DRAFT_REFRESH_TOKEN`，换 access token（不存），只有一个函数 `createDraft(raw, threadId)`，背后只发 `POST https://gmail.googleapis.com/gmail/v1/users/me/drafts`。方法和网址写死在宿主代码里，模块传不进来。测试和 lane 用环境变量 `PSA_GOOGLE_OAUTH_URL` 把它指到本地的假服务，和 `just google-auth` 一样，这个变量只有宿主进程读。

**工具描述写 `port`。** `tool.json` 写 `"effect": "write"`、`"port": "gmail.createDraft"`。检查时 `port` 只认这一个值，只许 `mail` 模块写，没写 `"effect": "write"` 也拒绝。工具照常是一个进程，它拼好 RFC 2822 文本，回 `{ draft: { raw, threadId }, note? }`，自己不联网，环境里没有写草稿的 token。

**宿主先查再建。** 网关先按权威表核对：`write` 效果的工具，使用者开的任务和规则任务能调，推断任务不能，工具都不跑。工具回来以后，宿主核对 `raw` 不超过 1 MB、有 `To`、头里没有 `Cc` 和 `Bcc`（折行的也算），然后调 `createDraft`。任务拿到 `{ draftId, threadId, to, subject, note }`，`to` 和 `subject` 是宿主从 `raw` 里读出来的，不是工具说的。

**收据只在本机。** 建好以后宿主写一条收据宿主行，写着收件人、主题和草稿箱链接 `https://mail.google.com/mail/u/0/#drafts`，标着「邮件（只在本机）」。收据和别的收据一样不发 Telegram：收件人和主题来自私密的信。

**预演不建真草稿。** `config.json` 的 `feedFixtures` 打开时（`just module try` 就是这样起宿主的），没有 `PSA_GOOGLE_OAUTH_URL` 的口子一律拒绝，不请求 Google。`cases.json` 和 `just module check` 只跑工具进程，不经网关，碰不到口子。

**仓库扫描只是 lint。** `tests/no-gmail-send.test.ts` 扫 `src/` 和 `docs/modules/examples/`，出现 `messages.send`、`drafts.send`、`/messages/send`、`/drafts/send`、`gmail.send` 就失败。代码能在运行时拼出 `send`，扫描看不见（计划 Appendix A 实测过），所以不发信的保证是这个口子，扫描只拦手误。

## 为什么这样做

- **保证放在模块碰不到的地方。** 宿主只会发一种请求，模块代码怎么写、模型怎么被信里的话带偏，最多是多一封草稿。草稿要使用者自己点发送。
- **收件人由信定，不由模型定。** `draft-reply` 只收 `messageId` 和 `body`，收件人、主题、引用头都从存下的原信拼。信里写「抄送 attacker@example.org」只是一段正文。
- **只回 From，不回 Reply-To。** M2 记下 Reply-To 没验证过，谁都能写。From 至少过了邮件名单，Reply-To 和它不一样时，收据和回复里写明，要回 Reply-To 由使用者在 Gmail 里改。

## 没有采用的做法

- **把 token 给模块，靠扫描挡 `send`。** 扫描看不见运行时拼出来的字。
- **工具自己说收件人和主题，宿主照抄进收据。** 收据是使用者核对的东西，要从真正交给 Gmail 的 `raw` 里读。
- **按计划回给 Reply-To。** 冒用 Reply-To 的信会让草稿发给第三方，使用者点发送前未必看得出。
- **拿 DMARC 结果卡草稿。** 没存，见 `docs/modules/mail.md`「设计上的限制」。From 被冒用时草稿回给真正的名单上的人，不会落到冒用者手里。

## 代价和剩下的风险

- `gmail.compose` 本身能发信。token 在宿主的 `secretsFile` 里，使用者开的任务的 `bash` 和批准卡片上的命令读得到这个文件（ADR-0021 记过），这一条不变。
- 规则任务能建草稿，一封名单上的来信可以让规则任务建一封回信草稿。最坏是草稿箱里多一封，使用者删掉就好。
- 宿主只认 UTF-8 base64 的编码字（`mail` 工具写的那种）来显示主题，别的编码在收据里照原样显示。
