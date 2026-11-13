/**
 * `<module data dir>/files/` is the one place a module's code writes. The Python environments that
 * `just module setup` installs live there too, one per lock file, so a ticket pinned to an older
 * package copy keeps the versions that copy was locked to.
 */
import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export const PY_DIR = "py";
/** Holds the full lock hash, written after a finished install: a venv without it is half installed. */
export const VENV_MARK = ".psa-lock";
const VENV = /^venv-[0-9a-f]{12}$/;

export const filesDir = (dataDir: string): string => join(dataDir, "files");

/** The sha256 of the package's `py/uv.lock`. Undefined: the package has no Python project. */
export function lockOf(packageDir: string): string | undefined {
	const lock = join(packageDir, PY_DIR, "uv.lock");
	return existsSync(lock) ? createHash("sha256").update(readFileSync(lock)).digest("hex") : undefined;
}

export const venvDir = (dataDir: string, lock: string): string => join(filesDir(dataDir), `venv-${lock.slice(0, 12)}`);

export const venvsIn = (dataDir: string): string[] => (existsSync(filesDir(dataDir)) ? readdirSync(filesDir(dataDir)).filter((name) => VENV.test(name)) : []);

/** For a rehearsal's throwaway state dir. A venv's scripts hold its absolute path, so it is linked, never copied. */
export function cloneFiles(realDataDir: string, tempDataDir: string): void {
	const [real, temp] = [filesDir(realDataDir), filesDir(tempDataDir)];
	if (!existsSync(real)) return;
	const venvs = venvsIn(realDataDir);
	cpSync(real, temp, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: (path) => !venvs.some((name) => path === join(real, name)) });
	for (const name of venvs) symlinkSync(join(real, name), join(temp, name));
}
