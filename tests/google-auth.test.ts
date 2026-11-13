import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { writeSecret } from "../src/secrets.ts";
import { authWorld, runGoogleAuth, startFakeGoogle, type AuthWorld, type FakeGoogleOptions } from "./helpers/fake-google.ts";
import { freePort } from "./helpers/fakes.ts";

const REPO = join(import.meta.dirname, "..");
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

async function world(t: TestContext, options: FakeGoogleOptions = {}, secretsText?: string): Promise<AuthWorld> {
	const fake = await startFakeGoogle(options);
	t.after(() => fake.close());
	const state = mkdtempSync(join(tmpdir(), "psa-gauth-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	return authWorld(fake, state, secretsText);
}

const run = (w: AuthWorld, args: string[], timeoutMs?: number) => runGoogleAuth(w, [process.execPath, "--import", "./src/pi-runtime.mjs", "src/cli/google-auth.ts"], args, { cwd: REPO, ...(timeoutMs !== undefined && { timeoutMs }) });

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const redirectOf = (url: URL) => url.searchParams.get("redirect_uri")!;
const leaked = (w: AuthWorld, out: string) => w.fake.issued.filter((value) => out.includes(value));

test("the authorization URL asks for exactly one scope, offline, with consent, PKCE S256 and a state, and nothing granted before", async (t) => {
	const w = await world(t);
	const { url, done } = run(w, ["read"]);
	const q = (await url).searchParams;
	assert.equal(q.get("scope"), READONLY);
	assert.equal(q.get("access_type"), "offline");
	assert.equal(q.get("prompt"), "consent");
	assert.equal(q.get("code_challenge_method"), "S256");
	assert.match(q.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
	assert.match(q.get("state") ?? "", /^[A-Za-z0-9_-]{16,}$/);
	assert.equal(q.get("response_type"), "code");
	assert.equal(q.get("client_id"), w.fake.client.id);
	assert.match(redirectOf(await url), /^http:\/\/127\.0\.0\.1:\d+\/$/);
	assert.equal(q.has("include_granted_scopes"), false);
	await fetch(await url);
	assert.equal((await done).status, 0);
});

test("after the browser comes back, the read refresh token is written to secretsFile, the port closes, and the output names only the secret and scope", async (t) => {
	const w = await world(t, {}, "# my keys\nGOOGLE_OAUTH_CLIENT_ID=fake-client-id.apps.googleusercontent.com\nGOOGLE_OAUTH_CLIENT_SECRET=fake-client-secret\nOTHER_KEY=keep-me\n");
	const { url, done } = run(w, ["read"]);
	const page = await fetch(await url);
	assert.equal(page.status, 200);
	const result = await done;
	assert.equal(result.status, 0, result.out);
	assert.match(result.out, /^已写入 secretsFile 的 GMAIL_READ_REFRESH_TOKEN（gmail\.readonly）$/m);
	const lines = readFileSync(w.secrets, "utf8").split("\n");
	assert.deepEqual(lines.slice(0, 4), ["# my keys", "GOOGLE_OAUTH_CLIENT_ID=fake-client-id.apps.googleusercontent.com", "GOOGLE_OAUTH_CLIENT_SECRET=fake-client-secret", "OTHER_KEY=keep-me"]);
	assert.match(lines[4] ?? "", /^GMAIL_READ_REFRESH_TOKEN=1\/\/fake-refresh-/);
	assert.equal(statSync(w.secrets).mode & 0o777, 0o600);
	await assert.rejects(fetch(redirectOf(await url)), "the callback port is closed");
	assert.deepEqual(leaked(w, result.out), []);
});

test("draft asks for gmail.compose only and writes the draft refresh token", async (t) => {
	const w = await world(t);
	const { url, done } = run(w, ["draft"]);
	assert.equal((await url).searchParams.get("scope"), COMPOSE);
	await fetch(await url);
	const result = await done;
	assert.equal(result.status, 0, result.out);
	assert.match(result.out, /^已写入 secretsFile 的 GMAIL_DRAFT_REFRESH_TOKEN（gmail\.compose）$/m);
	assert.match(readFileSync(w.secrets, "utf8"), /^GMAIL_DRAFT_REFRESH_TOKEN=1\/\/fake-refresh-/m);
	assert.doesNotMatch(readFileSync(w.secrets, "utf8"), /GMAIL_READ_REFRESH_TOKEN/);
});

test("a callback with the wrong state gets 400 and changes nothing; the right one afterwards still works", async (t) => {
	const w = await world(t);
	const { url, done } = run(w, ["read"]);
	const before = sha(w.secrets);
	const wrong = new URL(redirectOf(await url));
	wrong.searchParams.set("state", "not-the-state");
	wrong.searchParams.set("code", "4/forged");
	assert.equal((await fetch(wrong)).status, 400);
	assert.equal(sha(w.secrets), before);
	await fetch(await url);
	const result = await done;
	assert.equal(result.status, 0, result.out);
	assert.match(readFileSync(w.secrets, "utf8"), /^GMAIL_READ_REFRESH_TOKEN=/m);
	assert.equal(w.fake.log.filter((line) => line === "POST /token").length, 1, "the forged code never reached the token endpoint");
});

for (const [name, scope] of [
	["one scope more", `${READONLY} ${COMPOSE}`],
	["the requested scope missing", "https://www.googleapis.com/auth/userinfo.email"],
] as const) {
	test(`Google granting ${name} is refused on one line and nothing is written`, async (t) => {
		const w = await world(t, { grant: () => ({ scope }) });
		const before = sha(w.secrets);
		const { url, done } = run(w, ["read"]);
		await fetch(await url);
		const result = await done;
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /^Google 给的 scope 是 .+，不是只有 gmail\.readonly，什么都没写$/m);
		assert.equal(sha(w.secrets), before);
		assert.deepEqual(leaked(w, result.out), []);
	});
}

test("no refresh token in Google's reply is refused, with where to remove the app's access", async (t) => {
	const w = await world(t, { grant: (requested) => ({ scope: requested, refresh_token: null }) });
	const before = sha(w.secrets);
	const { url, done } = run(w, ["read"]);
	await fetch(await url);
	const result = await done;
	assert.equal(result.status, 1, result.out);
	assert.match(result.out, /Google 没有给 refresh token.*第三方应用和服务.*再跑一次/);
	assert.equal(sha(w.secrets), before);
});

test("the user clicking Cancel on the consent screen ends the command and writes nothing", async (t) => {
	const w = await world(t, { deny: true });
	const before = sha(w.secrets);
	const { url, done } = run(w, ["read"]);
	await fetch(await url);
	const result = await done;
	assert.equal(result.status, 1, result.out);
	assert.match(result.out, /access_denied/);
	assert.equal(sha(w.secrets), before);
});

test("the token endpoint dropping the connection gives one line and exit 1, a short page, and writes nothing", async (t) => {
	const w = await world(t, { dropToken: true });
	writeFileSync(w.secrets, `${readFileSync(w.secrets, "utf8")}GMAIL_READ_REFRESH_TOKEN=1//stored\n`);
	const before = sha(w.secrets);
	const { url, done } = run(w, ["read"]);
	const page = await fetch(await url);
	const result = await done;
	assert.equal(result.status, 1, result.out);
	assert.match(result.out, /^连不上 Google 的 token 接口（.+），什么都没写$/m);
	assert.doesNotMatch(result.out, /^\s+at |Node\.js v/m);
	assert.equal(page.status, 400);
	assert.match(await page.text(), /^连不上 Google 的 token 接口/);
	assert.equal(sha(w.secrets), before);
	const check = await run(w, ["read", "--check"]).done;
	assert.equal(check.status, 1, check.out);
	assert.match(check.out, /^连不上 Google 的 token 接口（.+）$/m);
	assert.doesNotMatch(check.out, /^\s+at |Node\.js v/m);
});

test("no callback before the timeout: exits non-zero, closes the port, writes nothing", async (t) => {
	const w = await world(t);
	const before = sha(w.secrets);
	const { url, done } = run(w, ["read"], 800);
	const redirect = redirectOf(await url);
	const result = await done;
	assert.equal(result.status, 1, result.out);
	assert.match(result.out, /秒内没有等到回调，什么都没写/);
	await assert.rejects(fetch(redirect), "the callback port is closed");
	assert.equal(sha(w.secrets), before);
});

test("--port puts the callback on that port, for ssh -L from a laptop", async (t) => {
	const w = await world(t);
	const port = await freePort();
	const { url, done } = run(w, ["read", "--port", String(port)]);
	assert.equal(redirectOf(await url), `http://127.0.0.1:${port}/`);
	await fetch(await url);
	assert.equal((await done).status, 0);
});

test("--check trades the stored refresh token for an access token and prints neither", async (t) => {
	const w = await world(t);
	const first = run(w, ["read"]);
	await fetch(await first.url);
	assert.equal((await first.done).status, 0);
	const check = await run(w, ["read", "--check"]).done;
	assert.equal(check.status, 0, check.out);
	assert.match(check.out, /^GMAIL_READ_REFRESH_TOKEN 能换到 access token（gmail\.readonly，3599 秒内有效）$/m);
	assert.deepEqual(leaked(w, check.out), []);
});

test("--check with a token Google rejects says so on one line and exits 1", async (t) => {
	const w = await world(t);
	writeFileSync(w.secrets, `${readFileSync(w.secrets, "utf8")}GMAIL_READ_REFRESH_TOKEN=1//revoked\n`);
	const check = await run(w, ["read", "--check"]).done;
	assert.equal(check.status, 1, check.out);
	assert.match(check.out, /^Google 拒绝了 GMAIL_READ_REFRESH_TOKEN：400 invalid_grant/m);
	assert.doesNotMatch(check.out, /1\/\/revoked/);
});

test("without the OAuth client in secretsFile it points to the first section of docs/deploy/gmail.md", async (t) => {
	const w = await world(t, {}, "OTHER_KEY=x\n");
	const result = await run(w, ["read"]).done;
	assert.equal(result.status, 1, result.out);
	assert.match(result.out, /GOOGLE_OAUTH_CLIENT_ID.*docs\/deploy\/gmail\.md 第一节/);
});

test("without secretsFile in config.json it says how to add one", async (t) => {
	const w = await world(t);
	writeFileSync(join(w.state, "config.json"), "{}");
	const result = await run(w, ["read"]).done;
	assert.equal(result.status, 1, result.out);
	assert.match(result.out, /config\.json.*"secretsFile"/);
});

test("anything but read or draft prints the usage and exits 2", async (t) => {
	const w = await world(t);
	for (const args of [[], ["send"], ["read", "draft"], ["read", "--port"], ["read", "--port", "http"]]) {
		const result = await run(w, args).done;
		assert.equal(result.status, 2, `${args.join(" ")}: ${result.out}`);
		assert.match(result.out, /just google-auth read\|draft/);
	}
});

test("writeSecret replaces the line that sets the name, keeps every other line and comment, and swaps in a 600 file by rename", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-wsecret-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "secrets.env");
	writeFileSync(file, "# keys\nA=1\nGMAIL_READ_REFRESH_TOKEN=old\n\nB=2", { mode: 0o644 });
	const inode = statSync(file).ino;
	writeSecret(file, "GMAIL_READ_REFRESH_TOKEN", "1//new");
	assert.equal(readFileSync(file, "utf8"), "# keys\nA=1\nGMAIL_READ_REFRESH_TOKEN=1//new\n\nB=2");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.notEqual(statSync(file).ino, inode, "a new file took the old one's place");
	assert.deepEqual(readdirSync(dir), ["secrets.env"], "no temporary file is left behind");
	writeSecret(file, "C", "3");
	assert.equal(readFileSync(file, "utf8"), "# keys\nA=1\nGMAIL_READ_REFRESH_TOKEN=1//new\n\nB=2\nC=3\n");
});

