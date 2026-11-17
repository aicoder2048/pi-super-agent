import { deepStrictEqual } from "node:assert";
import { parseLetters, type Letter, type Stored, type Fill } from "./parser.ts";

type Input = {
	items?: Letter[]; rows?: { fills?: Stored[] }; cursor?: string | null;
	// Only feed fixtures can set these top-level fields; never read controls from mail bodies.
	fixture_mode?: string; fixture_expected?: { fills: Record<string, unknown>[]; skipped: Record<string, unknown>[]; notice_reasons?: string[] };
};
const canon = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canon);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canon(v)]));
	return value;
};
const key = (value: unknown) => JSON.stringify(canon(value));
function projection(actual: unknown, expected: unknown): unknown {
	if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
		return Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, projection((actual as Record<string, unknown> | null)?.[k], v)]));
	}
	return actual;
}
function assertFixture(result: ReturnType<typeof parseLetters>, expected: NonNullable<Input["fixture_expected"]>) {
	deepStrictEqual(result.fills.length, expected.fills.length, "fill count");
	deepStrictEqual(result.skipped.length, expected.skipped.length, "skipped count");
	for (const e of expected.fills) {
		const actual = result.fills.find((f) => f.fill_id === e["fill_id"]);
		deepStrictEqual(projection(actual, e), e, `fill ${e["fill_id"]}`);
	}
	// Source expectations group skips by reason rather than document order.
	const remaining = [...result.skipped];
	for (const e of expected.skipped) {
		const at = remaining.findIndex((s) => key(projection(s, e)) === key(e));
		deepStrictEqual(at >= 0, true, `skipped ${key(e)}`);
		remaining.splice(at, 1);
	}
}
function record(fill: Fill) {
	return { ...fill, instrument: JSON.stringify(fill.instrument), partial_fill: String(fill["partial_fill"]), unconfirmed: JSON.stringify(fill["unconfirmed"]) };
}
export default function fills(input: Input) {
	const result = parseLetters(input.items ?? [], input.rows?.fills ?? []);
	if (input.fixture_mode === "assert-parser-v1") {
		if (!input.fixture_expected) throw new Error("Fixture expected fills/skipped required");
		assertFixture(result, input.fixture_expected);
	}
	const notices = result.skipped.flatMap((s, index) => {
		if (s.reason !== "unparsed" && s.reason !== "duplicate-order-key") return [];
		const letter = input.items?.find((m) => m.id === s.message_id);
		return [{ id: `${s.message_id ?? "unknown"}:${s.reason}:${index}`, fields: { reason: s.reason }, thread: letter?.threadId || s.message_id || "fills-review" }];
	});
	if (input.fixture_mode === "assert-parser-v1" && input.fixture_expected?.notice_reasons) deepStrictEqual(notices.map((n) => n.fields.reason), input.fixture_expected.notice_reasons, "anomaly notices");
	return { records: result.fills.map(record), notices, ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}) };
}
