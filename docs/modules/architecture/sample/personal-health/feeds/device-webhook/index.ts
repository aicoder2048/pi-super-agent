/** One delivery from the webhook connector. The connector has already checked the signature. */
interface Item {
	id: string;
	receivedAt: string;
	body: unknown;
}

interface Reading {
	metric: string;
	value: number;
	unit: string;
	measuredAt: string;
	device: string;
}

interface VendorSample {
	type: string;
	val: number;
	unit: string;
	ts: string;
}

const METRICS: Record<string, string> = {
	rhr: "静息心率",
	sbp: "血压收缩压",
	dbp: "血压舒张压",
	weight: "体重",
};

function isSample(value: unknown): value is VendorSample {
	if (typeof value !== "object" || value === null) return false;
	const sample = value as Record<string, unknown>;
	return typeof sample.type === "string" && typeof sample.val === "number" && typeof sample.unit === "string" && typeof sample.ts === "string";
}

/** The module's whole feed: vendor payloads in, device readings out. No network, no files. */
export default function parse(input: { items: Item[] }): { records: (Reading & { id: string })[] } {
	const records: (Reading & { id: string })[] = [];
	for (const item of input.items) {
		const payload = item.body as { device?: unknown; samples?: unknown };
		if (typeof payload !== "object" || payload === null || !Array.isArray(payload.samples)) continue;
		const device = typeof payload.device === "string" ? payload.device : "unknown";
		for (const [index, sample] of payload.samples.entries()) {
			if (!isSample(sample)) continue;
			const metric = METRICS[sample.type];
			if (metric === undefined) continue;
			records.push({ id: `${item.id}#${index}`, metric, value: sample.val, unit: sample.unit, measuredAt: sample.ts, device });
		}
	}
	return { records };
}
