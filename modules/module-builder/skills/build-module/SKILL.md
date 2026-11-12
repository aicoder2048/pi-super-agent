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

- 模块包只能在 `$STATE/modules/<名字>/`。宿主只在这里发现模块，放进成品目录宿主看不到，`just module on` 也打不开。这一条优先于系统提示里的「成品放在哪里」：做模块不调 new_app，不在成品目录建副本再链接过来，`PSA_STATE_DIR` 只设成 `$STATE`。宿主在汇报卡上列出写到成品目录之外的文件，这里就是模块包的文件，是预期的。派活时把 `$STATE/modules/<名字>/` 的绝对路径写进任务。
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
- 汇报里列出改了哪些文件。
