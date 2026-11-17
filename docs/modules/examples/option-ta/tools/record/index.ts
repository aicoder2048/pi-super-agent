import { isoDay, objectJSON, pending, price4, quantityOK, reply } from "../strategy/p2.ts";
export default function record(input: { request?: string }) {
  const q = objectJSON(input.request);
  if (!q) return reply("INVALID_INPUT", "request 必须是 JSON 对象文字，最大 64KB");
  const missing = ["account_ref", "instrument", "side", "qty", "price", "trade_date", "cumulative_qty"].filter(k => q[k] === undefined || q[k] === null || q[k] === "");
  if (missing.length) return reply("INVALID_INPUT", "缺少必填字段；不猜账户、乘数、日期或累计数量", { missing });
  if (["BUY", "SELL", "EXPIRE", "ASSIGNED", "EXERCISED", "CASH_SETTLED"].includes(String(q.side))) return pending("事件及其股票交割校验尚未实现；普通股票成交不在范围内");
  const instrument = q.instrument as Record<string, unknown>;
  if (!instrument || typeof instrument !== "object" || Array.isArray(instrument) || !["STO", "BTO", "BTC", "STC"].includes(String(q.side)) || typeof q.account_ref !== "string" || !q.account_ref.trim() || !quantityOK(q.qty) || !quantityOK(q.cumulative_qty) || q.cumulative_qty < q.qty || price4(q.price) === undefined || !isoDay(q.trade_date)) return reply("INVALID_INPUT", "账户、方向、数量、价格或日期格式无效；price 仅接受最多4位小数文字");
  if (instrument.adjusted === true) return pending("调整合约交割物校验未实现，不按100猜测");
  if (!quantityOK(instrument.multiplier) || typeof instrument.option_symbol !== "string" || !/^[A-Z0-9.]{1,8}\d{6}[CP]\d{8}$/.test(instrument.option_symbol)) return reply("INVALID_INPUT", "需 OCC 格式 option_symbol 和已核实的正整数 multiplier；本轮不核验合约事实");
  return reply("VALIDATED_ONLY", "仅通过基础格式校验，禁止据此入账；数据库查重、OCC事实核验、累计增量、fill_id、冲销和账户映射均待P3", { candidate: q, may_write: false, dedup: "NOT_IMPLEMENTED", fees: "NOT_CHECKED" });
}
