import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exitOnConfigError } from "../config-error.ts";
import type { SecretLookup } from "../modules/run-code.ts";
import { configuredSecretsFile, secretLookup, writeSecret } from "../secrets.ts";
import { defaultStateDir } from "../state-dir.ts";

/** One scope per token, so each can be revoked alone and the draft token never reaches module code (ADR-0019). */
const SCOPES = {
	read: { scope: "https://www.googleapis.com/auth/gmail.readonly", secret: "GMAIL_READ_REFRESH_TOKEN" },
	draft: { scope: "https://www.googleapis.com/auth/gmail.compose", secret: "GMAIL_DRAFT_REFRESH_TOKEN" },
} as const;
type Scope = keyof typeof SCOPES;

const USAGE = "用法：just google-auth read|draft [--port <端口>] [--check]";
const CLIENT = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
const TIMEOUT_MS = 300_000;
const TOKEN_FETCH_MS = 30_000;
const PAGE = { "content-type": "text/plain; charset=utf-8", connection: "close" };

type Args = { scope: Scope; port: number; check: boolean };
type Endpoints = { auth: string; token: string };
type Google = { client: { id: string; secret: string }; secretsFile: string; secretOf: SecretLookup; endpoints: Endpoints };
type Callback = { code: string; page: ServerResponse } | { error: string; page: ServerResponse };

const short = (scope: string) => scope.replace("https://www.googleapis.com/auth/", "");
const base64url = (bytes: Buffer) => bytes.toString("base64url");

function parseArgs(args: readonly string[]): Args | undefined {
	const [scope, ...rest] = args;
	if (scope === undefined || !Object.hasOwn(SCOPES, scope)) return undefined;
	const parsed: Args = { scope: scope as Scope, port: 0, check: false };
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--check") parsed.check = true;
		else if (rest[i] === "--port" && /^\d{1,5}$/.test(rest[i + 1] ?? "") && Number(rest[i + 1]) <= 65535) parsed.port = Number(rest[++i]);
		else return undefined;
	}
	return parsed;
}

