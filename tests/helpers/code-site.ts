import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeSite } from "../../src/modules/run-code.ts";

const scratchData = join(tmpdir(), `psa-test-data-${process.pid}`);
process.once("exit", () => rmSync(scratchData, { recursive: true, force: true }));

/** For a test that runs one piece of module code directly. The data dir is gone when the test process exits. */
export const codeSite = (packageDir: string, component = ""): CodeSite => ({ packageDir, component, dataDir: scratchData });
