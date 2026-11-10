---
name: pi-extension-basics
description: 写 Pi 扩展最常用的知识：最小骨架、导入包名、放在哪里、registerTool / registerCommand / 事件 / 消息与状态 / ctx.ui / 自定义渲染 / 模型调用的写法和常见坑，外加原文的章节索引。要写或改 Pi 扩展、回答扩展怎么写时，先读这一份，不够再按索引读原文的那一节，不要从头读整份 extensions.md。
---

# 写 Pi 扩展的常用知识

依据 `@earendil-works/pi-coding-agent 1.5.0` 的 `docs/extensions.md`（约 3300 行、156 KB）。这里只收最常用的部分，代码照抄原文的写法。

- 先核对版本：本机 Pi 的版本写在安装目录的 `package.json`（安装目录就是系统提示词「Pi documentation」一节里 README 所在的目录）。不是 1.5.0 时，用到的接口以原文为准。
- 这里没有的，按文末「原文索引」找到标题，用 `grep` 工具定位、`read` 只读那一节，见文末的做法。
- 终端界面组件（`Text`、`Box`、`Container`、自定义组件）的细节在 `docs/tui.md`，快捷键在 `docs/keybindings.md`。

## 最小骨架

```typescript
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event) && event.input.command.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({ name: Type.String({ description: "Name to greet" }) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} };
    },
  });

  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

- 默认导出一个工厂函数，可以是 `async`，Pi 等它完成再继续启动。TypeScript 由 jiti 直接加载，不用编译。
- 工厂里不要起后台进程、socket、文件监听或定时器：有的调用根本不开会话。放到 `session_start` 或用到它的命令、工具里，并在 `session_shutdown` 里清理（清理要能重复调用）。
- 试跑：`pi -e ./my-extension.ts`。

## 导入包名

| 包 | 用途 |
|---|---|
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`、`ExtensionContext`、事件类型和辅助函数（`isToolCallEventType`、`withFileMutationQueue`、`truncateHead` 等） |
| `typebox` | 工具参数的 schema：`Type`、`Static` |
| `@earendil-works/pi-ai` | `StringEnum`（字符串枚举一律用它） |
| `@earendil-works/pi-tui` | 渲染用的组件：`Text`、`Box`、`Container`、`truncateToWidth` |

旧名 `@mariozechner/*` 和 `@sinclair/typebox` 映射到同一批模块，新代码用上表的名字。Node 内置模块（`node:fs` 等）可以直接用；要 npm 包就在扩展旁边放 `package.json` 再 `npm install`，上表的包不要写进 `dependencies`。

## 放在哪里

| 位置 | 范围 |
|---|---|
| `~/.pi/agent/extensions/*.ts`、`*/index.ts`、写了 `"pi": { "extensions": [...] }` 的 `*/package.json` | 全局 |
| `.pi/extensions/` 下同样的三种布局 | 本项目，项目被信任后才加载 |

只往下找一层。别的路径写进 `settings.json` 的 `extensions` 或 `packages`。

## 工具：`pi.registerTool`

```typescript
import { type Static, Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: ["Use my_tool for todo planning instead of direct file edits when the user asks for a task list."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    onUpdate?.({ content: [{ type: "text", text: "Working..." }], details: {} });
    const result = await pi.exec("some-command", [], { signal });
    return { content: [{ type: "text", text: "Done" }], details: { data: result } };
  },
  renderCall(args, theme, context) { /* 见「自定义渲染」 */ },
  renderResult(result, options, theme, context) { /* 见「自定义渲染」 */ },
});
```

