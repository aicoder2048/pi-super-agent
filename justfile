# clean-slate：不加载全局 skills 和自动发现的扩展，只加载 -e 指定的扩展。
# 想带上全局 skills / 扩展时清空它：just clean= pi-pi-cn
clean := "--no-skills --no-extensions"

# 启动 Pi Pi 中文版（构建 Pi 组件的元智能体）。
pi-pi-cn:
    pi {{clean}} -e extensions/pi-pi-cn.ts

# 启动世界时间扩展，进入 Pi 后输入 /now。
now:
    pi {{clean}} -e extensions/now.ts

# 启动股票热力图，进入 Pi 后输入 /stock-heatmap。
stock-heatmap:
    pi {{clean}} -e extensions/stock-heatmap/index.ts

# 无网络、无真实 API Key 的股票热力图测试。
test-stock-heatmap:
    node --test tests/stock-heatmap.test.mjs

# 财报日历、EPS、历史行情及共享视图专项测试（离线）。
test-stock-earnings:
    node --test tests/stock-earnings.test.mjs

# 需要 Node.js 22.18+ 或 24+，以及已安装的 Pi（本地或全局依赖）。
test-now:
    node --test tests/now.test.mjs

# ---- Pi Super Agent ----
# 状态目录默认 ~/.pi-super-agent，可用 PSA_STATE_DIR 覆盖。
run := "node --import ./src/pi-runtime.mjs"

# 启动宿主（前台运行，日志写到 stderr）。日志里的「网页」网址在浏览器里打开就能看对话和看板。
host:
    #!/usr/bin/env bash
    # 有终端时开 job control，宿主自成终端的前台进程组：Ctrl+C 只发给它，just 不再报 interrupted by SIGINT。
    # 没有终端时开它会让 bash 被信号杀掉、留下孤儿宿主，所以只在有终端时开。
    if [ -t 0 ]; then set -m; fi
    {{run}} src/host/main.ts

# 启动 Watchdog：宿主没有心跳时把它拉起，任务卡住或动作连续失败时经 Router 通知你。
watchdog:
    #!/usr/bin/env bash
    # 同 host：有终端时 Ctrl+C 只发给 Watchdog。
    if [ -t 0 ]; then set -m; fi
    {{run}} src/watchdog/main.ts

# 用的是现在 PATH 里的 node 和状态目录（PSA_STATE_DIR）。重复运行不会重启宿主：
# 换了 node、仓库位置或升级了 Pi，要让宿主用上，跑 just service-uninstall && just service-install。
# 登录后自动启动 Watchdog（它再拉起宿主），崩溃后 launchd 把它拉回来。需要这台 Mac 开着自动登录。
service-install:
    {{run}} src/service/cli.ts install

# 停掉 Watchdog 和宿主，删掉 LaunchAgent。没装也不报错。
service-uninstall:
    {{run}} src/service/cli.ts uninstall

# 试装时 PSA_SERVICE_LABEL 和 PSA_STATE_DIR 一起换：只换 label，试装的 plist 仍指向真的状态目录，卸载时会停掉真的宿主。
# 打印 launchd 里的状态、已装 plist 的 node 路径和最近一次心跳。
service-status:
    {{run}} src/service/cli.ts status

# 更新到最新 main 并重装服务，最后打印服务状态。只改了 config.json 时用 just redeploy --no-pull。
redeploy flag="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{flag}}" in
        "") branch=$(git rev-parse --abbrev-ref HEAD)
            if [ "$branch" != "main" ]; then echo "现在在分支 ${branch}，不是 main。先 git checkout main，或者用 just redeploy --no-pull 只重装。" >&2; exit 1; fi
            git pull --ff-only ;;
        --no-pull) ;;
        *) echo "用法：just redeploy [--no-pull]" >&2; exit 2 ;;
    esac
    echo "版本：$(git log --oneline -1)"
    just service-uninstall
    just service-install
    sleep 3
    just service-status

