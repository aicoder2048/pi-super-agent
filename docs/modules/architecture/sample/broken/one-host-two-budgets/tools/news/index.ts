interface Host {
	fetch(url: string): Promise<{ status: number; body: string }>;
}

export default async function quote(input: { symbol: string }, host: Host): Promise<{ price: number }> {
	const reply = await host.fetch(`https://api.example.com/quote/${input.symbol}`);
	return { price: (JSON.parse(reply.body) as { price: number }).price };
}
