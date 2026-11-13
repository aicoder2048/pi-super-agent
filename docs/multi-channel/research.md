# 调研：让白宫接上 Gmail、GitHub、Google Drive 和更多 IM

> 第二版，2026-11-12。第一版写于 2026-11-10，当时没提交。这一版按已经合并的模块框架（G1-G5）和 Telegram 客户端（T1-T3）重写，并重新核对了平台事实。
> 只是调研和建议，没有实施。第 7 节的决定要使用者来定，每条都带默认做法。
> 术语以 `GLOSSARY.md` 为准，按「客户端 / 来源 / 渠道」写。连接器（connector）和 feed 的意思和 `docs/modules/architecture/design.md` 第 3 节一致。
> 设计依据：ADR-0003、0005、0016、0017，`docs/modules/architecture/design.md` 第 3、5 节，`docs/modules/module-data-feeds-plan.md`。

## 1. 结论

使用者想要的四样东西里，只有 IM 是客户端。Gmail、GitHub、Google Drive 都是来源，在模块框架里是一个模块的 feed，内容一律是数据（ADR-0003）。

**三个来源都不用改宿主代码就能起步。** 今天的调度器已经能按 `every` 运行一个不写连接器、只带 `handler` 的 feed。模块自带的代码拿着 `feed.json` 里声明的密钥去联网，交回行、触发和进度，宿主负责存、去重、记进度（`src/modules/scheduler.ts`、`src/modules/feed-runner.ts`）。design 第 3 节列的 `mail`、`google-drive` 连接器可以等第二个模块也要同一种服务时再做，这和 `module-data-feeds-plan.md` 推迟 `http-poll` 的理由相同。

**建议顺序是 GitHub、Gmail、Google Drive，微信暂缓。**

1. GitHub 通知最便宜。一个只带 `notifications` 权限的 classic PAT，一个模块包，不碰宿主。它是第一个带别人写的文字的来源，正好用它把「外部文字只是数据」这条路在真机上走一遍。
2. Gmail 价值最大，但要先做一次 Google OAuth 授权。授权工具做好以后 Drive 直接复用。
3. Google Drive 主要服务以后的个人健康、报税这类模块，等这些模块装上再接。
4. 微信两条官方路都不顺。企业微信智能机器人只能在企业微信 App 里聊，个人微信 ClawBot 本周起新建的机器人发不出消息（第 4.4 节）。个人号协议违反微信许可协议，不考虑。

**不建议现在加第二个 IM 客户端。** Telegram 已经能叫醒使用者、能点按钮。真要第二个，iMessage 最合适，前提是宿主那台 Mac 登录一个单独的 Apple ID（第 4.5 节）。

| 平台 | 身份 | 建议的接法 | 主要问题 |
|---|---|---|---|
| GitHub | 来源 | handler feed 轮询 Notifications API，classic PAT 只给 `notifications` | 只有 classic PAT 能读通知；标题和评论是别人写的 |
| Gmail | 来源 | handler feed 用 Gmail API 的 `history.list` 轮询，OAuth 只读（`gmail.readonly`） | 首次授权要有浏览器；refresh token 能管多久要实测 |
| Google Drive | 来源 | handler feed 用 `changes.list` 轮询，OAuth（`drive.readonly`） | `drive.readonly` 能读整个网盘 |
| 微信 | 客户端 | 暂缓 | 见上 |
| iMessage | 客户端（备选） | `imsg` 命令行读 `chat.db`、用 AppleScript 发 | 要图形会话和完全磁盘访问权限；没有按钮 |

## 2. 每样东西给使用者带来什么

### GitHub

- 有人在 PR 上请他 review、在 Issue 里 @他、把 Issue 指派给他，Telegram 上来一行，点进网页看详情。
- 他的 PR 跑 CI 失败（通知原因 `ci_activity`），幕僚长开一个任务看日志，汇报是哪一步失败、像不像偶发。
- 以后可以在对话里说「回复那个 Issue，说下周修」，由他在对话里开的任务去发评论。

