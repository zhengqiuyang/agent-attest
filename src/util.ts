import { readFileSync } from "node:fs";

/**
 * Read a text file with BOM stripped and CRLF (or lone CR) normalized to LF.
 * All parsing of human/editor-touched text files goes through this so the
 * tool behaves identically on Windows checkouts and POSIX ones.
 */
export function readTextNormalized(path: string): string {
  const raw = readFileSync(path, "utf8");
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Convert backslashes to forward slashes (Windows-safe path comparison). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Normalize a repo-relative path for glob matching. */
export function normalizePath(p: string): string {
  return toPosix(p).replace(/^\.\//, "");
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
