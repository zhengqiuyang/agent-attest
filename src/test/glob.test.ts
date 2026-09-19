import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, matchAny, matchGlob } from "../glob.js";

const CASES: Array<[string, string, boolean]> = [
  // "src/**" — everything under src/, not src itself, not siblings
  ["src/**", "src/app.js", true],
  ["src/**", "src/a/b/c.js", true],
  ["src/**", "docs/app.js", false],
  ["src/**", "src", false],
  ["src/**", "srcx/app.js", false],
  // single star stays within one segment
  ["src/*.js", "src/a.js", true],
  ["src/*.js", "src/app.test.js", true],
  ["src/*.js", "src/a/b.js", false],
  ["src/*.js", "src/a.ts", false],
  // leading globstar (**/ may match zero segments, minimatch-style)
  ["**/*.js", "a.js", true],
  ["**/*.js", "x/y/a.js", true],
  ["**/*.js", "x/y/a.ts", false],
  // bare filenames and extensions
  ["*.md", "README.md", true],
  ["*.md", "a/README.md", false],
  ["Makefile", "Makefile", true],
  ["Makefile", "Makefile.bak", false],
  // question mark
  ["?", "a", true],
  ["?", "ab", false],
  ["file?.js", "file1.js", true],
  ["file?.js", "file10.js", false],
  // literal dots are literals, not regex wildcards
  ["src/app.js", "src/app.js", true],
  ["src/app.js", "src/appXjs", false],
  // other protected-path style patterns
  ["infra/**", "infra/main.tf", true],
  ["infra/**", "infrastructure/main.tf", false],
  [".github/workflows/*.yml", ".github/workflows/ci.yml", true],
  ["**", "anything/at/all.js", true],
  ["**", "top.txt", true],
];

test("glob matcher behavior", () => {
  for (const [glob, path, expected] of CASES) {
    assert.equal(matchGlob(path, glob), expected, `matchGlob(${JSON.stringify(path)}, ${JSON.stringify(glob)}) should be ${expected}`);
  }
});

test("glob matching normalizes Windows separators", () => {
  assert.equal(matchGlob("src\\app.js", "src/**"), true);
  assert.equal(matchGlob("src/app.js", "src\\**"), true);
  assert.equal(matchAny("src\\a\\b.js", ["docs/**", "src/**"]), true);
  assert.equal(matchAny("docs/x.md", ["docs/**", "src/**"]), true);
  assert.equal(matchAny("other/x.md", ["docs/**", "src/**"]), false);
});

test("globToRegExp produces anchored regexes", () => {
  assert.equal(globToRegExp("src/*.js").test("src/app.js"), true);
  // regex metacharacters in globs are treated literally
  assert.equal(globToRegExp("a+b/c").test("a+b/c"), true);
  assert.equal(globToRegExp("a+b/c").test("aab/c"), false);
});
