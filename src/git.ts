import { execFile } from "node:child_process";

/**
 * Thin, Windows-safe git plumbing built on execFile (never a shell string).
 * Read-only operations only — agent-attest never mutates the repository.
 */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(args: string[], opts: { cwd: string }): Promise<GitResult> {
  return await new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      {
        cwd: opts.cwd,
        env: process.env,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (typeof code === "number") {
            // Normal nonzero git exit (e.g. rev-parse of an unknown ref).
            resolvePromise({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          // git itself missing / could not spawn
          reject(err);
          return;
        }
        resolvePromise({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** Repo working-tree root, or null when not inside a git repository. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(["rev-parse", "--show-toplevel"], { cwd });
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

/** Resolve a ref to a full 40-hex commit sha, or null when it does not exist. */
export async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
  if (r.code !== 0) return null;
  return r.stdout.trim().toLowerCase();
}

/** Full commit message (%B) of a sha, or null when unavailable. */
export async function commitMessage(cwd: string, sha: string): Promise<string | null> {
  const r = await git(["log", "-1", "--format=%B", sha], { cwd });
  return r.code === 0 ? r.stdout : null;
}

/** Paths changed by a commit (works for root commits too via --root). */
export async function commitFiles(cwd: string, sha: string): Promise<string[]> {
  const r = await git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha], { cwd });
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Commits reachable from head but not base, oldest first. Null on a bad range. */
export async function revListRange(cwd: string, range: string): Promise<string[] | null> {
  const r = await git(["rev-list", range], { cwd });
  if (r.code !== 0) return null;
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .reverse();
}
