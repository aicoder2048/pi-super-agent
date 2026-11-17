import { pending, reply } from "../strategy/p2.ts";
export default function ledger(input: { view?: string; tax_year?: number }) {
  if (!["chain", "tax"].includes(input.view ?? "")) return reply("INVALID_INPUT", "view 必须是 chain 或 tax");
  if (input.tax_year !== undefined && (!Number.isInteger(input.tax_year) || input.tax_year < 1900 || input.tax_year > 9999)) return reply("INVALID_INPUT", "tax_year 必须是有效四位年份");
  return pending("尚未读取 data.db；链重建、已实现/浮动盈亏、费用、税年、长短期、wash sale/跨式、§1256/60:40 和年末估值均未实现。无法判断空账本，不返回零收益", { view: input.view, database: "NOT_READ" });
}