身份是来源。第一版不把他在 GitHub 上写的评论当成他的话，理由和 ADR-0016 一样，授权只来自客户端和规则文件。

### Gmail

- 只看他列出的发件人（医院、学校、银行、券商），来了就在 Telegram 上提醒一行。
- 带 PDF 附件的报告、账单归档进模块的实例数据，以后问「上个月的电费单是多少」能查到。
- 每天一封摘要不需要做，提醒和查询都在对话里。

身份是来源。邮件的 `From` 能伪造，第一版不把任何邮件当作使用者的话，也不做「发邮件给白宫下指令」。发信属于对外动作，第一版不做。

### Google Drive

- 他把体检报告放进网盘里一个约定的文件夹，模块归档原件，提醒一行。design 第 3 节的 `sample/personal-health/feeds/drive-checkups/` 就是这个例子。
- 报税季把 1099 等表格放进另一个文件夹，报税模块按年份归档。

身份是来源，只读。

### 微信和其他 IM

**作为客户端。** 在微信里和幕僚长说话，等于把 Telegram 做过的事再做一遍。对他的好处只是少装一个 App。

**作为来源。** 读他和中国亲友的聊天，帮他记事、提醒。这只有个人号协议能做到，会违反微信许可协议，可能封掉他的主号。不建议。

## 3. 代码里已经有的

| 要用到的 | 已经在哪里 | 怎么用 |
|---|---|---|
| 不带连接器的 handler feed | `src/modules/scheduler.ts` 的 `work`：`connector` 没写、`every` 到点就调用 handler | 三个来源都这样起步 |
| 密钥只给声明它的代码 | `feed.json` 的 `secrets`，`src/modules/run-code.ts` 的 `secretsFor` 从 `secretsFile` 或环境变量取值，只放进这一次调用的子进程环境 | PAT、refresh token 放 `secretsFile` |
| 进度和去重 | handler 交回 `cursor`，宿主最后调用 `saveFeedState`；行和触发按 `id` 去重 | GitHub 存 `Last-Modified`，Gmail 存 `historyId`，Drive 存 `pageToken` |
| 一次调用的时限 | 默认 20 秒，`feed.json` 的 `limit` 最多 `10m` | 下附件的 Drive feed 要写 `limit` |
| 不联网的检查和预演 | `feeds/<名字>/fixtures/` 的 `responses` 按网址代替 `fetch`；`just module check`、`just module try` | 三个 feed 都能先用样例应答测完再上真机 |
| 私密数据在 Telegram 上只发一行 | `DATA_CLASSES`（`shareable`、`private`）；feed 的级别取它写进的集合的级别；Telegram 客户端的 `privateTitle` 和 `privateLine` | 邮件、网盘的集合标 `private` |
| 宿主行和提醒 | ADR-0017，`host_lines` 表；private 模块的提醒在 Telegram 上也只发一行 | 今天的提醒条件只比较数字，邮件提醒走触发 |
| 推断任务没有 `bash` | `src/worker/extension.ts` 的工具白名单；对外动作只能写进 `report` 的 `drafts` | 来源触发的推断任务读得到邮件，做不了事 |
| 读过别人的话就不能写盯盘条件 | `Kernel.heardOtherThanUser`（ADR-0017） | 读过邮件或 Issue 的任务改不了提醒 |
| Telegram 客户端的写法 | `src/host/telegram/`：`rules.ts` 是纯函数的去留判断，`store.ts` 是按编号去重的发件箱，`client.ts` 只做收发 | 以后的第二个 IM 客户端照这个分层写 |

还没有的：

