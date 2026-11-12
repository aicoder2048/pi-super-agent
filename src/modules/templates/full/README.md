# 从 full 模板生成的模块

full 模板是 team 模板（知识、技能、专家、考题）再加一个工具。设计里的 full 还有数据和 feed，这两样框架还没做，所以模板里没有。每个文件夹放什么：

- `knowledge/<名字>/`：一份知识。`source.json` 写标题、版本、出处和 `license`，正文是旁边的 Markdown，按 `##` 标题切段。受版权保护的资料写 `"license": "user-import"`，包里只放 `source.json`，全文用 `just module import <模块> <知识名> <文件或目录>` 导入。
- `skills/<名字>/SKILL.md`：一份技能，开头写 `name` 和 `description`。
- `agents/<名字>.md`：一位专家。开头写 `tools`（Pi 工具）和 `uses`（能用模块里的哪些能力，没列的调不到），正文是它的提示词。有专家时 `module.json` 要写 `team`（队名）。
- `evals/<名字>.md`：一道考题。`uses` 是答题时必须用到的能力，`expect` 是答案里必须有的话，正文是问题。`just module try <模块>` 把每道题当成任务跑一遍并判定。
- `tools/<名字>/`：一个工具。`tool.json` 写输入输出，`index.ts` 默认导出一个函数，`cases.json` 是测试用例。只做计算的工具每次检查都跑用例，用例不过模块就打不开。

改完跑 `just module check <这个目录>` 和 `just module try <模块>`，再用 `just module on <模块>` 打开。
