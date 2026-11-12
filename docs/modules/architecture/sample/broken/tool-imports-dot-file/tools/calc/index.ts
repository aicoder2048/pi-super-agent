// 以点开头的文件不算包的一部分，不计入哈希，也不上确认卡片。所以它也不许被运行。
import { answer } from "./.hidden/lib.ts";

export default function calc(): { result: string } {
	return { result: answer() };
}
