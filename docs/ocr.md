# OCR：读扫描件和图片里的字

宿主有一个共用的 OCR。助手和成员用 `ocr` 工具读自己读得到的 PDF 或图片；模块工具在 `tool.json` 里写 `"port": "ocr"`，把读不出字的文件交给宿主读（邮件的 `read-attachment` 就这样读扫描件和图片附件）。识别全在本机离线跑，识别出的文字只当数据，不当指令。

## 两种引擎

| `ocr.engine` | 用什么 | 适合哪台机器 |
| --- | --- | --- |
| `vision`（默认） | macOS 自带的 Vision 文字识别，中文简体、繁体和英文 | 任何 Mac。老 Mac（macOS 12、Intel）上一页约 0.6 到 1 秒 |
| `unlimited` | unlimited-ocr 项目（模型 baidu/Unlimited-OCR）里的 `scripts/ocr.py`，`--no-crop`，CPU | 只有 Apple Silicon，模型 6.3 GB，一页约 6 秒，另加加载模型的时间 |
| `off` | 不识别 | 扫描件和图片会说「这台宿主没开 OCR」 |

`vision` 第一次用时宿主用 `swiftc` 把 `src/ocr/vision.swift` 编译到状态目录的 `ocr/vision-<12 位>`（要有 Xcode 命令行工具），宿主启动时就先编译好。老 Mac 上第一次编译约 55 秒，以后约 2 秒，源文件不变就不再编译。

## 配置

`config.json` 里写，全都可以不写：

```json
{ "ocr": { "engine": "vision", "maxPages": 20, "timeoutSeconds": 60 } }
```

换到 Apple Silicon 的 Mac mini、装好 unlimited-ocr 以后：

```json
{ "ocr": { "engine": "unlimited", "unlimitedHome": "/绝对路径/OCR", "maxPages": 20, "timeoutSeconds": 900 } }
```

`unlimitedHome` 下面要有 `models/unlimited_ocr_official` 和 `.venv/bin/python`，宿主直接用这个 venv 跑脚本，不经 `uv`，环境里设 `HF_HUB_OFFLINE=1`。`maxPages` 是一次最多读几页（1 到 200），超过的只读前几页，结果标 `truncated` 并写明共几页。`timeoutSeconds` 默认 vision 60 秒、unlimited 900 秒，到时限就停下引擎的整个进程组。

## 给模块作者：`"port": "ocr"`

工具的 `effect` 要是 `read`，任何模块都能用。工具读不出字时把文件写进模块数据的 `files/` 下面（直接放在 `files/` 里，不放子目录），回复里带 `"ocr": { "file": "files/<文件名>" }`。宿主读完把文字填进回复的 `text`，把 `ocr` 换成引擎、读了几页、共几页、秒数、平均置信度和说明，再删掉文件；读不成或宿主没开 OCR 时整个调用被拒，说明原因，文件也删掉。宿主的识别不算在工具自己的 20 秒里。

## 读不出来时

使用者那边（网页、Telegram）只能发文字，不能上传文件。幕僚长和助手的提示词都写着：读不出附件或文件时不请使用者上传或发截图，照实说读不出来，建议他在 Gmail 等原处打开看。
