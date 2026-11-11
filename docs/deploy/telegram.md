# 在 Telegram 里和白宫对话

宿主里跑一个 Telegram 机器人，作为网页和终端之外的第三个客户端。机器人用长轮询向 Telegram 取消息，宿主不开任何端口。只有 `config.json` 名单上的数字 id、在私聊里，才算你；其他人和群里的消息在进宿主之前就丢掉。规则和风险见 ADR-0016。

下面的命令都在仓库目录里运行。状态目录默认是 `~/.pi-super-agent`，设了 `PSA_STATE_DIR` 就是那个目录。

## 1. 建机器人

1. 在 Telegram 里找 `@BotFather`，发 `/newbot`，按提示起名字和用户名（用户名以 `bot` 结尾）。
2. BotFather 回一个 token，形如 `123456789:AA...`。冒号前的数字是机器人的 id，整串是密码，不要发给别人，不要贴进聊天或截图。

## 2. 放 token

token 只放在宿主的 `secretsFile` 或环境变量 `TELEGRAM_BOT_TOKEN` 里，不放 `config.json`。

如果 `config.json` 已经有 `secretsFile`（比如放行情密钥的 `.env`），在那个文件里加一行；没有就在状态目录里新建 `secrets.env`：

```
TELEGRAM_BOT_TOKEN=123456789:AA...
```

```bash
chmod 600 ~/.pi-super-agent/secrets.env
```

环境变量和 `secretsFile` 里都有时，用环境变量里的。

## 3. 用设置模式找到你的数字 id

在状态目录的 `config.json` 里加上 `telegram` 段，名单先留空：

```json
{
  "secretsFile": "secrets.env",
  "telegram": { "allowedUserIds": [] }
}
```

重启宿主：前台运行的按 Ctrl+C 再 `just host`；装了 LaunchAgent 的运行 `just service-uninstall && just service-install`。日志里出现：

```
[telegram] bot token 来自secretsFile …/secrets.env
[telegram] 名单为空：只告诉来信的人他自己的数字 id，不把任何消息交给幕僚长
[telegram] 已连上 @你的机器人，设置模式
```

在手机上打开机器人，点「开始」或随便发一句。机器人回：

```
你的 Telegram 数字 id 是 987654321。把这个数字写进宿主状态目录里 config.json 的 telegram.allowedUserIds，重启宿主后就能在这里和幕僚长对话。
```

设置模式下谁私聊都会收到他自己的 id，每个聊天一次；任何消息都不交给幕僚长。

## 4. 写进名单

```json
{
  "secretsFile": "secrets.env",
  "telegram": { "allowedUserIds": [987654321] }
}
```

名单里是正整数，不重复。群和频道的 id 是负数，写进去宿主会拒绝启动。重启宿主，日志里出现：

```
[telegram] 已连上 @你的机器人，名单 1 人
```

## 5. 之后

- 你在机器人里打的字就是对幕僚长说的话，和网页、终端是同一个对话。
- 幕僚长的回复发到这里，带通知。
- 你在网页或终端说的话也静默转过来，前面写「你在网页或终端说：」，手机不响。
- 只收文字。图片、语音、转发的消息不交给幕僚长，机器人回一句说明。
- `/start` 和 `/help` 回一段说明。
- 不在名单里的人、群里的消息一律丢掉，不回复。日志最多每小时一行，只写丢了几条。
- 宿主停着时你发的话不会丢：Telegram 替你存着（最多 24 小时），宿主启动后取回，每句只进对话一次。
- Telegram 连不上时，网页和终端照常；没发出去的回复按顺序等着，连上后补发，每条一次。

问题卡片的按钮和滑动回复引用在后续版本里加。成员上限只能在网页或终端的「待你处理」里放宽。

## 关掉、换 token

- **关掉**：删掉 `config.json` 里的 `telegram` 段，重启宿主。
- **换 token**：在 BotFather 里对这个机器人发 `/revoke`，把新 token 写进 `secretsFile`，重启宿主。同一个机器人换 token，聊天记录和取消息的位置都保留。换成另一个机器人时，宿主清掉旧机器人的全部 Telegram 记录。
- **从名单里去掉一个 id**：改 `config.json`，重启宿主。宿主删掉这个聊天的记录，之后它发的消息按陌生人处理。

## 日志里的几种情况

| 日志 | 意思 | 怎么办 |
|---|---|---|
| 启动时报「写了 telegram 段，但环境变量和 secretsFile 里都没有 TELEGRAM_BOT_TOKEN」 | 宿主没启动。 | 按第 2 步放 token。 |
| 启动时报「TELEGRAM_BOT_TOKEN（…）格式不对」或「…含有空白或非 ASCII 字符」 | 宿主没启动，报错里不带 token。 | 从 BotFather 重新复制，不要多出空格。 |
| `Telegram 拒绝了 bot token（401），Telegram 客户端已停用` | token 被撤销或抄错。网页和终端照常。 | 换 token 后重启宿主。 |
| `取消息失败（另一处在用同一个 bot token 取消息，或这个机器人设了 webhook）` | 另一台机器上的宿主在用同一个 token，或这个机器人设过 webhook。宿主每 30 秒重试。 | 停掉另一处；宿主不会替你删 webhook。 |
| `发消息失败（…），N 秒后重试` | Telegram 暂时连不上或要求限流。 | 不用管，恢复后自动补发。 |
| `一个聊天屏蔽了机器人` | 你在 Telegram 里屏蔽或删除了机器人。 | 解除屏蔽后发一句，之后的回复照常发；屏蔽期间的不补发。 |

## 安全

- 对话会经过 Telegram 的服务器，机器人聊天不是端到端加密的。执行过程、看板细节和成员的输出不发。
- 宿主里能读 `secretsFile` 的东西都能拿到 token。有 `bash` 的助手目前也能读到（ADR-0016 的已知风险），拿到 token 的人能抢先取走你发给机器人的消息。怀疑泄露时立刻在 BotFather 里 `/revoke`。
- Telegram 账号被盗等于有人冒充你。给 Telegram 开两步验证。
