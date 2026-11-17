// 出处：theta app/src/lib/oi-term-structure.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7
/**
 * oi-term-structure — OI term structure + max-pain + cross-expiry aggregate
 * walls from option chains. Pure — no I/O. Read-only OI counting/math, NOT a
 * trade signal.
 *
 * Per expiry:  put-OI / call-OI / P/C-OI ratio / put-volume / max-pain.
 * Cross-expiry: per-strike aggregate put-OI & call-OI ("walls ladder") + the
 * top put/call walls by aggregate OI.
 *
 * max-pain = the strike that minimizes total option-holder payout at expiry
 *   Σ_calls max(0, S−K)·OI  +  Σ_puts max(0, K−S)·OI
 * (informational; on thin/young names it is unreliable — the consuming skill
 * states that caveat).
 */

export interface OiRow {
	strike: number;
	open_interest: number | null;
	volume?: number | null;
}

export interface ExpiryChain {
	expiration: string;
	calls: OiRow[];
	puts: OiRow[];
}

export interface ExpiryOi {
	expiration: string;
	put_oi: number;
	call_oi: number;
	/** put_oi / call_oi, or null when call_oi is 0. */
	pc_oi: number | null;
	put_vol: number;
	max_pain: number | null;
}

export interface AggWall {
	strike: number;
	put_oi: number;
	call_oi: number;
}

export interface OiTermStructure {
	spot: number | null;
	by_expiry: ExpiryOi[];
	/** Per-strike aggregate across all expiries, sorted by strike ascending. */
	aggregate_walls: AggWall[];
	/** Aggregate walls sorted by put_oi desc (top N). */
	top_put_walls: AggWall[];
	/** Aggregate walls sorted by call_oi desc (top N). */
	top_call_walls: AggWall[];
}

const num = (x: number | null | undefined): number =>
	x == null || Number.isNaN(x) ? 0 : x;

/**
 * Strike minimizing total option-holder payout at expiry. Returns null when
 * there are no strikes.
 */
export function maxPain(calls: OiRow[], puts: OiRow[]): number | null {
	const strikes = [...new Set([...calls, ...puts].map((r) => r.strike))].sort((a, b) => a - b);
	if (strikes.length === 0) return null;
	let best: { strike: number; payout: number } | null = null;
	for (const S of strikes) {
		let payout = 0;
		for (const c of calls) payout += Math.max(0, S - c.strike) * num(c.open_interest);
		for (const p of puts) payout += Math.max(0, p.strike - S) * num(p.open_interest);
		if (best === null || payout < best.payout) best = { strike: S, payout };
	}
	return best ? best.strike : null;
}

export function oiTermStructure(
	chains: ExpiryChain[],
	spot: number | null = null,
	topN = 8,
): OiTermStructure {
	const by_expiry: ExpiryOi[] = chains.map((ch) => {
		const put_oi = ch.puts.reduce((a, r) => a + num(r.open_interest), 0);
		const call_oi = ch.calls.reduce((a, r) => a + num(r.open_interest), 0);
		const put_vol = ch.puts.reduce((a, r) => a + num(r.volume), 0);
		return {
			expiration: ch.expiration,
			put_oi,
			call_oi,
			pc_oi: call_oi > 0 ? put_oi / call_oi : null,
			put_vol,
			max_pain: maxPain(ch.calls, ch.puts),
		};
	});

	// Aggregate per strike across all expiries.
	const agg = new Map<number, AggWall>();
	for (const ch of chains) {
		for (const c of ch.calls) {
			const w = agg.get(c.strike) ?? { strike: c.strike, put_oi: 0, call_oi: 0 };
			w.call_oi += num(c.open_interest);
			agg.set(c.strike, w);
		}
		for (const p of ch.puts) {
			const w = agg.get(p.strike) ?? { strike: p.strike, put_oi: 0, call_oi: 0 };
			w.put_oi += num(p.open_interest);
			agg.set(p.strike, w);
		}
	}
	const aggregate_walls = [...agg.values()].sort((a, b) => a.strike - b.strike);
	const top_put_walls = [...aggregate_walls].sort((a, b) => b.put_oi - a.put_oi).slice(0, topN);
	const top_call_walls = [...aggregate_walls].sort((a, b) => b.call_oi - a.call_oi).slice(0, topN);

	return { spot, by_expiry, aggregate_walls, top_put_walls, top_call_walls };
}
