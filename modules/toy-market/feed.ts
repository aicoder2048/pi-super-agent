import { join } from "node:path";
import { ConfigError, exitOnConfigError } from "../../src/config-error.ts";
import { loadConfig, loadModules } from "../../src/host/config.ts";
import { dropTrigger } from "../../src/sources/generic.ts";

function main(): void {
	const [symbol = "TOYX", changeArg = "-5.2", volumeArg = "12"] = process.argv.slice(2);
	const change = Number(changeArg);
	const volume = Number(volumeArg);
	if (Number.isNaN(change) || Number.isNaN(volume)) throw new ConfigError("用法：just toy-feed <代码> <涨跌幅%> <成交量>");
	const config = loadConfig();
	if (!loadModules(config).modules.some((m) => m.name === "toy-market")) {
		throw new ConfigError(`玩具行情模块 toy-market 没有启用，假行情不会命中它的规则。在 ${join(config.stateDir, "config.json")} 里写 "modules": { "toy-market": true }，重启宿主后再试。`);
	}
	const price = +(100 * (1 + change / 100)).toFixed(2);
	const sign = change >= 0 ? "+" : "";
	const inbox = join(config.stateDir, "inbox");
	const file = dropTrigger(inbox, {
		source: "toy-market",
		thread: symbol,
		threadTitle: `${symbol} 行情`,
		sender: "toy-feed",
		body: `${symbol} 价格 ${price}，涨跌 ${sign}${change}%，成交量 ${volume} 股`,
	});
	console.log(`投递 ${join(inbox, file)}：${symbol} ${price}（${sign}${change}%，成交量 ${volume} 股）`);
}

try {
	main();
} catch (error) {
	exitOnConfigError(error);
}
