import { BlockList, isIP } from "node:net";

const BLOCKED_V4 = [
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
	"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"224.0.0.0/4", "240.0.0.0/4",
];

const BLOCKED_V6 = [
	"::/96", "::ffff:0:0:0/96", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16", "64:ff9b::/96", "64:ff9b:1::/48",
	"fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
];

const blocked = new BlockList();
for (const cidr of BLOCKED_V4) addSubnet(cidr, "ipv4");
for (const cidr of BLOCKED_V6) addSubnet(cidr, "ipv6");

function addSubnet(cidr: string, family: "ipv4" | "ipv6"): void {
	const [network, prefix] = cidr.split("/");
	blocked.addSubnet(network!, Number(prefix), family);
}

export function isPublicAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 0) return false;
	return !blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export function checkUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`不是有效的网址：${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`只能读取 http 或 https 网址，不能读取 ${url.protocol}`);
	return url;
}
