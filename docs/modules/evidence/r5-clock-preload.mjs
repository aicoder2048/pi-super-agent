// Live lanes only, loaded into the host with --import: Date.now starts at PSA_R5_NOW and moves with the wall clock, and each
// SIGUSR2 moves it a minute ahead, so the quotes feed is due on the next scheduler tick at any hour of the real day.
const realNow = Date.now;
let offset = Date.parse(process.env.PSA_R5_NOW ?? "") - realNow();
if (Number.isNaN(offset)) throw new Error("PSA_R5_NOW must be an ISO time");
Date.now = () => realNow() + offset;
process.on("SIGUSR2", () => {
	offset += 60_000;
});
