# 在家里的 Mac 上长期运行宿主

照这份手册做完，家里的 Mac 上会一直跑着宿主。你在手机和笔记本上经 Tailscale 打开网页，家里的路由器不开任何端口。Mac 重启、自动登录以后，宿主自己回来。

手册按老 Mac（Intel，macOS 12.7.6）上实际走过的步骤写成，目标机器是 Mac mini（macOS 13.5 以上）。两台机器不同的地方，各节分开写。

文中的占位符：

- `<machine>` 是这台 Mac 在 tailnet 里的机器名。
- `<tailnet>` 是你的 tailnet 名字，`<machine>.<tailnet>.ts.net` 合起来是这台 Mac 的远程地址。
- `<user>` 是这台 Mac 上你的用户名（`whoami` 的输出）。
- `<old-mac>` 是老 Mac 在 tailnet 里的机器名。

## 开始之前

- 一个 ChatGPT 订阅，宿主经 Pi 的 `openai-codex` 用它。不要在配置里写 `anthropic/*`、`deepseek/*` 这些按量付费的模型。
- 一个 Tailscale 账户。手机、笔记本和这台 Mac 都登录同一个账户。
- 行情密钥（可选）。股票技术分析模块（stock-ta）取报价、日线和财报日要用，没有时它不发请求，别的照常。
- 宿主的状态都在 `~/.pi-super-agent`（下文叫状态目录）。全文只有「搬家」一节会动另一台机器的状态目录。

## 装 Node

宿主要 Node 22.19 以上（Pi 1.5.2 的要求），而且要带 `node:sqlite`。

两台机器都用 nvm 装 Node 22，全文不用 Homebrew。老 Mac 上就是这样装的。macOS 12 上 Node 24 以上的安装包要求 macOS 13.5，所以老 Mac 只能用 Node 22。Mac mini 也装 Node 22，和老 Mac 跑同一个大版本。

1. 装 Command Line Tools。它带 git，nvm 的安装脚本要用 git：

	```sh
	xcode-select --install
	```

	在弹窗里点安装，等它装完。已经装过时，它打印 `Command line tools are already installed`，接着做下一步。

2. 装 nvm。nvm 的安装脚本只往已经存在的 `~/.zshrc` 里写配置，新 Mac 上还没有这个文件，所以先建一个：

	```sh
	touch ~/.zshrc
	curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
	```

3. 关掉终端，重新打开一个。
4. 装 Node 22，并设为默认版本：

	```sh
	nvm install 22
	nvm alias default 22
	```

检查 Node 和 git：

```sh
node -v
node -e "require('node:sqlite'); console.log('sqlite ok')"
git --version
```

预期输出：

- `node -v` 打印 `v22.19.0` 或更高的版本号。老 Mac 上是 `v22.23.4`。
- 第二条打印 `sqlite ok`。Node 22 还会多打一行 `ExperimentalWarning`，可以不管。
- `git --version` 打印版本号。

## 装 Pi 并登录 Codex

1. 用刚装的 Node 全局安装 Pi：

	```sh
	npm install -g @earendil-works/pi-coding-agent
	pi --version
	```

	`pi --version` 打印版本号，例如 `1.5.2`。

2. 运行 `pi`，在 Pi 里输入 `/login`，选 **OpenAI Codex**，在浏览器里登录你的 ChatGPT 账户。
3. 登录成功后退出 Pi。

## 装 just

两台机器都把 just 装到 `~/bin`：

```sh
mkdir -p ~/bin
curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to ~/bin
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```

重新打开终端，运行 `just --version`，预期打印 `just 1.59.0` 或更高的版本号。

## 拉代码并跑测试

```sh
cd ~
git clone https://github.com/aicoder2048/pi-super-agent.git
cd pi-super-agent
just test
```

预期最后几行里 `fail 0`。下文的 `just` 命令都要在仓库目录 `~/pi-super-agent` 里运行。

