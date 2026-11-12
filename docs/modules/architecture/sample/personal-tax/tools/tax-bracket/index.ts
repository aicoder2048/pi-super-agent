import { readFileSync } from "node:fs";

interface Bracket {
	upTo: number | null;
	rate: number;
}

const table = JSON.parse(readFileSync(new URL("./rates-2025.json", import.meta.url), "utf8")) as { brackets: Bracket[] };

export default function taxBracket(input: { taxableIncome: number }): { bracket: number; marginalRate: number; tax: number } {
	if (!(input.taxableIncome >= 0)) throw new Error("应税所得不能是负数");
	let tax = 0;
	let floor = 0;
	for (const [index, bracket] of table.brackets.entries()) {
		const ceiling = bracket.upTo ?? Number.POSITIVE_INFINITY;
		if (input.taxableIncome <= ceiling) {
			return { bracket: index + 1, marginalRate: bracket.rate, tax: tax + (input.taxableIncome - floor) * bracket.rate };
		}
		tax += (ceiling - floor) * bracket.rate;
		floor = ceiling;
	}
	throw new Error("税率表的最后一档必须没有上限");
}
