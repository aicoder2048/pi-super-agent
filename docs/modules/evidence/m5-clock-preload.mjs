// Live lanes only, loaded into the host with --import: each SIGUSR2 moves the host's Date.now 24 hours and a minute ahead,
// so lane 4 can watch a card expire without waiting a day.
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
process.on("SIGUSR2", () => {
	offset += 24 * 60 * 60_000 + 60_000;
});
