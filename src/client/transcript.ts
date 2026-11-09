import { blocks, clip, textOf } from "./board-format.mjs";
import type { TranscriptMessage } from "./protocol.ts";

const TOOL_RESULT_LIMIT = 400;

export function formatTranscriptMessage(message: TranscriptMessage): string[] {
	const content = blocks(message);
	const text = textOf(message);
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
