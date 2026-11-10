import { connect } from "node:net";
import { join } from "node:path";
import { quoteMark } from "../client/board-format.mjs";
import { clientTokenBeside } from "../client/client-token.ts";
import { defaultStateDir } from "../host/config.ts";
import { onJsonLines, writeJsonLine } from "../jsonl.ts";
import type { Quote } from "../kernel/types.ts";

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
const token = tokenOrExit();
let greeted = false;
const socket = connect(socketPath);
const time = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
const print = (who: string, body: string, at: number) => console.log(`${time(at)} ${who}> ${body}`);
const printLine = (m: { who: string; text: string; at: number; quote?: Quote }) => {
	if (m.quote) console.log(`${time(m.at)} ${quoteMark(m.quote)}`);
	print(m.who === "user" ? "你" : "Router", m.text, m.at);
};

socket.on("error", (e) => fail(`连不上宿主：${e.message}。先运行 just host。`));
socket.on("close", () => {
	if (!greeted) fail("宿主在打招呼时断开了连接，多半是 client-token 和宿主启动时读到的不一致。重启宿主后再试。");
});
writeJsonLine(socket, { type: "hello", role: "client", token });
onJsonLines(socket, (record) => {
	const r = record as any;
	if (r.type === "snapshot") {
		greeted = true;
		if (mode === "tail") r.conversation.slice(-10).forEach(printLine);
		if (mode === "say") writeJsonLine(socket, { type: "say", text });
	} else if (r.type === "reply") print("Router", r.text, r.at);
	else if (r.type === "user" && mode === "tail") printLine({ ...r, who: "user" });
	else if (r.type === "board" && mode === "board") {
		for (const row of r.rows) console.log(`${row.stage.padEnd(18)} ${row.basis.padEnd(9)} ${row.title} · ${row.latestSummary ?? ""}`);
		console.log("---");
	}
});
if (mode === "say") {
	if (!text) throw new Error("用法：just say <要说的话>");
	setTimeout(() => process.exit(0), waitMs).unref();
}
