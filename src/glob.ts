import { normalizePath } from "./util.js";

/**
 * Minimal, predictable glob matcher for protected paths (minimatch-style
 * subset, no brace expansion):
 *   `**` matches any number of path segments (including none)
 *   `*`  matches within a single segment
 *   `?`  matches a single non-separator character
 * Path separators are normalized to `/` before matching, so Windows paths
 * and git-provided paths behave identically.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;

  const pattern = normalizePath(glob);
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      let j = i;
      while (pattern[j] === "*") j++;
      const stars = j - i;
      if (stars >= 2) {
        if (pattern[j] === "/") {
          // `**/` — zero or more whole segments; i lands on the "/", loop skips it.
          re += "(?:[^/]*/)*";
          i = j;
        } else {
          re += ".*";
          i = j - 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+(){}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  const rx = new RegExp(`^${re}$`);
  cache.set(glob, rx);
  return rx;
}

export function matchGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizePath(path));
}

export function matchAny(path: string, globs: string[]): boolean {
  return globs.some((g) => matchGlob(path, g));
}