- **连接器只跑了两个。** `CONNECTORS` 列了八个，调度器的 `RUNNING` 只有 `timer` 和 `inbox`。写了 `"connector": "mail"` 的 feed 今天会停在「宿主还没有」的日志行。
- **`ask` 的回答没地方存。** `manifest.ts` 能读 `ask`，宿主不存回答。第一版把发件人名单、文件夹 id 直接写在使用者自己那份 `feed.json` 的 `settings` 里。单人自用，这样够了。
- **没有入站 HTTP。** 宿主不开端口，GitHub webhook、Drive 推送都用不了，三个来源都只能轮询。

## 4. 各平台怎么接

### 4.1 GitHub

**接法。** 新模块 `github`，一个 feed `notifications`，handler 每 1 到 5 分钟请求一次 `GET /notifications?participating=true`，带上次的 `Last-Modified`。没有新通知时 GitHub 回 304，不算限额。只把 `reason` 是 `mention`、`review_requested`、`assign`、`approval_requested`、`ci_activity` 的发成触发，线程取 `owner/repo#编号`，后续通知直达订阅了它的任务。

**认证。** 只能用 classic PAT。通知接口的文档写明它不接受 fine-grained PAT 和 GitHub App 的 token。PAT 只勾 `notifications`，不勾 `repo`，因为 `repo` 能读写他全部私有仓库。

**回写放到以后。** 发评论、开 PR 是对外动作，只由他在对话里开的任务去做。到时用一个 fine-grained PAT，只授权他自己的仓库。GitHub 从 2024-10 起允许个人项目的 fine-grained PAT 不设过期。单独建一个 machine user 账号也合规（服务条款允许每人再有一个免费的机器账号），但单人自用多一个账号要管，建议不建。

**为什么不用 GitHub App。** App 的 token 读不了通知，只能退回仓库事件接口。文档写明那个接口的延迟在 30 秒到 6 小时之间。App 收 webhook 又要公网地址，`gh webhook forward` 和 smee.io 都写明只给测试用。

**限额。** PAT 每小时 5000 次。发内容另有每分钟 80 次、每小时 500 次的次级限制。轮询必须照响应头 `X-Poll-Interval` 放慢。

**数据级别。** 他的仓库是公开的，通知标题本来就公开。建议集合标 `shareable`，标题能发到 Telegram。私有仓库的通知也会进来，所以这是第 7 节的一个决定。

### 4.2 Gmail

**接法。** 新模块 `mail`，一个 feed `inbox`，handler 每 5 到 15 分钟调用 Gmail API 的 `history.list`，从上次的 `historyId` 往后取新邮件，再用 `messages.get` 取头部（`format=metadata`）。只要普通 HTTPS，用 `fetch` 就行，不加运行时依赖。按 `settings` 里的发件人名单过滤，命中的写进 `private` 集合并发触发。`historyId` 太旧时接口回 404，handler 改为只取最近一天的邮件重新起步。

用量很小。`history.list` 每次 2 个配额单位，`messages.get` 20 个，个人上限是每分钟 6000 个。

**认证用 OAuth 只读，不用应用专用密码。**

- 在他自己的 Google Cloud 项目里建一个桌面应用类型的 OAuth 客户端，只申请 `gmail.readonly`。
- 发布状态设为「生产」，不送审。Google 的帮助页写明，个人自用（少于 100 个用户）的应用，用户可以点过「未验证的应用」提示。restricted scope 的审核页也写着，只有你自己用就不需要审核。
- 不要停在「测试」状态。文档写明测试状态下的 refresh token 7 天过期。
- 生产状态下 refresh token 能管多久，文档没有明说。已知的失效情况有三种，分别是撤销授权、6 个月不用，以及改 Google 密码（带 Gmail scope 的 token 会被收回）。上线后要实测过了 7 天还能不能用。

**首次授权要一个有浏览器的地方。** 设备流（电视那种输入码的流程）不允许 Gmail scope，复制授权码的旧流程已经停用。剩下的是本机回环地址。在他的笔记本上运行一个授权命令，浏览器里点同意，命令把 refresh token 打印出来，他再写进老 Mac 的 `secretsFile`。也可以在老 Mac 上运行，用 `ssh -L` 把回环端口转到笔记本。这个命令以后 Drive 也用，建议做成 `just google-auth`。

