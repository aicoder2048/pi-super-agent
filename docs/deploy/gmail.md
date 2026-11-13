# 让白宫读你的 Gmail

授权在你自己的 Google Cloud 项目里做，一次一个 scope，refresh token 只放在宿主的 `secretsFile` 里。读邮件的 token（`gmail.readonly`）给 `mail` 模块，写草稿的 token（`gmail.compose`）只在宿主手里，模块代码拿不到。规则见 ADR-0019。

下面的命令都在仓库目录里运行。状态目录默认是 `~/.pi-super-agent`，设了 `PSA_STATE_DIR` 就是那个目录。

## 1. 建 Cloud 项目和 OAuth 客户端

在笔记本的浏览器里做，约 15 分钟（推断）。按钮名照 2025 年的 Google Auth Platform 控制台写，界面改了名时以界面为准。

1. 打开 `https://console.cloud.google.com/projectcreate`，**Project name** 写 `psa-mail`，点 **Create**。完成时控制台左上角的项目选择器显示 `psa-mail`。
2. 左侧菜单 **APIs & Services** > **Library**，搜 `Gmail API`，点进去，点 **Enable**。完成时页面显示 **API Enabled**。
3. 左侧菜单 **Google Auth Platform** > **Branding**，点 **Get started**。**App name** 写 `PSA mail`，**User support email** 选自己，点 **Next**。**Audience** 选 **External**，点 **Next**。**Contact information** 写自己的邮箱，点 **Next**，勾选同意条款，点 **Create**。
4. **Google Auth Platform** > **Audience**。在 **Test users** 下点 **Add users**，加自己的 Gmail 地址，点 **Save**。然后在 **Publishing status** 下点 **Publish app**，确认。完成时页面写着 **In production**。不送审。测试状态下 refresh token 7 天过期，所以一定要改成生产。
5. **Google Auth Platform** > **Clients**，点 **Create client**。**Application type** 选 **Desktop app**，**Name** 写 `psa-laptop`，点 **Create**。弹窗里有 **Client ID** 和 **Client secret**，先别关。
6. 用编辑器打开 `config.json` 的 `secretsFile` 指的那个 `.env`，加两行，保存，再关掉弹窗。不要贴进聊天或 Telegram。

   ```
   GOOGLE_OAUTH_CLIENT_ID=<Client ID>
   GOOGLE_OAUTH_CLIENT_SECRET=<Client secret>
   ```

   完成时 `grep -c '^GOOGLE_OAUTH_CLIENT_' <secretsFile>` 打印 `2`。`config.json` 还没有 `secretsFile` 时，在状态目录里新建 `secrets.env`，`chmod 600` 它，在 `config.json` 里加 `"secretsFile": "secrets.env"`。
7. **Data Access** 页不用加 scope。授权时浏览器会显示「Google 尚未验证此应用」，点 **Advanced**（「高级」），再点 **Go to PSA mail (unsafe)**。

## 2. 授权

### 在笔记本上

```bash
just google-auth read
```

命令打印一个网址。在浏览器里打开，用要授权的 Google 账号登录，点过「未验证」提示，同意。浏览器回到 `127.0.0.1` 上的一页，写着「已写入」。终端打印：

```
已写入 secretsFile 的 GMAIL_READ_REFRESH_TOKEN（gmail.readonly）
```

`secretsFile` 里多了这一行，别的行不变，文件权限是 600。token 和授权码不出现在屏幕上。写草稿的 token 同样做一次：

```bash
just google-auth draft
```

5 分钟里没回到 `127.0.0.1` 就退出，什么都不写，再跑一次就好。Google 给的 scope 不正好是申请的那一个，或者没给 refresh token，命令也拒绝，一行写明怎么办。

看 token 还能不能用（只调 Google 的 token 接口，不读邮件）：

```bash
just google-auth read --check
```

```
GMAIL_READ_REFRESH_TOKEN 能换到 access token（gmail.readonly，3599 秒内有效）
```

