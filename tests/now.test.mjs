import assert from "node:assert/strict";
import test from "node:test";
import "./pi-runtime.mjs";

const { default: nowExtension, formatWorldTime, createWorldTimeSnapshot, WorldTimeCard } = await import("../extensions/now.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

function setup() {
	let command;
	let renderer;
	const messages = [];
	nowExtension({
		registerCommand(name, options) { command = { name, ...options }; },
		registerMessageRenderer(name, callback) {
			assert.equal(name, "world-time");
			renderer = callback;
		},
		sendMessage(message, options) { messages.push({ message, options }); },
	});
	return { command, renderer, messages };
}

function cityBlock(text, name) {
	const block = text.split("\n\n").find((line) => line.startsWith(`${name}（`));
	assert.ok(block, `缺少城市：${name}`);
	return block;
}

test("显示本地、美东、香港及其他城市，并解释国际重要性", () => {
	const text = formatWorldTime(new Date("2026-01-15T16:05:06Z"));
	assert.match(cityBlock(text, "本地"), /Pi 进程所在环境/);
	for (const name of ["纽约／美东", "中国香港", "伦敦", "东京", "新加坡", "法兰克福", "迪拜"]) {
		assert.match(cityBlock(text, name), /国际重要性：.+/);
	}
	assert.match(cityBlock(text, "纽约／美东"), /11:05:06/);
	assert.match(cityBlock(text, "纽约／美东"), /GMT-5/);
	assert.match(cityBlock(text, "中国香港"), /2026\/01\/16.*00:05:06/);
	assert.match(cityBlock(text, "中国香港"), /GMT\+8/);
	assert.match(text, /不判断交易日、节假日或市场是否开市/);
});

test("美东与伦敦自动切换夏令时，香港保持 UTC+8", () => {
	const summer = formatWorldTime(new Date("2026-07-15T16:05:06Z"));
	const winter = formatWorldTime(new Date("2026-01-15T16:05:06Z"));
	assert.match(cityBlock(summer, "纽约／美东"), /12:05:06/);
	assert.match(cityBlock(summer, "纽约／美东"), /GMT-4/);
	assert.match(cityBlock(summer, "伦敦"), /17:05:06/);
	assert.match(cityBlock(summer, "伦敦"), /GMT\+1/);
	assert.match(cityBlock(winter, "伦敦"), /16:05:06/);
	assert.match(cityBlock(winter, "伦敦"), /GMT(?:\+0)?(?:\s|$)/);
	assert.match(cityBlock(summer, "中国香港"), /00:05:06/);
	assert.match(cityBlock(summer, "中国香港"), /GMT\+8/);
});

test("注册 now 命令，RPC 模式通过纯文本通知显示结果", async () => {
	const { command, messages } = setup();
	assert.equal(command.name, "now");
	const notices = [];
	await command.handler("", {
		mode: "rpc", hasUI: true,
		ui: { notify: (...args) => notices.push(args) },
	});
	assert.equal(notices.length, 1);
	assert.match(notices[0][0], /世界时间/);
	assert.equal(notices[0][1], "info");
	assert.doesNotMatch(notices[0][0], /\x1b/);
	assert.equal(messages.length, 0);
});

test("无 UI 时写入 stderr，不调用通知", async () => {
	const { command, messages } = setup();
	const writes = [];
	const originalWrite = process.stderr.write;
	process.stderr.write = (text) => { writes.push(text); return true; };
	try {
		await command.handler("", { mode: "json", hasUI: false });
	} finally {
		process.stderr.write = originalWrite;
	}
	assert.equal(writes.length, 1);
	assert.match(writes[0], /世界时间/);
	assert.doesNotMatch(writes[0], /\x1b/);
	assert.equal(messages.length, 0);
});

const plainTheme = { fg: (_token, text) => text, bold: (text) => text };
const snapshot = createWorldTimeSnapshot(new Date("2026-01-15T16:05:06Z"));

test("TUI 使用可展开的消息卡片，不启动模型轮次", async () => {
	const { command, renderer, messages } = setup();
	await command.handler("", { mode: "tui", hasUI: true });
	assert.equal(messages.length, 1);
	const { message, options } = messages[0];
	assert.equal(message.customType, "world-time");
	assert.equal(message.display, true);
	assert.equal(options?.triggerTurn, undefined);
	assert.equal(message.details.cities.length, 8);
	assert.match(message.content, /国际重要性/);
	const card = renderer(message, {
		expanded: false, outputPad: 1,
		keyText: (key) => { assert.equal(key, "app.tools.expand"); return "ctrl+o"; },
	}, plainTheme);
	assert.ok(card instanceof WorldTimeCard);
	assert.match(card.render(80).join("\n"), /世界时间/);
	assert.match(card.render(80).join("\n"), /ctrl\+o · 展开/);
	assert.equal(renderer({ content: "旧消息" }, { expanded: false, outputPad: 1 }, plainTheme), undefined);
});

for (const width of [1, 8, 20, 30, 40, 60, 64, 66, 80, 100, 120]) {
	for (const expanded of [false, true]) {
		test(`${width} 列布局不溢出（${expanded ? "展开" : "紧凑"}）`, () => {
			const card = new WorldTimeCard(snapshot, plainTheme, expanded, 1);
			const lines = card.render(width);
			assert.ok(lines.length > 0);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
			if (width >= 20) {
				const text = lines.join("\n");
				for (const city of snapshot.cities) {
					assert.ok(text.includes(city.name));
					assert.ok(text.includes(city.time));
					assert.ok(text.includes(city.date));
				}
			}
		});
	}
}

test("展开保留全部时区和完整定位说明", () => {
	const card = new WorldTimeCard(snapshot, plainTheme, true, 1);
	const text = card.render(120).join("\n");
	for (const city of snapshot.cities) {
		assert.ok(text.includes(city.timeZone));
		assert.ok(text.includes(city.reason));
	}
});

test("宽屏各列对齐，窄屏与展开后仍是同一时间快照", () => {
	const before = JSON.stringify(snapshot);
	const card = new WorldTimeCard(snapshot, plainTheme, false, 2);
	const wide = card.render(120);
	const positions = wide.filter((line) => snapshot.cities.some((city) => line.includes(city.time)))
		.map((line) => visibleWidth(line.slice(0, line.search(/\d{2}:\d{2}:\d{2}/))));
	assert.equal(positions.length, 8);
	assert.equal(new Set(positions).size, 1);
	card.render(40);
	card.invalidate();
	assert.deepEqual(card.render(120), wide);
	assert.equal(JSON.stringify(snapshot), before);
	assert.deepEqual(card.render(0), []);
});

test("深浅主题均只使用语义色，重绘重新读取主题", async () => {
	const themeModule = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
	const { getThemeByName } = await import(themeModule.href);
	for (const name of ["dark", "light"]) {
		const theme = getThemeByName(name);
		assert.ok(theme, `缺少内置主题 ${name}`);
		for (const width of [40, 64, 80, 120]) {
			const card = new WorldTimeCard(snapshot, theme, true, 1);
			for (const line of card.render(width)) assert.ok(visibleWidth(line) <= width);
		}
	}
	let calls = 0;
	const theme = { fg: (_token, text) => { calls++; return text; }, bold: (text) => text };
	const card = new WorldTimeCard(snapshot, theme, false, 1);
	card.render(80);
	const initial = calls;
	card.invalidate();
	card.render(80);
	assert.ok(calls > initial);
});
