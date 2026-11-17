// No network, database access, or model-generated substitute for market data.
export default function chain(_input: unknown) {
  return { status: "NOT_IMPLEMENTED", reason: "期权链取数、分页、二元过滤、IV/希腊值补算、OI/GEX/最大痛点与异常成交尚未实现；没有返回行情或计算结果。" };
}
