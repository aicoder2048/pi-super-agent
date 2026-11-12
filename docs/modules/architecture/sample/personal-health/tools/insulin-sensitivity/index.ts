interface Input {
	fastingGlucose: number;
	fastingInsulin: number;
}

interface Output {
	homaIr: number;
	quicki: number;
}

const MG_DL_PER_MMOL_L = 18.016;

export default function insulinSensitivity(input: Input): Output {
	const { fastingGlucose, fastingInsulin } = input;
	if (!(fastingGlucose > 0) || !(fastingInsulin > 0)) {
		throw new Error("空腹血糖和空腹胰岛素都必须大于 0");
	}
	return {
		homaIr: (fastingGlucose * fastingInsulin) / 22.5,
		quicki: 1 / (Math.log10(fastingInsulin) + Math.log10(fastingGlucose * MG_DL_PER_MMOL_L)),
	};
}
