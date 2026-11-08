/**
 * /now — 主题自适应的世界时间快照；展开消息可查看完整地区说明。
 * 启动：pi -e extensions/now.ts
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

interface WorldCity {
	name: string;
	timeZone: string;
	reason: string;
}

const WORLD_CITIES: readonly WorldCity[] = [
	{
		name: "纽约／美东",
		timeZone: "America/New_York",
		reason: "NYSE、Nasdaq 美股市场采用美东时间，纽约是全球主要资本市场中心。",
	},
	{
		name: "中国香港",
		timeZone: "Asia/Hong_Kong",
		reason: "港交所所在地，连接中国内地与国际资本的重要金融枢纽。",
	},
	{
		name: "伦敦",
		timeZone: "Europe/London",
		reason: "全球主要外汇交易与国际金融中心，连接亚洲和美洲交易时段。",
	},
	{
		name: "东京",
		timeZone: "Asia/Tokyo",
		reason: "东京证券交易所所在地，日元与日本资本市场具有全球影响力。",
	},
	{
		name: "新加坡",
		timeZone: "Asia/Singapore",
		reason: "国际航运、外汇与大宗商品交易枢纽，也是东南亚金融中心。",
	},
	{
		name: "法兰克福",
		timeZone: "Europe/Berlin",
		reason: "欧洲央行与德国证券交易所所在地，是欧元区货币政策和金融枢纽。",
	},
	{
		name: "迪拜",
		timeZone: "Asia/Dubai",
		reason: "连接欧洲、亚洲与非洲的国际航空、贸易及金融枢纽。",
	},
];

export interface CityTime extends WorldCity {
	date: string;
	weekday: string;
	time: string;
	offset: string;
}

export interface WorldTimeSnapshot {
	capturedAt: string;
	cities: CityTime[];
}

const MESSAGE_TYPE = "world-time";
const DISCLAIMER = "UTC 偏移随夏令时自动调整；本命令不判断交易日、节假日或市场是否开市。";

/** 只获取一次时间，重绘、展开和窗口缩放不会改变快照。 */
export function createWorldTimeSnapshot(now: Date = new Date()): WorldTimeSnapshot {
	const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
	const cities: WorldCity[] = [
		{ name: "本地", timeZone: localZone, reason: "Pi 进程所在环境的本地时区，不一定是远程用户电脑的时区。" },
		...WORLD_CITIES,
	];
	return {
		capturedAt: now.toISOString(),
		cities: cities.map((city) => {
			const parts = new Intl.DateTimeFormat("zh-CN", {
				timeZone: city.timeZone,
				year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
				hour: "2-digit", minute: "2-digit", second: "2-digit",
				hourCycle: "h23", timeZoneName: "shortOffset",
			}).formatToParts(now);
			const part = (type: Intl.DateTimeFormatPartTypes): string =>
				parts.find((value) => value.type === type)?.value ?? "";
			return {
				...city,
				date: `${part("year")}/${part("month")}/${part("day")}`,
				weekday: part("weekday"),
				time: `${part("hour")}:${part("minute")}:${part("second")}`,
				offset: part("timeZoneName"),
			};
		}),
	};
}

function formatSnapshot(snapshot: WorldTimeSnapshot): string {
	return [
		"世界时间（同一时刻快照，24 小时制）",
		...snapshot.cities.map((city, index) =>
			`${city.name}（${city.timeZone}）\n  ${city.date}${city.weekday} ${city.time} ${city.offset}\n  ${index === 0 ? "说明" : "国际重要性"}：${city.reason}`,
		),
		`注：${DISCLAIMER}`,
	].join("\n\n");
}

/** RPC 与无界面模式保留完整、无 ANSI 的文本输出。 */
export function formatWorldTime(now: Date = new Date()): string {
	return formatSnapshot(createWorldTimeSnapshot(now));
}

/** 所有对齐按可见列宽计算；颜色只使用当前主题的语义 token。 */
export class WorldTimeCard implements Component {
	private readonly snapshot: WorldTimeSnapshot;
	private readonly theme: Theme;
	private readonly expanded: boolean;
	private readonly outputPad: number;
	private readonly expandKey: string;