test("writeSecret refuses a value the .env reader would read back differently, and leaves the file as it was", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-wsecret-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "secrets.env");
	writeFileSync(file, "A=1\n");
	for (const value of ["has#hash", "two words", "line\nbreak"]) assert.throws(() => writeSecret(file, "B", value), /写不下/, JSON.stringify(value));
	assert.equal(readFileSync(file, "utf8"), "A=1\n");
});

/** The single-quoted script the old Mac runs in docs/deploy/gmail.md's copy command, with `f=` set by the caller. */
function oldMacCopyScript(): string {
	const doc = readFileSync(join(REPO, "docs/deploy/gmail.md"), "utf8");
	const match = /\|\s*ssh <旧 Mac> '([^']*)'/.exec(doc.slice(doc.indexOf("### 给旧 Mac（默认")));
	assert.ok(match, "the copy command is in docs/deploy/gmail.md");
	return match[1]!.replace(/^f=<旧 Mac 的 secretsFile>\n?/, "");
}

test("the docs' old-Mac copy command replaces same-named lines, keeps a last line without newline whole, and reruns unchanged", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-gcopy-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const target = join(dir, "mac.env");
	writeFileSync(target, "TELEGRAM_BOT_TOKEN=tg\nexport GMAIL_READ_REFRESH_TOKEN=1//old\nLAST=no-newline", { mode: 0o600 });
	const lines = "GOOGLE_OAUTH_CLIENT_ID=id\nGOOGLE_OAUTH_CLIENT_SECRET=sec\nGMAIL_READ_REFRESH_TOKEN=1//new\n";
	const copy = (file: string) => spawnSync("/bin/sh", ["-c", oldMacCopyScript()], { input: lines, env: { PATH: process.env["PATH"], f: file }, encoding: "utf8" });
	assert.equal(copy(target).status, 0);
	const once = readFileSync(target, "utf8");
	assert.deepEqual(once.split("\n"), ["TELEGRAM_BOT_TOKEN=tg", "LAST=no-newline", "GOOGLE_OAUTH_CLIENT_ID=id", "GOOGLE_OAUTH_CLIENT_SECRET=sec", "GMAIL_READ_REFRESH_TOKEN=1//new", ""]);
	assert.equal(copy(target).status, 0);
	assert.equal(readFileSync(target, "utf8"), once, "a rerun changes nothing");
	assert.equal(statSync(target).mode & 0o777, 0o600);
	assert.notEqual(copy(join(dir, "missing.env")).status, 0);
	assert.deepEqual(readdirSync(dir), ["mac.env"], "a wrong path creates no file");
});