- 每个结果（包括传给 `onUpdate` 的中间结果）都要有给模型看的 `content` 和一个 `details`；没东西存就写 `details: undefined`。同一个工具所有结果的 `details` 类型要一致。
- 出错：在 `execute` 里 `throw`，或返回 `isError: true`（后者还能带 `details`）。别的返回值不算出错。
- 字符串枚举用 `StringEnum`，所有提供方都认。`Type.Refine()` 不会执行，约束在 `execute` 里自己查。
- `promptSnippet` 让工具在系统提示词的 `<tools>` 里占一行，不写就不出现在那里。`promptGuidelines` 的每一条平铺进 `<rules>`，必须写出工具名（「Use my_tool when…」），不能写「Use this tool」。
- 输出必须截断：内置上限 50KB 或 2000 行，用 `truncateHead`（文件、搜索结果）或 `truncateTail`（日志、命令输出）。
- 改文件的工具用 `withFileMutationQueue(absolutePath, async () => { ... })` 包住整个读改写，否则和并行的内置 `edit`/`write` 会互相覆盖。路径参数先去掉开头的 `@`。
- 同一条助手消息里的工具调用默认并行。共享内存状态的工具设 `executionMode: "sequential"`。
- 返回 `terminate: true` 提示这一批工具之后不再调模型（整批都 terminate 才生效）。
- 工具可以在任何时候注册（`session_start`、命令里都行），注册后默认激活；`pi.setActiveTools(names)` 改激活集合，`pi.getActiveTools()`、`pi.getAllTools()` 查看。
- 工具里可以调别的工具：`ctx.executeTool(name, args, { signal, onUpdate })`，失败也不抛，结果带 `isError: true`。

## 命令：`pi.registerCommand`

```typescript
import type { AutocompleteItem } from "@earendil-works/pi-tui";

pi.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const items = ["dev", "staging", "prod"].map((e) => ({ value: e, label: e }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```

- `args` 是 `/deploy` 后面的整段文字。命令先于 `input` 事件处理，命令触发时 `input` 不触发。
- 几个扩展注册同名命令时都保留，按加载顺序变成 `/review:1`、`/review:2`。
- 命令处理函数拿到的 `ctx` 多了会话操作：`ctx.waitForIdle()`、`ctx.newSession()`、`ctx.reload()` 等，用法查原文「ExtensionCommandContext」。

## 事件：`pi.on(event, handler)`

`handler(event, ctx)` 可以是 `async`；`pi.on` 返回取消订阅的函数。按扩展加载顺序、再按注册顺序执行。最常用的：

| 事件 | 什么时候 | 返回值 |
|---|---|---|
| `session_start` | 会话开始、恢复、`/new`、`/fork`、`/reload` 之后；`event.reason` 说明是哪种 | 无 |
| `session_shutdown` | 会话要拆掉（退出、重载、换会话）前 | 无，在这里清理资源 |
| `input` | 用户输入到达，命令已检查、技能和模板还没展开；`event.text`、`event.source`（`"interactive"`、`"rpc"`、`"extension"`） | `{ action: "continue" }`（默认）、`{ action: "transform", text }`、`{ action: "handled" }`（不交给模型） |
| `before_agent_start` | 一次运行开始前 | `{ message: { customType, content, display }, systemPrompt }`，都可选 |
| `tool_call` | 工具执行前；`event.toolName`、`event.input`（可原地改） | `{ block: true, reason }` 拦下 |
| `tool_result` | 工具执行后 | 部分补丁：`content`、`details`、`isError` |
| `turn_start` / `turn_end` | 每一轮模型请求前后 | 见原文 |
| `agent_end` / `agent_settled` | `agent_end` 之后可能还有重试或排队消息；真正空闲用 `agent_settled` | 无 |
| `context` | 每次请求模型前，可改要发出的消息 | 见原文 |
| `model_select` | 换模型后 | 无 |

- `isToolCallEventType("bash", event)` 收窄类型，之后 `event.input.command` 有类型。自定义工具的输入类型用 `isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)`。
- `tool_call` 处理函数抛错就拦下这次调用（宁可拦错）。其他事件处理函数抛错只记日志，Pi 照常运行。
- 在事件里做网络请求或调模型，把 `ctx.signal` 传下去，用户按 Esc 能取消。空闲时（会话事件、命令、快捷键）它通常是 `undefined`。

## 消息和状态

- `pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: true, deliverAs: "steer" })`：插一条自定义消息，**会**进模型上下文。`deliverAs`：`"steer"`（默认，当前这批工具执行完、下次请求模型前送到）、`"followUp"`（等运行结束）、`"nextTurn"`（等下一次用户输入）。空闲时不写 `triggerTurn: true` 就只存下不触发回复。
- `pi.sendUserMessage(text, { deliverAs })`：像用户打字一样发一条。模型正在运行时必须写 `deliverAs`（`"steer"` 或 `"followUp"`），否则被拒。默认不展开命令和模板，要展开写 `expandPromptTemplates: true`。
- `pi.appendEntry(customType, data)`：存扩展自己的数据，**不**进模型上下文；配合 `pi.registerEntryRenderer` 能在对话里显示。
- 会随会话分支走的状态，存在工具结果的 `details` 里，在 `session_start` 和 `session_tree` 时从 `ctx.sessionManager.getBranch()` 重建（只看当前分支，不看全部 entry）：

