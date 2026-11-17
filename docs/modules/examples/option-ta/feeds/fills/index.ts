// Host supplies body + optional decoded html (<=256KB). Never log/echo mail contents.
// Explicit P2 placeholder: do not acknowledge messages, write records, or advance cursor.
export default function fills(input: { cursor?: string; items?: unknown[] }) {
  return {
    records: [],
    cursor: input.cursor,
    problem: {
      id: "option-ta-fills-not-implemented",
      text: "NOT_IMPLEMENTED / 待P3：成交邮件HTML/纯文本解析、累计增量、去重和冲销未实现。本轮未处理邮件、未入账；配置密钥或白名单不能补齐解析器。请保持 option-ta 停用，不要把空 records 当作无成交。"
    }
  };
}
