export default function riskReward(input: { entry: number; stop: number; target: number; atr?: number }) {
	const { entry, stop, target, atr } = input;
	for (const [name, value] of Object.entries({ entry, stop, target })) {
		if (typeof value !== "number" || !(value > 0)) throw new Error(`${name} 要是正数，收到 ${JSON.stringify(value)}`);
	}
	const side = stop < entry && entry < target ? "做多" : target < entry && entry < stop ? "做空" : undefined;
	if (side === undefined) throw new Error("止损和目标要在开仓价两侧：做多时止损低于开仓价、目标高于开仓价，做空反过来");
	const risk = Math.abs(entry - stop);
	const reward = Math.abs(target - entry);
	const result = { side, risk, reward, ratio: reward / risk, stopPercent: (risk / entry) * 100, targetPercent: (reward / entry) * 100 };
	return typeof atr === "number" && atr > 0 ? { ...result, stopInAtr: risk / atr } : result;
}