**应用专用密码作为后备。** 它仍然存在，前提是开了两步验证。Gmail 从 2025-01 起 IMAP 一直开着，关不掉。缺点有三个。密码能读、能删整个邮箱；改 Google 密码就失效；IMAP 协议要引入 imapflow 这类库。模块代码可以把库带在自己的包里，不动宿主的依赖，这一点是推断，没试过。

**推送不需要。** `users.watch` 要经 Cloud Pub/Sub。用拉取订阅可以不要公网，但多一个要维护的云服务，而且每 7 天要续一次。15 分钟延迟对邮件够了。

### 4.3 Google Drive

**接法。** 模块里一个 feed，先用 `changes.getStartPageToken` 拿起点，之后每次 `changes.list` 取变化，存 `newStartPageToken` 作为进度。只处理 `settings` 里那个文件夹下的新文件，下载原件进实例数据的 `blobs/`。

**scope 只能选 `drive.readonly`。** `drive.file` 不敏感，但只覆盖这个应用建的文件、或用户用 Picker 交给它的文件，无人值守的宿主用不上。`drive.readonly` 是 restricted，按 Gmail 那样走个人自用、点过提示。代价是这个 token 能读整个网盘。

**推送用不了。** `changes.watch` 要一个带有效证书的 HTTPS 地址。

**另一条路是 Google Drive 桌面版。** 在老 Mac 上装桌面版，把那个文件夹同步到本地，feed 读本地文件夹，完全不用 OAuth。它要老 Mac 有登录的图形会话，而且整个网盘对同一个系统用户可见。这一条没有实测，列在这里备查。

### 4.4 微信

两条官方路，这次核实后都比 11-10 更差。

**企业微信智能机器人（长连接）。** 2026-03 上线，宿主只连出站的 `wss://openws.work.weixin.qq.com`，有模板卡片按钮，使用者先说过话后机器人可以主动推送，每个会话每分钟 30 条、每小时 1000 条。11-10 的这些描述都对得上官方文档（2026-10-10 更新）。这次新确认了两点。

- 它只出现在企业微信 App 里，个人微信里找不到它。个人微信能聊的是自建应用，那要公网回调地址。
- 没找到要求企业认证的说法。据第三方说，个人建一个「未注册组织」免费；美国手机号能否注册没查。

所以走这条路，使用者要在手机上多装一个企业微信 App。这和 Telegram 比没有优势。

**个人微信 ClawBot / iLink。**

- 腾讯在 `Tencent/openclaw-weixin` 仓库里公开了协议文档，许可证是 MIT。但没有条款说非 OpenClaw 的客户端可以直连。
- 3.0.0-beta-0（11-09）说以后绑定时要输入手机上显示的 PIN 码，实名流程以后默认开启。
- issue #385 开于 2026-11-12。11-12 起新建的机器人，`sendmessage` 只回 `{"ret":0}`，没有 `message_id`，手机收不到；11-05 建的机器人在同一台服务器上正常。另有几个 11 月的 issue 是同一现象。
- 主动推送要用入站消息带来的 `context_token`。用户反馈它在使用者十几个小时不说话后就失效（#309），官方没有说明。
- 从海外连，媒体 CDN 只有南京的地址，上传时有间歇的 500（#370）。美国手机号注册的微信能不能绑定，没找到说法。

白宫的回复常在几小时后才来，加上现在新机器人发不出去，这条路至少要等它稳定。

**个人号协议不考虑。** 微信软件许可协议 8.2.1.4 和 8.2.1.6 禁止用未经腾讯授权的第三方工具接入、登录或做自动化操作。Wechaty、iPad 协议、PC hook 都在其中，封的是他的主号。

### 4.5 其他 IM

使用者在美国，亲友多在国内。客户端是他自己和幕僚长说话的地方，亲友用什么不影响选择。亲友用什么只在「读聊天当来源」时才相关，而那条路在微信上走不通。

