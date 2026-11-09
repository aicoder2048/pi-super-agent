// Measures host.say() -> "user" frame latency on the Unix socket (trunk and head) and on SSE (head only).
// Usage: node --import <repo>/src/pi-runtime.mjs perf.ts <repo> <label> <n>
import { connect } from "node:net";
import { request } from "node:http";
import { performance } from "node:perf_hooks";
const [repo, label, nArg] = process.argv.slice(2);
const n = Number(nArg);
const { startHost } = await import(`${repo}/tests/helpers/fakes.ts`);
const head = label === "head";
const { host } = await startHost(() => [], () => {}, head ? { webPort: 0 } : {});
const pending = new Map<string, { t: number; sock?: number; sse?: number }>();
const sock = connect(host.socketPath);
let buf = "";
sock.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		if (m.type === "user" && pending.has(m.text)) pending.get(m.text)!.sock = performance.now();
	}
});
sock.write(JSON.stringify({ type: "hello", role: "client" }) + "\n");
if (head) {
	const u = new URL(host.webUrl);
	await new Promise<void>((resolve) => {
		request({ host: "127.0.0.1", port: u.port, path: `/events${u.search}` }, (res) => {
			let b = "";
			res.on("data", (d) => {
				b += d;
				let i;
				while ((i = b.indexOf("\n\n")) >= 0) {
					const frame = b.slice(0, i);
					b = b.slice(i + 2);
					const line = frame.split("\n").find((l) => l.startsWith("data: "));
					if (!line) continue;
					const m = JSON.parse(line.slice(6));
					if (m.type === "snapshot") resolve();
					if (m.type === "user" && pending.has(m.text)) pending.get(m.text)!.sse = performance.now();
				}
			});
		}).end();
	});
}
await new Promise((r) => setTimeout(r, 300));
for (let k = 0; k < n; k++) {
	const text = `perf-${label}-${k}`;
	pending.set(text, { t: performance.now() });
	host.say(text);
	await new Promise((r) => setTimeout(r, 20));
}
await new Promise((r) => setTimeout(r, 500));
const out = [...pending.values()].map((p) => ({ sock: p.sock! - p.t, sse: p.sse === undefined ? null : p.sse - p.t }));
console.log(JSON.stringify(out));
sock.destroy();
await host.stop();
process.exit(0);
