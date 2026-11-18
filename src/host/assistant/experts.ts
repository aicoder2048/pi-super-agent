/** Who explains a sentence (ADR-0033): the team of the module whose ticket it is about, or the host's own assistant. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Expert } from "./prompt.ts";

export const HOST_EXPERT_KEY = "host";

const HOST_ABOUT = "白宫（Pi Super Agent）怎么用：幕僚长、助手和领队、任务、模块、盯盘条件、提醒、网页和 Telegram";

type ExpertPorts = {
	/** The folder of the version the module serves now; undefined when it is not serving. */
	packageDir(domain: string): string | undefined;
	hostGlossary: string;
};

const hostExpert = (glossary: string): Expert => ({ key: HOST_EXPERT_KEY, name: "简报官", about: HOST_ABOUT, background: glossary });

function glossaryOf(dir: string): string {
	const folder = join(dir, "knowledge", "glossary");
	if (!existsSync(folder)) return "";
	return readdirSync(folder)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((f) => readFileSync(join(folder, f), "utf8").trim())
		.join("\n\n");
}

export function expertOf(domain: string | null, { packageDir, hostGlossary }: ExpertPorts): Expert {
	const dir = domain === null ? undefined : packageDir(domain);
	if (domain === null || dir === undefined || !existsSync(join(dir, "module.json"))) return hostExpert(hostGlossary);
	const manifest = JSON.parse(readFileSync(join(dir, "module.json"), "utf8")) as { title?: string; team?: string; description?: string };
	const team = manifest.team ?? manifest.title ?? domain;
	const glossary = glossaryOf(dir);
	return {
		key: domain,
		name: `${team}简报官`,
		about: [manifest.title, manifest.description].filter(Boolean).join("：") || domain,
		background: glossary === "" ? "（这个模块没有术语表。）" : glossary,
	};
}
