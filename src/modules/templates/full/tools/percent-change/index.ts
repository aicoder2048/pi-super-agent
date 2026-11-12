export default function percentChange(input: { from: number; to: number }): { change: number; percent: number } {
	if (input.from === 0) throw new Error("原来的数是 0，算不了百分比");
	const change = input.to - input.from;
	return { change, percent: (change / input.from) * 100 };
}
