---
name: build-module
description: 做一个新模块或改一个已有模块的步骤、命令和不能做的事。领队开工前读；成员按领队派的那一步读对应的部分
---
# 做模块

## 位置和命令

你的工作目录是 `<状态目录>/workers/<任务>`。在 bash 里：

```bash
STATE="$(cd ../.. && pwd)"                      # 状态目录
just -f "$PSA_REPO/justfile" module check "$STATE/modules/<名字>"
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module new <名字> --template <notes|team|full>
PSA_STATE_DIR="$STATE" just -f "$PSA_REPO/justfile" module try <名字>
```

- 模块包只能在 `$STATE/modules/<名字>/`，宿主只在这里发现模块。做模块不调 new_app，不在成品目录建副本再链接过来，`PSA_STATE_DIR` 只设成 `$STATE`。派活时把这个绝对路径写进任务。
- `$PSA_REPO/modules/` 是仓库自带的模块，不改。使用者要改它们时，汇报说它在代码仓库里，请他自己改。
- 不跑 `just module on`、`just module off`，不改 `config.json`。

## 做新模块

1. **说明书。** 派给 interviewer，把使用者的话整理成 `spec.md`。使用者已经说清楚、或说了「不用问」，就按默认值做，假设写进汇报。缺了就做不下去的事，用一次 report（blocked）问，最多三个问题，每个附一个默认答案。
2. **名字。** `ls "$STATE/modules/<名字>"`。已经有了就停：不覆盖，不删，汇报「已有同名模块」，问使用者换名字还是改那个模块。`module new` 遇到同名也会拒绝，那一行原样写进汇报。
3. **搭结构。** 派给 scaffolder：`module new`，再按技能 package-layout 改 `module.json`、技能和专家。
4. **知识。** 有资料就派给 knowledge-curator。受版权保护的全文不进包。
5. **考题。** 派给 eval-writer，按技能 write-evals 写两三道。
6. **检查。** 派给 checker，跑到 `module check` 打印 `ok` 为止。
7. **预演。** 你自己用 bg_start 跑 `module try`（要几分钟）。看每道题的 PASS 和 FAIL：包的问题改掉再跑；模型答偏的写进汇报。
8. **汇报。** 写包的路径、`module check` 的 ok 那一行、预演结果、你做的假设、使用者还要做的事（导入知识的命令）。最后一句是「新模块停在已停用，你看过以后运行 `just module on <名字>` 打开」。

## 改已有模块

- 直接改 `$STATE/modules/<名字>/` 里的文件。不重跑 `module new`，不删文件夹再建。
- 每次改完跑 `module check`。模块开着的话，宿主看到存盘，检查通过就换上新版本；没通过，旧版本继续服务，要你改好。
- 改开放工具（`module.json` 的 `exports` 列着的）的 `tool.json` 或 `cases.json` 之前，先把整个包复制到你的工作目录，改完跑 `module check "$STATE/modules/<名字>" --previous <那份副本>`。工具被拿掉、`input` 或 `output` 少了字段、改了 `type` 或 `title`、同名用例的输出形状变了，都会有一行提醒，写明「这个工具开放给了别的模块」。提醒不挡检查，原样写进汇报，说明哪些模块可能要跟着改。
- 汇报里列出改了哪些文件。

## 和别的模块连起来

一个模块要的只读数据别的模块已经有（例如现价、技术面结构在 stock-ta），就调它开放的工具，不在新模块里再做一套。文件怎么写见技能 package-layout 的 `exports`、外部 `uses` 两节和两个示例包。

- **先确认提供方开放了。** 读 `$PSA_REPO/modules/<提供方>/module.json` 或 `$STATE/modules/<提供方>/module.json` 的 `exports`，只用列着的工具。没开放的，汇报说「要先请提供方开放 <工具>」，不自己做一份。
- **写在哪一处。** 有专家的模块写在要用它的专家的 `uses` 里；没有专家的写在 `module.json` 的 `uses` 里。两处只写一处，有专家时写 `module.json` 的 `uses` 检查报错。
- **专家的提示词写进三句。** 下面三条写进用外部工具的专家文件（没有专家时写进技能），新模块的专家照着做：
  1. 提供方不在时，调用回一个固定原因（「stock-ta 没装或没开」「stock-ta 现在没有开放 quote」「stock-ta 的运行环境还没装好」）。汇报写明哪部分没做、为什么，其余照常做完，不整个停下。
  2. 请对提供方说。工具的输出指向提供方内部、使用方跟不过去时，专家不自己补，转成一句给使用者的话：「请对 <提供方> 说……」。例如 stock-ta 的 `signals` 每条带的 `sources` 要用 `note` 才看得到原文，`note` 不开放，就写「要看出处原文，请对 stock-ta 说」；`structure` 回「把它加进自选股」时，自选股是 stock-ta 的写操作，就写「要分析 TSLA 的结构，请对 stock-ta 说把它加进自选股」。
  3. 只传必要的参数。模块有私密数据（`class` 是 `private` 的集合、mail 连接器的 feed）时，调会联网的开放工具只传它要的短参数，例如只传股票代码，不把邮件、持仓、成本这类内容放进参数：`stock-ta/tools/quote` 会把参数发给 Massive。
- **feed 调不了外部工具。** feed 的处理代码不经网关，调不了别的模块的工具，也调不了本模块的工具。feed 要的数据由它自己取，密钥放模块自己的 `.env`：汇报里写给使用者的命令 `just module secret <名字> <密钥名>`，你不替他跑。或者让 feed 开一个任务，由任务里的专家调。
- **开放自己的工具。** 新模块的只读工具别的模块用得上时，才在 `exports` 列它。规则见 package-layout 的 `exports` 一节；模块有私密集合就不能开放。
- **考题。** 用外部工具的专家，考题的 `uses` 写全名。预演会带上提供方当前在服务的版本；提供方没开时打印一行「现在没开」，这道题判失败，写进汇报，不是包的问题。
