import { ConfigError } from "./config-error.ts";

export interface Team {
	name: string;
	/** One sentence for the Router's roster. */
	description: string;
	members: readonly string[];
	file: string;
	line: number;
}

const unquote = (value: string) => (value.match(/^"(.*)"$|^'(.*)'$/)?.slice(1).find((v) => v !== undefined) ?? value).trim();

/**
 * Reads the one shape teams.yaml has: a top-level `团队名:`, under it `description: 一句话` and `members:` with one `- 名字` per line.
 * Anything else is an error with the file and line, so no YAML library is needed.
 */
export function parseTeams(file: string, text: string): Team[] {
	const teams: Team[] = [];
	let draft: { name: string; line: number; description?: string; members?: string[] } | undefined;
	let inMembers = false;
	const fail = (line: number, message: string): never => {
		throw new ConfigError(`${file}:${line}：${message}`);
	};
	const finish = () => {
		if (!draft) return;
		if (draft.description === undefined) fail(draft.line, `团队 ${draft.name} 缺少 description`);
		if (!draft.members?.length) fail(draft.line, `团队 ${draft.name} 缺少 members`);
		teams.push({ name: draft.name, description: draft.description!, members: draft.members!, file, line: draft.line });
	};
	text.split("\n").forEach((raw, index) => {
		const line = index + 1;
		const body = raw.trim();
		if (!body || body.startsWith("#")) return;
		if (/^ *\t/.test(raw)) fail(line, "缩进请用空格，不要用 Tab");
		if (!raw.startsWith(" ")) {
			const header = body.startsWith("-") ? null : body.match(/^(.+?)\s*:$/);
			if (!header) fail(line, `顶层每行应是「团队名:」，这一行是「${body}」`);
			finish();
			const name = unquote(header![1]);
			if (teams.some((t) => t.name === name)) fail(line, `团队 ${name} 在这个文件里写了两次`);
			draft = { name, line };
			inMembers = false;
			return;
		}
		if (!draft) return fail(line, "先写「团队名:」，再缩进写它的 description 和 members");
		if (body.startsWith("-")) {
			if (!inMembers) fail(line, "「- 名字」只能写在 members: 下面");
			const member = unquote(body.slice(1));
			if (!member) fail(line, "「-」后面要写成员的名字");
			if (draft.members!.includes(member)) fail(line, `成员 ${member} 写了两次`);
			draft.members!.push(member);
			return;
		}
		const [, key, value] = body.match(/^([^:\s]+)\s*:\s*(.*)$/) ?? fail(line, `看不懂这一行「${body}」，团队里只能写 description 和 members`);
		if (key !== "description" && key !== "members") fail(line, `不认识的键 ${key}，团队里只能写 description 和 members`);
		if (draft[key as "description" | "members"] !== undefined) fail(line, `${key} 写了两次`);
		inMembers = key === "members";
		if (key === "members") {
			if (value) fail(line, "members 要写成每行一个「- 名字」");
			draft.members = [];
		} else {
			draft.description = unquote(value) || fail(line, "description 不能为空，写一句给幕僚长看的说明");
		}
	});
	finish();
	return teams;
}