在慢机器上，全套并行跑时可能有两处超时：`tests/host-main.test.ts` 整个文件，和 `tests/dispatch-process.test.ts` 里的用例「真的 Pi 进程：成员跑一条比无进展时限还久、一声不吭的命令，照常做完，不被当成无进展」。把它们放宽时限单独跑：

```sh
node --import ./src/pi-runtime.mjs --test --test-timeout=120000 tests/host-main.test.ts tests/dispatch-process.test.ts
```

单独跑全过，说明是机器慢，安装没有问题。

始终在 `main` 分支上运行。在一个比 `main` 旧的分支上运行，已合并的功能会悄悄消失。老 Mac 就遇到过：它停在旧分支上，用 tailnet 名字打开网页时一直是 403。

## 配置

宿主只从两处读行情密钥：进程的环境变量，或者 `config.json` 里 `secretsFile` 指向的文件。它不会自己去读仓库里的 `.env`。开机自动启动时，宿主由 launchd 拉起，`~/.zshrc` 里 `export` 的变量不存在，所以密钥必须写进 `secretsFile`。

1. 建状态目录和密钥文件：

	```sh
	mkdir -p ~/.pi-super-agent
	chmod 700 ~/.pi-super-agent
	touch ~/.pi-super-agent/secrets.env
	chmod 600 ~/.pi-super-agent/secrets.env
	open -e ~/.pi-super-agent/secrets.env
	```

2. 在 `secrets.env` 里写下面两行，等号后面换成你的密钥。股票技术分析模块（stock-ta）用 `POLYGON_API_KEY` 取报价和日线，用 `FINNHUB_API_KEY` 查下一次财报日，装法见 `docs/modules/stock-ta.md`。

	```sh
	POLYGON_API_KEY=<你的 Massive 密钥>
	FINNHUB_API_KEY=<你的 Finnhub 密钥>
	```

3. 写 `~/.pi-super-agent/config.json`。`models` 的三个模型都写成 Codex：回退模型的默认值是按量付费的 DeepSeek，不写就会用到它。`secretsFile` 写相对路径时，相对的是状态目录。

	```json
	{
		"models": {
			"router": "openai-codex/gpt-6.1-terra",
			"worker": "openai-codex/gpt-6.1-sol",
			"fallback": "openai-codex/gpt-6.1-sol"
		},
		"secretsFile": "secrets.env"
	}
	```

	这个文件原样复制就能用。远程访问用的 `webHosts` 要等装好 Tailscale、知道这台 Mac 的名字以后，在「远程访问」一节再加。

4. 在前台试跑一次宿主：

	```sh
	just host
	```

	预期日志里有这几行（时间戳和路径因机器而异）：

	```text
	[host] 已启动，状态目录 ~/.pi-super-agent，Router openai-codex/gpt-6.1-terra，Worker openai-codex/gpt-6.1-sol，回退 openai-codex/gpt-6.1-sol
	[host] 网页 http://127.0.0.1:4517/?token=…
	```

	这时还没有 `[host] 网页（远程）` 那一行。它在「远程访问」一节加上 `webHosts` 以后才出现。

5. 在这台 Mac 的浏览器里打开 `[host] 网页` 那一行的网址，确认网页能打开。
6. 按 Ctrl+C 停掉宿主。日志最后一行是 `[host] 已停止`。下一节由 launchd 接管，前台的宿主必须先停，否则两个宿主抢同一个端口。

## 自动启动

1. 安装 LaunchAgent。它在你登录后启动看门狗，看门狗再拉起宿主：

	```sh
	just service-install
	```

	预期输出：

	```text
	[service] 预检通过：node <node 的路径>，npm root -g 找到 Pi，bash /bin/bash，just <just 的路径>，config.json 能加载
	[service] 已安装 com.pi-super-agent.watchdog：~/Library/LaunchAgents/com.pi-super-agent.watchdog.plist
	[service] 看门狗日志 ~/.pi-super-agent/watchdog.log，宿主日志 ~/.pi-super-agent/host.log
	```

	服务的 PATH 是 node 的目录、just 和 uv 的目录（装的时候在你的 PATH 里找到的话），再加系统目录。`~/bin` 不在系统目录里，所以要在 `~/bin` 已经进了 PATH 的终端里跑这一步，module-builder 的专家队才能跑 `just module new/check/try`。找不到 just 时照样会装上，但多打一行提醒：装上 just 或把它的目录加进 PATH，再重跑 `just service-install`。

	Node 是用 nvm 装的，所以还会多一行提醒：服务固定用这个 Node 版本和它下面装的 Pi，换了 Node 版本后要重跑 `just service-uninstall && just service-install`。

