import { QUOTA_ERROR } from "../model-selector.ts";

// The host's own record of what is broken right now. Only host code raises and clears an alarm, never a model:
// a model that is down cannot say so, and the page and Telegram must still show it.

export type Area = "model" | "data";
export type Cause = "auth" | "quota" | "network" | "provider";

export interface Failure {
	area: Area;
	/** What broke, in the user's words: 幕僚长模型, stock-ta 报价. */
	subject: string;
	error: string;
	/** What to do. Defaults to the advice for the error's cause. */
	advice?: string;
	/** Consecutive failures, this one included, before the alarm goes up. */
	after: number;
}

export interface Alarm {
	id: string;
	area: Area;
	subject: string;
	cause: Cause;
	/** When the first failure of this run happened. */
	since: number;
	lastAt: number;
	/** One line, keys taken out. */
	lastError: string;
	/** Failures in this run so far. */
	count: number;
	advice: string;
}

/** What the page lists under 最近恢复. */
export type ClearedAlarm = Pick<Alarm, "id" | "area" | "subject" | "since"> & { clearedAt: number };

export interface HealthBoard {
	/** Oldest first. */
	active: Alarm[];
	/** Newest first. */
	recent: ClearedAlarm[];
	/** A model and a data alarm are both up with network errors. A guess, not a probe. */
	offline: boolean;
}

export interface HealthOptions {
	now(): number;
	onRaised(alarm: Alarm): void;
	onCleared(alarm: ClearedAlarm): void;
	recentMax?: number;
}

const ERROR_MAX = 200;
const RECENT_MAX = 10;

const CAUSES: readonly [Cause, RegExp][] = [
	["quota", QUOTA_ERROR],
	["auth", /\b40[13]\b|unauthori[sz]ed|forbidden|invalid[_ ]grant|invalid.{0,20}(api.?key|token|credential)|authenticat|revoked|expired.{0,20}token|token.{0,20}expired|not logged in|login/i],
	["network", /fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|getaddrinfo|connection error|timed? ?out/i],
];

export function causeOf(error: string): Cause {
	return CAUSES.find(([, pattern]) => pattern.test(error))?.[0] ?? "provider";
}

export const ADVICE: Readonly<Record<Area, Record<Cause, string>>> = {
	model: {
		auth: "登录或密钥失效，不会自己好：重新登录这个模型的账号（openai-codex 跑 pi 里的 /login），或检查密钥",
		quota: "额度用尽或被限流：等额度恢复，或在 config.json 换一个回退模型",
		network: "连不上模型服务：检查这台电脑的网络",
		provider: "模型服务出错或太忙：通常会自己恢复，恢复后这条自动消失",
	},
	data: {
		auth: "密钥或授权失效，不会自己好：检查宿主密钥文件里这个来源的密钥，或重新授权",
		quota: "数据接口限流或额度用尽：等它恢复，或换套餐",
		network: "连不上数据接口：检查这台电脑的网络",
		provider: "数据服务出错或太忙：恢复后自动接着取，这条自动消失",
	},
};

