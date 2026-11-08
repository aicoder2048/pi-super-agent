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
