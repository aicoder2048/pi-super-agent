export default function iv(input: { cursor?: string }) {
  return {
    records: [], cursor: input.cursor,
    problem: {
      id: "option-ta-iv-not-implemented",
      text: "NOT_IMPLEMENTED / 待P3：IV选约、授权日线、BS反解、交易日历、收盘落盘及一年回填均未实现；没有采集，不推进交易日cursor，不生成0或伪历史。P3完成后由使用者配置 just module secret option-ta POLYGON_API_KEY；本轮不读取密钥、不联网。"
    }
  };
}
