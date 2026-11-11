// e2e only, loaded into the host with --import: sends the host's Bot API calls to the fake server at
// PSA_E2E_TELEGRAM_URL. The host's own code and config have no way to change the Bot API address.
const target = process.env.PSA_E2E_TELEGRAM_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(target)) throw new Error(`PSA_E2E_TELEGRAM_URL 必须是 http://127.0.0.1:<端口>，现在是「${target}」`);
const OFFICIAL = "https://api.telegram.org/";
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return realFetch(url.startsWith(OFFICIAL) ? `${target}/${url.slice(OFFICIAL.length)}` : input, init);
};