const endpointsOf = (env: NodeJS.ProcessEnv): Endpoints =>
	env.PSA_GOOGLE_OAUTH_URL ? { auth: `${env.PSA_GOOGLE_OAUTH_URL}/o/oauth2/v2/auth`, token: `${env.PSA_GOOGLE_OAUTH_URL}/token` } : { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token" };

type TokenReply = { ok: true; body: Record<string, unknown> } | { ok: false; refused: string } | { ok: false; unreachable: string };

/** Only Google's `error` code is shown: an error reply carries no token, but its other fields are not ours to print. */
async function postToken(endpoints: Endpoints, form: Record<string, string>): Promise<TokenReply> {
	const reply = await fetch(endpoints.token, { method: "POST", body: new URLSearchParams(form), signal: AbortSignal.timeout(TOKEN_FETCH_MS) }).catch((error: Error) => error);
	if (reply instanceof Error) return { ok: false, unreachable: `连不上 Google 的 token 接口（${causeOf(reply)}）` };
	const body = (await reply.json().catch(() => ({}))) as Record<string, unknown>;
	return reply.ok ? { ok: true, body } : { ok: false, refused: `${reply.status} ${typeof body.error === "string" ? body.error : "（没有错误码）"}` };
}

const causeOf = (error: Error): string => (error.cause instanceof Error ? error.cause.message : error.message).replace(/\s+/g, " ");

function listen(port: number, state: string, timeoutMs: number) {
	let settle: (callback: Callback | "timeout") => void;
	const outcome = new Promise<Callback | "timeout">((done) => (settle = done));
	const server = createServer((req, res) => {
		const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
		if (q.get("state") !== state) {
			console.log("收到一次 state 对不上的回调，已忽略");
			return res.writeHead(400, PAGE).end("state 对不上，这次回调已忽略\n");
		}
		const error = q.get("error");
		settle(error !== null ? { error, page: res } : { code: q.get("code") ?? "", page: res });
	});
	const timer = setTimeout(() => settle("timeout"), timeoutMs);
	const ready = new Promise<number>((done, fail) => {
		server.once("error", fail);
		server.listen(port, "127.0.0.1", () => done((server.address() as AddressInfo).port));
	});
	// Idle sockets only: the browser's own request is still waiting for the page that says how it went.
	const close = () => {
		clearTimeout(timer);
		if (server.listening) server.close();
		server.closeIdleConnections();
	};
	return { ready, outcome, close };
}

function authUrl({ endpoints, client }: Google, scope: string, redirect: string, challenge: string, state: string): string {
	const url = new URL(endpoints.auth);
	for (const [key, value] of Object.entries({ client_id: client.id, redirect_uri: redirect, response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" })) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

function grantOf(requested: string, body: Record<string, unknown>): { refreshToken: string } | { why: string } {
	const granted = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [];
	if (granted.length !== 1 || granted[0] !== requested) return { why: `Google 给的 scope 是 ${granted.map(short).join(" ") || "（空）"}，不是只有 ${short(requested)}，什么都没写` };
	if (typeof body.refresh_token !== "string") return { why: "Google 没有给 refresh token：到 Google 账号的「第三方应用和服务」（https://myaccount.google.com/connections）删掉 PSA mail 的访问权限，再跑一次" };
	return { refreshToken: body.refresh_token };
}

async function authorize(args: Args, google: Google, timeoutMs: number): Promise<number> {
	const { scope, secret } = SCOPES[args.scope];
	const verifier = base64url(randomBytes(32));
	const state = base64url(randomBytes(16));
	const callback = listen(args.port, state, timeoutMs);
	try {
		const port = await callback.ready.catch((error: Error) => error);
		if (port instanceof Error) return refuse(`127.0.0.1:${args.port} 开不了：${port.message}`);
		const redirect = `http://127.0.0.1:${port}/`;
		console.log("在浏览器里打开下面的网址，用要授权的 Google 账号登录并同意：");
		console.log(authUrl(google, scope, redirect, base64url(createHash("sha256").update(verifier).digest()), state));
		console.log(`等浏览器回到 ${redirect}（${Math.round(timeoutMs / 1000)} 秒内）`);
		const back = await callback.outcome;
		if (back === "timeout") return refuse(`${Math.round(timeoutMs / 1000)} 秒内没有等到回调，什么都没写`);
		// The first matching callback is the only one: the port stops listening before the code is traded.
		callback.close();
		const finish = (line: string, status: number) => {
			console.log(line);
			back.page.writeHead(status === 0 ? 200 : 400, PAGE).end(`${line}\n${status === 0 ? "可以关掉这个页面了。" : ""}\n`);
			return status;
		};
		if ("error" in back) return finish(`Google 没有授权（${back.error}），什么都没写`, 1);
		const { client, endpoints, secretsFile } = google;
		const reply = await postToken(endpoints, { grant_type: "authorization_code", code: back.code, code_verifier: verifier, client_id: client.id, client_secret: client.secret, redirect_uri: redirect });
		if ("unreachable" in reply) return finish(`${reply.unreachable}，什么都没写`, 1);
		if ("refused" in reply) return finish(`Google 拒绝了换 token：${reply.refused}，什么都没写`, 1);
		const grant = grantOf(scope, reply.body);
		if ("why" in grant) return finish(grant.why, 1);
		writeSecret(secretsFile, secret, grant.refreshToken);
		return finish(`已写入 secretsFile 的 ${secret}（${short(scope)}）`, 0);
	} finally {
		callback.close();
	}
}

async function check(args: Args, { client, endpoints, secretOf }: Google): Promise<number> {
	const { secret } = SCOPES[args.scope];
	const refreshToken = secretOf(secret);
	if (refreshToken === undefined) return refuse(`secretsFile 里没有 ${secret}，先跑 just google-auth ${args.scope}`);
	const reply = await postToken(endpoints, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.id, client_secret: client.secret });
	if ("unreachable" in reply) return refuse(reply.unreachable);
	if ("refused" in reply) return refuse(`Google 拒绝了 ${secret}：${reply.refused}`);
	console.log(`${secret} 能换到 access token（${short(String(reply.body.scope))}，${String(reply.body.expires_in)} 秒内有效）`);
	return 0;
}

function refuse(line: string): number {
	console.log(line);
	return 1;
}

async function googleAuth(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
	const args = parseArgs(argv);
	if (args === undefined) {
		console.log(USAGE);
		return 2;
	}
	const stateDir = defaultStateDir();
	const secretsFile = configuredSecretsFile(stateDir);
	if (secretsFile === undefined) return refuse(`${stateDir}/config.json 里没有 "secretsFile"。加一行 "secretsFile": "<.env 文件的路径>"（相对路径从状态目录算起），再跑一次`);
	const secretOf = secretLookup(secretsFile);
	const [id, secret] = CLIENT.map(secretOf);
	if (id === undefined || secret === undefined) return refuse(`secretsFile 里缺 ${CLIENT.join(" 或 ")}，先照 docs/deploy/gmail.md 第一节建 OAuth 客户端，把这两行写进 ${secretsFile}`);
	const google: Google = { client: { id, secret }, secretsFile, secretOf, endpoints: endpointsOf(env) };
	return args.check ? check(args, google) : authorize(args, google, Number(env.PSA_GOOGLE_AUTH_TIMEOUT_MS) || TIMEOUT_MS);
}

process.exitCode = await googleAuth(process.argv.slice(2), process.env).catch(exitOnConfigError);
