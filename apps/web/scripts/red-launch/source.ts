/**
 * Ensures launch deploys ship the approved git revision (clean HEAD), not a dirty tree.
 */

export type GitRevision = {
  sha: string;
  short: string;
  clean: boolean;
};

export type GitClient = {
  revision(): Promise<GitRevision>;
};

type RunGit = (
  argv: string[],
  options?: { timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function createGitClient(run: RunGit = defaultGitRun, cwd = process.cwd()): GitClient {
  return {
    async revision() {
      const head = await run(["git", "-C", cwd, "rev-parse", "HEAD"], { timeoutMs: 15_000 });
      if (head.code !== 0) throw new Error("Unable to resolve git HEAD for the approved source revision.");
      const sha = head.stdout.trim();
      if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("git HEAD did not return a full commit SHA.");

      const status = await run(["git", "-C", cwd, "status", "--porcelain"], { timeoutMs: 15_000 });
      if (status.code !== 0) throw new Error("Unable to read git status before deploy.");
      const clean = status.stdout.trim() === "";
      return { sha, short: sha.slice(0, 7), clean };
    },
  };
}

async function defaultGitRun(
  argv: string[],
  options?: { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timeout = options?.timeoutMs ?? 15_000;
  const timer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code: code ?? 1, stdout, stderr };
}

/** Fail-closed gate used before any production deploy. */
export function requireCleanApprovedRevision(revision: GitRevision): string {
  if (!revision.clean) {
    throw new Error(
      "Working tree is dirty. Commit or stash changes so the launch CLI deploys the approved git revision only.",
    );
  }
  return revision.sha;
}
