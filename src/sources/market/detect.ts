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
	highestUpBand: number;
	highestDownBand: number;
	volume: boolean;
}

export interface MarketCursor {
	nyDate: string;
	sawFreshQuote: boolean;
	pollsWithoutFreshQuote: number;
	fired: Record<string, Fired>;
}

export type Signal = { kind: "band"; dir: "up" | "down"; pct: number } | { kind: "volume"; ratio: number };

export interface Move {
	nyDate: string;
	quote: Quote;
	signal: Signal;
}

// Prices are cents, so a real move of exactly a band can compute a hair below it (609 / 600 → 1.4999…%).
const BAND_EPSILON = 1e-9;
// Opening and closing auctions print huge single minutes that are not news.
const AUCTION_MS = 10 * MINUTE;

export function detect(cursor: MarketCursor | undefined, quotes: Quote[], session: Session, settings: DetectSettings): { moves: Move[]; cursor: MarketCursor } {
	const today: MarketCursor = cursor?.nyDate === session.nyDate ? cursor : { nyDate: session.nyDate, sawFreshQuote: false, pollsWithoutFreshQuote: 0, fired: {} };
	const fired: Record<string, Fired> = { ...today.fired };
	const moves: Move[] = [];
	let fresh = 0;
	for (const quote of quotes) {
		if (nyDateOf(quote.at) !== session.nyDate || quote.at < session.openAt || quote.at > session.closeAt) continue;
		fresh++;
		const was: Fired = { highestUpBand: 0, highestDownBand: 0, volume: false, ...fired[quote.symbol] };
		const next = { ...was };
		const highest = quote.changePct >= 0 ? "highestUpBand" : "highestDownBand";
		const bands = settings.bands.bySymbol[quote.symbol] ?? settings.bands.default;
		const dir = quote.changePct >= 0 ? "up" : "down";
		const reached = Math.max(0, ...bands.filter((b) => Math.abs(quote.changePct) >= b - BAND_EPSILON));
		if (reached > was[highest]) {
			next[highest] = reached;
			moves.push({ nyDate: session.nyDate, quote, signal: { kind: "band", dir, pct: reached } });
		}
		const ratio = quote.minuteVolume && quote.prevVolume ? quote.minuteVolume / (quote.prevVolume / session.previousSessionMinutes) : 0;
		const outsideAuctions = quote.at >= session.openAt + AUCTION_MS && quote.at <= session.closeAt - AUCTION_MS;
		if (!was.volume && outsideAuctions && ratio >= settings.volumeSpikeX) {
			next.volume = true;
			moves.push({ nyDate: session.nyDate, quote, signal: { kind: "volume", ratio } });
		}
		fired[quote.symbol] = next;
	}
	return {
		moves,
		cursor: { nyDate: today.nyDate, sawFreshQuote: today.sawFreshQuote || fresh > 0, pollsWithoutFreshQuote: fresh > 0 ? 0 : (today.pollsWithoutFreshQuote ?? 0) + 1, fired },
	};
}

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

function describe(move: Move): string {
	const { quote: q, signal: s } = move;
	if (s.kind === "band") return `${q.symbol} ${s.dir === "up" ? "涨" : "跌"} ${signed(q.changePct)}，到达 ${s.dir === "up" ? "+" : "-"}${s.pct}% 档。`;
	return `${q.symbol} 放量：最近一分钟成交 ${compact(q.minuteVolume!)}，是昨日分钟均量的 ${s.ratio.toFixed(1)} 倍，当前 ${signed(q.changePct)}。`;
}

export function moveId({ quote, signal, nyDate }: Move): string {
	return `${quote.symbol}:${nyDate}:${signal.kind === "band" ? `${signal.dir}${signal.pct}` : "volume"}`;
}

export function toTrigger(source: string, move: Move): TriggerSubmission {
	const { quote: q, nyDate } = move;
	return {
		source,
		externalId: moveId(move),
		threads: [{ id: threadId(source, `${q.symbol}:${nyDate}`), title: `${q.symbol} ${nyDate} 行情` }],
		sender: source,
		body: `${describe(move)}现价 ${q.price}，昨收 ${q.prevClose}。报价时间 ${nyTime(q.at)} ET${q.delayed ? "（延迟行情）" : ""}。`,
		occurredAt: q.at,
	};
}
