// No raw observations means no snapshot row and no cursor advancement.
export default function iv(_input: unknown) {
  return {
    records: [],
    notices: [{ id: "iv-not-implemented-v1", fields: { status: "NOT_IMPLEMENTED", message: "IV一年回填、收盘后采集和同口径反解未实现；未取数、未存快照、未推进cursor。" } }],
    problem: { id: "NOT_IMPLEMENTED", text: "NOT_IMPLEMENTED：iv采集与交易日历未实现；settings只是默认口径，不能当作已运行或已回填。", once: true }
  };
}
