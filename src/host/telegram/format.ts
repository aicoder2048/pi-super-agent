// Pure: the chief of staff's Markdown as Telegram HTML (parse_mode HTML). Telegram knows a handful of tags and
// refuses a message whose tags do not nest, so every block below is closed on its own and the layout only cuts between blocks.

/** A unit the layout never cuts: one line, one code block, or one quote. */
export interface Block {
	html: string;
	/** The block inside the expandable quote, where Telegram allows no nested quote. */
	flat: string;
	lines: number;
	/** A plain line that can follow the speaker's name on the same line. */
	inline: boolean;
	/** A blank line came before it. */
	gap: boolean;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#-]*)\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HEAD_LINES = 5;
// Placeholders keep code spans and links out of the emphasis rules; the input can't contain them.
const CODE = "\u0000";
const LINK = "\u0001";

// The URL stops at a code placeholder, which would put a tag inside href, and keeps one level of balanced parentheses: Foo_(bar).
const LINK_MARKDOWN = /\[([^\]]+)\]\((https?:\/\/(?:[^\s()\u0000]|\([^\s()\u0000]*\))+)\)/g;

export const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What the phone shows for an HTML message: Telegram counts its length limit on this. */
export const visibleText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

export function markdownBlocks(markdown: string): Block[] {
	const lines = markdown.replace(/[\u0000\u0001]/g, "").replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let gap = false;
	const push = (html: string, { lines = 1, flat = html, inline = false } = {}) => {
		blocks.push({ html, flat, lines, inline, gap: gap && blocks.length > 0 });
		gap = false;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = FENCE.exec(line);
		if (fence) {
			const closing = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
			const code: string[] = [];
			while (++i < lines.length && !closing.test(lines[i])) code.push(lines[i]);
			const body = escapeHtml(code.join("\n"));
			push(fence[2] ? `<pre><code class="language-${fence[2]}">${body}</code></pre>` : `<pre>${body}</pre>`, { lines: Math.max(code.length, 1) });
			continue;
		}
		if (!line.trim()) {
			gap = true;
			continue;
		}
		if (line.includes("|") && lines[i + 1]?.includes("|") && TABLE_SEPARATOR.test(lines[i + 1])) {
			push(`<b>${cells(line).map((cell) => inline(cell.replace(/\*\*/g, ""))).join(" | ")}</b>`);
			i++;
			while (lines[i + 1]?.includes("|")) push(cells(lines[++i]).map(inline).join(" | "));
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			push(`<b>${inline(heading[1].replace(/\*\*/g, ""))}</b>`, { inline: true });
			continue;
		}
		if (RULE.test(line)) {
			push("———");
			continue;
		}
		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			for (let q; i < lines.length && (q = QUOTE.exec(lines[i])); i++) quoted.push(inline(q[1]));
			i--;
			push(`<blockquote>${quoted.join("\n")}</blockquote>`, { lines: quoted.length, flat: quoted.map((q) => `│ ${q}`).join("\n") });
			continue;
		}
		const item = ITEM.exec(line);
		if (item) {
			const indent = "  ".repeat(Math.floor(item[1].replace(/\t/g, "  ").length / 2));
			push(`${indent}${/\d/.test(item[2]) ? item[2] : "•"} ${inline(item[3])}`);
			continue;
		}
		push(inline(line.trim()), { inline: true });
	}
	return blocks;
}

/** The first lines as they are, the rest folded into an expandable quote. */
export function foldBlocks(blocks: readonly Block[]): string {
	let shown = 0;
	let cut = 0;
	while (cut < blocks.length && shown + blocks[cut].lines <= HEAD_LINES) shown += blocks[cut++].lines;
	const head = joinBlocks(blocks.slice(0, cut), (b) => b.html);
	if (cut === blocks.length) return head;
	const tail = `<blockquote expandable>${joinBlocks(blocks.slice(cut), (b) => b.flat)}</blockquote>`;
	return head ? `${head}\n${tail}` : tail;
}

const joinBlocks = (blocks: readonly Block[], pick: (b: Block) => string) => blocks.map((b, i) => (i === 0 ? "" : b.gap ? "\n\n" : "\n") + pick(b)).join("");

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

function inline(text: string): string {
	const codes: string[] = [];
	const links: string[] = [];
	const withCode = text.replace(/`([^`]+)`/g, (_, code: string) => `${CODE}${codes.push(code) - 1}${CODE}`);
	const withLinks = withCode.replace(LINK_MARKDOWN, (_, label: string, url: string) => `${LINK}${links.push(`<a href="${escapeHtml(url)}">${emphasis(escapeHtml(label))}</a>`) - 1}${LINK}`);
	return emphasis(escapeHtml(withLinks))
		.replace(new RegExp(`${LINK}(\\d+)${LINK}`, "g"), (_, n: string) => links[Number(n)])
		.replace(new RegExp(`${CODE}(\\d+)${CODE}`, "g"), (_, n: string) => `<code>${escapeHtml(codes[Number(n)])}</code>`);
}

/** Each rule matches only text without tags, so what it wraps always nests. `_` needs a non-letter on both sides, so snake_case stays as it is. */
function emphasis(html: string): string {
	return html
		.replace(/\*\*(?=\S)([^<>]*?\S)\*\*/g, "<b>$1</b>")
		.replace(/(?<![\p{L}\p{N}_])__(?=\S)([^<>]*?\S)__(?![\p{L}\p{N}_])/gu, "<b>$1</b>")
		.replace(/(?<![*\\])\*(?=[^\s*])([^<>*]*?[^\s*])\*(?!\*)/g, "<i>$1</i>")
		.replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^<>_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, "<i>$1</i>")
		.replace(/~~(?=\S)([^<>]*?\S)~~/g, "<s>$1</s>");
}
