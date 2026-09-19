#!/usr/bin/env node
/**
 * agent-attest demo — the full story on a throwaway fixture repo:
 *
 *   keygen -> headless agent commits -> create (verification really runs)
 *   -> verify -> tamper one byte -> verify catches it -> restore
 *   -> gate passes -> unattested commit -> gate fails -> override trailer
 *   -> report
 *
 * No network, no real agents. The repo lives in os.tmpdir() and is removed
 * at the end.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(here);
const cliJs = join(projectRoot, "dist", "cli.js");

if (!existsSync(cliJs)) {
  console.error("dist/cli.js not found — building first (tsc)…");
  const build = spawnSync(process.execPath, [join(projectRoot, "node_modules", "typescript", "bin", "tsc")], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const tmp = mkdtempSync(join(tmpdir(), "agent-attest-demo-"));
const repo = join(tmp, "repo");
mkdirSync(repo, { recursive: true });
const globalCfg = join(tmp, "gitconfig-global");
writeFileSync(globalCfg, "");

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: globalCfg,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Demo",
  GIT_AUTHOR_EMAIL: "demo@example.com",
  GIT_COMMITTER_NAME: "Demo",
  GIT_COMMITTER_EMAIL: "demo@example.com",
};

function git(args) {
  const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}):\n${r.stderr}`);
  return r.stdout;
}

function cli(args, expect = 0) {
  const r = spawnSync(process.execPath, [cliJs, ...args], { cwd: repo, env, encoding: "utf8", windowsHide: true });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (expect !== null && r.status !== expect) {
    console.error(`\ndemo: expected exit ${expect} from "agent-attest ${args.join(" ")}", got ${r.status}`);
    process.exit(1);
  }
  return r;
}

function banner(text) {
  console.log(`\n${"-".repeat(76)}\n-- ${text}\n${"-".repeat(76)}`);
}

function writeInRepo(rel, content) {
  const abs = join(repo, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(files, message) {
  for (const [rel, content] of Object.entries(files)) writeInRepo(rel, content);
  git(["add", "--", ...Object.keys(files)]);
  git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
}

console.log(`agent-attest demo — throwaway repo at ${repo}`);

banner("1. Scaffold a fixture repo with a gate config (src/** and infra/** are protected)");
git(["-c", "init.defaultBranch=main", "init"]);
const base = commit(
  {
    "agent-attest.yaml": [
      "protectedPaths:",
      '  - "src/**"',
      '  - "infra/**"',
      "requireVerificationPassed: true",
      "allowOverrideTrailer: true",
      "",
    ].join("\n"),
    "README.md": "# widget\n",
    "pass.js": "process.exit(0);\n",
    "fail.js": "process.exit(1);\n",
  },
  "chore: scaffold widget repo",
);

banner("2. keygen — ed25519 keypair, private key written 0600 and gitignored");
cli(["keygen"]);

banner("3. Headless agents push straight to the branch (no PR review on this lane)");
const shaA = commit(
  { "src/auth.js": "export function issueToken(user) { return `tok-${user}`; }\n" },
  "feat(auth): issue session tokens\n\nProduced by a scheduled headless agent run. Nobody reviewed this lane.",
);
const shaB = commit(
  { "docs/notes.md": "# Notes\n\n- brainstorm from the docs agent\n" },
  "docs: brainstorming notes from the docs agent",
);

banner("4. create — attestations recorded at run time (the verification command really runs)");
const promptA = join(tmp, "prompt-auth.txt");
writeFileSync(promptA, "Implement session token issuance in src/auth.js. Make the checks pass.\n");
const metaA = join(tmp, "meta-auth.json");
writeFileSync(metaA, JSON.stringify({ objective: "implement session-token auth", scheduledBy: "cron:nightly" }, null, 2));
cli([
  "create",
  "--commit",
  shaA,
  "--agent",
  "claude-code",
  "--command",
  "claude -p --output-format json",
  "--prompt-file",
  promptA,
  "--verification",
  "node pass.js",
  "--meta",
  metaA,
]);
const promptB = join(tmp, "prompt-docs.txt");
writeFileSync(promptB, "Update the docs brainstorming notes.\n");
cli([
  "create",
  "--commit",
  shaB,
  "--agent",
  "claude-code",
  "--command",
  "claude -p --output-format json",
  "--prompt-file",
  promptB,
  "--verification",
  "node pass.js",
]);

banner("5. verify — both attestations are valid");
cli(["verify"]);

banner("6. Tamper: flip one byte inside a signed payload");
const attB = join(repo, ".agent-attest", "attestations", `${shaB}.attestation.json`);
const pristine = readFileSync(attB, "utf8");
const tampered = JSON.parse(pristine);
const payload = Buffer.from(tampered.payload, "base64");
payload[0] = payload[0] ^ 0xff;
tampered.payload = payload.toString("base64");
writeFileSync(attB, JSON.stringify(tampered, null, 2) + "\n");
console.log("(...payload byte flipped...)\n");
cli(["verify"], 1);
console.log("-> 1 valid, 1 tampered: nothing slips through silently.");

banner("7. Restore the pristine attestation");
writeFileSync(attB, pristine);
cli(["verify"]);

banner("8. gate — protected paths are covered, so the branch is mergeable");
cli(["gate", "--range", `${base}..HEAD`]);

banner("9. A new agent commit without an attestation -> the gate blocks it");
const shaC = commit(
  { "src/payments.js": "export function charge(n) { return n * 100; }\n" },
  "feat(payments): charge API (attestation pipeline broke here)",
);
cli(["gate", "--range", `${base}..HEAD`], 1);
console.log("-> gate FAILED: src/payments.js was touched with no attestation.");

banner("10. The agent backfills its attestation -> gate passes again");
const promptC = join(tmp, "prompt-payments.txt");
writeFileSync(promptC, "Implement the charge API.\n");
cli([
  "create",
  "--commit",
  shaC,
  "--agent",
  "claude-code",
  "--command",
  "claude -p --output-format json",
  "--prompt-file",
  promptC,
  "--verification",
  "node pass.js",
]);
cli(["gate", "--range", `${base}..HEAD`]);

banner("11. The override trailer — an escape hatch that is never silent");
const shaD = commit(
  { "src/hotfix.js": "export const hot = true;\n" },
  "fix: emergency hotfix\n\nagent-attest-override: pager duty at 2am, backfilling attestation tomorrow",
);
cli(["gate", "--range", `${base}..HEAD`]);
console.log("-> exit 0, but the OVERRIDE is listed in every output format. Auditors see it.");

banner("12. report — the compliance inventory");
cli(["report", "--format", "markdown"]);

banner("Cleanup");
rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log("demo complete — fixture repo removed.");
