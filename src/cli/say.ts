import { connect } from "node:net";
import { join } from "node:path";
import { defaultStateDir } from "../host/config.ts";
import { onJsonLines, writeJsonLine } from "../jsonl.ts";

const [mode = "tail", ...rest] = process.argv.slice(2);
const text = rest.join(" ");
const waitMs = Number(process.env.PSA_SAY_WAIT_MS ?? 120_000);
const socket = connect(join(defaultStateDir(), "host.sock"));
const time = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
const print = (who: string, body: string, at: number) => console.log(`${time(at)} ${who}> ${body}`);

socket.on("error", (e) => {
	console.error(`连不上宿主：${e.message}。先运行 just host。`);
	process.exit(1);
});
writeJsonLine(socket, { type: "hello", role: "client" });
onJsonLines(socket, (record) => {
	const r = record as any;
	if (r.type === "snapshot") {
		if (mode === "tail") for (const m of r.conversation.slice(-10)) print(m.who === "user" ? "你" : "Router", m.text, m.at);
		if (mode === "say") writeJsonLine(socket, { type: "say", text });
	} else if (r.type === "reply") print("Router", r.text, r.at);
	else if (r.type === "user" && mode === "tail") print("你", r.text, r.at);
	else if (r.type === "board" && mode === "board") {
		for (const row of r.rows) console.log(`${row.stage.padEnd(18)} ${row.basis.padEnd(9)} ${row.title} · ${row.latestSummary ?? ""}`);
		console.log("---");
	}
});
if (mode === "say") {
	if (!text) throw new Error("用法：just say <要说的话>");
	setTimeout(() => process.exit(0), waitMs).unref();
}
