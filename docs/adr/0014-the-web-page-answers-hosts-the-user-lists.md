# 网页也回应使用者在 webHosts 里列出的 tailnet 名字

改写 ADR-0004 的两句：「`Host` 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`」和「`Origin` 恰好是本机这个端口的页面」。ADR-0004 其余内容（只绑 `127.0.0.1`、token 只在网址里、Host 先于 token 检查、POST 要 JSON 正文）不变。

## 问题

使用者想把宿主放在家里的 Mac 上长期运行，在外面用手机或笔记本打开网页，而且不开公网端口，也不让局域网里的其他设备看到网页。远程访问走使用者自己的 Tailscale：`tailscale serve` 在本机终结 TLS，把 `https://<机器名>.<tailnet>.ts.net/` 转发到宿主的端口。今天网关只认本机的 Host 和 `http://` 本机的 Origin，所以经 `*.ts.net` 转来的请求都得 403。

## 决定

**宿主仍只绑 `127.0.0.1`。** 宿主不知道 Tailscale，也不调用它。使用者自己运行 `tailscale serve --bg <webPort>`。

**`config.json` 的 `webHosts` 列出 tailnet 机器名**，例如 `["psa-home.example.ts.net"]`。每一项必须是小写的 `*.ts.net` 名字，不带 `https://`、端口和路径，也不能是 IP 或通配符。写错时宿主启动就退出，报错指出是第几项、原值是什么。大写字母读成小写，重复的只留一项。`webHosts` 不为空时 `webPort` 不能是 0：`tailscale serve` 转发到一个固定端口，端口每次启动都变，远程网址就失效。缺省或空数组时，网关的行为与今天完全相同。

**接受的地址只从一处推导。** `src/host/web-hosts.ts` 从端口和名字算出两个集合：接受的 Host 是 `127.0.0.1:<端口>`、`localhost:<端口>` 和每个名字（不带端口）；接受的 Origin 是这两个本机地址加 `http://`，以及每个 `https://<名字>`。远程名字不带端口，因为 Tailscale 在 443 上应答，浏览器在 Host 和 Origin 里都省略默认端口。网关对每个请求只做精确的集合查找，Host 仍在 token 之前检查。打印的远程网址出自同一份数据，所以日志里的网址一定是网关接受的地址。

**Host 和 Origin 分开检查，不要求成对。** 如果某个转发方式把 Host 改写成 `127.0.0.1:<端口>`，Origin 仍是 `https://<名字>`，两项各自都在集合里，请求照样通过。这样设计不依赖 `tailscale serve` 是否改写 Host。两个集合里的每个值都是使用者自己的页面，所以不成对检查不会放进外人。

**日志为每个名字多打一行** `[host] 网页（远程） https://<名字>/?token=…`，本机那一行不变。

## 为什么 DNS rebinding 仍被挡住

rebinding 页面发来的请求带的是攻击者自己的域名，这个域名不在集合里。集合里只有本机地址和使用者列出的 tailnet 名字，`*.ts.net` 的 DNS 由 Tailscale 和使用者控制，攻击者改不了它的解析。所以 `webHosts` 只收 `*.ts.net`，不收任意主机名：使用者顺手写一个自己不控制 DNS 的域名，就会重新打开 rebinding。

## 谁能打开网页

要同时满足两个条件：设备在使用者的 tailnet 上，并且能访问这台机器的 443 端口（Tailscale 的 ACL 管这一项）；手里有 token。Tailscale 是第一道门，token 是第二道。把 tailnet 或这台机器共享给别人，等于让他们走到 token 这一道门前。

**只用 `tailscale serve`，不用 `tailscale funnel`。** funnel 把同一个 `*.ts.net` 名字开到公网上，宿主从 Host 上分不出请求来自 tailnet 还是公网。开了 funnel，整个公网面前就只剩 token 一道门。

**不信任 `Tailscale-User-*` 头。** 网页的凭据仍只有 token。这些头能不能被客户端伪造，取决于 Tailscale 的转发方式，宿主不拿它们做身份判断。

## token

token 仍只在网址里，理由同 ADR-0004。从手机打开后，网址会进手机浏览器的历史记录，也可能经浏览器同步（例如 iCloud 的 Safari 标签页）到使用者的其他设备。token 泄露或换手机时，运行 `just web-token-rotate` 再重启宿主，旧网址随之 401。

## Considered Options

- **宿主改绑 `0.0.0.0` 或 tailnet 地址**：局域网里的设备也能连上，违背 ADR-0004 只绑本机的初衷。
- **关掉 Host 检查**：DNS rebinding 的防线就没了。
- **要求 Tailscale 改写 Host 头**：使用者要记得给 Tailscale 加额外参数，忘了就是一片 403。
- **接受任意主机名**：使用者不控制 DNS 的名字会重新打开 rebinding。
- **Host 和 Origin 成对检查**：要先确认 `tailscale serve` 是否改写 Host，而且不挡住更多外人。
- **开公网端口或用 Cloudflare Tunnel**：对话会经过第三方或暴露在公网上，使用者要的是私有云。

## Consequences

- `webHosts` 为空时行为与今天相同。403 的说明里提到 `webHosts`。
- 换用别的反向代理要放宽 `*.ts.net` 这一条，那需要一个新的 ADR。
- SSE 经 `tailscale serve` 到手机的表现、Tailscale 转发时 Host 的确切值，要在使用者的机器上用真 Tailscale 确认。网关的 15 秒 keepalive 和 `retry: 1000` 不变。
