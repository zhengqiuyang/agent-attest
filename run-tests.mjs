#!/usr/bin/env node
/**
 * Portable test launcher.
 *
 * Enumerates dist/test/*.test.js and hands the explicit file list to
 * `node --test`. We pass explicit files instead of glob arguments because
 * glob support in `node --test` needs Node 21+, and we support Node 20.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "dist", "test");

let files;
try {
  files = readdirSync(testDir)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => join(testDir, f));
} catch {
  console.error(`run-tests: cannot read ${testDir} — did \`npm run build\` succeed?`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`run-tests: no *.test.js files found in ${testDir}`);
  process.exit(1);
}

console.log(`run-tests: ${files.length} test file(s):`);
for (const f of files) console.log(`  ${f}`);

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