2. 几秒后查看状态：

	```sh
	just service-status
	```

	预期第一行是 `com.pi-super-agent.watchdog：运行中，看门狗 pid …`，最后一行是 `心跳    N 秒前，宿主 pid …`。宿主每 30 秒写一次心跳，所以 N 在 0 到 30 之间。刚装完的几秒里宿主还在启动，最后一行可能是 `心跳    宿主没有在运行`，等几秒再跑一次。

3. 打开自动登录。LaunchAgent 只在你登录后运行，停电重启后没有人登录，宿主就不会回来。

	自动登录要求先关掉 FileVault。新 Mac 默认打开 FileVault，这时自动登录的选项是灰的。关掉的代价是有人拿走这台 Mac 时，开机就能进你的账户，读到状态目录里的对话、token 和行情密钥。Mac mini 放在家里不带出门时，这个代价通常可以接受。

	- macOS 13 以上：先在 **System Settings** > **Privacy & Security** > **FileVault** 里点 **Turn Off**，等解密完成。再到 **System Settings** > **Users & Groups** > **Automatically log in as**，选你自己。
	- macOS 12：先在 **System Preferences** > **Security & Privacy** > **FileVault** 里关掉 FileVault。再到 **System Preferences** > **Users & Groups** > **Login Options** > **Automatic login**，选你自己。

4. 防止 Mac 睡眠，并在停电恢复后自动开机：**System Settings** > **Energy**，打开 **Prevent automatic sleeping when the display is off** 和 **Start up automatically after a power failure**。这一步老 Mac 上没有做过，选项名以你的系统为准。
5. 做一次重启测试：

	```sh
	sudo shutdown -r now
	```

	重启并自动登录后，不打开终端，等一两分钟，再查看看门狗日志：

	```sh
	tail -3 ~/.pi-super-agent/watchdog.log
	```

	预期这三行，每行开头还有一个 ISO 格式的时间戳：

	```text
	[watchdog] 已启动，每 3 分钟检查一次，状态目录 ~/.pi-super-agent
	[watchdog] 宿主没有心跳，正在拉起
	[watchdog] 已拉起宿主，pid …，日志 ~/.pi-super-agent/host.log
	```

## 远程访问

宿主只监听 `127.0.0.1`。Tailscale 的 `serve` 在本机做 HTTPS，把 `https://<machine>.<tailnet>.ts.net/` 转发到宿主的 4517 端口。只用 `serve`，永远不要用 `tailscale funnel`。funnel 会把网页开到公网上，挡在外人面前的就只剩 token。

1. 装 Tailscale。Tailscale 的 macOS 客户端要求 macOS 13 以上（1.104 起要求 13.5）。
	- Mac mini：从 Tailscale 官网的下载页或 Mac App Store 装。
	- 只有 macOS 12 时，见本节末尾的「macOS 12 上的 Tailscale」。

2. 打开 Tailscale，按提示允许它的系统扩展。macOS 版是菜单栏里的图标，没有主窗口。
3. 登录。可以点菜单栏图标登录，也可以用命令行，它打印一个登录网址，在浏览器里打开：

	```sh
	/Applications/Tailscale.app/Contents/MacOS/Tailscale up
	```

4. 查这台 Mac 的名字：

	```sh
	/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json | grep -m1 DNSName
	```

	输出形如 `"DNSName": "<machine>.<tailnet>.ts.net.",`。去掉末尾的点，就是 `<machine>.<tailnet>.ts.net`。

