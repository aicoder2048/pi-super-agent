export default function bmi(input: { weightKg: number; heightM: number }): { bmi: number } {
	return { bmi: input.weightKg / input.heightM ** 2 };
}
