/** Judging a dry run (B3): each question of `evals/` asked as a request, then checked against the host's own receipts. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalDescriptor, PackageScan } from "./manifest.ts";

/** One question of `evals/` and the text the dry run says. */
export type Exam = EvalDescriptor & { question: string };

/** What the host did with one question. The Router may answer without opening a ticket, and a ticket may never report. */
export type Attempt =
	| { opened: false; replies: readonly string[] }
	| { opened: true; ticket: string; domain: string | null; report: { status: string; summary: string } | null; gateway: readonly string[] };

export type Verdict = { pass: boolean; reasons: readonly string[] };

export function examsOf(scan: PackageScan): Exam[] {
	return scan.components.flatMap((c) => {
		if (c.kind !== "evals") return [];
		const text = readFileSync(join(scan.dir, "evals", `${c.name}.md`), "utf8");
		return [{ ...c.eval, question: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() }];
	});
}

/** The capabilities a ticket called successfully, read from the Gateway's access lines (`[gateway] <module> <use> <ticket> <who> <basis> ok <N> ms`). */
function usedBy(gateway: readonly string[], module: string, ticket: string): Set<string> {
	const used = new Set<string>();
	for (const line of gateway) {
		const [, from, use, by] = line.match(/\[gateway\] (\S+) (\S+) (\S+) \S+ \S+ ok \d+ ms/) ?? [];
		if (from === module && by === ticket && use !== undefined) used.add(use);
	}
	return used;
}

export function judge(module: string, exam: Exam, attempt: Attempt): Verdict {
	if (!attempt.opened) return { pass: false, reasons: [`Router 没有开任务${attempt.replies.length > 0 ? `，它回复「${attempt.replies.join(" / ")}」` : ""}`] };
	const reasons: string[] = [];
	if (attempt.domain !== module) reasons.push(`任务开在 ${attempt.domain ?? "（没有模块）"}，不在 ${module}`);
	const used = usedBy(attempt.gateway, module, attempt.ticket);
	for (const use of exam.uses) if (!used.has(use)) reasons.push(`没用到 ${use}`);
	if (attempt.report === null) reasons.push("没等到汇报");
	else for (const phrase of exam.expect) if (!attempt.report.summary.includes(phrase)) reasons.push(`汇报里没有「${phrase}」`);
	return { pass: reasons.length === 0, reasons };
}

export const verdictLine = (exam: Exam, verdict: Verdict) => (verdict.pass ? `PASS ${exam.name}` : `FAIL ${exam.name}：${verdict.reasons.join("；")}`);
