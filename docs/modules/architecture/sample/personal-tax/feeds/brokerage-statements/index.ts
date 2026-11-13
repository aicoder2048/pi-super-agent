interface Input {
	settings: { baseUrl: string; account: string };
	cursor: string | null;
}

interface Trade {
	id: string;
	tradedAt: string;
	symbol: string;
	side: string;
	quantity: number;
	proceeds: number;
	realizedGain: number;
}

/** Fetches the trades since the cursor from the brokerage's own API. The host has no connector for it. */
export default async function collect(input: Input) {
	const since = input.cursor ?? "1970-01-01";
	const url = `${input.settings.baseUrl}/accounts/${input.settings.account}/trades?since=${since}`;
	const reply = await fetch(url, { headers: { authorization: `Bearer ${process.env.PERSONAL_TAX_BROKER_TOKEN}` } });
	if (!reply.ok) throw new Error(`券商接口返回 ${reply.status}`);
	const trades = ((await reply.json()) as { trades: Trade[] }).trades;
	if (trades.length === 0) return { records: [] };
	const gain = trades.reduce((sum, trade) => sum + trade.realizedGain, 0);
	const latest = trades.map((trade) => trade.tradedAt).sort().at(-1) as string;
	return {
		records: trades,
		notices: [{ id: `trades-${latest}`, fields: { count: String(trades.length), gain: gain.toFixed(2) } }],
		cursor: latest,
	};
}
