// P2: offline validation only. No fetch, environment/secret access, database or file IO.
export type Reply = { status: string; reason: string; payload: string };
export const reply = (status: string, reason: string, data: unknown = {}): Reply => ({ status, reason, payload: JSON.stringify(data) });
export const pending = (reason: string, data: unknown = {}) => reply("NOT_IMPLEMENTED", `${reason}；待 P3，不代表已完成或没有数据。`, data);
export function objectJSON(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string" || text.length > 65536) return undefined;
  try { const x = JSON.parse(text); return x && typeof x === "object" && !Array.isArray(x) ? x : undefined; } catch { return undefined; }
}
export function isoDay(x: unknown): x is string {
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const d = new Date(`${x}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === x;
}
export const symbolOK = (x: unknown): x is string => typeof x === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(x);
export const quantityOK = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x <= 1000000;
export function price4(x: unknown): bigint | undefined {
  if (typeof x !== "string" || !/^\d{1,8}(\.\d{1,4})?$/.test(x)) return undefined;
  const [whole, fraction = ""] = x.split(".");
  return BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, "0"));
}
export function money4(x: bigint): string {
  const sign = x < 0n ? "-" : "";
  const n = x < 0n ? -x : x;
  return `${sign}${n / 10000n}.${String(n % 10000n).padStart(4, "0")}`;
}
