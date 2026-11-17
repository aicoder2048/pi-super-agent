/**
 * Rewrites each mail inbox fixture as the letters the mail connector hands the handler for it, from the Gmail replies the fixture held on main.
 * A fixture whose letters never reach the handler under the connector (an empty list, a dead authorization) is dropped: the host tests cover it.
 * `node --import ./src/pi-runtime.mjs tests/fixtures/mail-parity/reshape.ts`
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gmailAccount } from "../../../src/modules/connectors/gmail.ts";
import { fetchLetters } from "../../../src/modules/connectors/mail.ts";
import { senderGate } from "../../../src/modules/connectors/senders.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const FIXTURES = join(import.meta.dirname, "../../../docs/modules/examples/mail/feeds/inbox/fixtures");

for (const file of readdirSync(import.meta.dirname).filter((f) => f.endsWith(".json"))) {
	const { given } = JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8"));
	const replay = (async (url: string | URL) => {
		const key = String(url);
		if (!Object.hasOwn(given.responses, key)) throw new Error(`${file} has no response for ${key}`);
		return new Response(JSON.stringify(given.responses[key]));
	}) as typeof fetch;
	const gate = senderGate(given.input.rows.senders, NOW, "邮件名单");
	const gmail = gate.kind === "open" ? await gmailAccount({ secret: () => "fixture", oauthUrl: undefined, fetch: replay }).open() : undefined;
	if (gate.kind === "blocked" || gmail === undefined) {
		rmSync(join(FIXTURES, file), { force: true });
		continue;
	}
	const cursor = given.input.cursor === null ? undefined : JSON.parse(given.input.cursor);
	const { letters } = await fetchLetters(gmail, cursor, NOW, gate.accepts);
	writeFileSync(join(FIXTURES, file), `${JSON.stringify({ input: { items: letters } }, null, 2)}\n`);
}