### 给旧 Mac（默认：笔记本上授权，复制三行）

旧 Mac 没有浏览器。在笔记本上跑完 `just google-auth read`，把 OAuth 客户端和读邮件的 token 三行直接经 ssh 写进旧 Mac 的 `secretsFile`，token 不经过终端屏幕。旧 Mac 上同名的旧行先删掉再写新的，别的行不动，文件末尾没有换行也不会粘到上一行，重跑一次文件不变；`secretsFile` 路径写错时退出 1，不新建文件：

```bash
grep -E '^(GOOGLE_OAUTH_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET|GMAIL_READ_REFRESH_TOKEN)=' <笔记本的 secretsFile> |
  ssh <旧 Mac> 'f=<旧 Mac 的 secretsFile>
new=$(cat); [ -f "$f" ] && [ -n "$new" ] || exit 1
names=$(printf "%s\n" "$new" | cut -d= -f1 | paste -s -d "|" -)
t=$(mktemp) || exit 1
{ grep -Ev "^[[:space:]]*(export[[:space:]]+)?($names)[[:space:]]*=" "$f"; printf "%s\n" "$new"; } > "$t" && cat "$t" > "$f"
rm -f "$t"'
```

然后在旧 Mac 上看一次：

```bash
ssh <旧 Mac> 'cd <旧 Mac 上的仓库> && just google-auth read --check'
```

写草稿的 token 用同一条命令复制，只把第一行换成 `grep -E '^GMAIL_DRAFT_REFRESH_TOKEN=' <笔记本的 secretsFile> |`。这一行由旧 Mac 上的宿主读，`mail` 模块的代码拿不到（ADR-0022）。复制后在旧 Mac 上看一次 `just google-auth draft --check`。

复制完，笔记本 `secretsFile` 里 token 那一行默认删掉（计划 Appendix E 第 3 条），笔记本上不跑宿主就用不到它。

### 给旧 Mac（另一条路：在旧 Mac 上授权，转发端口）

什么都不用复制。在旧 Mac 上开一个固定端口：

```bash
ssh <旧 Mac> 'cd <旧 Mac 上的仓库> && just google-auth read --port 8765'
```

另开一个笔记本终端，把笔记本的 8765 转到旧 Mac：

```bash
ssh -N -L 8765:127.0.0.1:8765 <旧 Mac>
```

在笔记本的浏览器里打开第一个终端打印的网址。授权完浏览器回到 `127.0.0.1:8765`，经转发到了旧 Mac 上的命令，token 写进旧 Mac 的 `secretsFile`。

### 撤销

- 全部撤掉。到 `https://myaccount.google.com/connections` 找到 `PSA mail`，删除它的访问权限，两个 token 一起失效。
- 撤写草稿的那个。在跑宿主的机器上用 Google 的撤销接口撤掉它，token 不经过屏幕，打印 `200` 就是撤掉了：

  ```bash
  grep '^GMAIL_DRAFT_REFRESH_TOKEN=' <secretsFile> | cut -d= -f2- |
    curl -s -o /dev/null -w '%{http_code}\n' --data-urlencode token@- https://oauth2.googleapis.com/revoke
  ```

  撤销接口撤的是整份授权，不只是这一个 token。2026-11-13 时段 2 实测（计划 M7 lane 10），撤掉写草稿的 token 以后，读邮件的 token 也跟着失效，`just google-auth read --check` 回 `400 invalid_grant`。所以撤哪一个都等于两个一起撤，`draft-reply` 回一句「写草稿的授权失效了」，`inbox` 也不再收信。要接着用，两个都重新授权，跑 `just google-auth read` 和 `just google-auth draft`，把两行都换掉。
- 撤完把旧 Mac 和笔记本 `secretsFile` 里对应的行删掉。全部撤掉时再在模块页关掉 `mail`。

## 3. 在旧 Mac 上线

