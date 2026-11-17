export default function watch(input: { cursor?: string | null }) {
	return {
		records: [], notices: [],
		...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
		problem: { id: "NOT_IMPLEMENTED", text: "NOT_IMPLEMENTED：持仓风险监控没有有效检测结果，不表示风险已排除，不发虚构提醒。密钥设置用 just module secret option-ta POLYGON_API_KEY 和 just module secret option-ta FINNHUB_API_KEY；阈值契约见watch-thresholds技能。" },
	};
}
