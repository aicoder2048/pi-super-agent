const SYMBOL = /^[A-Z][A-Z0-9]{0,9}(\.[A-Z0-9]{1,3})?$/;

export function parseSymbol(raw: unknown): string | undefined {
	const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	return SYMBOL.test(s) ? s : undefined;
}
