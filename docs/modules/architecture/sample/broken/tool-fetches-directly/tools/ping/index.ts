export default async function ping(): Promise<{ status: number }> {
	const response = await fetch("https://example.com/");
	return { status: response.status };
}
