# 连宿主 socket 的客户端要出示状态目录里的凭据

ADR-0003 规定只有使用者本人在对话里说的话才算指令。宿主把 `host.sock` 上的 client 连接当作使用者的对话前端，client 发来的 `say` 和 `answer` 就是使用者的话。但在这之前，`hello` 里写 `role: "client"` 就够了，宿主不验任何东西。本机上任何知道 socket 路径的进程都能冒充使用者说话，带 `bash` 的 Worker 就是这样一个进程。

现在宿主启动时在状态目录里读或生成 `client-token`（32 字节随机数，文件权限 0600，更宽的会被收紧，跨重启不变）。`hello` 只要不是 worker 角色，就必须带上内容一致的 `token`，宿主用常数时间比较。不带或带错时，宿主断开连接并记一行不含凭据的日志（同样的拒绝一分钟内只记一行），这条连接没有角色，`say`、`answer`、`watch` 都用不了。Worker 仍然用每次启动新发的任务 token 走 worker 角色，没有变化。

TUI、`just say` 和 `just tail` 每次连接和重连时读 socket 所在目录下的 `client-token`。调用方仍然只给 socket 路径，宿主换了凭据后客户端重连时自己跟上，一个状态目录的凭据也不会被送到另一个状态目录的 socket。文件不存在时客户端报一行，提示先启动宿主。

宿主在网页端口绑定成功之后才读或生成这个文件。第二个 `just host` 因为端口被占用退出时，不会改掉正在运行的宿主的凭据。

`client-token` 和 `web-token` 是两个文件。`web-token` 会出现在宿主日志、浏览器地址栏和历史记录里（ADR-0004），`client-token` 只在文件里，不进日志，不进环境变量。`workerEnv` 还去掉了 `PSA_STATE_DIR`，Watchdog 拉起的宿主带着这个变量，以前 Worker 进程会继承它。

## 这次没有挡住什么

这次改动挡住的是只凭 socket 路径建立的连接，并且让凭据和指向它的 `PSA_STATE_DIR` 不出现在 Worker 的环境里。它挡不住一个有意去读状态目录的进程。

Worker 进程必须拿到 `PSA_SOCKET` 才能汇报，而凭据就在 socket 所在的目录里。Worker 的工作目录是 `<状态目录>/workers/<任务编号>`，工具跑的命令读 `../../client-token` 就能拿到凭据，然后以 client 身份连接。Worker 和宿主是同一个系统用户，文件权限 0600 对它不起作用。`web-token` 也是这样，拿到它就能 `POST /say`。

真正的修法是让 Worker 的工具命令跑在操作系统的沙箱里，沙箱读不到宿主的状态目录。这次没有做。在那之前，依据为推断的任务有 `read`，读得到这个文件，但它没有 `bash`、不能写文件、没有后台命令（见 `toolAllowlist`），`web_get` 又拒绝本机地址，所以没有工具能拿凭据去连宿主。依据为请求或规则的任务有 `bash`，它们的 Worker 读得到也用得上。

## Considered Options

- **复用 `web-token`**：少一个文件，但它印在日志和浏览器历史里，等于把 socket 的凭据也放到那些地方。
- **把凭据经环境变量交给客户端**：客户端不用读文件，但环境变量会被子进程继承，正是这次要避免的。
- **socket 放到 Worker 读不到的目录**：Worker 汇报也走这个 socket，要先把 worker 和 client 拆成两个 socket，而且 Worker 仍然能读到状态目录。没有沙箱时这只是换了一个路径。
- **用 `SO_PEERCRED` 之类的办法认对端进程**：Worker 和客户端是同一个用户，Node 也不直接提供，认不出谁是谁。

## Consequences

- 升级后要把宿主重启一次，`client-token` 才会存在。在那之前打开的 TUI、`just say` 和 `just tail` 会报找不到这个文件。升级前就开着的 TUI 进程里还是旧代码，不会带凭据，要关掉重开。
- 换凭据运行 `just client-token-rotate`，然后重启宿主。它删掉文件，重启前新开的客户端连不上，已经连着的不受影响。
- 自己写脚本连 `host.sock` 的，`hello` 里要带 `token`，值是 `client-token` 的内容。`docs/web-client/evidence/perf.mts` 已经这样改了。