5. 在 `~/.pi-super-agent/config.json` 里加上 `webHosts`，写上一步查到的名字，不带 `https://`、端口和路径。大小写都可以，宿主读的时候转成小写。改完的文件是这样，`<machine>.<tailnet>` 换成你的名字：

	```json
	{
		"models": {
			"router": "openai-codex/gpt-6.1-terra",
			"worker": "openai-codex/gpt-6.1-sol",
			"fallback": "openai-codex/gpt-6.1-sol"
		},
		"webHosts": ["<machine>.<tailnet>.ts.net"],
		"secretsFile": "secrets.env"
	}
	```

6. 开 `serve`：

	```sh
	/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 4517
	/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
	```

	`serve status` 应显示 `https://<machine>.<tailnet>.ts.net` 转发到 `http://127.0.0.1:4517`。第一次开 `serve` 时，它可能让你先在 Tailscale 管理后台打开 HTTPS 证书，照提示的网址去打开。

7. 重启宿主，让它读到新的 `webHosts`：

	```sh
	cd ~/pi-super-agent
	just service-uninstall && just service-install
	```

8. 从宿主日志里取远程网址：

	```sh
	grep '网页（远程）' ~/.pi-super-agent/host.log | tail -1
	```

	预期一行 `[host] 网页（远程） https://<machine>.<tailnet>.ts.net/?token=…`。

9. 在手机上装 Tailscale，登录同一个账户，再用手机浏览器打开上一步的网址。笔记本同样要装 Tailscale 并登录同一个账户。
10. 检查手机断线后能自己回来：锁屏一分钟再解锁。网页顶上先出现「连接中断，正在重连」，重连上以后这行字消失。

如果远程网址打开是 403，先确认 `webHosts` 里的名字和 `DNSName` 一字不差，再确认仓库在 `main` 分支上。

### macOS 12 上的 Tailscale

macOS 12 上只有 1.102.4 能运行。它会自动升级到装不上的新版，所以先关掉自动更新再第一次打开它：

1. 下载安装包和它的校验值，核对一致后再装：

	```sh
	curl -fLO https://pkgs.tailscale.com/stable/Tailscale-1.102.4-macos.pkg
	curl -fsSL https://pkgs.tailscale.com/stable/Tailscale-1.102.4-macos.pkg.sha256
	shasum -a 256 Tailscale-1.102.4-macos.pkg
	```

	后两条命令打印的十六进制串必须相同。

2. 关掉自动更新：

	```sh
	defaults write io.tailscale.ipn.macsys SUEnableAutomaticChecks -bool false
	defaults write io.tailscale.ipn.macsys SUAutomaticallyUpdate -bool false
	```

3. 双击安装包安装，然后打开 Tailscale，在菜单栏图标的 **About** 里确认版本是 1.102.4。

## 远程管理

在笔记本上用 ssh 管理这台 Mac，不用走到它跟前。

1. 在这台 Mac 上打开 **System Settings** > **General** > **Sharing** > **Remote Login**，只允许你自己的账户。
2. 在笔记本上经 tailnet 登录：

	```sh
	ssh <user>@<machine>
	```

	登录后的 shell 是交互式的，会读 `~/.zshrc`，所以 nvm 和 `~/bin` 都在 `PATH` 上，`just` 能直接用。

3. 想免密码登录时，在笔记本上运行 `ssh-copy-id <user>@<machine>`。如果笔记本上已经有 `~/.ssh/id_ed25519`，直接用它，不要再跑 `ssh-keygen`：它会覆盖已有的密钥，用这把密钥的其他服务器就都登不上了。

## 更新

代码、`config.json`、`secrets.env` 和状态目录里的 `modules/` 都只在宿主启动时读一次。改了任何一个，都要重启宿主。

```sh
cd ~/pi-super-agent
just redeploy
```

`just redeploy` 先确认当前在 `main` 分支，再 `git pull --ff-only`，然后依次运行 `just service-uninstall`、`just service-install` 和 `just service-status`，最后一步会打印装上的版本和最近一次心跳。不在 `main` 分支，或者本地有改动让快进失败时，它停下来报错，不会重装。