| IM | 官方接口 | 只出站 | 认证 | 按钮 | 风险 |
|---|---|---|---|---|---|
| iMessage | 没有。`imsg` 命令行读 `~/Library/Messages/chat.db`，用 AppleScript 发 | 是，本机 | Mac 上登录的 Apple ID，加完全磁盘访问和「自动化」权限 | 没有 | 没有封号的说法 |
| Signal | 没有官方 bot。`signal-cli` 常驻，JSON-RPC | 是 | 要一个单独的手机号 | 没有 | 非官方，个人用量风险低 |
| WhatsApp | Cloud API | 否，要公网 webhook | Meta 企业账号和企业号码 | 有 | 商业条款限制通用 AI 助手；非官方的 Baileys 可能封号 |
| 飞书 / Lark | 官方机器人，WebSocket 收事件 | 是 | 自己租户里的应用 id 和密钥 | 有卡片 | 官方 |
| QQ | 官方机器人（q.qq.com），WebSocket | 是 | AppID 和密钥，个人可扫码注册 | 有限 | 官方；长时间没互动时主动消息可能被拦 |

iMessage 是唯一不用他多装 App 的选择，而宿主本来就是 Mac。要注意三点。

- 宿主那台 Mac 要单独登录一个 Apple ID。用他自己的 Apple ID，宿主就能读到他全部短信和 iMessage，包括亲友发给他的。
- Messages 要有登录的图形会话。老 Mac 现在以 LaunchAgent 跑宿主，有没有常驻的图形会话要看部署，这一点是推断。
- 没有按钮，问题卡片要退回「回序号」，和 TUI 一样。

`imsg` 0.21.0（2026-11-05）合入了 macOS 26 的修复。OpenClaw 已经用它替换了 BlueBubbles。

## 5. 风险

**外部文字里的指令。** 邮件正文、Issue 标题和评论是别人写的。今天的程序层底线有三条。

- 触发的正文由 feed 的 `notice` 模板拼出，模块决定放哪些字段。建议邮件只放发件人和主题，正文留在集合里。
- 来源触发、又没有规则对上时，幕僚长如果开任务，依据只能是推断。推断任务没有 `bash`，对外动作只能写成草稿等使用者确认（`src/worker/extension.ts`）。
- 读过使用者以外的话的任务，改不了盯盘条件（ADR-0017）。

口子在规则任务。`rules.md` 里写了 `来源: mail/inbox` 的规则，开出的任务带 `bash`，会读到别人写的文字。使用者已决定暂缓 Worker 沙箱（单人自用，安全从简），所以建议 `mail` 和 `github` 模块第一版不带规则，触发只走推断任务。使用者自己写规则，就是接受这一点。

**邮件内容经过 Telegram。** 按 ADR-0016，写了 `telegram` 段就是同意对话经过 Telegram 的服务器，机器人聊天不是端到端加密的。邮件和网盘的集合标 `private` 后，碰过它们的任务在 Telegram 上只有一行「邮件 有新内容，请在网页上查看」。design 第 5 节记下的缺口仍在，幕僚长之后的回复如果复述了邮件内容，会原样发到 Telegram。

**token 能读到什么。**

| token | 能做什么 | 放哪里 | 谁读得到 |
|---|---|---|---|
| GitHub classic PAT（只有 `notifications`） | 读和标记通知 | `secretsFile` | 声明它的 feed；带 `bash` 的 Worker 也能读 `secretsFile` |
| Google refresh token（`gmail.readonly`、`drive.readonly`） | 读全部邮件、整个网盘 | `secretsFile` | 同上 |
| 应用专用密码（后备） | 读、删整个邮箱 | `secretsFile` | 同上 |