# 打开 TUI 客户端（Pi TUI 只当界面，输入转发给宿主）。连接时读状态目录里的 client-token。
client:
    pi {{clean}} --no-session --no-context-files --tui-mode regular -e extensions/super-agent.ts

# 对 Super Agent 说一句话，打印之后两分钟内的回复。连接时读状态目录里的 client-token，没有就先运行 just host。
say +text:
    {{run}} src/cli/say.ts say {{text}}

# 通过通用来源投递一条触发：just drop <来源> <线程> <正文>
drop source thread +body:
    {{run}} src/cli/drop.ts {{source}} {{thread}} {{body}}

# 玩具行情模块投递一条假行情：just toy-feed TOYX -5.2 12
# toy-market 默认关闭，先在 config.json 写 "modules": { "toy-market": true } 并重启宿主。
toy-feed symbol="TOYX" change="-5.2" volume="12":
    {{run}} modules/toy-market/feed.ts {{symbol}} {{change}} {{volume}}

# 用真实行情接口取一次自选股快照打印成表，再打印第一只自选股的日线指标和 Finnhub 财报（不打印密钥）。密钥来自环境变量或 config.json 的 secretsFile。
market-smoke:
    {{run}} src/cli/market-smoke.ts

# 列出最近的触发和它们的去向：just log [条数]
log limit="30":
    {{run}} src/cli/log.ts {{limit}}

# 换网页 token：删掉状态目录里的 web-token，宿主下次启动生成新的。正在运行的宿主重启前沿用旧 token。
web-token-rotate:
    {{run}} src/cli/web-token-rotate.ts

# 换客户端凭据：删掉状态目录里的 client-token，然后重启宿主生成新的。重启前新开的 TUI、just say 和 just tail 连不上。
client-token-rotate:
    {{run}} src/cli/client-token-rotate.ts

# 持续显示对话。
tail:
    {{run}} src/cli/say.ts tail

# 内核、宿主组装点和其余全部自动测试。
test:
    {{run}} --test --test-timeout=30000 tests/*.test.ts tests/*.test.mjs

# 列出找到的模块：启用还是停用、为什么、来源、规则、技能。不需要宿主在运行。
modules:
    {{run}} src/cli/modules.ts

# just module check <目录> [--previous <旧版本目录>]：检查新布局包，没问题打印一行 ok | just module import <模块> <知识名> <文件或目录>：user-import 知识的全文进实例数据，不进模块包
module *args:
    {{run}} src/cli/module.ts {{args}}

# 在状态目录的 modules/ 下生成一个新模块骨架：just module-new <模块名>
module-new name:
    {{run}} src/cli/module-new.ts {{name}}

# 真实宿主、Worker 子进程和无头浏览器，模型换成 tests/e2e/fake-model.ts 的本地假模型，不请求任何真实模型或行情接口。
# 首次运行自动装 playwright-core 和浏览器。失败报告在 tests/e2e/.out/<测试>/index.html。
# 故意弄坏某一步：PSA_E2E_SABOTAGE="Router 回复" just e2e；让 Worker 崩溃：PSA_E2E_SABOTAGE="Worker 汇报:crash" just e2e
# 端到端测试（假模型 + 真实宿主 + 浏览器）。
e2e: _browser
    @ls -dt tests/e2e/.out/run-* 2>/dev/null | tail -n +6 | xargs rm -rf
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

# 装依赖和浏览器：缺什么才装什么。浏览器目录按 playwright-core 的 browsers.json 定位。
_browser kind="chromium-headless-shell":
    @[ -d node_modules/playwright-core ] || npm ci --no-audit --no-fund --loglevel=error
    @[ -d "$(node -p 'const os = require("os"); const rev = require("./node_modules/playwright-core/browsers.json").browsers.find((b) => b.name === "{{kind}}").revision; (process.env.PLAYWRIGHT_BROWSERS_PATH || require("path").join(os.homedir(), os.platform() === "darwin" ? "Library/Caches" : ".cache", "ms-playwright")) + "/{{replace(kind, "-", "_")}}-" + rev')" ] || npx --no-install playwright-core install {{kind}} >/dev/null
