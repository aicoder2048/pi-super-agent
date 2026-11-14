// Loaded with --import by proactive-live.ts; each SIGUSR2 moves the clock ahead so a feed can be made due at once.
const realNow = Date.now;
const step = Number(process.env.PSA_PROACTIVE_STEP_MS ?? 60_000);
let offset = Date.parse(process.env.PSA_PROACTIVE_NOW ?? "") - realNow();
if (Number.isNaN(offset)) throw new Error("PSA_PROACTIVE_NOW must be an ISO time");
Date.now = () => realNow() + offset;
process.on("SIGUSR2", () => {
	offset += step;
});
