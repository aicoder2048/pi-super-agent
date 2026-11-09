# 美股 Stock Heatmap

```sh
just stock-heatmap
# 或
pi -e ./extensions/stock-heatmap
```

在 Pi 内输入：

```text
/stock-heatmap
/stock-heatmap S&P 500
/stock-heatmap Nasdaq 100
/stock-heatmap Tech Services
/stock-heatmap 自选
/stock-heatmap-close
/stock-heatmap-focus
/stock-heatmap-mode 市值
/stock-heatmap-refresh

/stock-add META,TSLA,NVDA
/stock-add AAPL MSFT；AMZN、BRK.B
/stock-remove TSLA NVDA
/stock-watchlist list
/stock-watchlist set META,TSLA,NVDA
/stock-watchlist clear
/stock-ticker off
/stock-ticker on
/stock-ticker status
```

默认在**输入框上方**显示只读热图，命令执行完成即返回编辑器，热图不接管普通字符、方向键或光标。没有类别参数时临时展开**可搜索的类别选择器**，支持键盘选择；`自选`、`S&P 500`、`Nasdaq 100` 固定置顶，其余类别按使用次数排序。命令参数也支持 Tab 补全，不需要给包含空格的类别加引号。

## 配置与数据

API Key 从本目录 `.env` 读取，不依赖启动工作目录；外部同名环境变量优先。

支持的密钥名，优先级从高到低：`STOCK_HEATMAP_API_KEY`、`MASSIVE_API_KEY`、`POLYGON_API_KEY`。已有 `.env` 不需要改名，扩展不会写入、打印或发送密钥给模型。可选设置参见 `.env.example`。

- 股票：Massive/Polygon `/v2/snapshot/locale/us/markets/stocks/tickers`。
- 市值：`/v3/reference/tickers/{ticker}`，按需查询，本地缓存七天。
- 每日快照全零重置时，通过 `/v2/aggs/grouped/locale/us/market/stocks/{date}` 寻找最近两个真实交易日，计算收盘涨跌并明确标为**日线回退，非实时行情**。跳过周末，假日空结果继续往前，最多请求六个工作日；缓存三十分钟，不把前收盘伪装成最新成交。无日线权限则保留无报价状态。
- VIX：`/v3/snapshot/indices?ticker.any_of=I:VIX`，需要独立指数数据权限；不使用 VXX 或 ETF 价格假冒 VIX。
- Bearer Header 认证，不在 URL 携带 key；只向配置的官方 HTTPS 域名发送密钥，不跟随重定向。
- 默认每 60 秒轮询，所有请求共享约 5 次/分钟限速器；行情条内容超宽时每 350ms 滚动一列，能够完整显示时静止，不会增加 API 请求。VIX 最多每五分钟查询一次，权限拒绝后到 `/reload` 前不再请求。
- `401`、`403`、`429`、超时与空快照都有提示。快照接口并非所有套餐都包含；**刷新频率不等于数据实时性**。显示的时间是服务返回的行情时间，实时/延迟取决于套餐；休市数据可能是上一交易日的。盘后优先使用最新成交/分钟价，相对昨收计算涨跌，避免常规时段收盘价与盘后涨跌幅混用。
- 大股票池一次请求全市场并在本地过滤，小股票池按代码批量请求。空自选股不会意外触发全市场请求（行情条开启时仍会请求 ETF）。

## 交互和视觉口径

### 默认：热图与命令输入共存

只读热图使用命名 `aboveEditor` widget，不占键盘焦点、不显示选股光标。图体自适应终端高度，整体约用半屏，最多 28 行；矮终端降级为一行摘要，给聊天和编辑器留出空间。其他扩展、多行输入也会占用空间，不能保证所有布局中热图完整可见。

界面仅保留类别/面积标题、热图、图例、行情状态与一行操作提示。普通字符和方向键均属于 **Pi 编辑器**，不是热图快捷键。

| 命令 | 功能 |
| --- | --- |
| `/stock-heatmap [类别]` | 显示或更新热图；无参数临时搜索选择类别，确认/取消后回到编辑器 |
| `/stock-heatmap-close` | 收起热图，不影响独立的大盘行情条 |
| `/stock-heatmap-mode 成交额` | 默认面积口径，支持 `turnover` |
| `/stock-heatmap-mode 市值` | 读取并缓存市值，支持 `cap` |
| `/stock-heatmap-mode 等权` | 全部股票等权，支持 `equal` |
| `/stock-heatmap-refresh` | 请求刷新，在原位置更新，不等待网络阻塞命令输入 |
| `/stock-heatmap-focus [类别]` | 可选交互式大图，明确进入“专注模式” |

