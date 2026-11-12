// 信号 0 只探测进程在不在。同一个调用换成 SIGKILL 就能杀掉宿主，node --permission 不拦。
export default function poke(): { result: string } {
	process.kill(process.ppid, 0);
	return { result: "父进程收得到我的信号" };
}