旧 Mac 是一直开着的宿主。照这一节从头做到尾，`mail` 就在旧 Mac 上跑起来，名单上的人来信时手机响三行。全程约 60 分钟（推断），一半是等信。要你本人做的是第 4 步复制密钥、第 7 步给名单、第 8 步看手机，其余几步协调会话可以替你跑。旧 Mac 上的写操作只在你说「部署」以后做。

标「笔记本」的命令在笔记本的仓库目录跑。标「旧 Mac」的命令先 `ssh <旧 Mac>` 登录，再 `cd <旧 Mac 上的仓库>`。要用登录 shell，`just`、`uv` 和 nvm 的 Node 才在 `PATH` 上。状态目录是 `~/.pi-super-agent`。

**这一次顺带部署 R2b 和 R3。** `just redeploy` 把旧 Mac 换到当时的 `main`。`main` 上除了 M1 到 M7，还有 us-market 退休计划的 R2b（盘面专家和只读的 `intraday` 工具）和 R3（风险计划查下一次财报日）。退休计划写的是这两个跟着下一次部署走，所以就是这一次。第 3 步有它们的快速检查。R5、R6 还没合并，这一次不删 `sources.us-market`。代码里新加的只有 `run_asks` 一张表（批准卡片），不改已有的表，所以回退不用恢复数据库。

### 0. 预检（旧 Mac，只读）

挑美东 16:20 以后或周末做，切换时没有盘中行情。

```bash
git rev-parse --short HEAD
git status --short
just modules
just service-status
```

记下第一行的 SHA，回退时要用。`git status --short` 应该什么都不打印，否则第 2 步的快进会停下。`just modules` 里 stock-ta、module-builder、pi-pi 运行中，us-market、toy-market 已停用，还没有 `mail`。`just service-status` 写着运行中，心跳在一分钟以内。

再在 Telegram 上问一句「NVDA 的支撑阻力在哪」，记下从发问到收到汇报的分钟数和汇报里的数据时间。第 3 步换完代码后再问一次，两次都要有汇报和数据时间（旧 Mac 上一份技术分析汇报约两分钟）。

### 1. 备份（旧 Mac）

```bash
b=~/psa-backup-$(date +%Y%m%d-%H%M) && mkdir -p "$b" && chmod 700 "$b"
cp -p ~/.pi-super-agent/config.json "$b"/
s=$(python3 -c 'import json,os; d=os.path.expanduser("~/.pi-super-agent"); print(os.path.join(d, json.load(open(d+"/config.json"))["secretsFile"]))')
echo "密钥文件 $s"
cp -p "$s" "$b"/secrets.env
sqlite3 ~/.pi-super-agent/state.db ".backup $b/state.db"
sqlite3 ~/.pi-super-agent/modules-data/stock-ta/data.db ".backup $b/stock-ta-data.db"
ls -l "$b"
```

`ls` 列出四个文件，`secrets.env` 的权限是 `-rw-------`。记下 `$b` 的路径和「密钥文件」那一行的路径，第 4 步要用后者。`secrets.env` 只为第 4 步写坏密钥文件时恢复用，第 5 步通过以后删掉它（`rm "$b"/secrets.env`）。

### 2. 换代码（旧 Mac）

```bash
just redeploy
cp -R docs/modules/examples/stock-ta ~/.pi-super-agent/modules/
just module setup stock-ta
just modules
```

`just redeploy` 打印「版本：」和 `main` 的最新提交，最后是运行中和新的心跳。stock-ta 的 Python 钉的提交没变，`just module setup stock-ta` 什么都不装。`just modules` 里 stock-ta 的版本散列和第 0 步的不一样（包里多了盘面专家和两个工具），宿主几秒内换上，不用重启。

```bash
just notify "M8 部署：代码已换上"
```

手机上收到这一行就说明 Telegram 通。

### 3. R2b、R3 的快速检查（Telegram 和网页）

