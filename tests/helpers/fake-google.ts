import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** `refresh_token`: undefined mints one, null leaves it out of the reply. */
export type Grant = { scope: string; refresh_token?: string | null };

export type FakeGoogleOptions = {
	grant?: (requested: string) => Grant;
	deny?: boolean;
	/** The token endpoint closes the connection without a reply. */
	dropToken?: boolean;
	/** `"GET /gmail/v1/users/me/profile"` → the JSON to reply with. */
	routes?: Record<string, unknown>;
};

export type FakeGoogle = {
	/** Set `PSA_GOOGLE_OAUTH_URL` to this. */
	url: string;
	client: { id: string; secret: string };
	/** `METHOD /path` of every request, in order; a path ending in `/send` adds a `SEND ATTEMPT` line. */
	log: string[];
	/** Every authorization code, refresh token and access token this fake handed out, for leak scans. */
	issued: string[];
	close(): Promise<void>;
};

const FAKE_CLIENT = { id: "fake-client-id.apps.googleusercontent.com", secret: "fake-client-secret" };

const base64url = (bytes: Buffer) => bytes.toString("base64url");

async function body(req: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of req) text += chunk;
	return text;
}

/** The consent page redirects straight back with a code, so `fetch(authUrl)` plays the browser. */
export async function startFakeGoogle(options: FakeGoogleOptions = {}): Promise<FakeGoogle> {
	const client = FAKE_CLIENT;
	const grant = options.grant ?? ((requested): Grant => ({ scope: requested }));
	const log: string[] = [];
	const issued: string[] = [];
	const codes = new Map<string, { challenge: string; redirect: string; scope: string }>();
	const refreshTokens = new Map<string, string>();
	const mint = (prefix: string) => {
		const value = `${prefix}${base64url(randomBytes(12))}`;
		issued.push(value);
		return value;
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://fake");
		log.push(`${req.method} ${url.pathname}`);
		const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
		if (url.pathname.endsWith("/send")) {
			log.push("SEND ATTEMPT");
			return json(500, { error: "send is never allowed" });
		}
		if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth") {
			const q = url.searchParams;
			const back = new URL(q.get("redirect_uri") ?? "");
			back.searchParams.set("state", q.get("state") ?? "");
			if (options.deny) back.searchParams.set("error", "access_denied");
			else {
				const code = mint("4/fake-code-");
				codes.set(code, { challenge: q.get("code_challenge") ?? "", redirect: q.get("redirect_uri") ?? "", scope: q.get("scope") ?? "" });
				back.searchParams.set("code", code);
			}
			return res.writeHead(302, { location: back.toString() }).end();
		}
		if (req.method === "POST" && url.pathname === "/token") {
			if (options.dropToken) return void req.socket.destroy();
			const form = new URLSearchParams(await body(req));
			if (form.get("client_id") !== client.id || form.get("client_secret") !== client.secret) return json(401, { error: "invalid_client" });
			if (form.get("grant_type") === "refresh_token") {
				const scope = refreshTokens.get(form.get("refresh_token") ?? "");
				return scope === undefined ? json(400, { error: "invalid_grant" }) : json(200, { access_token: mint("ya29.fake-"), expires_in: 3599, scope, token_type: "Bearer" });
			}
			const code = codes.get(form.get("code") ?? "");
			codes.delete(form.get("code") ?? "");
			const verifier = form.get("code_verifier") ?? "";
			if (code === undefined || code.redirect !== form.get("redirect_uri") || base64url(createHash("sha256").update(verifier).digest()) !== code.challenge) return json(400, { error: "invalid_grant" });
			const granted = grant(code.scope);
			const refresh = granted.refresh_token === undefined ? mint("1//fake-refresh-") : granted.refresh_token;
			if (refresh !== null) refreshTokens.set(refresh, granted.scope);
			return json(200, { access_token: mint("ya29.fake-"), expires_in: 3599, scope: granted.scope, token_type: "Bearer", ...(refresh !== null && { refresh_token: refresh }) });
		}
		const route = options.routes?.[`${req.method} ${url.pathname}`];
		return route === undefined ? json(404, { error: "not_found" }) : json(200, route);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		client,
		log,
		issued,
		close: () =>
			new Promise((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}

export type AuthWorld = { fake: FakeGoogle; state: string; secrets: string };

export function authWorld(fake: FakeGoogle, state: string, secretsText = `GOOGLE_OAUTH_CLIENT_ID=${fake.client.id}\nGOOGLE_OAUTH_CLIENT_SECRET=${fake.client.secret}\n`, config: Record<string, unknown> = {}): AuthWorld {
	const secrets = join(state, "secrets.env");
	writeFileSync(join(state, "config.json"), JSON.stringify({ ...config, secretsFile: "secrets.env" }));
	writeFileSync(secrets, secretsText, { mode: 0o600 });
	return { fake, state, secrets };
}

/** `url` resolves when the command prints the authorization URL; `fetch(url)` then plays the browser. */
export function runGoogleAuth(w: AuthWorld, command: readonly string[], args: readonly string[], { cwd, timeoutMs = 20_000 }: { cwd: string; timeoutMs?: number }) {
	const env = { PATH: process.env["PATH"], HOME: process.env["HOME"], PSA_STATE_DIR: w.state, PSA_GOOGLE_OAUTH_URL: w.fake.url, PSA_GOOGLE_AUTH_TIMEOUT_MS: String(timeoutMs) };
	const child = spawn(command[0]!, [...command.slice(1), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let found: (url: URL) => void;
	const url = new Promise<URL>((done) => (found = done));
	for (const stream of [child.stdout, child.stderr]) {
		createInterface({ input: stream }).on("line", (line) => {
			out += `${line}\n`;
			if (line.startsWith(`${w.fake.url}/o/oauth2/v2/auth?`)) found(new URL(line));
		});
	}
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 30_000);
	const done = new Promise<{ status: number | null; out: string }>((settle) =>
		child.once("close", (status) => {
			clearTimeout(timer);
			settle({ status, out: `$ ${[...command, ...args].join(" ")}\n${out}(exit ${status})` });
		}),
	);
	return { url, done };
}
