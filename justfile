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

# 启动宿主（前台运行，日志写到 stderr）。
host:
    {{run}} src/host/main.ts

# 对 Super Agent 说一句话，打印之后两分钟内的回复。
say +text:
    {{run}} src/cli/say.ts say {{text}}

# 通过通用来源投递一条触发：just drop <来源> <线程> <正文>
drop source thread +body:
    {{run}} src/cli/drop.ts {{source}} {{thread}} {{body}}

# 玩具行情模块投递一条假行情：just toy-feed TOYX -5.2 12
toy-feed symbol="TOYX" change="-5.2" volume="12":
    {{run}} modules/toy-market/feed.ts {{symbol}} {{change}} {{volume}}

# 持续显示对话。
tail:
    {{run}} src/cli/say.ts tail

# 内核、宿主组装点和其余全部自动测试。
test:
    {{run}} --test --test-timeout=30000 tests/*.test.ts tests/*.test.mjs
