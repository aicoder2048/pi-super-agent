# 网页右栏的简报官

决定见 `docs/adr/0033-an-ai-assistant-explains-the-conversation-on-the-web-page.md`。

## Stage 1: 宿主的简报官服务
**Goal**: `POST /assist` 收 `{ question, about?: { lineId, picked? } }`。宿主按这句话所属模块拼专家背景和上下文，用模型会话回答，问答存进 `state.db`。回答以 `assistant` 帧经 SSE 推给页面（流式），快照里带最近的问答。`POST /assist/clear` 清空。
**Success Criteria**: 假模型下：问一句属于 option-ta 任务的话，提示词里有期权研究组的身份、术语表、那句话和前后文；不属于模块的话用简报官；回答存下、重连后还在；清空后没了。
**Tests**: `tests/unit/assistant-prompt.test.ts`（拼背景和上下文的纯函数），`tests/integration/assistant.test.ts`（真宿主 + 假模型）。
**Status**: Complete

## Stage 2: 网页「简报官」页和「问简报官」
**Goal**: 右栏加「简报官」标签页，可以输入、发送、看流式回答（Markdown）、清空。对话每句话加「问简报官」；选中文字浮出「问简报官」。手机上在「概况」里。
**Success Criteria**: 真页面里点一句话的「问简报官」，或选中「IV Rank」点「问简报官」，简报官页打开并预填问题；发出后回答流式出现。
**Tests**: `view.mjs` 纯函数单测（预填问题、简报官视图）；`tests/e2e/assistant.e2e.ts`。
**Status**: Complete

## Stage 3: 朗读
**Goal**: `POST /speak` 收一句文字，宿主按读音表换读法后用 edge-tts 晓伊合成 mp3 并缓存；页面按句切开，边合成边播，可以停。合成失败退回浏览器朗读。
**Success Criteria**: 假合成器下：切句、读音替换、缓存命中；真机上听一条回答。
**Tests**: `tests/unit/assistant-speech.test.ts`；e2e 里点朗读、换成假合成器。
**Status**: Complete

## Stage 4: 部署和实测
**Goal**: 部署老 Mac，使用者用前面那两段期权回答试「问简报官」和朗读。之后再看 Telegram 怎么做。
**Status**: Not Started