- **R2b。** 网页上 stock-ta 的专家队显示 6 位，多了「盘面」。在 Telegram 上问「NVDA 今天的走势是它自己的事还是板块的事」，汇报里有 NVDA、SPY、QQQ 和一只板块 ETF 的涨跌幅和差值，有当天走势的时间段，有数据时间。
- **R3。** 在 Telegram 上问「NVDA 在 170 进、160 止损、190 目标，怎么看」，风险计划那段有一行财报日和跳空风险，或者一行「下一次财报在 <日期>，不在持有期内」。写的是「没查到财报日」时，旧 Mac 的密钥文件里多半没有 `FINNHUB_API_KEY`（us-market 以前用的就是它，推断还在），照第 4 步的命令把这一行也复制过去。
- **回归。** 再问一次第 0 步那句「NVDA 的支撑阻力在哪」，有汇报、有数据时间。

旧 Mac 的 CPU 慢，每份专家汇报约两分钟，三句可以一起发。

### 4. 复制四行密钥（笔记本，你本人跑）

先看笔记本上的 token 还能不能用：

```bash
just google-auth read --check
just google-auth draft --check
```

两行都打印「…能换到 access token」就往下走。打印「Google 拒绝了 …：invalid_grant」，说明时段 2 撤销以后还没重新授权，照第 2 节跑 `just google-auth read` 和 `just google-auth draft`，再查一次。

然后把 OAuth 客户端、读邮件的 token、写草稿的 token 四行经 ssh 写进旧 Mac 的密钥文件。命令和第 2 节「给旧 Mac」那条相同，只是一次带四个名字。token 不经过屏幕，同名旧行先删再写，重跑不变：

```bash
grep -E '^(GOOGLE_OAUTH_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET|GMAIL_READ_REFRESH_TOKEN|GMAIL_DRAFT_REFRESH_TOKEN)=' <笔记本的 secretsFile> |
  ssh <旧 Mac> 'f=<旧 Mac 的 secretsFile>
new=$(cat); [ -f "$f" ] && [ -n "$new" ] || exit 1
names=$(printf "%s\n" "$new" | cut -d= -f1 | paste -s -d "|" -)
t=$(mktemp) || exit 1
{ grep -Ev "^[[:space:]]*(export[[:space:]]+)?($names)[[:space:]]*=" "$f"; printf "%s\n" "$new"; } > "$t" && cat "$t" > "$f"
rm -f "$t"'
echo "退出码 $?"
```

打印「退出码 0」。`<旧 Mac 的 secretsFile>` 写第 1 步打印的「密钥文件」路径，原样写绝对路径，不要写 `~`，它在单引号里不展开。

不想让旧 Mac 写草稿，就从第一行去掉 `|GMAIL_DRAFT_REFRESH_TOKEN`。那样 `mail` 照常收信、读附件，`draft-reply` 回「还没授权写草稿」，第 8 步的 c 跳过。见计划 Appendix E 第 13 条。

`FINNHUB_API_KEY` 要复制时，单独跑一次同样的命令，第一行换成 `grep -E '^FINNHUB_API_KEY=' <笔记本的 secretsFile> |`。

### 5. 在旧 Mac 上看 token（旧 Mac）

```bash
just google-auth read --check
just google-auth draft --check
```

```
GMAIL_READ_REFRESH_TOKEN 能换到 access token（gmail.readonly，3599 秒内有效）
GMAIL_DRAFT_REFRESH_TOKEN 能换到 access token（gmail.compose，3599 秒内有效）
```

两行都对，删掉第 1 步备份里的 `secrets.env`。打印「secretsFile 里没有 …」是第 4 步的路径写错了，打印 `invalid_grant` 是笔记本上的 token 已经失效，回第 4 步。

### 6. 装 mail 并打开（旧 Mac）

```bash
cp -R docs/modules/examples/mail ~/.pi-super-agent/modules/
just module setup mail
just module check ~/.pi-super-agent/modules/mail
just module on mail
```

