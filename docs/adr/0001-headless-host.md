# Super Agent 做成无头宿主，而不是 Pi 扩展里的交互式会话

本仓库已有的 Pi 组件都是扩展（`pi -e extensions/xxx.ts`），最省事的做法是让交互式 Pi 会话直接充当 Router。我们没有这样做：Super Agent 是一个不依赖终端的宿主进程，持有任务状态、来源、Router 和所有 Worker；TUI 只是连到宿主的一个人机界面。

原因是目标是 7×24 跑在家里的 Mac mini 上。Router 如果绑在一个终端界面上，关掉终端它就停了，崩溃后也没有东西能把它拉起来，以后的 Telegram、Electron 桌面端、手机端都得绕着这个界面接入。代价是 MVP 要多做一层“界面如何连接宿主”。

## Considered Options

- **交互式 Pi 会话即 Router，放在 tmux 里常驻**：起步最快，但 Router 的生命周期等于一个终端界面的生命周期，无法交给系统托管。
