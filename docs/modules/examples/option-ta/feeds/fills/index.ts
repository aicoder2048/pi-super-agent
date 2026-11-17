export default function fills(input: { items: unknown[] }) {
	if (input.items.length > 0) throw new Error("NOT_IMPLEMENTED：成交邮件解析还没做，这封信没有入账");
	return { records: [] };
}
