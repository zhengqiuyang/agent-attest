#!/usr/bin/env node
/**
 * agent-attest CLI entry point.
 * Delegates to dist/cli.js (TypeScript build output).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliJs = join(here, "..", "dist", "cli.js");

if (!existsSync(cliJs)) {
  console.error("agent-attest: dist/cli.js not found — run `npm run build` first.");
  process.exit(2);
}

try {
  const { main } = await import(pathToFileURL(cliJs).href);
  const code = await main(process.argv.slice(2));
  process.exit(code);
} catch (err) {
  console.error(`agent-attest: unexpected failure: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(2);
}
