// No sandbox in the MVP (see spec), so this list is the program-level floor for inference tickets, not a guarantee.
const EXTERNAL_ACTIONS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
	{ pattern: /\bgit\s+push\b/, what: "推送代码" },
	{ pattern: /\bgh\s+(pr|issue|release|repo|gist)\s+(create|comment|merge|edit|close|reopen|review|delete)\b/, what: "在 GitHub 上留下内容" },
	{ pattern: /\bgh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i, what: "调用 GitHub 写接口" },
	{ pattern: /\bcurl\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s(-d|--data[\w-]*|-F|--form)\s)/i, what: "向外部服务提交数据" },
	{ pattern: /\b(wget)\b.*--post/i, what: "向外部服务提交数据" },
	{ pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b/, what: "发布软件包" },
	{ pattern: /(^|[|;&]\s*|\bsudo\s+)(sendmail|mail|mailx|msmtp)\b/, what: "发送邮件" },
	{ pattern: /\bosascript\b.*\b(Mail|Messages)\b/, what: "通过系统应用发送消息" },
];

export function blockedExternalAction(command: string): string | undefined {
	const hit = EXTERNAL_ACTIONS.find((rule) => rule.pattern.test(command));
	if (!hit) return undefined;
	return `依据为推断的任务不能${hit.what}。把这一步写成草稿，用 report 的 drafts 提交，等使用者确认。`;
}
