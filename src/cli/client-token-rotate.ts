import { defaultStateDir } from "../host/config.ts";
import { removeToken, tokenPath } from "../host/web-token.ts";

const stateDir = defaultStateDir();
removeToken(stateDir, "client-token");
console.log(`已删除 ${tokenPath(stateDir, "client-token")}。现在重启宿主，它启动时生成新凭据；重启前新开的 TUI、just say 和 just tail 连不上，已经连着的不受影响。`);
