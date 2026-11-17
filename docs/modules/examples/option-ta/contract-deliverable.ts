// 出处：theta app/src/lib/contract-deliverable.ts @ a1e637b7db3d9bc0beb48cac7d2da62a27bdc4c9
/**
 * contract-deliverable — is this option contract still 100 shares?
 *
 * After an OCC adjustment one contract stops delivering 100 shares. A 3-for-2
 * split leaves a 150-share deliverable (SNEX); a reverse split collapses it
 * (BYND1 → 4, AMCR1 → 20, TLRY1 → 10) while the *multiplier* field keeps
 * reading 100 — so "multiplier == 100" proves nothing. theta hardcoded the 100
 * assumption in its sizing math, where the failure mode is concrete: 300 shares
 * of a 150-share-deliverable name would size `floor(300/100) = 3` covered calls
 * against coverage for 2, conjuring a contract of naked exposure.
 *
 * Live-verified against Polygon `/v3/reference/options/contracts` (2026-08-17):
 * the endpoint DOES return `shares_per_contract`, and the adjusted series read
 * 4 / 10 / 20 / 150 as above.
 *
 * Scope: this answers "is this contract still 100 shares", nothing more. It does
 * NOT predict how OCC will adjust — the adjustment panel rules case by case, so
 * any formula that pre-computes an adjustment is unreliable; the right move is
 * to read the OCC/broker adjustment notice. Pure — no I/O, no network.
 *
 * ── The design red line ──────────────────────────────────────────────────────
 * A MISSING field is NOT evidence of a non-standard contract. Practically every
 * position theta holds carries no deliverable field, and flagging them all would
 * make this a noise generator that everyone learns to ignore. So: no field →
 * behave exactly as before (100 shares, no flag), leaving only a provenance
 * trace. Only POSITIVE evidence — a declared count ≠ 100, or an OCC adjusted
 * root suffix — ever flags or refuses. Do not relax this.
 */

/** How we know (or don't) what one contract delivers. */
export type DeliverableProvenance =
	/** Caller handed us a real `shares_per_contract` (e.g. from Polygon). */
	| "declared"
	/** No evidence either way → the standard 100-share assumption, as always. */
	| "assumed_standard"
	/** OCC adjusted root suffix (BYND1, SNEX2) → non-standard, count unknown. */
	| "root_suffix_inferred";

export interface DeliverableInput {
	/** `shares_per_contract` for the series, when the caller has it. */
	sharesPerContract?: number | null;
	/** Option root as it appears in the OCC symbol ("BYND1", "SNEX2", "NVDA"). */
	optionRoot?: string | null;
	/** Underlying equity ticker ("BYND"). */
	underlying: string;
}

export interface DeliverableClassification {
	/** Shares one contract delivers. **null = unknowable** (adjusted series whose
	 *  count we can't see) — callers must refuse to size, not fall back to 100. */
	shares_per_contract: number | null;
	/** true only when the contract is the ordinary 100-share kind. */
	standard: boolean;
	provenance: DeliverableProvenance;
	/** Human-readable warning. null on the standard path — always. */
	flag: string | null;
}

/** Standard OCC equity option deliverable. The ONE place this number lives. */
export const STANDARD_SHARES_PER_CONTRACT = 100;

/**
 * Does `optionRoot` look like an OCC adjusted series of `underlying`?
 *
 * The rule is "strip exactly ONE trailing digit and compare to the underlying",
 * NOT "the last character is a digit" — tickers may legitimately end in a digit
 * (SPX7), and the naive rule would flag every one of them. Stripping one digit
 * also survives second adjustments: the real SNEX root is SNEX2, and stripping
 * *all* trailing digits would break a hypothetical SPX71 on underlying SPX7.
 */
function isAdjustedRoot(optionRoot: string, underlying: string): boolean {
	const root = optionRoot.trim().toUpperCase();
	const under = underlying.trim().toUpperCase();
	if (!root || !under) return false;
	if (!/[0-9]$/.test(root)) return false;
	return root.slice(0, -1) === under;
}

/**
 * Classify what one contract delivers, from whatever evidence the caller has.
 *
 * Priority is fixed and must not be reordered: a declared count beats a root
 * inference (it carries the actual number), and both beat the assumption.
 */
export function classifyDeliverable(input: DeliverableInput): DeliverableClassification {
	const declared = input.sharesPerContract;

	// 1 · declared count — only a finite positive number counts as evidence;
	//     0 / negative / NaN / Infinity are garbage, and garbage is not evidence.
	if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
		const standard = declared === STANDARD_SHARES_PER_CONTRACT;
		return {
			shares_per_contract: declared,
			standard,
			provenance: "declared",
			flag: standard
				? null
				: `调整合约:每张交割 ${declared} 股(非标准 ${STANDARD_SHARES_PER_CONTRACT} 股)—— 按 100 股折算张数会错,已拒算;查 OCC 调整通知`,
		};
	}

	// 2 · OCC adjusted root suffix — proves the series is non-standard but says
	//     nothing about the share count, so the count stays null (unknowable).
	const root = input.optionRoot;
	if (typeof root === "string" && isAdjustedRoot(root, input.underlying)) {
		return {
			shares_per_contract: null,
			standard: false,
			provenance: "root_suffix_inferred",
			flag: `期权 root ${root.trim().toUpperCase()} 带 OCC 调整后缀:交割物已非标准 ${STANDARD_SHARES_PER_CONTRACT} 股,具体股数未知 —— 查 OCC 调整通知`,
		};
	}

	// 3 · no evidence → today's behaviour, verbatim. Provenance only.
	return {
		shares_per_contract: STANDARD_SHARES_PER_CONTRACT,
		standard: true,
		provenance: "assumed_standard",
		flag: null,
	};
}

export interface CoverableResult {
	/** Contracts the shares cover. **null = refused** (non-standard deliverable):
	 *  refusing to answer beats answering wrong, because the wrong answer here is
	 *  silently-naked short calls. */
	contracts: number | null;
	flag: string | null;
}

/**
 * How many contracts do `shares` cover? The single home of `floor(shares/100)`.
 *
 * Omitting `deliverable` means "no evidence" and yields the historical answer.
 */
export function coverableContracts(
	shares: number,
	deliverable?: DeliverableClassification | null,
): CoverableResult {
	if (deliverable && !deliverable.standard) {
		return { contracts: null, flag: deliverable.flag };
	}
	if (!Number.isFinite(shares) || shares <= 0) return { contracts: 0, flag: null };
	return { contracts: Math.floor(shares / STANDARD_SHARES_PER_CONTRACT), flag: null };
}
