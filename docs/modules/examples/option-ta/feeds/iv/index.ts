export default function iv(input: { cursor?: string | null }) {
	return {
		records: [],
		...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
		problem: { id: "NOT_IMPLEMENTED", text: "NOT_IMPLEMENTED：IV原始输入采集、交易日历与一年回填没有有效结果；没有写入快照，不把该交易日标成成功。设置密钥用 just module secret option-ta POLYGON_API_KEY；设置密钥本身不会让采集完成。" },
	};
}
