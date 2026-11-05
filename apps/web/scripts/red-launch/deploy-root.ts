/**
 * Monorepo root for Vercel CLI deploys.
 *
 * The cope2/rednest project Root Directory is `apps/web`. Invoking
 * `vercel deploy` from `apps/web` (as `bun run --cwd apps/web` does) makes the
 * CLI resolve that setting again → `apps/web/apps/web`, which fails. Deploy
 * commands must always pass the git/monorepo root via `--cwd`.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Project Root Directory configured on Vercel for cope2/rednest. */
export const VERCEL_PROJECT_ROOT_DIRECTORY = "apps/web";

export function resolveMonorepoDeployRoot(startDir = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    const packageJson = join(dir, "package.json");
    const webPackage = join(dir, VERCEL_PROJECT_ROOT_DIRECTORY, "package.json");
    if (existsSync(packageJson) && existsSync(webPackage)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Unable to locate monorepo root from ${startDir} (expected ${VERCEL_PROJECT_ROOT_DIRECTORY}/ under an ancestor). Refusing to deploy: nested cwd would duplicate the Vercel Root Directory.`,
      );
    }
    dir = parent;
  }
}

/** True when `cwd` is the nested web package, not the monorepo root. */
export function isNestedWebPackageCwd(cwd: string, monorepoRoot: string): boolean {
  return resolve(cwd) === resolve(monorepoRoot, VERCEL_PROJECT_ROOT_DIRECTORY);
}
