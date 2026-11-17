import { isoDay, pending, reply, symbolOK } from "../strategy/p2.ts";
export default function chain(input: { symbol?: string; expiry?: string; right?: string; session?: string }) {
  const missing = [!input.symbol && "symbol", !input.expiry && "expiry", !input.right && "right"].filter(Boolean);
  if (missing.length) return reply("INVALID_INPUT", "缺少必填字段", { missing });
  if (!symbolOK(input.symbol) || !isoDay(input.expiry) || !["put", "call"].includes(input.right!)) return reply("INVALID_INPUT", "代码、日期或 put/call 格式无效");
  return pending("期权链、分页、二元过滤、报价及 BS/Greeks 均未接入；休市也不返回伪收盘 IV", { query: input, market_data: "NOT_REQUESTED" });
}
