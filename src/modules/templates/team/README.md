# 从 team 模板生成的模块

team 模板在 notes 模板的知识和技能之外，加了专家和考题。每个文件夹放什么：

- `knowledge/<名字>/`：一份知识。`source.json` 写标题、版本、出处和 `license`，正文是旁边的 Markdown，按 `##` 标题切段。受版权保护的资料写 `"license": "user-import"`，包里只放 `source.json`，全文用 `just module import <模块> <知识名> <文件或目录>` 导入。
- `skills/<名字>/SKILL.md`：一份技能，开头写 `name` 和 `description`。
- `agents/<名字>.md`：一位专家。开头写 `tools`（Pi 工具）和 `uses`（能用模块里的哪些能力，没列的调不到），正文是它的提示词。有专家时 `module.json` 要写 `team`（队名）。
- `evals/<名字>.md`：一道考题。`uses` 是答题时必须用到的能力，`expect` 是答案里必须有的话，正文是问题。`just module try <模块>` 把每道题当成任务跑一遍并判定。

改完跑 `just module check <这个目录>` 和 `just module try <模块>`，再用 `just module on <模块>` 打开。