名字以 `_TOKEN`、`_SECRET`、`_PASSWORD` 结尾的变量不进 Worker 的环境（ADR-0005），但有 `bash` 的 Worker 能直接读 `secretsFile`。ADR-0016 已经把这一条记为 Telegram token 的已知风险，Google 的 refresh token 后果更重。便宜的缓解是只申请只读 scope，Gmail 和 Drive 用两个 token，任何一个出问题都能单独到 Google 账号里撤销。

**老 Mac 上的 `gh`。** 老 Mac 上如果用使用者本人登录过 `gh`，今天任何带 `bash` 的 Worker 就能以他的身份发评论、推代码。这和这次接不接 GitHub 无关，部署时值得看一眼。这一点没有登录老 Mac 核实。

## 6. 第一个 PR

**`github` 模块，只读通知 feed，不改宿主代码。**

- `modules/github/module.json`、`rules.md`（第一版没有规则，只写一段说明为什么）。
- `modules/github/data/notifications/`：一类数据，字段是仓库、编号、类型、原因、标题、链接、更新时间。
- `modules/github/feeds/notifications/feed.json`：`handler`、`every: "2m"`、`secrets: ["GITHUB_NOTIFICATIONS_TOKEN"]`、`into: "notifications"`、`notice` 模板。
- `index.ts`：带 `If-Modified-Since` 请求，处理 304，照 `X-Poll-Interval` 放慢，按原因过滤，`cursor` 存 `Last-Modified`，标题去掉控制字符。
- `fixtures/`：304、一条 `review_requested`、一条被过滤掉的 `subscribed`、401。
- `docs/deploy/github.md`：怎么建只有 `notifications` 的 classic PAT，放进 `secretsFile`，在模块页打开开关。

怎么算做完：`just module check` 用样例跑过；`just module try` 里 304 不出触发、`review_requested` 出一条；在老 Mac 上给自己的仓库开一个 PR 并请自己 review，Telegram 上收到一行。

后面每个都是一个 PR，依次是：

1. `just google-auth` 授权命令。
2. `mail` 模块。
3. Drive feed，放进第一个需要它的模块。

## 7. 要使用者定的事

1. **先接哪个。** 默认 GitHub、Gmail、Drive。如果最想要邮件，就把 Gmail 提到第一，代价是第一个 PR 要先做 Google 授权。
2. **Gmail 用什么认证。** 默认 OAuth 只读（`gmail.readonly`，自己的 Google Cloud 项目，生产状态不送审，授权时点过「未验证」提示）。另一条是应用专用密码加 IMAP。
3. **邮件在 Telegram 上露多少。** 默认集合标 `private`，Telegram 上只有一行，详情在网页。也可以标 `shareable`，发件人和主题会经过 Telegram。
4. **GitHub 通知的级别。** 默认 `shareable`，标题发到 Telegram。私有仓库多的话改成 `private`。
5. **来源开的任务能不能带 `bash`。** 默认 `mail` 和 `github` 不带规则，邮件和通知只开推断任务（没有 `bash`，只出草稿）。
6. **微信和第二个 IM。** 默认微信暂缓，一两个月后再看 ClawBot，也不加第二个 IM 客户端。要加的话选 iMessage，宿主那台 Mac 用单独的 Apple ID。

## 8. 和 2026-11-10 相比变了的事实

- 微信 ClawBot。3.0.0-beta-0（11-09）要加绑定 PIN 码，实名以后默认开启；11-12 起新建的机器人发不出消息（issue #385，未关闭）；海外媒体上传间歇失败（#370）。
- 企业微信智能机器人只能在企业微信 App 里聊，个人微信里没有它。
- Gmail。IMAP 从 2025-01 起一直开着；用 OAuth 登录的 IMAP 会话约 1 小时；个人自用的生产状态应用可以点过未验证提示。这让 Gmail API 比 11-10 判断的更可行，第一版因此从「IMAP 加应用专用密码」改为「Gmail API 加 OAuth 只读」。
- Gmailify 和 POP 收第三方邮箱的功能 2027-01 移除，不影响第三方读 Gmail。
- GitHub 的结论没变。通知原因多了 `approval_requested`、`agent_session_finished`、`member_feature_requested`。
- WhatsApp 商业条款 2026-01-15 起限制通用 AI 助手，之后按国家放宽（条款 2026-09-23 修改）。
- Drive 推送文档不再提域名验证，只要求有效证书的 HTTPS。
- 11-10 版写「GitHub 和邮件之前要先补 Worker 沙箱」。使用者之后定了单人自用、安全从简，这一版改为第 5 节的便宜做法。