	constructor(snapshot: WorldTimeSnapshot, theme: Theme, expanded: boolean, outputPad: number, expandKey = "") {
		this.snapshot = snapshot;
		this.theme = theme;
		this.expanded = expanded;
		this.outputPad = outputPad;
		this.expandKey = expandKey;
	}

	invalidate(): void {
		// 不缓存 ANSI 文本；每次 render 都根据当前主题和宽度重新排版。
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const pad = Math.max(0, Math.min(Math.floor(this.outputPad), Math.floor((width - 24) / 2)));
		const inner = Math.max(1, width - pad * 2);
		const { theme } = this;
		const lines: string[] = [];
		const wrap = (text: string): void => { lines.push(...wrapTextWithAnsi(text, inner)); };
		const muted = (text: string): string => theme.fg("muted", text);
		const field = (text: string, size: number): string => truncateToWidth(text, size, "…", true);
		const rule = (): void => { lines.push(theme.fg("borderMuted", "─".repeat(inner))); };

		wrap(theme.fg("accent", theme.bold("世界时间")));
		wrap(theme.fg("dim", "同一时刻快照 · 24 小时制"));
		lines.push("");

		if (inner >= 64) {
			const showZone = inner >= 100;
			const columns = (name: string, time: string, date: string, offset: string): string =>
				`${field(name, 12)}  ${field(time, 8)}  ${field(date, 15)}  ${field(offset, 6)}`;
			wrap(muted(columns("地区", "时间", "日期", "UTC") + (showZone ? "  IANA 时区" : "")));
			rule();
			this.snapshot.cities.forEach((city, index) => {
				const name = field(city.name, 12);
				lines.push(
					`${index === 0 ? theme.fg("accent", name) : theme.fg("text", name)}  ` +
					`${theme.fg("text", theme.bold(city.time))}  ` +
					`${muted(field(`${city.date} ${city.weekday}`, 15))}  ${muted(field(city.offset, 6))}` +
					(showZone ? `  ${theme.fg("dim", city.timeZone)}` : ""),
				);
				if (index === 0) rule();
			});
		} else {
			this.snapshot.cities.forEach((city, index) => {
				if (index > 0) lines.push("");
				const name = theme.fg(index === 0 ? "accent" : "text", city.name);
				const time = theme.fg("text", theme.bold(city.time));
				if (inner >= 30) {
					wrap(`${field(name, 12)}  ${time}`);
					wrap(muted(`${city.date} ${city.weekday} · ${city.offset}`));
				} else {
					wrap(name);
					wrap(time);
					wrap(muted(city.date));
					wrap(muted(`${city.weekday} · ${city.offset}`));
				}
			});
		}

		lines.push("");
		if (this.expanded) {
			rule();
			wrap(theme.fg("accent", theme.bold("时区与地区定位")));
			for (const city of this.snapshot.cities) {
				lines.push("");
				wrap(`${theme.fg("text", city.name)} · ${muted(city.timeZone)}`);
				wrap(muted(city.reason));
			}
			lines.push("");
		} else {
			wrap(theme.fg("dim", `${this.expandKey ? `${this.expandKey} · ` : ""}展开消息可查看完整时区与地区定位。`));
		}
		wrap(muted(DISCLAIMER));
		// 极窄终端中也不允许双宽字符溢出；正常宽度下不会截断内容。
		return lines.map((line) => " ".repeat(pad) +
			(visibleWidth(line) > inner ? truncateToWidth(line, inner, "") : line));
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerMessageRenderer<WorldTimeSnapshot>(MESSAGE_TYPE, (message, options, theme) => {
		if (!message.details?.cities?.length) return undefined;
		return new WorldTimeCard(message.details, theme, options.expanded, options.outputPad,
			options.keyText("app.tools.expand"));
	});
	pi.registerCommand("now", {
		description: "查看世界时间快照，展开消息显示时区与地区定位",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const snapshot = createWorldTimeSnapshot();
			const text = formatSnapshot(snapshot);
			if (ctx.mode === "tui") {
				// 保存快照到会话，但不启动模型轮次。
				pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true, details: snapshot });
			} else if (ctx.hasUI) {
				ctx.ui.notify(text, "info");
			} else {
				// 不污染 JSON 集成使用的 stdout 事件流。
				process.stderr.write(`${text}\n`);
			}
		},
	});
}
