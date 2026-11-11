import { dirname, isAbsolute, join } from "node:path";
import { ConfigError } from "../config-error.ts";
import type { Heartbeat } from "../heartbeat.ts";

declare const labelBrand: unique symbol;
export type ServiceLabel = string & { readonly [labelBrand]: true };

export const DEFAULT_LABEL = "com.pi-super-agent.watchdog" as ServiceLabel;
const WATCHDOG_ENTRY = "src/watchdog/main.ts";
// launchd's own default PATH after both Homebrew prefixes; /bin holds the bash that members run.
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export interface LaunchAgentInput {
	label: ServiceLabel;
	/** As found on PATH with symlinks kept: /opt/homebrew/bin/node survives `brew upgrade`, the Cellar path does not. */
	node: string;
	repo: string;
	home: string;
	stateDir: string;
}

export type LaunchdState =
	| { kind: "not_loaded" }
	| { kind: "running"; pid: number; runs: number }
	| { kind: "stopped"; lastExit: string }
	| { kind: "unknown"; detail: string };

export type InstallStep = "bootout" | "write" | "bootstrap";
export type UninstallStep = "bootout" | "stop_host" | "remove";

export interface InstalledAgent {
	node: string;
	repo: string;
	stateDir: string;
}

export interface StatusInput {
	label: ServiceLabel;
	plistFile: string;
	installed: InstalledAgent | undefined;
	launchd: LaunchdState;
	nodeExists: boolean;
	/** Only a heartbeat whose host still runs. */
	heartbeat: Heartbeat | undefined;
	now: number;
}

export function parseServiceLabel(raw: string | undefined): ServiceLabel {
	if (!raw) return DEFAULT_LABEL;
	if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(raw)) throw new ConfigError(`launchd label「${raw}」只能用字母、数字、点和横线，并以字母或数字开头`);
	return raw as ServiceLabel;
}

export const plistPath = (home: string, label: ServiceLabel): string => join(home, "Library", "LaunchAgents", `${label}.plist`);
export const watchdogLogPath = (stateDir: string): string => join(stateDir, "watchdog.log");

export function findOnPath(name: string, pathEnv: string, isExecutable: (file: string) => boolean): string | undefined {
	for (const dir of pathEnv.split(":")) {
		if (isAbsolute(dir) && isExecutable(join(dir, name))) return join(dir, name);
	}
	return undefined;
}

export function servicePath(node: string): string {
	return [...new Set([dirname(node), ...SYSTEM_PATH])].join(":");
}

/** The plist's environment and the exact env preflight runs `npm root -g` under, so what passed preflight is what launchd runs. */
export function serviceEnvironment(input: LaunchAgentInput): Record<string, string> {
	return { HOME: input.home, PATH: servicePath(input.node), PSA_STATE_DIR: input.stateDir };
}

type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plistXml(value: PlistValue, indent: string): string {
	if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>\n`;
	if (typeof value === "boolean") return `${indent}<${value}/>\n`;
	if (Array.isArray(value)) return `${indent}<array>\n${value.map((v) => plistXml(v, `${indent}\t`)).join("")}${indent}</array>\n`;
	const entries = Object.entries(value).map(([k, v]) => `${indent}\t<key>${escapeXml(k)}</key>\n${plistXml(v, `${indent}\t`)}`);
	return `${indent}<dict>\n${entries.join("")}${indent}</dict>\n`;
}

/** Deterministic: same input, same bytes. planInstall's no-op compares these bytes with the file on disk. */
export function launchAgentPlist(input: LaunchAgentInput): string {
	const log = watchdogLogPath(input.stateDir);
	const agent: PlistValue = {
		Label: input.label,
		ProgramArguments: [input.node, "--import", "./src/pi-runtime.mjs", WATCHDOG_ENTRY],
		WorkingDirectory: input.repo,
		EnvironmentVariables: serviceEnvironment(input),
		RunAtLoad: true,
		KeepAlive: true,
		StandardOutPath: log,
		StandardErrorPath: log,
	};
	return [
		`<?xml version="1.0" encoding="UTF-8"?>\n`,
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`,
		`<plist version="1.0">\n`,
		plistXml(agent, ""),
		`</plist>\n`,
	].join("");
}

const NOT_FOUND = 113;

