import { defaultStateDir } from "../host/config.ts";
import { removeWebToken, webTokenPath } from "../host/web-token.ts";

const stateDir = defaultStateDir();
removeWebToken(stateDir);
console.log(`已删除 ${webTokenPath(stateDir)}。宿主下次启动时生成新 token，旧网址随之失效；正在运行的宿主沿用旧 token，直到重启。重启后用宿主日志里的新网址打开。`);