### 可选：专注大图

只有 `/stock-heatmap-focus` 使用全屏 overlay，期间键盘用于热图；标题与底部始终提示 **Esc 返回输入框**。退出后保留先前的只读热图与 ticker。

| 按键 | 功能（仅专注模式） |
| --- | --- |
| `Esc` / `q` | 返回 Pi 输入框；类别选择器中 Esc 先取消选择 |
| `c` / `Tab` | 类别搜索，使用原生 `Input` 正确定位光标和 IME |
| 方向键 | 按屏幕空间方向选择股票；仅此时出现蓝框/蓝字和“已选”详情，不再出现 `>股票代码` 假光标 |
| `Enter` / `Backspace` | 进入选中股票的板块 / 返回全部板块 |
| `r` | 刷新 |
| `v` / `m` / `e` | 成交额 / 市值 / 等权 |

### 颜色与边界

两个视图共用按板块分组的 **squarified treemap**，考虑字符宽高比。上涨为绿、下跌为红，使用**固定 ±10% 连续色阶**：同为下跌的 −0.14% 与 −0.99% 不再被量化成同色，+3% 到 +10% 仍有层次。零涨跌与缺失报价使用不同灰色，缺失显示 `—` / `N/A`，不伪造为零；亮色背景自动改用深色文字保证对比度。

所有相邻股票均保留**一列纵向分隔、一行横向分隔**，相同背景也能看出边界。小到无法容纳边界与标签的尾部合并为中性 `+N` 格，保留其总面积权重，不用混色伪装成单只股票；标题显示具名数量。需要更多细节时可打开专注模式或选择单一板块。

**面积口径始终标明。** 默认使用 API 快照的 `day.vw × day.v`（VWAP×成交量；日线回退时为该交易日的 VWAP×成交量），不把成交额称为市值。经典市值模式用 `/stock-heatmap-mode 市值` 开启（专注模式中也可按 `m`）；首次访问需要逐只查询元数据，免费低频套餐加载完整指数可能很慢，付费套餐可调整请求间隔。未获得权重的股票不分配面积，覆盖数量显示在顶部；市值不是指数官方自由流通调整权重。无法具名的小格会合并；专注模式可以用方向键选择具名股票，按 Enter 下钻板块。

底部 SPY、QQQ、DIA、IWM 为**指数 ETF 报价**，不是指数点位；VIX 单独标注为指数。为避免页脚信息过载，行情条共用一段简短的时间/收盘状态，滚动区域前的“大盘”标签固定；需要完整数据或 VIX 权限错误详情时使用 `/stock-ticker status`。VIX 上升的绿色仅表示数值上涨，不代表股市利好。

### 为什么行情条不直接替换 Footer？

界面专家核实：Pi 的 `setFooter()` 会整体替换 Footer，没有可靠的读取/追加现有 Footer 的公共接口。本项目 `pi-pi-cn.ts` 已有自定义 Footer，因此采用独立的 `belowEditor` widget 在页脚上方滚动，不覆盖模型、上下文使用率等原有信息。开启扩展后自动显示，可随时用 `/stock-ticker off` 关闭。

## 股票池与持久化

- `universe.json` 包含随扩展发布的 S&P 500、Nasdaq 100 成分快照、来源和抓取日期。成分不是实时获取，不保证跟踪后续调仓，可自行更新此文件后 `/reload`。类别不只是几个示例股票。
- S&P 500 来源：`datasets/s-and-p-500-companies`；Nasdaq 100 根据 Wikipedia 的历史成分变化整理。公司多股类别会导致股票代码数量超过 500/100。
- `Tech Services`、`Electronic Tech` 等是本扩展按公开 GICS 行业映射的**近似分类**，股票池范围为两个指数的并集，不是 TradingView 全美股行业数据库。Nasdaq 独有成员少量使用粗粒度板块归类。非股票池内的自选股仍能请求行情，未归类时显示在“其他”。
- 自选股、类别使用频率及行情条开关：`<getAgentDir()>/stock-heatmap/watchlist.json`，默认 `~/.pi/agent/stock-heatmap/watchlist.json`。
- 市值缓存：同目录 `market-caps.json`。不在 Git 仓库中保存用户偏好或密钥。
- 自选股支持跨进程锁、原子替换，损坏的 JSON 不会静默覆盖。若进程在持锁期间异常终止，确认没有其他实例写入后，手动删除同目录 `watchlist.json.lock/` 再试。
- `set` 一次替换整个自选列表；`clear` 需要确认。代码按格式校验并去重，不预先声称代码有效；无报价时显示缺失。`BRK-B` 自动归一为 Polygon 的 `BRK.B`。

