// Deliberately handler-only: mail's connector cursor is not the handler cursor.
// A successful empty reply would consume real mail; throwing eventually rejects it.
// Do NOT attach connector: mail until a verified parser and failure retention exist.
export default function fills(_input: unknown) {
  return {
    records: [],
    notices: [{ id: "fills-not-implemented-v1", fields: { status: "NOT_IMPLEMENTED", message: "成交邮件解析未实现，未接入mail；未读取真实邮件、未推进连接器cursor、未入账。" } }],
    problem: { id: "NOT_IMPLEMENTED", text: "NOT_IMPLEMENTED：fills未接mail。HTML/纯文本解析、累计成交增量、冲突与去重校验未实现。勿启用收信或声称入账。", once: true }
  };
}
