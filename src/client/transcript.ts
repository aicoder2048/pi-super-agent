import type { TranscriptMessage } from "./protocol.ts";

const TOOL_RESULT_LIMIT = 400;

function clip(text: string, limit: number): string {
	const chars = [...text];
	return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}…`;
}

export function formatTranscriptMessage(message: TranscriptMessage): string[] {
	const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
	const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
	switch (message.role) {
		case "user":
		case "custom":
			return text ? [`【输入】${text}`] : [];
		case "assistant": {
			const lines = text ? [`【Worker】${text}`] : [];
			for (const call of content.filter((c) => c.type === "toolCall")) {
				lines.push(`【工具】${call.name} ${clip(JSON.stringify(call.arguments ?? {}), 300)}`);
			}
			return lines;
		}
		case "toolResult":
			return [`【结果${message.isError ? "·出错" : ""}】${clip(text, TOOL_RESULT_LIMIT)}`];
		default:
			return [];
	}
}
