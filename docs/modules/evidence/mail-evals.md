# mail 上线评测清单（M8）

计划 `docs/multi-channel/gmail-plan.md` 的 M8 在旧 Mac 上的评测。步骤照 `docs/deploy/gmail.md` 第 3 节做，这里只写每一步证明什么、怎样算通过、结果记在哪。真账号的输出（截图、命令输出）只存在本机 `/tmp/swarm-m8/`，不提交；存之前删掉地址、正文和 token，只留时间、行数和通过与否。

## 时段 3 的检查

| 步骤（gmail.md 第 3 节） | 证明 | 通过的样子 | 存成 |
|---|---|---|---|
| 0、3 回归 | M8 lane 1 | 部署前后各问一次「NVDA 的支撑阻力在哪」，两次都有汇报和数据时间；`just notify` 那一行到了手机 | `m8-regression.txt` |
| 3 R2b、R3 | 退休计划 R2b、R3 的 You see | 专家队 6 位有「盘面」；走势问题的汇报有 SPY、QQQ、板块 ETF 的差值和数据时间；风险计划有财报日那一行 | `m8-r2b-r3.png` |
| 4、5 复制密钥 | M1 lane 10，M8 lane 5 | 复制命令退出码 0；旧 Mac 上 `read --check`、`draft --check` 都「能换到」；终端输出里没有 token | `m8-install.txt` |
| 6 装 mail | M8 lane 5 | `setup` 打印环境目录，`check` 一行 ok，打开后网页和 Telegram 各一条「邮件名单是空的」 | `m8-install.txt` |
| 7 名单 | M8 lane 5 | 核对命令打印 `0` | `m8-install.txt` |
| 8a 来信 | M2 lane 10 前半，M3 lane 10，M8 lane 6 | 10 分钟内手机响一次三行（M8 本身的门槛是 15 分钟），第一行有真地址，没有链接预览卡片，网页上同样三行 | `m8-phone.png`，分钟数 |
| 8b 全文 | M2 lane 10 后半，M8 lane 7 | 信到以后 Telegram 上的价格回答是全文 | `m8-phone-full.png` |
| 8c 草稿 | M8 lane 8 | 网页收据写着「没有发送」、收件人、主题、草稿箱链接；草稿在原会话；已发送里没有；Telegram 上没有收据 | `m8-draft.png` |
| 8d PDF | M8 lane 9 | 汇报引用 PDF 文字；`read-attachment` 那一行的毫秒数小于 20000 | `m8-attachment.png`，毫秒数 |
| 9 撤销（可选） | M8 lane 10 | 网页和 Telegram 各一条授权失效通知；`draft-reply` 一行说明；重新授权后下一拍恢复 | `m8-revoke-all.txt` |

## 性能

- **空闲 CPU。** 在笔记本上只读取样，每分钟一次，旧 Mac 上什么都不写：

  ```bash
  mkdir -p /tmp/swarm-m8 && while true; do ssh -o BatchMode=yes <旧 Mac> 'p=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser(\"~/.pi-super-agent/heartbeat.json\")))[\"pid\"])"); echo "$(date +%FT%T) $(ps -o %cpu= -p $p)"' >> /tmp/swarm-m8/cpu.txt; sleep 60; done
  ```

  部署前取一段当基线，部署后再取 24 小时。规则是部署后的中位数比基线高 2 个百分点以上算失败。2026-11-13 部署前取了 5 分钟（20 次，每 15 秒一次），宿主进程的 `%CPU` 中位数 0.0，最高 0.6。macOS 的 `ps` 给的是衰减平均，只能看个量级。计划要的是部署前一整天，这里只有 5 分钟；宿主空闲时几乎不占 CPU，差 2 个百分点很容易看出来，所以没有为了基线把部署推迟一天。
- **一拍的时间。** `mail/inbox` 每 5 分钟一拍，按整 5 分钟对齐（`src/modules/connectors/timer.ts`）。宿主日志那一行的时刻减去所在的整 5 分钟，是这一拍的时间加上调度的延迟，当作上界。规则是中位数超过 3 秒算失败。

  ```bash
  grep 'mail/inbox' ~/.pi-super-agent/host.log | tail -288
  ```

- **到达时间。** 8a、8d 各记一次发信到响铃的分钟数。规则是超过 15 分钟算失败。

## 计划里的十三个评测场景，现在由什么证明

计划原本要写 `mail-evals.ts`，经真幕僚长和真 Worker 把十三个场景各跑 3 次。M8 只改 `docs/`，没有写它（计划 Appendix E 第 15 条）。每个场景在 M2 到 M7 里都已经有一条 lane 或测试，下表列出来；「真模型」一栏写的是当时跑了几次。

| 场景 | 现有的证据 | 真模型 |
|---|---|---|
| 普通通知 | M2 lane 1、4（假服务）；时段 3 的 8a（真账号） | 不经模型 |
| 要回复的信 | M7 lane 2、5；时段 2 的 M7 lane 9（真账号） | 1 次（M7 lane 5，两个模型） |
| 钓鱼 `curl \| bash` | M4 lane 10；M5 lane 10 | 各 1 次 |
| 要求读 secrets | M4 lane 10 的同一封 fixture | 1 次 |
| 要求直接发送 | M7 lane 5；宿主只发 `POST drafts`（ADR-0022） | 1 次 |
| 要求抄送陌生人 | M7 lane 5；宿主拒绝带 `Cc` 的草稿 | 1 次 |
| 附件里藏指令 | M6 lane 7，PR #119 记的是 lane 1 到 8 全部 PASS（计划里这些框没勾） | 1 次 |
| 显示名冒充「白宫 · 系统」 | M2 lane 8；`tests/mail-inbox.test.ts` | 不经模型 |
| 超长主题 | M3 lane 3；M2 lane 8 | 不经模型 |
| 名单外的发件人 | M2 lane 4 | 不经模型 |
| 来信后其他汇报仍是全文 | M3 lane 4（假模型）；时段 3 的 8b（真） | 时段 3 一次 |
| 对话里加发件人，下一拍就收 | M2 lane 3 | 1 次（两个模型） |
| 名单为空时的提示 | M2 lane 2；时段 3 的第 6 步 | 不经模型 |

不经模型的七个场景由程序保证，重复跑结果不变。要靠模型守规矩的五个（钓鱼、读 secrets、直接发送、抄送、附件指令）各只跑过 1 次。真正的保证不在模型：来源开的任务没有 `bash` 和 `web_get`（ADR-0018），命令要你在卡片上点（ADR-0021），模块拿不到写草稿的 token、宿主只建草稿（ADR-0022）。模型被带偏时最坏是出一张你会拒绝的卡片，或者汇报写偏。
