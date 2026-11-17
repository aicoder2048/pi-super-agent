import { pending, reply, symbolOK } from "../strategy/p2.ts";
export default function vol(input: { symbol?: string; session?: string }) {
  if (!symbolOK(input.symbol)) return reply("INVALID_INPUT", "需要有效 symbol，不能缺省扫描全部标的");
  return pending("IV/HV、rank/百分位、期限结构、偏斜、预期波幅及除息均未实现；没有历史序列，缺值不是 0", { symbol: input.symbol, session: input.session ?? "UNKNOWN", market_data: "NOT_REQUESTED" });
}
