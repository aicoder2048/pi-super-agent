import type { TriggerSubmission } from "../../kernel/types.ts";
import { threadId } from "../generic.ts";
import { MINUTE, nyDateOf, nyTime, type Session } from "./session.ts";

export interface Quote {
	symbol: string;
	price: number;
	prevClose: number;
	changePct: number;
	at: number;
	delayed: boolean;
	dayVolume?: number;
	minuteVolume?: number;
	prevVolume?: number;
}

export interface DetectSettings {
	bands: { default: number[]; bySymbol: Record<string, number[]> };
	volumeSpikeX: number;
}

export interface Fired {
	up: number;
	down: number;
	volume: boolean;
}

export interface MarketCursor {
	nyDate: string;
	fired: Record<string, Fired>;
	holiday?: boolean;
}

export type Signal = { kind: "band"; dir: "up" | "down"; pct: number } | { kind: "volume"; ratio: number };

export interface Move {
	nyDate: string;
	quote: Quote;
	signal: Signal;
}

const REGULAR_MINUTES = 390;
// Opening and closing auctions print huge single minutes that are not news.
const AUCTION_MS = 10 * MINUTE;

export function detect(cursor: MarketCursor | undefined, quotes: Quote[], session: Session, settings: DetectSettings): { moves: Move[]; cursor: MarketCursor; fresh: number } {
	const today = cursor?.nyDate === session.nyDate ? cursor : { nyDate: session.nyDate, fired: {} };
	const fired: Record<string, Fired> = { ...today.fired };
	const moves: Move[] = [];
	let fresh = 0;
	for (const quote of quotes) {
		if (nyDateOf(quote.at) !== session.nyDate || quote.at < session.openAt || quote.at > session.closeAt) continue;
		fresh++;
		const was = fired[quote.symbol] ?? { up: 0, down: 0, volume: false };
		const next = { ...was };
		const bands = settings.bands.bySymbol[quote.symbol] ?? settings.bands.default;
		const dir = quote.changePct >= 0 ? "up" : "down";
		const reached = Math.max(0, ...bands.filter((b) => Math.abs(quote.changePct) >= b));
		if (reached > was[dir]) {
			next[dir] = reached;
			moves.push({ nyDate: session.nyDate, quote, signal: { kind: "band", dir, pct: reached } });
		}
		const ratio = quote.minuteVolume && quote.prevVolume ? quote.minuteVolume / (quote.prevVolume / REGULAR_MINUTES) : 0;
		const outsideAuctions = quote.at >= session.openAt + AUCTION_MS && quote.at <= session.closeAt - AUCTION_MS;
		if (!was.volume && outsideAuctions && ratio >= settings.volumeSpikeX) {
			next.volume = true;
			moves.push({ nyDate: session.nyDate, quote, signal: { kind: "volume", ratio } });
		}
		fired[quote.symbol] = next;
	}
	return { moves, cursor: { ...today, fired }, fresh };
}

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

function describe(move: Move): string {
	const { quote: q, signal: s } = move;
	if (s.kind === "band") return `${q.symbol} ${s.dir === "up" ? "涨" : "跌"} ${signed(q.changePct)}，到达 ${s.dir === "up" ? "+" : "-"}${s.pct}% 档。`;
	return `${q.symbol} 放量：最近一分钟成交 ${compact(q.minuteVolume!)}，是昨日分钟均量的 ${s.ratio.toFixed(1)} 倍，当前 ${signed(q.changePct)}。`;
}

export function toTrigger(source: string, move: Move): TriggerSubmission {
	const { quote: q, signal: s, nyDate } = move;
	const key = s.kind === "band" ? `${s.dir}${s.pct}` : "volume";
	return {
		source,
		externalId: `${q.symbol}:${nyDate}:${key}`,
		threads: [{ id: threadId(source, `${q.symbol}:${nyDate}`), title: `${q.symbol} ${nyDate} 行情` }],
		sender: source,
		body: `${describe(move)}现价 ${q.price}，昨收 ${q.prevClose}。报价时间 ${nyTime(q.at)} ET${q.delayed ? "（延迟行情）" : ""}。`,
		occurredAt: q.at,
	};
}