```typescript
const reconstruct = (ctx: ExtensionContext) => {
  items = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "my_tool") {
      items = (entry.message.details as { items?: string[] } | undefined)?.items ?? [];
    }
  }
};
pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
```

## 和用户交互：`ctx.ui`

```typescript
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");
const name = await ctx.ui.input("Name:", "placeholder");
const text = await ctx.ui.editor("Edit:", "prefilled text");
ctx.ui.notify("Done!", "info");                         // "info" | "warning" | "error"
ctx.ui.setStatus("my-ext", "Processing...");            // 页脚状态，传 undefined 清掉
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);    // 输入框上方；{ placement: "belowEditor" } 放下方
ctx.ui.setWidget("my-widget", undefined);               // 清掉
ctx.ui.setEditorText("Prefill text");
```

复杂界面用 `ctx.ui.custom()`，它临时替换输入框，直到调用 `done(value)`：

```typescript
import { truncateToWidth } from "@earendil-works/pi-tui";

const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => ({
  render(width: number): string[] {
    return [truncateToWidth(theme.fg("accent", "Press Enter to confirm, Escape to cancel"), width)];
  },
  handleInput(data: string): void {
    if (keybindings.matches(data, "tui.select.confirm")) done(true);
    else if (keybindings.matches(data, "tui.select.cancel")) done(false);
  },
  invalidate() {},
}));
```

各运行模式下能用什么：

| 模式 | `ctx.mode` | `ctx.hasUI` | 说明 |
|---|---|---|---|
| 交互 | `"tui"` | `true` | 全部可用 |
| RPC（`--mode rpc`） | `"rpc"` | `true` | 对话框和通知走 JSON 协议；`custom()` 返回 `undefined`，组件工厂被忽略 |
| JSON（`--mode json`） | `"json"` | `false` | UI 方法什么都不做 |
| 打印（`-p`） | `"print"` | `false` | 扩展照常运行，但不能问用户 |

用 `custom()`、组件工厂、终端输入前查 `ctx.mode === "tui"`；用对话框和通知前查 `ctx.hasUI`。

## 自定义渲染

```typescript
import { Text } from "@earendil-works/pi-tui";

renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(theme.fg("toolTitle", theme.bold("my_tool ")) + theme.fg("muted", args.action));
  return text;
},
renderResult(result, { expanded, isPartial }, theme, context) {
  if (isPartial) return new Text(theme.fg("warning", "Processing..."), 0, 0);
  let text = theme.fg("success", "✓ Done");
  if (!expanded) text += ` (${context.keyHint("app.tools.expand", "to expand")})`;
  return new Text(text, 0, 0);
},
```

- 定义了就必须返回一个组件；不想显示内容就返回空的 `Container`。没定义或抛错时，调用行显示工具名，结果显示 `content` 的原文。
- `Text` 的内边距写 `(0, 0)`，默认的外框已经处理了内边距。默认视图保持紧凑，细节放在 `expanded` 里。
- 快捷键提示用渲染上下文里的 `context.keyHint()`，不要从包里导入 `keyHint`（扩展自带的那份包看不到用户的快捷键配置）。
- 自定义消息的显示：`pi.registerMessageRenderer(customType, (message, options, theme) => component)`；`appendEntry` 存的 entry 用 `pi.registerEntryRenderer`。

## 在扩展里调模型

用 `ctx.modelRegistry.complete(model, context, options)` 等最终的助手消息，或 `ctx.modelRegistry.streamSimple(model, context, options)` 拿事件流（再 `await .result()`）。两者都用已配置的提供方和认证，包括 `pi.registerProvider()` 注册的。当前模型是 `ctx.model`。不要用 `pi-ai/compat` 里的流式函数，它们看不到扩展注册的提供方。参数细节查原文「Streaming model calls」和 `docs/models.md`。

## 其他常用接口

