// e2e only, loaded into the host with --import: adds feed kind "e2e-alerts". Every file the test drops into
// PSA_E2E_ALERTS_DIR becomes one alert, the file name its externalId and the contents its text. A restarted host
// posts every file again, so the kernel's dedupe is what keeps the phone from ringing twice.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FEEDS } from "../../src/sources/feeds.ts";

const dir = process.env.PSA_E2E_ALERTS_DIR ?? "";
if (!dir) throw new Error("PSA_E2E_ALERTS_DIR 没有设置");

FEEDS["e2e-alerts"] = ({ source }) => ({
	source,
	lookupHelp: "",
	create: (ctx) => {
		const posted = new Set();
		let timer;
		const scan = () => {
			for (const name of readdirSync(dir)) {
				if (posted.has(name)) continue;
				posted.add(name);
				ctx.post({ kind: "alert", externalId: name, text: readFileSync(join(dir, name), "utf8").trim(), occurredAt: ctx.clock.now() });
			}
		};
		return {
			start() {
				timer = setInterval(scan, 100);
			},
			stop() {
				clearInterval(timer);
			},
			problem: () => undefined,
			lookup: async () => null,
		};
	},
});
