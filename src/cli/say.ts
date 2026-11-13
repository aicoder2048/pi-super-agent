import { connect } from "node:net";
import { join } from "node:path";
import { hostLineLabel, quoteMark } from "../client/board-format.mjs";
import { clientTokenBeside } from "../client/client-token.ts";
import { defaultStateDir } from "../host/config.ts";
import { hasVisibleText } from "../host/server.ts";
import { onJsonLines, writeJsonLine } from "../jsonl.ts";
import type { ConversationLine } from "../kernel/types.ts";

const [mode = "tail", ...rest] = process.argv.slice(2);
const text = rest.join(" ");
const waitMs = Number(process.env.PSA_SAY_WAIT_MS ?? 120_000);
const socketPath = join(defaultStateDir(), "host.sock");
const fail = (line: string): never => {
	console.error(line);
	process.exit(1);
};
function tokenOrExit(): string {
	try {
		return clientTokenBeside(socketPath);
	} catch (error) {
		return fail((error as Error).message);
	}
}
if (mode === "notify" && !hasVisibleText(text)) fail("用法：just notify <要通知的话>");
const token = tokenOrExit();
let greeted = false;
const socket = connect(socketPath);
const time = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
const WHO = { user: "你", router: "Router" } as const;
const print = (who: string, body: string, at: number) => console.log(`${time(at)} ${who}> ${body}`);
const printLine = (m: ConversationLine) => {
	if ("quote" in m && m.quote) console.log(`${time(m.at)} ${quoteMark(m.quote)}`);
	print(m.who === "user" || m.who === "router" ? WHO[m.who] : hostLineLabel(m), m.text, m.at);
};

socket.on("error", (e) => fail(`连不上宿主：${e.message}。先运行 just host。`));
socket.on("close", () => {
	if (!greeted) fail("宿主在打招呼时断开了连接，多半是 client-token 和宿主启动时读到的不一致。重启宿主后再试。");
	if (mode === "notify") fail("宿主没回话就断开了，通知可能没记下。看一眼网页再决定要不要重发。");
});
writeJsonLine(socket, { type: "hello", role: "client", token });
onJsonLines(socket, (record) => {
	const r = record as any;
	if (r.type === "snapshot") {
		greeted = true;
		if (mode === "tail") r.conversation.slice(-10).forEach(printLine);
		if (mode === "say") writeJsonLine(socket, { type: "say", text });
		if (mode === "notify") writeJsonLine(socket, { type: "notify", text, requestId: "notify" });
	} else if (r.type === "notified" && mode === "notify") process.exit(0);
	else if (r.type === "refused" && mode === "notify") fail(r.reason);
	else if (r.type === "reply") print("Router", r.text, r.at);
	else if (r.type === "user" && mode === "tail") printLine({ ...r, who: "user" });
	else if (r.type === "host_line" && mode === "tail") printLine(r);
	else if (r.type === "board" && mode === "board") {
		for (const row of r.rows) console.log(`${row.stage.padEnd(18)} ${row.basis.padEnd(9)} ${row.title} · ${row.latestSummary ?? ""}`);
		console.log("---");
	}
});
if (mode === "say") {
	if (!text) throw new Error("用法：just say <要说的话>");
	setTimeout(() => process.exit(0), waitMs).unref();
}
if (mode === "notify") setTimeout(() => fail("宿主 10 秒内没确认，通知可能没记下。看一眼网页再决定要不要重发。"), 10_000).unref();