- `pi.exec(command, args, { signal, timeout, cwd })`：不经 shell 执行命令，返回 `stdout`、`stderr`、`code`、`killed`、`truncated`。
- `pi.registerFlag(name, { description, type: "boolean", default })`：命令行参数。工厂里读到的是默认值，在 `session_start` 里用 `pi.getFlag(name)` 读实际值。
- `pi.registerShortcut("ctrl+shift+p", { description, handler: async (ctx) => {} })`：键名和保留键查 `docs/keybindings.md`。
- `pi.setModel(model)`、`pi.getThinkingLevel()`、`pi.setThinkingLevel(level)`：只改当前会话。
- `pi.events.on(name, fn)` / `pi.events.emit(name, data)`：扩展之间通信。
- `pi.setSessionName(name)`：会话显示名。
- `ctx.cwd`、`ctx.sessionManager`（只读：`getEntries()`、`getBranch()`、`getSessionFile()` 等）、`ctx.isIdle()`、`ctx.abort()`。

## 常见坑

1. 工具结果缺 `details`，或几个结果的 `details` 类型不一致。
2. 字符串枚举用了 `Type.Union` 拼字面量，换用 `StringEnum`。
3. `promptGuidelines` 写「Use this tool」，模型分不清是哪个工具。
4. 工具输出不截断，撑爆上下文。
5. 模型运行时调 `pi.sendUserMessage` 不写 `deliverAs`，被拒。
6. 拿 `agent_end` 当「空闲」，应该用 `agent_settled`。
7. 状态从全部 entry 重建，应该只看 `getBranch()`，并且在 `session_tree` 时也重建。
8. 在打印或 JSON 模式里弹对话框；先查 `ctx.hasUI`，`custom()` 先查 `ctx.mode === "tui"`。
9. 在工厂里起定时器或子进程，不在 `session_shutdown` 里收。
10. 自定义工具改文件不进 `withFileMutationQueue`，和内置 `edit` 互相覆盖。

## 原文索引

怎么只读一节：调用 `grep` 工具，`path` 写 `<docs>/extensions.md`，`pattern` 写 `^#{2,4} Custom Rendering`；一次找几个用 `^#{2,4} (Custom Rendering|Tool Events)`。`grep` 工具用的是 ripgrep 的正则，「或」直接写 `|`，前面不加反斜杠。标题里有括号、问号的（接口那几节），`pattern` 只写到括号前，例如 `^### pi\.registerTool`。拿到行号后，用 `read` 的 `offset` 和 `limit` 读到下一个同级标题为止。

下面每一项都是 `docs/extensions.md` 里一个标题的原文（接口写的是标题开头）：

- 入门：`Quick Start`、`Extension Locations`、`Available Imports`、`Tool parameter schemas and TypeBox`、`Writing an Extension`、`Async factory functions`、`Long-lived resources and shutdown`、`Extension Styles`
- 事件：`Lifecycle Overview`、`Handler Composition`、`Session Events`、`Agent Events`、`Model Events`、`Tool Events`、`Typing custom tool input`、`User Bash Events`、`Input Events`
- 上下文：`ExtensionContext`、`ExtensionCommandContext`、`Session replacement lifecycle and footguns`、`Streaming model calls`，以及 `ctx.ui`、`ctx.mode`、`ctx.hasUI`、`ctx.sessionManager`、`ctx.modelRegistry`、`ctx.signal`、`ctx.compact`、`ctx.newSession`、`ctx.fork`、`ctx.reload`
- 接口：`ExtensionAPI Methods`，以及 `pi.registerTool`、`pi.sendMessage`、`pi.sendUserMessage`、`pi.appendEntry`、`pi.registerCommand`、`pi.registerMessageRenderer`、`pi.registerEntryRenderer`、`pi.registerShortcut`、`pi.registerFlag`、`pi.exec`、`pi.getActiveTools`、`pi.setModel`、`pi.events`、`pi.registerProvider`
- 工具：`State Management`、`Custom Tools`、`Tool Definition`、`Overriding Built-in Tools`、`Output Truncation`、`Custom Rendering`、`Dynamic Tool Loading`、`Tool Exposure`、`Calling Other Tools`
- 界面：`Custom UI`、`Dialogs`、`Widgets, Status, and Footer`、`Autocomplete Providers`、`Custom Components`、`Custom Editor`、`Message and Entry Rendering`、`Theme Colors`
- 收尾：`Error Handling`、`Mode Behavior`、`Examples Reference`（`examples/extensions/` 里每个例子用到哪些接口）
