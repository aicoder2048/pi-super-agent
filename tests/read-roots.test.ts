import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFindTool, createGrepTool } from "@earendil-works/pi-coding-agent";
import { piCliPath } from "../src/pi-runtime.mjs";
import { piReadResolver, realRoots, rootRefusal } from "../src/worker/read-roots.ts";

const SECRET = "s3cr3t-m4-value";

function layout() {
	const home = mkdtempSync(join(tmpdir(), "psa-roots-"));
	const secrets = join(home, "secrets", ".env");
	mkdirSync(join(home, "secrets"));
	writeFileSync(secrets, `MAIL_TOKEN=${SECRET}\n`);
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ token: SECRET }));
	const state = join(home, ".psa-state");
	const workdir = join(state, "workers", "T1");
	mkdirSync(workdir, { recursive: true });
	writeFileSync(join(workdir, "notes.md"), "工作笔记\n");
	symlinkSync(secrets, join(workdir, "env-link"));
	symlinkSync(join(home, "gone"), join(workdir, "broken-link"));
	const pkg = join(state, "modules", ".store", "mail", "abc");
	mkdirSync(join(pkg, "knowledge", "guide"), { recursive: true });
	writeFileSync(join(pkg, "knowledge", "guide", "a.md"), "知识\n");
	mkdirSync(join(pkg, "skills", "triage"), { recursive: true });
	writeFileSync(join(pkg, "skills", "triage", "SKILL.md"), "技能\n");
	writeFileSync(join(pkg, "module.json"), "{}");
	const roots = realRoots([workdir, join(pkg, "knowledge"), join(pkg, "skills")]);
	return { home, secrets, state, workdir, pkg, roots };
}

async function withHome<T>(home: string, run: () => Promise<T> | T): Promise<T> {
	const saved = process.env.HOME;
	process.env.HOME = home;
	try {
		return await run();
	} finally {
		process.env.HOME = saved;
	}
}

const resolverOnce = piReadResolver(piCliPath());

test("读文件的路径按 Pi 自己的解析算：../ 绕出去、@ 开头的绝对路径、~ 开头的路径、指向密钥文件的符号链接、断掉的链接、不存在的文件都拒绝", async () => {
	const resolve = await resolverOnce;
	const { home, secrets, workdir, roots } = layout();
	await withHome(home, () => {
		for (const path of ["../../../secrets/.env", `@${secrets}`, "~/secrets/.env", "~/.pi/agent/auth.json", "env-link", "broken-link", "missing.md", secrets]) {
			assert.ok(rootRefusal(path, workdir, roots, resolve), `${path} 应被拒绝`);
		}
	});
});

test("工作目录、模块包的 knowledge/ 和 skills/ 下的文件放行，@ 前缀和相对路径照样放行", async () => {
	const resolve = await resolverOnce;
	const { workdir, pkg, roots } = layout();
	for (const path of ["notes.md", "./notes.md", `@${join(workdir, "notes.md")}`, join(pkg, "knowledge", "guide", "a.md"), join(pkg, "skills", "triage", "SKILL.md"), ".", join(pkg, "skills")]) {
		assert.equal(rootRefusal(path, workdir, roots, resolve), undefined, `${path} 应放行`);
	}
});

test("工作目录里名字以 .. 开头的文件仍算里面", async () => {
	const resolve = await resolverOnce;
	const { workdir, roots } = layout();
	writeFileSync(join(workdir, "..notes.md"), "笔记");
	assert.equal(rootRefusal("..notes.md", workdir, roots, resolve), undefined);
});

test("模块包里 knowledge/、skills/ 以外的文件不放行，包的根目录也不行", async () => {
	const resolve = await resolverOnce;
	const { workdir, pkg, roots } = layout();
	for (const path of [join(pkg, "module.json"), pkg]) assert.ok(rootRefusal(path, workdir, roots, resolve), path);
});

test("grep、find 的根是状态目录、家目录或 / 时拒绝：它们是被拒路径的祖先", async () => {
	const resolve = await resolverOnce;
	const { home, state, workdir, roots } = layout();
	await withHome(home, () => {
		for (const path of [state, home, "~", "/", "..", "../.."]) assert.ok(rootRefusal(path, workdir, roots, resolve), path);
	});
});

test("拒绝原因是一行中文，不写出解析后的路径", async () => {
	const resolve = await resolverOnce;
	const { home, secrets, workdir, roots } = layout();
	await withHome(home, () => {
		for (const path of ["../../../secrets/.env", "~/secrets/.env", "env-link", "missing.md"]) {
			const reason = rootRefusal(path, workdir, roots, resolve)!;
			assert.ok(!reason.includes("\n"), "一行");
			assert.match(reason, /[一-鿿]/);
			for (const leaked of [secrets, home, join(home, "secrets")]) assert.ok(!reason.includes(leaked), `${path} 的拒绝原因写出了 ${leaked}`);
		}
	});
});

test("Pi 的 grep 和 find 不跟随根目录里指向外面的符号链接，所以允许的根目录本身可以放行", async () => {
	const { workdir } = layout();
	const grep = await createGrepTool(workdir).execute("g1", { pattern: SECRET, path: "." });
	const grepText = grep.content.map((c: any) => c.text ?? "").join("");
	assert.ok(!grepText.includes(SECRET), `grep 读到了链接后面的密钥：${grepText}`);
	const sanity = await createGrepTool(workdir).execute("g2", { pattern: "工作笔记", path: "." });
	assert.match(sanity.content.map((c: any) => c.text ?? "").join(""), /notes\.md/, "grep 能看到根目录里的普通文件");
	mkdirSync(join(workdir, "sub"));
	symlinkSync(join(workdir, "..", "..", ".."), join(workdir, "sub", "up"));
	const found = await createFindTool(workdir).execute("f1", { pattern: "**/.env" });
	assert.ok(!found.content.map((c: any) => c.text ?? "").join("").includes(".env"), "find 跟随了指向外面的目录链接");
});
