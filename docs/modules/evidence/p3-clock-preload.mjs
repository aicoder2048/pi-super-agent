// Live lanes only, loaded into the host with --import: Date.now starts at PSA_P3_NOW and moves with the wall clock; each SIGUSR2
// sets it to the ISO time written in PSA_P3_CLOCK_FILE, so a lane can step from the session past the close in one jump.
import { readFileSync } from "node:fs";

const realNow = Date.now;
let offset = Date.parse(process.env.PSA_P3_NOW ?? "") - realNow();
if (Number.isNaN(offset)) throw new Error("PSA_P3_NOW must be an ISO time");
Date.now = () => realNow() + offset;
process.on("SIGUSR2", () => {
	const target = Date.parse(readFileSync(process.env.PSA_P3_CLOCK_FILE ?? "", "utf8").trim());
	if (!Number.isNaN(target)) offset = target - realNow();
});
