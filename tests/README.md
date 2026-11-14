# 测试怎么分

| 目录 | 放什么 | 怎么跑 |
| --- | --- | --- |
| `unit/` | 单元测试：在测试进程里直接调函数和类。可以用临时文件，也可以在进程里开内存或临时目录里的 SQLite。不起子进程，不开 HTTP 服务器或 socket，不组装真实宿主。 | `just test-unit` |
| `integration/` | 集成测试：起子进程（`src/host/main.ts` 宿主、Watchdog、Python/uv、`ta`、swift/Vision、Pi Worker），开假的 HTTP 服务器（Telegram、模型、Massive、Gmail），或者组装真实的宿主栈（`Host`、`startLiveModules`、带真实进程的 feed 调度）。 | `just test-integration` |
| `e2e/` | 端到端：真实宿主、Worker 子进程加无头浏览器，模型是本地假模型。 | `just e2e` |
| `helpers/` | 假的 Bot API、假模型服务器、PDF 构造器等测试共用的东西。 | |
| `fixtures/` | 测试用的样例模块和数据。 | |

`just test` 跑 `unit/` 和 `integration/` 两个目录。

一个文件里只要有一条测试属于集成测试，整个文件就放进 `integration/`。

`just test-unit` 带着 `helpers/unit-guard.mjs` 跑：测试里一起子进程或一监听端口就直接报错，报错里写着把文件挪到 `integration/`。新写的单元测试不小心起了进程，跑一次 `just test-unit` 就能发现。
