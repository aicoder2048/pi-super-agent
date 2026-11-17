// No notices: never disguise an unimplemented monitor as a successful no-trigger scan.
export default function watch(input: { cursor?: string }) {
  return {
    records: [], notices: [], cursor: input.cursor,
    problem: {
      id: "option-ta-watch-not-implemented",
      text: "NOT_IMPLEMENTED / 待P3：仓位重建、行情对时、5交易日/09:45/3%/2%/五成八成、财报除息、年末快照任务与提醒去重均未实现；本轮没有扫描，不代表无风险或无触发。仅P3完成后配置 just module secret option-ta POLYGON_API_KEY 和 just module secret option-ta FINNHUB_API_KEY；当前不读密钥、不联网、不发仓位通知。"
    }
  };
}
