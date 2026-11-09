import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import type { TriggerSubmission } from "../kernel/types.ts";

export interface GenericDrop {
	source?: string;
	id?: string;
	thread: string;
	threadTitle?: string;
	sender?: string;
	body: string;
	occurredAt?: string | number;
}

export function threadId(source: string, thread: string): string {
	return `thr_${source}:${thread}`;
}

export function parseDrop(fileName: string, text: string, now: number): TriggerSubmission {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`不是合法的 JSON：${(error as Error).message}`);
	}
	const d = raw as Partial<GenericDrop>;
	if (typeof d !== "object" || d === null) throw new Error("内容必须是 JSON 对象");
	if (typeof d.thread !== "string" || !d.thread.trim()) throw new Error("缺少 thread（线程标识）");
	if (typeof d.body !== "string" || !d.body.trim()) throw new Error("缺少 body（正文）");
	const source = typeof d.source === "string" && d.source.trim() ? d.source.trim() : "generic";
	if (source === "conversation") throw new Error("通用来源不能冒充对话");
	const occurredAt = d.occurredAt === undefined ? now : new Date(d.occurredAt).getTime();
	if (Number.isNaN(occurredAt)) throw new Error(`occurredAt 无法解析：${String(d.occurredAt)}`);
	return {
		source,
		externalId: typeof d.id === "string" && d.id ? d.id : basename(fileName),
		threads: [{ id: threadId(source, d.thread), title: d.threadTitle }],
		sender: typeof d.sender === "string" && d.sender ? d.sender : source,
		body: d.body,
		occurredAt,
	};
}

export interface GenericSourceOptions {
	inboxDir: string;
	submit(trigger: TriggerSubmission): void;
	now(): number;
	log(line: string): void;
}

export class GenericSource {
	readonly #o: GenericSourceOptions;
	#watcher: FSWatcher | undefined;
	#scanning = false;
	#rescan = false;

	constructor(options: GenericSourceOptions) {
		this.#o = options;
		for (const sub of ["", "processed", "rejected"]) mkdirSync(join(options.inboxDir, sub), { recursive: true });
	}

	start(): void {
		this.scan();
		this.#watcher = watch(this.#o.inboxDir, () => this.scan());
	}

	stop(): void {
		this.#watcher?.close();
	}

	scan(): void {
		if (this.#scanning) {
			this.#rescan = true;
			return;
		}
		this.#scanning = true;
		try {
			do {
				this.#rescan = false;
				const files = readdirSync(this.#o.inboxDir).filter((f) => f.endsWith(".json")).sort();
				for (const file of files) this.#take(file);
			} while (this.#rescan);
		} finally {
			this.#scanning = false;
		}
	}

	// Submit before moving: a crash in between resubmits the file, and the kernel dedupes it by externalId.
	#take(file: string): void {
		const path = join(this.#o.inboxDir, file);
		if (!existsSync(path)) return;
		let trigger: TriggerSubmission;
		try {
			trigger = parseDrop(file, readFileSync(path, "utf8"), this.#o.now());
		} catch (error) {
			const reason = (error as Error).message;
			renameSync(path, join(this.#o.inboxDir, "rejected", file));
			writeFileSync(join(this.#o.inboxDir, "rejected", `${file}.error.txt`), reason + "\n");
			this.#o.log(`[generic] 拒收 ${file}：${reason}`);
			return;
		}
		this.#o.submit(trigger);
		renameSync(path, join(this.#o.inboxDir, "processed", file));
	}
}

export function dropTrigger(inboxDir: string, drop: GenericDrop): string {
	mkdirSync(inboxDir, { recursive: true });
	const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
	const tmp = join(inboxDir, `.${name}.tmp`);
	writeFileSync(tmp, JSON.stringify(drop));
	renameSync(tmp, join(inboxDir, name));
	return name;
}