`just module setup mail` 用 `uv` 装读 PDF 的环境（只有 `pypdf`），打印环境所在的 `venv-<12 位>` 目录。`just module check` 打印一行 ok。`just module on mail` 以后几秒内跑第一拍，网页和 Telegram 上各出一条「邮件：邮件名单是空的……」。名单空着的时候模块不请求 Gmail。

### 7. 加邮件名单（网页，你本人说）

在网页的对话里贴你批准的那份名单，一行一个，域名写成 `@<域名>`：

```
把下面这些加进 mail 的邮件名单，备注写「上线时加入」：
<地址 1>
<地址 2>
@<域名>
```

也可以在旧 Mac 上一次说完：`just say "把下面这些加进 mail 的邮件名单，备注写「上线时加入」：<地址 1>、<地址 2>、@<域名>"`。名单是 `shareable`，助手的汇报可能把地址发到 Telegram（计划 Appendix E 第 9 条）。

在笔记本上核对，地址不上屏幕，打印 `0` 就是一行不差：

```bash
ssh <旧 Mac> 'sqlite3 -readonly ~/.pi-super-agent/modules-data/mail/data.db "select lower(trim(address)) from senders where removedAt is null"' | sort -u > /tmp/senders-old-mac.txt
grep -v '^#' <你批准的名单文件> | tr 'A-Z' 'a-z' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep . | sort -u | comm -3 - /tmp/senders-old-mac.txt | wc -l
rm /tmp/senders-old-mac.txt
```

两件事先知道：

- **第一拍会补最近一天的信。** 名单有了以后的第一拍（5 分钟以内）取 Gmail 当前的位置当起点，再补最近 24 小时里名单上的人的来信，每封响一次。昨天有好几封的话，手机会连着响几次。
- **名单只认 `From` 里的那个地址。** 同一个人有几个地址（例如 QQ 邮箱的数字地址和英文别名）时，每个都要加（时段 1 实测）。

### 8. 手机上的检查（你本人做，约 30 分钟）

顺序随意。读过信的正文以后，幕僚长在 Telegram 上的回复照样是全文（ADR-0023）。

- **a. 来信响三行。** 从名单上的另一个邮箱给自己的 Gmail 发一封信，主题写 `PSA 上线测试 <时刻>`，正文第一句写 `测试链接 https://example.com/x ，看手机上有没有预览卡片。` 记下发信时刻。通过的样子是 10 分钟内手机响一次，三行依次是显示名和地址、主题、开头一句，没有链接预览卡片，网页上同样三行。截图，记下发信到响铃的分钟数。
- **b. 幕僚长回全文。** 信到以后在 Telegram 上问「NVDA 现在多少」。回复是完整的价格回答，不是「请在网页上查看」那一行。
- **c. 写回信草稿。** 在网页上说「回那封 PSA 上线测试的信，说收到了，谢谢」。网页上出一条「邮件（只在本机）」的收据，写着「已写好回信草稿，没有发送」、收件人、主题和草稿箱链接；Telegram 上没有这条收据。打开 Gmail，草稿箱里有这封草稿，在原来的会话里，已发送里没有它。看完自己删掉草稿。
- **d. 读 PDF 附件。** 从名单上的邮箱再发一封信，附一个几页的文字 PDF。手机响了以后在网页上问「那封带 PDF 的信，附件里写了什么」。汇报引用了 PDF 里的文字。在旧 Mac 上看工具用了多久，最后一个数字是毫秒，要小于 20000：

  ```bash
  grep 'mail tools/read-attachment' ~/.pi-super-agent/host.log | tail -3
  ```

做完以后，测试信可以在 Gmail 里删掉，`messages` 里存的那几行留着不碍事。

### 9. 撤销演练（可选，约 10 分钟）

默认不做。时段 2 已经在笔记本上证明撤销任何一个都会两个一起失效，网页和 Telegram 上的授权失效通知由 fixtures 测过。想在旧 Mac 上亲眼看一次，就做这一步（计划 Appendix E 第 14 条）：

