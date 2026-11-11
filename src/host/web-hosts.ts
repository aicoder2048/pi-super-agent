import { ConfigError } from "../config-error.ts";

declare const tailnetBrand: unique symbol;

/** A machine name on the user's tailnet (ADR-0014). parseWebHosts is the only producer. */
export type TailnetName = string & { readonly [tailnetBrand]: true };

/** Every address the page answers at. What is printed and what is accepted come from the same port and names. */
export interface WebAddresses {
	readonly hosts: ReadonlySet<string>;
	readonly origins: ReadonlySet<string>;
	readonly local: string;
	readonly remote: readonly string[];
}

// Only *.ts.net: the user and Tailscale control that DNS, so a listed name cannot be rebound to an attacker's page.
const TAILNET_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

export function parseWebHosts(raw: unknown, label: string): readonly TailnetName[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new ConfigError(`${label}（${JSON.stringify(raw)}）必须是 tailnet 机器名的数组，例如 ["psa-home.example.ts.net"]`);
	const names = raw.map((item, i) => {
		const name = typeof item === "string" ? item.toLowerCase() : "";
		if (!TAILNET_NAME.test(name)) throw new ConfigError(`${label}[${i}]（${JSON.stringify(item)}）必须是 tailnet 里的机器名，例如 psa-home.example.ts.net：不带 https://、端口和路径`);
		return name as TailnetName;
	});
	return [...new Set(names)];
}

// Remote names carry no port: tailscale serve answers on 443 and browsers drop the default port from Host and Origin.
// Host and Origin are checked separately, so a forwarder that rewrites Host to 127.0.0.1 still works.
export function webAddresses(port: number, names: readonly TailnetName[]): WebAddresses {
	const local = [`127.0.0.1:${port}`, `localhost:${port}`];
	return {
		hosts: new Set([...local, ...names]),
		origins: new Set([...local.map((h) => `http://${h}`), ...names.map((n) => `https://${n}`)]),
		local: `http://127.0.0.1:${port}/`,
		remote: names.map((n) => `https://${n}/`),
	};
}