退出、切换会话和 `/reload` 会清理动画、轮询、在途请求及未结束的选择器/专注对话框；收起热图后只继续底部行情，二者都关闭时停止轮询。RPC/非交互模式不启动网络请求，也不弹出自定义 TUI。

## 验证

```sh
just test-stock-heatmap
```

测试使用假响应，不访问 API，也不读取真实密钥；覆盖命令注册、股票代码解析、持久化并发、API 认证/错误、树图面积与终端尺寸、连续色阶、横纵分隔、只读焦点、类别搜索、专注退出与 ticker 宽度。

## 财报日热力图

同一个扩展已集成 Finnhub 财报日历，不需要 Massive Benzinga 附加订阅；本目录 `.env` 中需配置 `FINNHUB_API_KEY`。

```text
/stock-earnings
/stock-earnings today
/stock-earnings tomorrow
/stock-earnings week
/stock-earnings 2026-11-06
/stock-earnings-mode eps
/stock-earnings-mode price
/stock-earnings-scope all
/stock-earnings-scope indices
/stock-earnings-scope watchlist
/stock-earnings-details AAPL
/stock-earnings-refresh
/stock-earnings-close
```

- 无参数临时选择今天、明天、本周或输入指定日期，取消时保留原图。日期按 `America/New_York` 组织；明天为自然日，本周为周一至周日，包含周末。相对日期在后续刷新时随美东跨日推进。供应商只提供日期字符串，不能把它当作附带时区的精确公告时间。
- 与股票热图共用一个输入框上方的只读槽，切换时不会叠加占屏或抢输入焦点；ticker 仍独立。各自的 `-close` 仅关闭对应视图，不会误关另一种。`/stock-heatmap-focus` 仍是**股票**专注大图，退出后保留财报视图。
- 默认按 **EPS 超预期**着色，固定 ±100% 连续色阶；每个财报事件等面积，切换颜色模式不改变面积。`BMO / AMC / INTRA / TBD` 分别为盘前、盘后、盘中、时间待定，周视图还按日期分组。小格在同一日期/时段内合并为 `+N`，不对 EPS 求平均。
- EPS%= `(epsActual - epsEstimate) / abs(epsEstimate) × 100`。实际 EPS 为零有效，预期为零不计算百分比；缺数据和未来事件显示灰色。EPS/营收采用 Finnhub 提供的调整口径，实际值可能晚于公告更新，日期也可能调整；不能仅因时间已过就推断已经公布。
- `price` 为**发布日股价涨跌，不是财报后的事件收益**。历史日期使用指定日常规收盘相对上一市场交易日的变化；当天使用日期匹配的快照，可能包括可用盘后成交。无当日日线时不拿其他日期替代；旧交易日快照不能冒充今天。盘后财报当天收盘可能早于公告，不能称作“盘后反应”。无实际财务值或未来日期暂不着色。
- `all` 为 Finnhub `international=false` 返回的美国市场日历，**不是全美股完整列表或逐股上市类型认证**，也不排除 ADR。`indices` 仅匹配随扩展发布的两个指数股票池；`watchlist` 按自选代码精确匹配，不自动猜测跨供应商的代码别名。优先给自选和指数成分标注名称，未具名事件仍保留合并面积。
- 周日历按七个单日查询，而不是依赖一个可能被截断的大范围查询。原始响应达到 1500 条会提示“可能截断”；接口没有公开分页契约，不宣称已取全。空数组表示本次未返回，不代表当天必定无财报。免费历史覆盖约一个月，远期及更早历史不保证。
- 日历五分钟内存缓存、可见时每十分钟刷新，Finnhub 独立串行限速并遵守 `Retry-After`；只有 price 模式按需请求 Massive。历史日线在会话内缓存，当天行情约每分钟更新。收起或切换到股票时停止财报专属请求/定时器，退出会话取消全部任务。
- `/stock-earnings-details [SYMBOL]` 显示实际/预估 EPS、营收、时段、价格日期、数据缺口和截断警告；默认最多列出 100 个事件，可按代码筛选。

财报专项离线测试：`just test-stock-earnings`。真实 Key 不参与测试，原 `.env` 不会被改写。
