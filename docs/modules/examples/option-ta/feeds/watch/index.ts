// Reads no holdings, calls no provider, emits no purported trading alert.
export default function watch(_input: unknown) {
  return {
    records: [],
    notices: [{ id: "watch-not-implemented-v1", fields: { status: "NOT_IMPLEMENTED", message: "到期、穿价、权利金、财报和除息监控未实现；没有判断仓位安全、没有发出交易提醒。" } }],
    problem: { id: "NOT_IMPLEMENTED", text: "NOT_IMPLEMENTED：watch取数、报价对齐、事件推算与去重均未实现；不要依赖后台监控。", once: true }
  };
}