## 9. 没核实的地方

- 生产状态、未送审的 Google 应用，refresh token 是否长期有效。文档只写了测试状态 7 天过期。
- 只有 `notifications` 权限的 classic PAT，私有仓库的通知标题是否完整。
- 模块包里自带 Node 库（例如 imapflow）能否被 handler 正常加载。
- Google Drive 桌面版在 LaunchAgent 跑宿主的老 Mac 上能否常驻。
- iMessage 在老 Mac 上需要的图形会话；美国手机号能否注册企业微信、绑定 ClawBot。
- ClawBot 主动推送的 `context_token` 期限和条数，只有用户反馈。
- GitHub 评论 65536 字符上限只来自 API 报错，文档没写。

## 10. 来源

这一版重新读过的页面：

Google

- https://support.google.com/accounts/answer/185833?hl=en
- https://support.google.com/mail/answer/7126229?hl=en
- https://developers.google.com/workspace/gmail/imap/imap-smtp
- https://developers.google.com/identity/protocols/oauth2
- https://support.google.com/cloud/answer/15549945?hl=en
- https://support.google.com/cloud/answer/13464323?hl=en
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/workspace/gmail/api/guides/push
- https://developers.google.com/workspace/gmail/api/guides/sync
- https://developers.google.com/workspace/gmail/api/reference/quota
- https://developers.google.com/identity/protocols/oauth2/limited-input-device
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://developers.google.com/workspace/drive/api/guides/push
- https://developers.google.com/workspace/drive/api/guides/manage-changes
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://support.google.com/mail/answer/17101213?hl=en

GitHub

- https://docs.github.com/en/rest/activity/notifications
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/rest/issues/comments
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- https://github.blog/changelog/2024-10-18-new-pat-rotation-policies-preview-and-optional-expiration-for-fine-grained-pats/
- https://github.blog/changelog/2025-03-18-fine-grained-pats-are-now-generally-available/
- https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps
- https://docs.github.com/en/rest/activity/events
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing
- https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks
- https://github.com/anthropics/claude-code-action/blob/main/docs/security.md

微信 / 企业微信

- https://developer.work.weixin.qq.com/document/path/101463
- https://work.weixin.qq.com/nl/index/openclaw
- https://open.work.weixin.qq.com/help?doc_id=21657
- https://github.com/dingxiang-me/OpenClaw-Wechat
- https://openclawchina.com/guides/wecom-ai-bot/
- https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin
- https://docs.openclaw.ai/channels/wechat
- https://github.com/Tencent/openclaw-weixin
- https://github.com/Tencent/openclaw-weixin/blob/main/docs/release-notes-bot-realname-auth_zh_CN.md
- https://github.com/Tencent/openclaw-weixin/issues/202
- https://github.com/Tencent/openclaw-weixin/issues/309
- https://github.com/Tencent/openclaw-weixin/issues/370
- https://github.com/Tencent/openclaw-weixin/issues/385
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin
- https://weixin.qq.com/agreement?lang=zh_CN

其他 IM

- https://github.com/openclaw/imsg
- https://docs.openclaw.ai/channels/imessage
- https://docs.openclaw.ai/channels/signal
- https://docs.openclaw.ai/channels/feishu
- https://docs.openclaw.ai/channels/qqbot
- https://docs.openclaw.ai/channels
- https://bot.qq.com/
- https://www.whatsapp.com/legal/business-solution-terms?lang=en
- https://www.bbc.com/news/articles/cn8qj8wjgxwo
