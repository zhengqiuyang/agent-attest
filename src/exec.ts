import { exec } from "node:child_process";

/**
 * Result of running an attestation's verification command.
 * `passed` is decided purely by the process exit code (0 == pass).
 */
export interface CommandResult {
  exitCode: number;
  passed: boolean;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run a command line string in a shell (cmd.exe on Windows, /bin/sh on POSIX)
 * inside `cwd` and capture the real outcome. We deliberately use a shell so
 * verification commands can be normal human-written command lines such as
 * `npm test` or `node scripts/check.js`.
 */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err) => {
        const durationMs = Date.now() - started;
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        if (e && typeof e.code === "string") {
          // The shell itself could not be spawned (ENOENT etc.) — treat as a failed command.
          resolve({ exitCode: 127, passed: false, durationMs, timedOut: false });
          return;
        }
        const timedOut = Boolean(e && e.killed && e.signal === "SIGTERM");
        const exitCode = typeof e?.code === "number" ? e.code : e ? 1 : 0;
        resolve({ exitCode, passed: exitCode === 0, durationMs, timedOut });
      },
    );
  });
}
