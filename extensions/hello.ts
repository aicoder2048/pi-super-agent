/**
 * hello, pi super agent!
 *
 * A minimal pi extension that registers the `/hello` slash command.
 *
 * Try it from the repository root:
 *
 *   pi -e extensions/hello.ts
 *   /hello
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function helloExtension(pi: ExtensionAPI) {
	pi.registerCommand("hello", {
		description: "Say hello, pi super agent!",
		handler: async (_args, ctx) => {
			ctx.ui.notify("hello, pi super agent!", "info");
		},
	});
}
