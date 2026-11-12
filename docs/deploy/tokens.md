# 白宫的几把钥匙：哪些 token，怕什么，泄露了怎么办

给使用者看的备忘。白宫有三样东西叫 token，作用和风险各不一样。另有行情接口的密钥，放在同一个 `secretsFile` 里，处理方式和 Telegram 的 token 一样。

| 名字 | 在哪里 | 拿到它的人能做什么 | 谁能用得上 |
|---|---|---|---|
| 网页 token | 网址里的 `?token=…`；状态目录的 `web-token` | 看全部对话和任务，以你的身份发话、点卡片回答、放宽成员上限 | 只有连得上宿主的设备：本机，或你 tailnet 里的设备 |
| 终端 token | 状态目录的 `client-token` | 用 `just say`、`just tail` 这类终端客户端，以你的身份发话 | 只有本机上能读这个文件的人 |
| Telegram 机器人 token | `secretsFile` 里的 `TELEGRAM_BOT_TOKEN` | 冒充机器人给你发消息，抢先读走你发给机器人的话 | 任何人，Telegram 的服务器在公网上 |

## 网页 token：网址里那一串

网址 `https://<machine>.<tailnet>.ts.net/?token=<64 位十六进制>` 里，`token=` 后面那一串就是网页 token。宿主只认它，分不出拿着它的是不是你（ADR-0004）。

把这个网址发给别人，就是把钥匙给了别人。现在还有第二道门：`*.ts.net` 的网址只有加入你 tailnet 的设备才打得开，不在 tailnet 里的人拿到网址也打不开（ADR-0014）。但把谁拉进了 tailnet，或者以后换了别的开放方式，拿到网址的人就能直接进来。所以把它当密码对待：

- 不发给别人，不贴到聊天、工单和公开的地方。
- 截图前看一眼地址栏；带着网址的截图只给信得过的人。
- 宿主日志 `host.log` 里有这个网址，日志也别外传。
- token 在浏览器的历史记录里，这是有意接受的（ADR-0004）。别人能用你的手机或电脑时，要知道这一点。

### 怀疑泄露了就换一个

在宿主那台 Mac 上（或从笔记本 `ssh` 过去）：

```
cd <仓库目录>
just web-token-rotate
just service-uninstall && just service-install
grep '网页' ~/.pi-super-agent/host.log | tail -2
```

最后一行打出新的本机网址和远程网址。旧网址从此返回 401，手机和电脑上都换成新网址。没装成服务、是在终端里跑 `just host` 的，换完 token 按 Ctrl+C 再 `just host` 也一样。

## 终端 token：`client-token`

终端客户端靠它证明自己是你的（ADR-0007）。它不出现在任何网址和日志里，只在状态目录里，权限 0600。能读到它的人本来就能读你的状态目录，所以平时不用管它。要换的话，停掉宿主，删掉状态目录里的 `client-token`，再启动宿主，宿主会生成一个新的。

## Telegram 机器人 token

接入 Telegram 后，从 BotFather 拿到的 token 写在 `secretsFile` 里（见 `docs/deploy/telegram.md`）。它比网页 token 更要小心：Telegram 的服务器在公网上，没有 tailnet 这道门，任何人拿到它都能直接用。拿到的人可以：

- 冒充你的机器人给你发消息；
- 抢先拉取你发给机器人的消息，宿主就收不到了。

宿主这边的保护：token 只从 `secretsFile`（或环境变量）读，日志、报错、状态库、网页里都不会出现，也不传给 Worker（界面上叫助手，团队任务里是领队）。已知的缺口：带 `bash` 的 Worker 能直接读 `secretsFile` 这个文件，要等 Worker 沙箱才堵得上（ADR-0016）。

### 怀疑泄露了就作废

1. 在 Telegram 里找 @BotFather，发 `/revoke`，选你的机器人，旧 token 立刻作废，BotFather 给你一个新的。
2. 把新 token 换进 `secretsFile`。
3. 重启宿主：`just service-uninstall && just service-install`。

## 一句话

网页 token 和机器人 token 都按密码对待：不转发，不截图外传，怀疑泄露就换。网址发给别人，就等于把白宫的钥匙交给了别人。
