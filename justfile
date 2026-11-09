# clean-slate：不加载全局 skills 和自动发现的扩展，只加载 -e 指定的扩展。
# 想带上全局 skills / 扩展时清空它：just clean= pi-pi-cn
clean := "--no-skills --no-extensions"

# 启动 Pi Pi 中文版（构建 Pi 组件的元智能体）。
pi-pi-cn:
    pi {{clean}} -e extensions/pi-pi-cn.ts

# 启动世界时间扩展，进入 Pi 后输入 /now。
now:
    pi {{clean}} -e extensions/now.ts

# 需要 Node.js 22.18+ 或 24+，以及已安装的 Pi（本地或全局依赖）。
test-now:
    node --test tests/now.test.mjs

# ---- Pi Super Agent ----
# 状态目录默认 ~/.pi-super-agent，可用 PSA_STATE_DIR 覆盖。
run := "node --import ./src/pi-runtime.mjs"

# 启动宿主（前台运行，日志写到 stderr）。日志里的「网页」网址在浏览器里打开就能看对话和看板。
host:
    {{run}} src/host/main.ts

# 启动 Watchdog：宿主没有心跳时把它拉起，任务卡住或动作连续失败时经 Router 通知你。
watchdog:
    {{run}} src/watchdog/main.ts

# 打开 TUI 客户端（Pi TUI 只当界面，输入转发给宿主）。
client:
    pi {{clean}} --no-session --no-context-files --tui-mode regular -e extensions/super-agent.ts

# 对 Super Agent 说一句话，打印之后两分钟内的回复。
say +text:
    {{run}} src/cli/say.ts say {{text}}

# 通过通用来源投递一条触发：just drop <来源> <线程> <正文>
drop source thread +body:
    {{run}} src/cli/drop.ts {{source}} {{thread}} {{body}}

# 玩具行情模块投递一条假行情：just toy-feed TOYX -5.2 12
toy-feed symbol="TOYX" change="-5.2" volume="12":
    {{run}} modules/toy-market/feed.ts {{symbol}} {{change}} {{volume}}

# 用真实行情接口取一次自选股快照，打印成表（不打印密钥）。密钥来自环境变量或 config.json 的 secretsFile。
market-smoke:
    {{run}} src/cli/market-smoke.ts

# 列出最近的触发和它们的去向：just log [条数]
log limit="30":
    {{run}} src/cli/log.ts {{limit}}

# 换网页 token：删掉状态目录里的 web-token，宿主下次启动生成新的。正在运行的宿主重启前沿用旧 token。
web-token-rotate:
    {{run}} src/cli/web-token-rotate.ts

# 持续显示对话。
tail:
    {{run}} src/cli/say.ts tail

# 内核、宿主组装点和其余全部自动测试。
test:
    {{run}} --test --test-timeout=30000 tests/*.test.ts tests/*.test.mjs

# 真实宿主、Worker 子进程和无头浏览器，模型换成 tests/e2e/fake-model.ts 的本地假模型，不请求任何真实模型或行情接口。
# 首次运行自动装 playwright-core 和浏览器。失败报告在 tests/e2e/.out/<测试>/index.html。
# 故意弄坏某一步：PSA_E2E_SABOTAGE="Router 回复" just e2e；让 Worker 崩溃：PSA_E2E_SABOTAGE="Worker 汇报:crash" just e2e
# 端到端测试（假模型 + 真实宿主 + 浏览器）。
e2e: _browser
    {{run}} --test --test-reporter=spec --test-timeout=90000 tests/e2e/*.e2e.ts

# 只跑一个：just demo 1-continuous。录屏和 summary.txt 在 demos/out/<名字>/。
# 演示 1 到 4（连续、高效、主动、持久）：有界面的浏览器，真实 openai-codex 模型（订阅），手动运行。
demo name="all": (_browser "chromium")
    #!/usr/bin/env bash
    set -u; status=0
    names=({{ if name == "all" { "1-continuous 2-efficient 3-proactive 4-durable" } else { name } }})
    for d in "${names[@]}"; do {{run}} "demos/demo-$d.mjs" || status=1; done
    for d in "${names[@]}"; do cat "demos/out/demo-$d/summary.txt" 2>/dev/null; done
    exit $status

# 行情密钥只经宿主的 secretsFile 读取：用 PSA_DEMO_SECRETS_FILE 指定 .env 路径，未指定时沿用 ~/.pi-super-agent/config.json 里的 secretsFile。
# 演示 5：真实美股行情模块（us-market），开盘时段运行；加 --dry 只跑开盘前一幕。
demo-market *flags: (_browser "chromium")
    {{run}} demos/demo-5-market.mjs {{flags}}

# 装依赖和浏览器；都装好时几乎不花时间。
_browser kind="chromium-headless-shell":
    @[ -d node_modules/playwright-core ] || npm ci --no-audit --no-fund --loglevel=error
    @npx --no-install playwright-core install {{kind}} >/dev/null
