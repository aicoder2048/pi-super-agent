import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { externalTool, type EvalDescriptor, type ModuleName, type PackageScan } from "./manifest.ts";
import { questionOf } from "./validate.ts";
import { withAttachment } from "../web/view.mjs";

export type Exam = EvalDescriptor & { question: string };

export type Attempt =
	| { opened: false; replies: readonly string[] }
	| { opened: true; ticket: string; domain: string | null; report: { status: string; summary: string } | null; gateway: readonly string[] };

export type Verdict = { pass: boolean; reasons: readonly string[] };

type Attached = { id: string; name: string; size: number };

/**
 * What a rehearsal says for one exam. An exam with `upload` first stores that package file as an upload, then ends with the
 * same attachment line the web page adds (ADR-0032), so the lead sees what it would see from the user.
 */
export function askedWith(exam: Exam, packageDir: string, save: (name: string, bytes: Buffer) => Attached): string {
	if (exam.upload === undefined) return exam.question;
	return withAttachment(exam.question, save(basename(exam.upload), readFileSync(join(packageDir, exam.upload))));
}

export function examsOf(scan: PackageScan): Exam[] {
	return scan.components.flatMap((c) => {
		if (c.kind !== "evals") return [];
		const text = readFileSync(join(scan.dir, "evals", `${c.name}.md`), "utf8");
		return [{ ...c.eval, question: questionOf(text) }];
	});
}

/** The modules whose exported tools the package names in its members', exams' or `module.json`'s `uses`: a rehearsal brings their serving copies. */
export function providersOf(scan: PackageScan): ModuleName[] {
	const uses = [...(scan.manifest.uses ?? []), ...scan.components.flatMap((c) => (c.kind === "agents" ? c.agent.uses : c.kind === "evals" ? c.eval.uses : []))];
	const providers = uses.flatMap((use) => externalTool(use)?.provider ?? []).filter((provider) => provider !== scan.manifest.name);
	return [...new Set(providers)].sort();
}

/** A call of another module's tool logs that module first and `from=<caller>` last, so it counts as `<provider>/tools/<name>`. */
function usedBy(gateway: readonly string[], module: string, ticket: string): Set<string> {
	const used = new Set<string>();
	for (const line of gateway) {
		const [, owner, use, by, from] = line.match(/\[gateway\] (\S+) (\S+) (\S+) \S+ \S+ ok \d+ ms(?: from=(\S+))?/) ?? [];
		if (by !== ticket || use === undefined) continue;
		if (from === undefined && owner === module) used.add(use);
		if (from === module) used.add(`${owner}/${use}`);
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
