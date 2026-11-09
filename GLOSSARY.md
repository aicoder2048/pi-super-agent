# Pi Super Agent

在 Pi Agent Harness 上实现的 Super Agent：一个持续在线、由事件驱动、同时推进多项任务的个人 Agent。

## Language

### 结构

**Super Agent**：
一个跨会话保持上下文、同时推进多项任务的连续 Agent。使用者感觉始终只面对一个 Agent，不需要知道底层有多少个会话。
_Avoid_：多 Agent 系统、Agent Team、助手

**宿主（Host）**：
Super Agent 常驻运行的本体，持有它的全部状态。人机界面连接宿主，但不属于宿主，关掉界面不影响 Super Agent 运行。
_Avoid_：服务端、后台、daemon

**Router**：
常驻的全局层。它承接所有与人的交互，决定事件归谁处理，并统一对外回复；它不执行具体任务。
_Avoid_：主 Agent、orchestrator、主 Session、Team Lead

**Worker**：
为一项任务而存在的执行者。它在隔离的上下文里完成任务，只向 Router 汇报，不直接与人交互。
_Avoid_：subagent、专家、Executor、子进程

**客户端（Client）**：
使用者自己的人机界面，例如终端界面、桌面端、手机端。它连接宿主，对宿主来说是一个来源加一个渠道。
_Avoid_：前端、UI、TUI

**Watchdog**：
宿主之外的独立检查者。它定时确认宿主是否在响应、每个任务是否有进展，并在异常时介入。
_Avoid_：监控、健康检查、心跳

### 事件

**来源（Source）**：
一条进入系统的事件流，例如 GitHub 通知、邮件、行情、定时器。
_Avoid_：信道、收件箱、连接器、输入

**通用来源（Generic Source）**：
让外部脚本自行投递触发的来源，用于还没有专门来源的事件。
_Avoid_：收件箱、Webhook

**触发（Trigger）**：
来源产生的一条不可变事件。
_Avoid_：事件、消息、通知

**线程（Thread）**：
同一话题下按时间排列的一串触发，例如同一封邮件的往来、同一个 Pull Request。由来源决定哪些触发属于同一个线程。
_Avoid_：会话、对话、话题

**对话（Conversation）**：
使用者在客户端里与 Super Agent 的全部往来，构成一个线程。它不被任何任务订阅，其中每句话都先到 Router。
_Avoid_：聊天、会话、Session

**渠道（Channel）**：
一个线程的回写出口，Router 通过它对人回复。
_Avoid_：信道、输出

### 工作

**任务（Ticket）**：
Router 决定要做的一项工作，由一个 Worker 执行。
_Avoid_：工单、Task、Job

**依据（Basis）**：
一项任务为什么可以做，分三种：请求（使用者直接开口）、规则（命中某条规则）、推断（Router 自己判断值得做）。依据决定任务能做到哪一步。
_Avoid_：授权、Mandate、强度、优先级

**对外动作**：
会被使用者以外的人看到或难以撤回的动作，例如发邮件、发帖、推送代码。依据为推断的任务不能自行做对外动作。
_Avoid_：副作用、写操作

**转交**：
Router 把一条触发交给一个已有的任务，由该任务的 Worker 处理。
_Avoid_：转发、路由、attach

**订阅（Subscription）**：
任务与线程之间的多对多关系。线程上的新触发直达订阅它的任务，不再经过 Router。
_Avoid_：绑定、监听

**汇报（Report）**：
Worker 交给 Router 的结构化状态：进展、就绪、受阻、失败、无需处理。
_Avoid_：结果、输出、回复

**规则（Rule）**：
使用者事先用自然语言写下的约定，说明哪类触发值得开任务、做到哪一步。
_Avoid_：策略、配置、Policy

**模块（Module）**：
为某一类事务准备的一组来源、规则和 Worker 技能，例如邮件、X 资讯、看盘。模块不引入新的运行时概念。
_Avoid_：插件、业务平台、应用
