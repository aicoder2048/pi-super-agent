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
- 只撤写草稿的那个。在跑宿主的机器上用 Google 的撤销接口撤掉它，token 不经过屏幕，打印 `200` 就是撤掉了：

  ```bash
  grep '^GMAIL_DRAFT_REFRESH_TOKEN=' <secretsFile> | cut -d= -f2- |
    curl -s -o /dev/null -w '%{http_code}\n' --data-urlencode token@- https://oauth2.googleapis.com/revoke
  ```

  之后 `draft-reply` 回一句「写草稿的授权失效了」。读邮件的 token 是不是跟着失效，要在时段 2 实测（计划 M7 lane 10），结果记在这里。
- 撤完把旧 Mac 和笔记本 `secretsFile` 里对应的行删掉。全部撤掉时再在模块页关掉 `mail`。
