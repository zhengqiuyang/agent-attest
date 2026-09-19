import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixture helpers: isolated git repos in os.tmpdir() with neutralized git
 * config (GIT_CONFIG_NOSYSTEM=1, empty GIT_CONFIG_GLOBAL) and injected
 * identity. No network, no real agents, Windows-safe.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const DIST_DIR = join(here, "..");
export const PROJECT_ROOT = join(here, "..", "..");
export const CLI_JS = join(DIST_DIR, "cli.js");

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface FixtureRepo {
  root: string;
  tmp: string;
  path(rel: string): string;
  git(args: string[]): RunResult;
  gitOk(args: string[]): string;
  write(rel: string, content: string): void;
  commitFiles(files: Record<string, string>, message: string): string;
  runCli(args: string[], extraEnv?: Record<string, string>): RunResult;
  cleanup(): void;
}

export function makeFixtureRepo(): FixtureRepo {
  const tmp = mkdtempSync(join(tmpdir(), "agent-attest-fx-"));
  const root = join(tmp, "repo");
  mkdirSync(root, { recursive: true });
  const globalCfg = join(tmp, "gitconfig-global");
  writeFileSync(globalCfg, "");

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture Bot",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture Bot",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };

  const git = (args: string[]): RunResult => {
    const r = spawnSync("git", args, { cwd: root, env: baseEnv, encoding: "utf8", windowsHide: true });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  const fx: FixtureRepo = {
    root,
    tmp,
    path: (rel) => join(root, ...rel.split("/")),
    git,
    gitOk(args) {
      const r = git(args);
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
      return r.stdout;
    },
    write(rel, content) {
      const abs = join(root, ...rel.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    commitFiles(files, message) {
      for (const [rel, content] of Object.entries(files)) fx.write(rel, content);
      const adds = Object.keys(files).map((p) => p.replace(/\\/g, "/"));
      fx.gitOk(["add", "--", ...adds]);
      fx.gitOk(["commit", "-m", message]);
      return fx.gitOk(["rev-parse", "HEAD"]).trim();
    },
    runCli(args, extraEnv = {}) {
      const r = spawnSync(process.execPath, [CLI_JS, ...args], {
        cwd: root,
        env: { ...baseEnv, ...extraEnv },
        encoding: "utf8",
        windowsHide: true,
      });
      return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    cleanup() {
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows file-lock races: best effort, tmpdir is cleaned by the OS.
      }
    },
  };
  return fx;
}

export function initRepo(fx: FixtureRepo): void {
  fx.gitOk(["-c", "init.defaultBranch=main", "init"]);
}

export function writeDefaultConfig(fx: FixtureRepo): void {
  fx.write(
    "agent-attest.yaml",
    ["protectedPaths:", '  - "src/**"', '  - "infra/**"', "requireVerificationPassed: true", "allowOverrideTrailer: true", ""].join("\n"),
  );
}

export function writeConfig(fx: FixtureRepo, options: { requireVerificationPassed?: boolean; allowOverrideTrailer?: boolean } = {}): void {
  const requireVerificationPassed = options.requireVerificationPassed ?? true;
  const allowOverrideTrailer = options.allowOverrideTrailer ?? true;
  fx.write(
    "agent-attest.yaml",
    [
      "protectedPaths:",
      '  - "src/**"',
      '  - "infra/**"',
      `requireVerificationPassed: ${requireVerificationPassed}`,
      `allowOverrideTrailer: ${allowOverrideTrailer}`,
      "",
    ].join("\n"),
  );
}

export function writeVerifyScripts(fx: FixtureRepo): void {
  fx.write("pass.js", "process.exit(0);\n");
  fx.write("fail.js", "process.exit(1);\n");
}

/** Scaffold + initial commit; returns the scaffold sha. */
export function scaffold(fx: FixtureRepo): string {
  initRepo(fx);
  writeDefaultConfig(fx);
  writeVerifyScripts(fx);
  return fx.commitFiles({ "README.md": "# fixture\n" }, "chore: scaffold");
}

export const DEFAULT_PROMPT = "Implement the feature with tests. Be honest about what passed.\n";
