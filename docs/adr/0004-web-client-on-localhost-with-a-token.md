# 网页客户端只开在 127.0.0.1，靠网址里的一次性 token 和 Host 头校验

宿主在 `127.0.0.1` 上开一个 HTTP 网关（端口取 `config.json` 的 `webPort`，默认 4517），浏览器用 SSE 收到的消息和 Unix socket 客户端完全相同。每次启动生成一个新的 32 字节随机 token，宿主日志打印 `[host] 网页 http://127.0.0.1:4517/?token=…`，只有带对的 token 才能拿到页面和事件流。两个静态脚本 `/app.mjs` 和 `/client/board-format.mjs` 不含对话或任务数据，所以不要 token，只查 Host 头。每个请求先查 `Host` 头，必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`，否则 403；然后才比对 token（常数时间比较），不对就 401。

只绑本机，是因为宿主持有全部对话和任务，网页没有登录体系，不该让局域网里的其他设备看到。光绑本机还不够：本机浏览器里打开的任何网站都能向 `127.0.0.1` 发请求，DNS rebinding 还能让恶意域名解析到 `127.0.0.1`、绕过同源限制读到响应。token 挡住前者，Host 头挡住后者（rebinding 的请求带的是恶意域名），而且 Host 头先于 token 检查，让这类页面连 token 猜没猜对都得不到反馈。

token 放在网址里，不放 cookie。cookie 不按端口隔离：`127.0.0.1` 上任何端口的服务都会收到它，而且浏览器会自动带上它，这正是 W2 加写操作后要防的 CSRF。网址里的 token 只有拿到日志的人才有。页面用 `no-referrer` 和 `no-store` 防止 token 经 Referer 或缓存泄出，CSP 只允许同源脚本，页面上的文字一律用 `textContent` 渲染。

我们接受 token 出现在宿主日志、浏览器地址栏和历史记录里。能读这些的人本来就能读宿主的状态目录。token 每次启动都换，宿主重启后旧网页提示 token 已失效，使用者用日志里的新网址重新打开。

## Considered Options

- **cookie 携带 token**：刷新和书签更方便，但 cookie 不按端口隔离，又会被浏览器自动带上，W2 有了 POST 之后就是 CSRF 的入口。
- **不要 token，只绑本机加 Host 头校验**：挡得住 rebinding，挡不住本机其他用户和本机上跑的其他程序。
- **网关做成独立进程，连 `host.sock`**：宿主不用改，但要多开一个窗口，违背「一个标签页」的目标。

## Consequences

- W2 加发言（POST）时，再校验 `Origin` 头必须是本机这个端口，和 token 一起防 CSRF。
- 第二个 `just host` 会因为端口被占用而退出，不再抢走正在运行的宿主的 `host.sock`。启动宿主的测试一律用 `webPort: 0`。