从 us-market 退役以前的版本更新时，`config.json` 里的 `sources.us-market` 要先删掉，否则新代码拒绝启动，步骤见 `docs/modules/stock-ta.md` 的「旧 Mac 部署」。

重启会让宿主停几秒，正在跑的任务会被停掉，所以挑没有任务在跑的时候做。只改了配置时，用 `just redeploy --no-pull`：不拉代码，只重装。

## 换 token

网页的 token 在网址里。截图分享过网址、换了手机，或者觉得 token 泄露了，就换一个：

```sh
cd ~/pi-super-agent
just web-token-rotate
just service-uninstall && just service-install
```

第一条打印「已删除 …/web-token。宿主下次启动时生成新 token……」。重启后旧网址返回 401。用「远程访问」第 8 步的 `grep` 取新网址。

## 搬家

把老 Mac 上的对话和任务搬到 Mac mini：

1. Mac mini 先按上面各节装好，跑通 `just test`。
2. 在老 Mac 上停掉服务，让复制时没有进程在写状态目录。命令在老 Mac 的仓库目录里运行，路径以老 Mac 上的为准：

	```sh
	cd ~/pi-super-agent
	just service-uninstall
	```

3. 在 Mac mini 上停掉服务，把它自己的状态目录挪开：

	```sh
	cd ~/pi-super-agent
	just service-uninstall
	mv ~/.pi-super-agent ~/.pi-super-agent.trial
	```

	Mac mini 试跑过宿主，就有自己的状态目录。`rsync -a` 只添加和覆盖文件，不删文件，复制到一个已有的状态目录上时，试跑留下的 `state.db-wal` 这类文件会留在原地，和老 Mac 的 `state.db` 混在一起。挪开而不是用 `rsync --delete` 删掉，是为了需要时还能找回试跑的状态。没装过服务时，`just service-uninstall` 打印「没有安装，什么也没做」。没有状态目录时，`mv` 报 `No such file or directory`，都可以不管。搬家确认没问题以后，可以删掉 `~/.pi-super-agent.trial`。

4. 把老 Mac 的 `~/.pi-super-agent` 整个复制到 Mac mini。例如在 Mac mini 上运行（老 Mac 要先打开 Remote Login）：

	```sh
	rsync -a <user>@<old-mac>:.pi-super-agent/ ~/.pi-super-agent/
	```

5. 在 Mac mini 上改 `~/.pi-super-agent/config.json`：`webHosts` 换成 Mac mini 的名字。`secretsFile` 写的是相对路径时不用改，写的是老 Mac 上的绝对路径时，改成 Mac mini 上的路径。
6. 在 Mac mini 上运行 `just service-install`。用户名或家目录和老 Mac 不同时，`host.log` 里有一行 `[host] 状态目录换了位置，已把会话记录的工作目录改到 …`。宿主把新位置记在状态目录的 `location.json` 里，并改写了会话记录里的路径。
7. 状态目录里的 `web-token` 也一起搬过来了，旧网址换成 Mac mini 的名字后仍然能用。不想让老网址继续有效，就做一次「换 token」。

有一类旧数据搬不回来。PR #59 让宿主写库前去掉 U+0000。在它之前、用 Node 22 写入的含 U+0000 的行，写入时就在 U+0000 处被截断了，搬家后仍是截断的。

## 卸载

```sh
cd ~/pi-super-agent
just service-uninstall
```

预期打印 `[service] 已停止并移除 com.pi-super-agent.watchdog`。再跑一次打印「没有安装，什么也没做」。`just service-status` 打印 `com.pi-super-agent.watchdog：未安装`。

卸载不动状态目录。要连对话一起删，再删 `~/.pi-super-agent`。要停掉远程访问，运行 `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve reset`。

## 日志在哪

- 看门狗日志在 `~/.pi-super-agent/watchdog.log`，宿主日志在 `~/.pi-super-agent/host.log`。
- `host.log` 里有带 token 的网址，所以它的权限是 `600`，不要把它整个贴给别人。
- `host.log` 不会自动轮转。文件太大时可以清空它，宿主不用停：

	```sh
	: > ~/.pi-super-agent/host.log
	```
