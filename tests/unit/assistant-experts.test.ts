import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { expertOf, HOST_EXPERT_KEY } from "../../src/host/assistant/experts.ts";

const EXAMPLES = join(import.meta.dirname, "../../docs/modules/examples");
const GLOSSARY = readFileSync(join(import.meta.dirname, "../../GLOSSARY.md"), "utf8");
const dirOf = (domain: string) => join(EXAMPLES, domain);

test("模块的话由模块团队的简报官回答：身份用团队名，领域用模块说明，背景是模块的术语表", () => {
	const expert = expertOf("option-ta", { packageDir: dirOf, hostGlossary: GLOSSARY });
	assert.equal(expert.key, "option-ta");
	assert.equal(expert.name, "期权研究组简报官");
	assert.match(expert.about, /美股期权链/);
	const glossary = readFileSync(join(EXAMPLES, "option-ta/knowledge/glossary", "glossary.md"), "utf8");
	assert.ok(expert.background.includes(glossary.trim().slice(0, 200)));
});

test("不属于模块的话、或模块找不到时，由简报官回答，背景是宿主的术语表", () => {
	for (const domain of [null, "no-such-module"]) {
		const expert = expertOf(domain, { packageDir: (d) => (d === "no-such-module" ? undefined : dirOf(d)), hostGlossary: GLOSSARY });
		assert.equal(expert.key, HOST_EXPERT_KEY);
		assert.equal(expert.name, "简报官");
		assert.ok(expert.background.includes(GLOSSARY.slice(0, 200)));
	}
});
