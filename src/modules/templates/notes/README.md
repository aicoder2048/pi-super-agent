# 从 notes 模板生成的模块

notes 模板只有知识和技能。每个文件夹放什么：

- `knowledge/<名字>/`：一份知识。`source.json` 写标题、版本、出处和 `license`，正文是旁边的 Markdown，按 `##` 标题切段。受版权保护的资料写 `"license": "user-import"`，包里只放 `source.json`，全文用 `just module import <模块> <知识名> <文件或目录>` 导入。
- `skills/<名字>/SKILL.md`：一份技能，开头写 `name` 和 `description`。Worker 处理这个模块的任务时加载它。

改完跑 `just module check <这个目录>`，再用 `just module on <模块>` 打开。
