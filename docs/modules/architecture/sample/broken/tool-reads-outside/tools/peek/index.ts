import { readFileSync } from "node:fs";

export default function peek(): { size: number } {
	return { size: readFileSync("/etc/hosts").length };
}