/** Reads only the one-tab top-level `key = value` lines: nested blocks such as environment and endpoints carry their own `state =`. */
export function parseLaunchctlPrint(exitCode: number, output: string): LaunchdState {
	if (exitCode === NOT_FOUND) return { kind: "not_loaded" };
	const firstLine = output.trim().split("\n")[0] ?? "";
	if (exitCode !== 0) return { kind: "unknown", detail: firstLine };
	const fields = new Map<string, string>();
	for (const line of output.split("\n")) {
		const m = /^\t([^\t=][^=]*?) = (.*)$/.exec(line);
		if (m) fields.set(m[1], m[2]);
	}
	const state = fields.get("state");
	const pid = Number(fields.get("pid"));
	if (state === "running" && Number.isInteger(pid)) return { kind: "running", pid, runs: Number(fields.get("runs") ?? 0) };
	if (state && state !== "running") {
		const code = fields.get("last exit code");
		return { kind: "stopped", lastExit: (code !== "(never exited)" && code) || fields.get("last terminating signal") || state };
	}
	return { kind: "unknown", detail: firstLine };
}

/** PSA_STATE_DIR from the job's own `environment` block; the `inherited environment` and `default environment` blocks are launchd's. */
export function jobStateDir(launchctlPrint: string): string | undefined {
	const block = /^\tenvironment = \{\n((?:\t\t.*\n)*)\t\}$/m.exec(launchctlPrint)?.[1] ?? "";
	return /^\t\tPSA_STATE_DIR => (.+)$/m.exec(block)?.[1];
}

/** Bootout comes before write so a crash between steps leaves a state the next run still repairs. */
export function planInstall({ onDisk, desired, launchd }: { onDisk: string | undefined; desired: string; launchd: LaunchdState }): InstallStep[] {
	if (launchd.kind === "unknown") throw new ConfigError(`读不懂 launchctl 的输出（${launchd.detail}），不改动 launchd`);
	const same = onDisk === desired;
	if (launchd.kind === "not_loaded") return same ? ["bootstrap"] : ["write", "bootstrap"];
	return same ? [] : ["bootout", "write", "bootstrap"];
}

/**
 * stop_host is always part of an uninstall: a watchdog that KeepAlive restarted adopts the running host without owning
 * it, so bootout stops only the watchdog. Remove comes last so a crash before it leaves the plist for the next run.
 */
export function planUninstall({ onDisk, launchd }: { onDisk: boolean; launchd: LaunchdState }): UninstallStep[] {
	if (!onDisk && launchd.kind === "not_loaded") return [];
	return [...(launchd.kind === "not_loaded" ? [] : ["bootout" as const]), "stop_host", ...(onDisk ? ["remove" as const] : [])];
}

export function nvmWarning(node: string): string | undefined {
	if (!node.includes("/.nvm/versions/node/")) return undefined;
	return `[service] node 来自 nvm（${node}）：服务固定用这个版本和它下面装的 Pi。nvm 卸掉这个版本或换了装 Pi 的版本后，重跑 just service-install。`;
}

/** `plutil -convert json` of the plist on disk, so status reports what is installed rather than the current shell. */
export function installedAgent(plistJson: any, plistFile: string): InstalledAgent {
	const node = plistJson?.ProgramArguments?.[0];
	const repo = plistJson?.WorkingDirectory;
	const stateDir = plistJson?.EnvironmentVariables?.PSA_STATE_DIR;
	if (typeof node !== "string" || typeof repo !== "string" || typeof stateDir !== "string") {
		throw new ConfigError(`${plistFile} 缺 ProgramArguments、WorkingDirectory 或 PSA_STATE_DIR，重跑 just service-install`);
	}
	return { node, repo, stateDir };
}

function headline({ label, installed, launchd }: StatusInput): string {
	switch (launchd.kind) {
		case "running":
			return `${label}：运行中，看门狗 pid ${launchd.pid}（launchd 已启动它 ${launchd.runs} 次）`;
		case "stopped":
			return `${label}：已停止（上次退出码 ${launchd.lastExit}）`;
		case "unknown":
			return `${label}：读不懂 launchctl 的输出（${launchd.detail}）`;
		case "not_loaded":
			return installed ? `${label}：已写 plist，launchd 没有加载（重跑 just service-install）` : `${label}：未安装`;
	}
}

export function statusLines(input: StatusInput): string[] {
	const lines = [headline(input)];
	if (!input.installed) return lines;
	lines.push(`  plist   ${input.plistFile}`);
	lines.push(`  node    ${input.installed.node}${input.nodeExists ? "" : "（不存在了，重跑 just service-install）"}`);
	lines.push(`  日志    ${watchdogLogPath(input.installed.stateDir)}`);
	const beat = input.heartbeat;
	lines.push(beat ? `  心跳    ${Math.round((input.now - beat.at) / 1000)} 秒前，宿主 pid ${beat.pid}` : "  心跳    宿主没有在运行");
	return lines;
}
