export class StartupError extends Error {
	override name = "StartupError";
}

export function exitOnStartupError(error: unknown): never {
	if (!(error instanceof StartupError)) throw error;
	console.error(error.message);
	process.exit(1);
}
