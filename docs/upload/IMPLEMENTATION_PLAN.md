# 网页上传入口

决定见 `docs/adr/0032-the-web-page-uploads-files-for-module-tools.md`。

## Stage 1: 宿主收文件
**Goal**: `POST /upload` 把文件存进 `<stateDir>/uploads/`，回 `{id, name, size}`。
**Success Criteria**: 带 token 和本机 Origin 的上传成功并落盘；缺 token 401、外站 Origin 403、类型不对 415、超过 10 MB 413、空文件或没有 name 400。
**Tests**: `tests/integration/web-upload.test.ts`。
**Status**: Complete

## Stage 2: 工具凭编号取文件
**Goal**: `fetch: "upload.file"`：输入 `upload_id`，宿主把文件复制进调用的临时目录，加 `fetched`。
**Success Criteria**: 存在的编号取到文件和元数据；不存在或格式不对的编号拒绝并说明；包检查不要求 feed。
**Tests**: `tests/unit/upload-fetch.test.ts`，`tests/unit/` 里包检查的用例。
**Status**: Complete

## Stage 3: 网页附件按钮和提示词
**Goal**: 输入框旁的附件按钮；选文件即上传，显示待发的附件，发话时在末尾加 `附件：…（上传编号 …）` 一行；幕僚长和 Worker 的提示词改口。
**Success Criteria**: 真页面里选文件、发话，对话里出现那一行，宿主目录里有文件。
**Tests**: `tests/unit/web-attach.test.ts`；`tests/e2e/upload.e2e.ts` 在真宿主和无头浏览器里选文件、发话、查宿主目录。
**Status**: Complete

## Stage 4: option-ta 导入读上传文件
**Goal**: `tools/import` 加 `upload_id`，`fetch: "upload.file"`；`csv` 文字只留给用例。领队技能改成请使用者在网页上传。
**Success Criteria**: 原有 16 个用例照过；新测试用上传的样例文件经宿主取出后导入，结果和直接给文字一样。
**Tests**: `tests/unit/option-ta-import-upload.test.ts`。
**Status**: Complete（真模型预演三道导入考题 3/3：领队把上传编号传给工具，工具读到的字节数与样例一致）

## Stage 5: 部署和实测
**Goal**: 合并后部署老 Mac，使用者在网页上传真实导出走一遍。
**Status**: Not Started