const SECRETS: readonly [RegExp, string][] = [
	[/([?&](?:api[_-]?key|apikey|key|token|access_token|secret|password|client_secret)=)[^&\s]+/gi, "$1…"],
	[/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 …"],
	[/\b(sk|pk|rk)-[\w-]{8,}/g, "$1-…"],
	[/\b(?:ya29|1\/\/)[\w.-]{10,}/g, "…"],
];

export function scrub(error: string): string {
	let text = error.replace(/\s+/g, " ").trim();
	for (const [pattern, replacement] of SECRETS) text = text.replace(pattern, replacement);
	return text.length <= ERROR_MAX ? text : `${text.slice(0, ERROR_MAX - 1)}…`;
}

type Run = Alarm & { raised: boolean };

export class Health {
	readonly #o: HealthOptions;
	readonly #runs = new Map<string, Run>();
	#recent: ClearedAlarm[] = [];

	constructor(options: HealthOptions) {
		this.#o = options;
	}

	failed(id: string, failure: Failure): void {
		const now = this.#o.now();
		const lastError = scrub(failure.error);
		const cause = causeOf(failure.error);
		const advice = failure.advice ?? ADVICE[failure.area][cause];
		const previous = this.#runs.get(id);
		const run: Run = previous
			? { ...previous, subject: failure.subject, cause, lastAt: now, lastError, count: previous.count + 1, advice }
			: { id, area: failure.area, subject: failure.subject, cause, since: now, lastAt: now, lastError, count: 1, advice, raised: false };
		const raise = !run.raised && run.count >= failure.after;
		if (raise) run.raised = true;
		this.#runs.set(id, run);
		if (raise) this.#o.onRaised(alarmOf(run));
	}

	ok(id: string): void {
		const run = this.#runs.get(id);
		if (!run) return;
		this.#runs.delete(id);
		if (!run.raised) return;
		const cleared: ClearedAlarm = { id, area: run.area, subject: run.subject, since: run.since, clearedAt: this.#o.now() };
		this.#recent = [cleared, ...this.#recent].slice(0, this.#o.recentMax ?? RECENT_MAX);
		this.#o.onCleared(cleared);
	}

	board(): HealthBoard {
		const active = [...this.#runs.values()].filter((r) => r.raised).map(alarmOf);
		const offline = (["model", "data"] as const).every((area) => active.some((a) => a.area === area && a.cause === "network"));
		return { active, recent: [...this.#recent], offline };
	}
}

function alarmOf({ raised: _, ...alarm }: Run): Alarm {
	return alarm;
}

export interface HealthConfig {
	/** Settled model turns that failed in a row before a 5xx, overload or network error shows. Auth and quota show at once. */
	modelFailuresBeforeAlarm: number;
	/** Feed beats that failed in a row before the feed shows. A key rejection and a problem the feed reports show at once. */
	feedFailuresBeforeAlarm: number;
}

export const HEALTH_DEFAULTS: HealthConfig = { modelFailuresBeforeAlarm: 2, feedFailuresBeforeAlarm: 3 };

/** What one model role (the Router, or every Worker together) reports after each settled turn. */
export class ModelHealth {
	readonly #health: Health;
	readonly #id: string;
	readonly #subject: string;
	readonly #after: number;

	constructor(health: Health, role: "router" | "worker", after: number) {
		this.#health = health;
		this.#id = `model:${role}`;
		this.#subject = role === "router" ? "幕僚长模型" : "助手模型";
		this.#after = after;
	}

	/** The turn failed and the selector did not switch. On the fallback a quota error has nowhere left to go, so it shows at once. */
	failed(error: string, onFallback: boolean): void {
		const cause = causeOf(error);
		const now = cause === "auth" || (cause === "quota" && onFallback);
		this.#health.failed(this.#id, { area: "model", subject: this.#subject, error, after: now ? 1 : this.#after, ...(cause === "quota" && onFallback && { advice: "主模型和回退模型都被限流或额度用尽：等额度恢复" }) });
	}

	/** The primary hit its quota and the selector moved to `to`. The turn goes on there, so this is not a failure. */
	fellBack(to: string, error: string): void {
		this.#health.failed(`${this.#id}:fallback`, { area: "model", subject: `${this.#subject}（主模型限流）`, error, after: 1, advice: `已切到回退模型 ${to} 继续做；主模型恢复后自动切回，这条自动消失` });
	}

	succeeded(fellBack: boolean): void {
		this.#health.ok(this.#id);
		if (!fellBack) this.#health.ok(`${this.#id}:fallback`);
	}

	capReached(text: string): void {
		this.#health.failed("model:fallback-cap", { area: "model", subject: "回退模型今日用量", error: text, after: 1, advice: "等主模型恢复或明天再继续；要今天继续，调大 config.json 的 fallbackDailyTokens 后重启宿主" });
	}

	capCleared(): void {
		this.#health.ok("model:fallback-cap");
	}
}

const clock = (at: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

export function raisedText(alarm: Alarm): string {
	return `⚠️ ${alarm.subject}出问题了（${clock(alarm.since)} 起，${alarm.count} 次）：${alarm.lastError}。${alarm.advice}`;
}

export function clearedText(alarm: ClearedAlarm): string {
	const minutes = Math.max(1, Math.round((alarm.clearedAt - alarm.since) / 60_000));
	return `✅ ${alarm.subject}恢复了（断了约 ${minutes} 分钟）`;
}
