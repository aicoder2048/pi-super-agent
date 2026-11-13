import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeSite } from "../../src/modules/run-code.ts";

const scratchData = join(tmpdir(), `psa-test-data-${process.pid}`);
process.once("exit", () => rmSync(scratchData, { recursive: true, force: true }));

export const codeSite = (packageDir: string, component = ""): CodeSite => ({ packageDir, component, dataDir: scratchData });
