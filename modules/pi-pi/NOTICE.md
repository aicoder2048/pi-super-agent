# Pi专家队成员的出处

`agents/` 里九位专家的提示词来自 `pi-vs-claude-code` 仓库的 `.pi/agents/pi-pi/`（MIT 许可，© 2026 IndyDevDan）。许可全文在本文件末尾。

和原文不同的地方：

- frontmatter 加了中文 `title`。
- `tools` 从 `read,grep,find,ls,bash` 改成 `read,grep,find,ls,web_get`。专家不能执行命令，也不写文件。
- 每个文件的「CRITICAL: First Action」一节重写。原文让专家在 shell 里用 `firecrawl scrape … || curl …` 把文档下载到 `/tmp` 再读，`cli-expert` 还要跑 `pi --help`。现在先用 `read`、`grep` 读本机已安装的 Pi 文档，读不到时用 `web_get` 取同一个网址。
- 每个文件的「How to Respond」一节开头加了一条：回复不超过 1800 个字符，先给最小可用的例子，再写读了哪份文档。宿主把超过 2000 字的成员回复截断，原文没有长度限制。
- 没有带上原仓库的 `pi-orchestrator.md`。派活由本队的助手做，见 `skills/pi-pi-desk/SKILL.md`。

其余正文照原文。

## 原许可

```
MIT License

Copyright (c) 2026 IndyDevDan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
