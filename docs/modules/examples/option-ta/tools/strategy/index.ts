import { money4, objectJSON, pending, price4, quantityOK, reply } from "./p2.ts";
export default function strategy(input: { request?: string }) {
  const q = objectJSON(input.request);
  if (!q) return reply("INVALID_INPUT", "request 必须是 JSON 对象文字，最大 64KB");
  if (typeof q.operation !== "string") return reply("INVALID_INPUT", "缺少 operation");
  if (q.operation !== "cashflow") return pending("只实现给定逐腿价格的未扣费权利金现金流；完整策略、场景、Roll 判定、BS、年化、概率均未实现");
  if (!Array.isArray(q.legs) || q.legs.length < 1 || q.legs.length > 4) return reply("INVALID_INPUT", "legs 需要 1 到 4 条；这不是对策略是否受支持的判断");
  let net = 0n;
  const amounts: string[] = [];
  for (const raw of q.legs) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reply("INVALID_INPUT", "腿必须是对象");
    const leg = raw as Record<string, unknown>;
    const p = price4(leg.price);
    if (!["STO", "STC", "BTO", "BTC"].includes(String(leg.side)) || p === undefined || !quantityOK(leg.qty) || !quantityOK(leg.multiplier)) return reply("INVALID_INPUT", "每腿须给 STO/STC/BTO/BTC、非负价格文字(最多4位小数)、正整数 qty 和已核实 multiplier；不默认100");
    const amount = p * BigInt(leg.qty) * BigInt(leg.multiplier) * (["STO", "STC"].includes(String(leg.side)) ? 1n : -1n);
    amounts.push(money4(amount));
    net += amount;
  }
  return reply("CALCULATED_PARTIAL", "仅计算使用者给定输入的未扣费权利金现金流（USD）；不是已实现盈亏、可成交报价或税务结果，不验证 Roll 配对/交割物，也不代表完整策略能力", { net_premium_usd: money4(net), leg_cashflows_usd: amounts, fees: "UNKNOWN_NOT_DEDUCTED", source: "USER_PROVIDED", market_data: "NOT_REQUESTED" });
}