1. 到 `https://myaccount.google.com/connections` 删掉 `PSA mail` 的访问权限。
2. 5 分钟以内，网页和 Telegram 上各出一条「邮件：Gmail 授权失效了……」。在网页上让任务回一封已存的信，回复写「写草稿的授权失效了」。
3. 在笔记本上重跑 `just google-auth read` 和 `just google-auth draft`，再跑第 4 步的复制命令和第 5 步的检查。下一拍恢复收信，中间的信不丢（不超过一天）。

### 10. 回退（旧 Mac）

`mail` 出问题、别的都好时，只关它：`just module off mail`。收信停下，已存的信留着，`just module on mail` 再开。

整次部署要退回去时：

```bash
just module off mail
mv ~/.pi-super-agent/modules/mail ~/psa-mail-package-off
git checkout <第 0 步记下的 SHA>
rm -rf ~/.pi-super-agent/modules/stock-ta && cp -R docs/modules/examples/stock-ta ~/.pi-super-agent/modules/
just redeploy --no-pull
just modules
```

旧代码不认 `mail` 包里的新字段，所以先关掉、挪出模块目录。stock-ta 包先删再从旧 SHA 复制，免得 R2b、R3 的文件留在旧包里；它的数据在 `modules-data/stock-ta/`，删包不删数据。`state.db` 和 stock-ta 的 `data.db` 这一次只多了一张表，不用恢复；它们坏了时才从第 1 步的备份恢复（先 `just service-uninstall`，`cp` 回去，再 `just service-install`）。密钥文件里新加的四行旧代码用不到，留着无害。修好以后回到 `main`：`git checkout main && just redeploy`，再从第 6 步做起。

## 4. 出问题怎么办

| 看到的 | 原因 | 怎么办 |
|---|---|---|
| 邮件：Gmail 授权失效了…… | 撤销过授权、改过 Google 密码，或半年没用 | 笔记本上重跑 `just google-auth read` 和 `just google-auth draft`，再跑第 3 节第 4、5 步。两个 token 撤一个就两个都失效，所以两个都换 |
| 邮件：邮件名单是空的…… | 名单上没有有效的地址 | 在对话里加发件人，见第 3 节第 7 步 |
| 邮件：有 N 小时没查…… | 宿主停过一天以上 | 模块已补最近一天的信，更早的去 Gmail 里看 |
| 「PDF 有密码，读不了」 | 附件 PDF 加了密码（银行对账单常见） | 这一版不读，在 Gmail 里打开看（计划 Appendix E 第 6 条） |
| 「附件下载超时」 | 旧 Mac 10 秒内没下载完附件 | 换个时候再问一次；常超时就把附件上限降到 5 MB（计划 Appendix E 第 11 条） |
| 来信了，手机没响 | 发件人不在名单上，或 `From` 用的是名单上没有的别名 | 在网页上问「mail 的邮件名单有哪些」，把那个地址加进去 |
| 「写草稿的授权失效了」或「还没授权写草稿」 | 写草稿的 token 失效或没复制 | 笔记本上 `just google-auth draft`，再按第 3 节第 4 步复制 |

宿主日志里每一拍有一行，看最近几拍：

```bash
grep 'mail/inbox' ~/.pi-super-agent/host.log | tail -5
```

## 5. 上线满 8 天以后

Google 只写了测试状态的应用 refresh token 7 天过期，生产状态、没送审的应用有没有期限没写（`docs/multi-channel/research.md` 第 9 节）。从最后一次授权那天算起满 8 天以后，在旧 Mac 上跑：

```bash
just google-auth read --check
just google-auth draft --check
grep 'mail/inbox' ~/.pi-super-agent/host.log | tail -3
```

两行都「能换到」、最近几拍没有失败，就把结果写进 research.md 第 9 节。打印 `invalid_grant` 时，按第 4 节重新授权，并把「生产状态也会过期」写进去。
