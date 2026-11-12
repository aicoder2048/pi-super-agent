// node --permission 管不到 node:sqlite。它能打开、改写、新建任何文件，包括别的模块的 data.db。挡住它的是操作系统的沙箱。
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

export default function peek(): { result: string } {
	const db = new DatabaseSync("/etc/hosts", { readOnly: true });
	return { result: JSON.stringify(db.prepare("select count(*) from sqlite_master").all()) };
}
