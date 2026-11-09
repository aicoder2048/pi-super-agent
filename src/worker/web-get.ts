import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { checkUrl, isPublicAddress } from "./net-guard.ts";

export interface WebGetOptions {
	allow?: (ip: string) => boolean;
	resolve?: (hostname: string) => Promise<string[]>;
	timeoutMs?: number;
	maxBytes?: number;
	maxChars?: number;
	maxRedirects?: number;
}

export interface WebPage {
	url: string;
	status: number;
	contentType: string;
	truncated: boolean;
	text: string;
}

const systemResolve = async (hostname: string) => (await dnsLookup(hostname, { all: true })).map((a) => a.address);

const TEXT_TYPE = /^(text\/[\w.+-]+|application\/(json|xml|xhtml\+xml|[\w.-]+\+(json|xml)))$/;

export async function webGet(rawUrl: string, options: WebGetOptions = {}): Promise<WebPage> {
	const {
		allow = isPublicAddress,
		resolve = systemResolve,
		timeoutMs = 15_000,
		maxBytes = 1_000_000,
		maxChars = 20_000,
		maxRedirects = 3,
	} = options;
	const signal = AbortSignal.timeout(timeoutMs);
	const refuse = (host: string, ip: string) => new Error(`只能读取公网地址：${host} 指向 ${ip}`);

	const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
		resolve(hostname).then((ips) => {
			if (ips.length === 0) throw new Error(`解析不到地址：${hostname}`);
			const bad = ips.find((ip) => !allow(ip));
			if (bad) throw refuse(hostname, bad);
			const entries = ips.map((address) => ({ address, family: isIP(address) }));
			if (lookupOptions.all) callback(null, entries);
			else callback(null, entries[0]!.address, entries[0]!.family);
		}).catch((error: NodeJS.ErrnoException) => callback(error, ""));
	};

	const fetchOnce = (url: URL) => new Promise<IncomingMessage>((done, fail) => {
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (isIP(host) && !allow(host)) return fail(refuse(host, host));
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = send(url, { method: "GET", lookup, signal, agent: false, headers: { accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.1" } }, done);
		req.on("error", fail);
		req.end();
	});

	try {
		let url = checkUrl(rawUrl);
		for (let hop = 0; ; hop++) {
			const res = await fetchOnce(url);
			const status = res.statusCode ?? 0;
			const location = res.headers.location;
			if (status >= 300 && status < 400 && location) {
				res.destroy();
				if (hop >= maxRedirects) throw new Error(`重定向次数超过 ${maxRedirects} 次`);
				url = checkUrl(new URL(location, url).href);
				continue;
			}
			const contentType = res.headers["content-type"] ?? "";
			const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
			if (!TEXT_TYPE.test(mediaType)) {
				res.destroy();
				throw new Error(`不支持的内容类型：${contentType || "未注明"}，只能读取文本页面`);
			}
			const { body, cut } = await readCapped(res, maxBytes);
			const decoded = decode(body, contentType);
			const plain = mediaType === "text/html" || mediaType === "application/xhtml+xml" ? htmlToText(decoded) : decoded;
			return { url: url.href, status, contentType, truncated: cut || plain.length > maxChars, text: plain.slice(0, maxChars) };
		}
	} catch (error) {
		if (signal.aborted) throw new Error(`读取超时（${timeoutMs} 毫秒）：${rawUrl}`);
		throw error;
	}
}

async function readCapped(res: IncomingMessage, maxBytes: number): Promise<{ body: Buffer; cut: boolean }> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of res as AsyncIterable<Buffer>) {
		chunks.push(chunk);
		size += chunk.length;
		if (size > maxBytes) {
			res.destroy();
			return { body: Buffer.concat(chunks).subarray(0, maxBytes), cut: true };
		}
	}
	return { body: Buffer.concat(chunks), cut: false };
}

function decode(body: Buffer, contentType: string): string {
	const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(body);
	} catch {
		return new TextDecoder("utf-8").decode(body);
	}
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
			if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
			const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		})
		.replace(/\s+/g, " ")
		.trim();
}
