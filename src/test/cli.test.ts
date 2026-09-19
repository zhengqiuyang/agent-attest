import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../canonical.js";
import {
  CLI_JS,
  DEFAULT_PROMPT,
  initRepo,
  makeFixtureRepo,
  scaffold,
  writeConfig,
  writeVerifyScripts,
  FixtureRepo,
} from "./helpers.js";

function promptFileFor(fx: FixtureRepo): string {
  const p = join(fx.tmp, "prompt.txt");
  writeFileSync(p, DEFAULT_PROMPT);
  return p;
}

/** Generate signing keys for the fixture repo through the real CLI. */
function keygenOk(fx: FixtureRepo): void {
  const r = fx.runCli(["keygen"]);
  if (r.status !== 0) throw new Error(`keygen failed: ${r.stderr}`);
}

function readStatement(fx: FixtureRepo, sha: string): { envelope: any; statement: any } {
  const raw = readFileSync(fx.path(`.agent-attest/attestations/${sha}.attestation.json`), "utf8");
  const envelope = JSON.parse(raw);
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  return { envelope, statement };
}

function writeStatement(fx: FixtureRepo, sha: string, envelope: unknown): void {
  writeFileSync(fx.path(`.agent-attest/attestations/${sha}.attestation.json`), JSON.stringify(envelope, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// keygen
// ---------------------------------------------------------------------------

test("cli keygen creates keys, gitignores them, refuses to overwrite", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  initRepo(fx);

  const r = fx.runCli(["keygen"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(fx.path(".agent-attest/keys/private.pem")));
  assert.ok(existsSync(fx.path(".agent-attest/keys/public.pem")));
  assert.match(r.stdout, /keyid/);
  const gitignore = readFileSync(fx.path(".gitignore"), "utf8");
  assert.ok(gitignore.includes(".agent-attest/keys/"));

  const r2 = fx.runCli(["keygen"]);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /refusing to overwrite/);
});

// ---------------------------------------------------------------------------
// create + verify happy path
// ---------------------------------------------------------------------------

test("create builds the in-toto statement and verify accepts it", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  const base = scaffold(fx);
  keygenOk(fx);
  const prompt = promptFileFor(fx);
  const sha = fx.commitFiles({ "src/app.js": "export const app = () => 1;\n" }, "feat: app (headless agent run)");

  const c = fx.runCli([
    "create",
    "--commit",
    sha,
    "--agent",
    "claude-code",
    "--command",
    "claude -p 'implement app' --output-format json",
    "--prompt-file",
    prompt,
    "--verification",
    "node pass.js",
    "--meta",
    metaFile(fx, { objective: "implement app module", scheduledBy: "cron:nightly" }),
  ]);
  assert.equal(c.status, 0, c.stderr + c.stdout);
  assert.match(c.stdout, /attestation written/);
  assert.match(c.stdout, /passed=true \(executed/);

  const attPath = fx.path(`.agent-attest/attestations/${sha}.attestation.json`);
  assert.ok(existsSync(attPath), "deterministic filename");

  const { envelope, statement } = readStatement(fx, sha);
  assert.equal(envelope.payloadType, "application/vnd.in-toto+json");
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, "https://agent-attest.dev/attestations/agent-run/v1");
  assert.equal(statement.subject[0].digest.gitCommit, sha);
  assert.equal(statement.subject[0].name, "repo");
  assert.equal(statement.predicate.agent.name, "claude-code");
  assert.deepEqual(statement.predicate.commits, [sha]);
  assert.equal(statement.predicate.metadata.objective, "implement app module");
  assert.equal(statement.predicate.verification.passed, true);
  assert.equal(statement.predicate.verification.source, "executed");
  assert.equal(
    statement.predicate.run.promptSha256,
    createHash("sha256").update(readFileSync(prompt)).digest("hex"),
    "promptSha256 must be sha256 of the prompt file",
  );
  assert.match(envelope.payloadDigest.sha256, /^[0-9a-f]{64}$/);

  const v = fx.runCli(["verify"]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /OK/);
  assert.match(v.stdout, /all 1 attestation\(s\) valid/);

  const v1 = fx.runCli(["verify", "--commit", sha]);
  assert.equal(v1.status, 0, v1.stdout);

  const vr = fx.runCli(["verify", "--recheck"]);
  assert.equal(vr.status, 0, vr.stdout + vr.stderr);
  assert.match(vr.stdout, /re-check agree/);

  // the scaffold/base commit has no attestation — verify --commit says so, exit 1
  const vNone = fx.runCli(["verify", "--commit", base]);
  assert.equal(vNone.status, 1);
  assert.match(vNone.stdout, /no attestation found/);
});

test("create runs the verification command for real and records failures", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  keygenOk(fx);
  const prompt = promptFileFor(fx);
  const sha = fx.commitFiles({ "src/broken.js": "throw new Error('nope');\n" }, "feat: broken (agent)");

  const c = fx.runCli([
    "create",
    "--commit",
    sha,
    "--agent",
    "claude-code",
    "--prompt-file",
    prompt,
    "--verification",
    "node fail.js",
  ]);
  assert.equal(c.status, 0, "create succeeds even when verification fails — the record is the point");
  assert.match(c.stdout, /WARNING: verification FAILED/);

  const { statement } = readStatement(fx, sha);
  assert.equal(statement.predicate.verification.passed, false);
  assert.equal(statement.predicate.verification.source, "executed");
  assert.equal(statement.predicate.verification.exitCode, 1);

  // signature is still valid — the attestation honestly records a failure
  const v = fx.runCli(["verify"]);
  assert.equal(v.status, 0, v.stdout);
});

test("--verification-passed claims a result; --recheck catches the lie", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  keygenOk(fx);
  const prompt = promptFileFor(fx);
  const sha = fx.commitFiles({ "src/lazy.js": "export const lazy = 1;\n" }, "feat: lazy (agent)");

  const c = fx.runCli([
    "create",
    "--commit",
    sha,
    "--agent",
    "claude-code",
    "--prompt-file",
    prompt,
    "--verification",
    "node fail.js",
    "--verification-passed",
    "true",
  ]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /claimed/);

  const { statement } = readStatement(fx, sha);
  assert.equal(statement.predicate.verification.passed, true);
  assert.equal(statement.predicate.verification.source, "claimed");

  const v = fx.runCli(["verify"]);
  assert.equal(v.status, 0, "without --recheck the claim stands");

  const vr = fx.runCli(["verify", "--recheck"]);
  assert.equal(vr.status, 1, "--recheck re-runs the command and catches the false claim");
  assert.match(vr.stdout, /re-check disagrees/);
  assert.match(vr.stdout, /recorded passed=true/);
});

// ---------------------------------------------------------------------------
// tamper detection
// ---------------------------------------------------------------------------

test("tamper detection: flipped byte, forged digest, renamed file, nonexistent commit", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  keygenOk(fx);
  const prompt = promptFileFor(fx);
  const shaA = fx.commitFiles({ "src/app.js": "export const a = 1;\n" }, "feat: a");
  const shaB = fx.commitFiles({ "docs/b.md": "b\n" }, "docs: b");
  const created = fx.runCli([
    "create",
    "--commit",
    shaA,
    "--agent",
    "claude-code",
    "--prompt-file",
    prompt,
    "--verification",
    "node pass.js",
  ]);
  assert.equal(created.status, 0, created.stderr);
  const attPath = fx.path(`.agent-attest/attestations/${shaA}.attestation.json`);
  const pristine = readFileSync(attPath, "utf8");

  // 1. flip one byte inside the signed payload -> digest mismatch
  const env1 = JSON.parse(pristine);
  const bytes = Buffer.from(env1.payload, "base64");
  bytes[3] = bytes[3]! ^ 0xff;
  env1.payload = bytes.toString("base64");
  writeStatement(fx, shaA, env1);
  let r = fx.runCli(["verify"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /digest mismatch/);

  // 2. rewrite the subject (and recompute the digest) but keep the old signature
  const env2 = JSON.parse(pristine);
  const statement = JSON.parse(Buffer.from(env2.payload, "base64").toString("utf8"));
  statement.subject[0].digest.gitCommit = shaB;
  const newBytes = Buffer.from(canonicalJson(statement), "utf8");
  env2.payload = newBytes.toString("base64");
  env2.payloadDigest.sha256 = createHash("sha256").update(newBytes).digest("hex");
  writeStatement(fx, shaA, env2);
  r = fx.runCli(["verify"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /signature verification failed/);

  // 3. rename the attestation to another commit -> subject/filename mismatch
  writeFileSync(fx.path(`.agent-attest/attestations/${shaB}.attestation.json`), pristine);
  rmSync(attPath);
  r = fx.runCli(["verify"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not match attestation filename/);

  // 4. attest a commit that does not exist -> create refuses
  const bogus = "1234567890abcdef1234567890abcdef12345678";
  const rc = fx.runCli([
    "create",
    "--commit",
    bogus,
    "--agent",
    "claude-code",
    "--prompt-file",
    prompt,
    "--verification",
    "node pass.js",
  ]);
  assert.notEqual(rc.status, 0);
  assert.match(rc.stderr, /not found in repository history/);

  // 5. verify --commit for a nonexistent commit
  const rv = fx.runCli(["verify", "--commit", bogus]);
  assert.equal(rv.status, 1);
  assert.match(rv.stdout, /not found in local git history/);
});

test("verification command with shell quoting runs for real", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  keygenOk(fx);
  const prompt = promptFileFor(fx);
  const sha = fx.commitFiles({ "src/q.js": "export const q = 1;\n" }, "feat: q");
  const c = fx.runCli([
    "create",
    "--commit",
    sha,
    "--agent",
    "claude-code",
    "--prompt-file",
    prompt,
    "--verification",
    'node -e "process.exit(0)"',
  ]);
  assert.equal(c.status, 0, c.stderr + c.stdout);
  const { statement } = readStatement(fx, sha);
  assert.equal(statement.predicate.verification.passed, true);
  assert.equal(statement.predicate.verification.source, "executed");
});

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

interface GateFiles {
  commitsTxt: string;
  filesJson: string;
}

function writeGateInputs(fx: FixtureRepo, entries: Array<{ sha: string; files: string[] }>): GateFiles {
  const commitsTxt = fx.path("commits.txt");
  writeFileSync(commitsTxt, entries.map((e) => e.sha).join("\n") + "\n");
  const filesJson = fx.path("files.json");
  writeFileSync(filesJson, JSON.stringify(Object.fromEntries(entries.map((e) => [e.sha, e.files])), null, 2));
  return { commitsTxt, filesJson };
}

test("gate: missing attestation fails, valid passes, unprotected is ignored, override is a listed warning", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  const base = scaffold(fx);
  keygenOk(fx);
  const prompt = promptFileFor(fx);
  const shaA = fx.commitFiles({ "src/app.js": "export const a = 1;\n" }, "feat: a (agent)");
  const shaB = fx.commitFiles({ "docs/notes.md": "notes\n" }, "docs: notes (human)");
  const shaC = fx.commitFiles({ "src/payments.js": "export const p = 1;\n" }, "feat: payments (agent)");

  // shaA gets a valid attestation; shaC does not (yet).
  let c = fx.runCli(["create", "--commit", shaA, "--agent", "claude-code", "--prompt-file", prompt, "--verification", "node pass.js"]);
  assert.equal(c.status, 0, c.stderr);

  let inputs = writeGateInputs(fx, [
    { sha: base, files: ["README.md", "agent-attest.yaml"] },
    { sha: shaA, files: ["src/app.js"] },
    { sha: shaB, files: ["docs/notes.md"] },
    { sha: shaC, files: ["src/payments.js"] },
  ]);

  let g = fx.runCli(["gate", "--commits", inputs.commitsTxt, "--files", inputs.filesJson]);
  assert.equal(g.status, 1, g.stdout);
  assert.match(g.stdout, /MISSING/);
  assert.match(g.stdout, new RegExp(shaC.slice(0, 12)));
  assert.match(g.stdout, /OK/);
  assert.match(g.stdout, new RegExp(shaA.slice(0, 12)));
  assert.doesNotMatch(g.stdout, /docs\/notes\.md/, "unprotected commit must be ignored, not listed");

  // json format: structured summary
  g = fx.runCli(["gate", "--commits", inputs.commitsTxt, "--files", inputs.filesJson, "--format", "json"]);
  assert.equal(g.status, 1);
  const parsed = JSON.parse(g.stdout);
  assert.equal(parsed.exitCode, 1);
  assert.equal(parsed.summary.checked, 2);
  assert.equal(parsed.summary.skipped, 2);
  assert.equal(parsed.summary.failed, 1);
  assert.equal(parsed.summary.ok, 1);
  const statuses = Object.fromEntries(parsed.findings.map((f: any) => [f.commit, f.status]));
  assert.equal(statuses[shaA], "ok");
  assert.equal(statuses[shaC], "missing");

  // github annotations
  g = fx.runCli(["gate", "--commits", inputs.commitsTxt, "--files", inputs.filesJson, "--format", "github"]);
  assert.equal(g.status, 1);
  assert.match(g.stdout, /::error title=agent-attest gate::/);
  assert.match(g.stdout, new RegExp(shaC.slice(0, 12)));

  // attest shaC properly -> gate passes
  c = fx.runCli(["create", "--commit", shaC, "--agent", "claude-code", "--prompt-file", prompt, "--verification", "node pass.js"]);
  assert.equal(c.status, 0, c.stderr);
  g = fx.runCli(["gate", "--commits", inputs.commitsTxt, "--files", inputs.filesJson]);
  assert.equal(g.status, 0, g.stdout);
  assert.match(g.stdout, /PASSED/);

  // override trailer: unattested commit escapes as a listed warning
  const shaD = fx.commitFiles(
    { "src/hotfix.js": "export const h = 1;\n" },
    "fix: emergency hotfix\n\nagent-attest-override: pager duty at 2am, backfilling attestation tomorrow",
  );
  inputs = writeGateInputs(fx, [
    { sha: base, files: ["README.md", "agent-attest.yaml"] },
    { sha: shaA, files: ["src/app.js"] },
    { sha: shaB, files: ["docs/notes.md"] },
    { sha: shaC, files: ["src/payments.js"] },
    { sha: shaD, files: ["src/hotfix.js"] },
  ]);
  g = fx.runCli(["gate", "--commits", inputs.commitsTxt, "--files", inputs.filesJson]);
  assert.equal(g.status, 0, "override downgrades to warning -> exit 0");
  assert.match(g.stdout, /OVERRIDE/);
  assert.match(g.stdout, /pager duty at 2am/);
  assert.match(g.stdout, new RegExp(shaD.slice(0, 12)));

  const gj = fx.runCli(["gate", "--commits", inputs.commitsTxt, "--files", inputs.filesJson, "--format", "json"]);
  const parsedD = JSON.parse(gj.stdout);
  assert.equal(parsedD.exitCode, 0);
  assert.equal(parsedD.summary.overridden, 1);
  const dFinding = parsedD.findings.find((f: any) => f.commit === shaD);
  assert.equal(dFinding.status, "overridden");
  assert.equal(dFinding.level, "warning");

  // github warning annotation for the override
  const gw = fx.runCli(["gate", "--commits", inputs.commitsTxt, "--files", inputs.filesJson, "--format", "github"]);
  assert.match(gw.stdout, /::warning title=agent-attest override::/);
  assert.match(gw.stdout, /::notice title=agent-attest gate::/);

  // allowOverrideTrailer: false -> the same commit blocks again
  writeConfig(fx, { allowOverrideTrailer: false });
  g = fx.runCli(["gate", "--commits", inputs.commitsTxt, "--files", inputs.filesJson]);
  assert.equal(g.status, 1, "with the escape hatch disabled the override is a hard finding");
  assert.match(g.stdout, /MISSING/);

  // requireVerificationPassed: false -> failed recorded verification no longer blocks
  writeConfig(fx, { allowOverrideTrailer: true, requireVerificationPassed: false });
  const shaE = fx.commitFiles({ "src/broken.js": "export const b = 1;\n" }, "feat: broken (agent, failed tests)");
  c = fx.runCli(["create", "--commit", shaE, "--agent", "claude-code", "--prompt-file", prompt, "--verification", "node fail.js"]);
  assert.equal(c.status, 0, c.stderr);
  const inputsE = writeGateInputs(fx, [
    { sha: base, files: ["README.md", "agent-attest.yaml"] },
    { sha: shaA, files: ["src/app.js"] },
    { sha: shaC, files: ["src/payments.js"] },
    { sha: shaE, files: ["src/broken.js"] },
  ]);
  let gE = fx.runCli(["gate", "--commits", inputsE.commitsTxt, "--files", inputsE.filesJson]);
  assert.equal(gE.status, 0, gE.stdout);
  assert.match(gE.stdout, /attested by claude-code/);

  writeConfig(fx, { requireVerificationPassed: true });
  gE = fx.runCli(["gate", "--commits", inputsE.commitsTxt, "--files", inputsE.filesJson]);
  assert.equal(gE.status, 1);
  assert.match(gE.stdout, /VERIF-FAIL/);
  assert.match(gE.stdout, /verification\.passed=false/);
});

test("gate --range: local mode over git history", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  const base = scaffold(fx);
  keygenOk(fx);
  const prompt = promptFileFor(fx);
  const shaA = fx.commitFiles({ "src/app.js": "export const a = 1;\n" }, "feat: a (agent)");

  let g = fx.runCli(["gate", "--range", `${base}..HEAD`]);
  assert.equal(g.status, 1, g.stdout);
  assert.match(g.stdout, /MISSING/);

  const c = fx.runCli(["create", "--commit", shaA, "--agent", "claude-code", "--prompt-file", prompt, "--verification", "node pass.js"]);
  assert.equal(c.status, 0, c.stderr);
  g = fx.runCli(["gate", "--range", `${base}..HEAD`]);
  assert.equal(g.status, 0, g.stdout);

  // invalid range -> usage/config error (exit 2)
  const bad = fx.runCli(["gate", "--range", "does-not-exist..alsonot"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /rev-list/);
});

test("gate without agent-attest.yaml is a config error (exit 2)", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  initRepo(fx);
  writeVerifyScripts(fx);
  const base = fx.commitFiles({ "README.md": "# x\n" }, "init");
  fx.commitFiles({ "src/app.js": "export const a = 1;\n" }, "feat: a");
  const g = fx.runCli(["gate", "--range", `${base}..HEAD`]);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /agent-attest\.yaml/);
});

test("gate with no commit source is a usage error (exit 2)", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  const g = fx.runCli(["gate"]);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /no commit source/);
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

test("report: markdown and json inventories, invalid signatures surfaced", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  keygenOk(fx);
  const prompt = promptFileFor(fx);
  const shaA = fx.commitFiles({ "src/app.js": "export const a = 1;\n" }, "feat: a");
  const shaB = fx.commitFiles({ "src/b.js": "export const b = 1;\n" }, "feat: b");
  fx.runCli(["create", "--commit", shaA, "--agent", "claude-code", "--prompt-file", prompt, "--verification", "node pass.js"]);
  fx.runCli(["create", "--commit", shaB, "--agent", "codex-cli", "--prompt-file", prompt, "--verification", "node pass.js"]);

  const rj = fx.runCli(["report", "--format", "json"]);
  assert.equal(rj.status, 0, rj.stderr);
  const parsed = JSON.parse(rj.stdout);
  assert.equal(parsed.totals.attestations, 2);
  assert.equal(parsed.totals.validSignatures, 2);
  assert.equal(parsed.totals.verificationPassed, 2);
  assert.equal(parsed.attestations.length, 2);
  const agents = parsed.attestations.map((r: any) => r.agent).sort();
  assert.deepEqual(agents, ["claude-code", "codex-cli"]);

  const rm = fx.runCli(["report"]);
  assert.equal(rm.status, 0);
  assert.match(rm.stdout, /# agent-attest report — repo/);
  assert.match(rm.stdout, /\| Commit \| Agent \| Ran at \| Verification \| Run duration \| Signature \|/);
  assert.match(rm.stdout, /claude-code/);
  assert.match(rm.stdout, /2 attestation\(s\)/);

  // tamper with shaB's attestation -> report flags it, still exit 0
  const attPath = fx.path(`.agent-attest/attestations/${shaB}.attestation.json`);
  const env = JSON.parse(readFileSync(attPath, "utf8"));
  const bytes = Buffer.from(env.payload, "base64");
  bytes[5] = bytes[5]! ^ 0x2f;
  env.payload = bytes.toString("base64");
  writeFileSync(attPath, JSON.stringify(env, null, 2) + "\n");

  const rj2 = fx.runCli(["report", "--format", "json"]);
  const parsed2 = JSON.parse(rj2.stdout);
  assert.equal(parsed2.totals.invalidSignatures, 1);
  assert.equal(parsed2.totals.validSignatures, 1);
  const row = parsed2.attestations.find((r: any) => r.commit === shaB);
  assert.equal(row.signatureValid, false);

  const rm2 = fx.runCli(["report"]);
  assert.match(rm2.stdout, /INVALID/);
});

// ---------------------------------------------------------------------------
// misc CLI behavior
// ---------------------------------------------------------------------------

test("verify with no attestations is a clean exit 0", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  const v = fx.runCli(["verify"]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /no attestations found/);
});

test("create outside a git repository is a usage error (exit 2)", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "agent-attest-norepo-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const prompt = join(tmp, "prompt.txt");
  writeFileSync(prompt, DEFAULT_PROMPT);
  const r = spawnSync(
    process.execPath,
    [CLI_JS, "create", "--commit", "a".repeat(40), "--agent", "x", "--prompt-file", prompt, "--verification", "node pass.js"],
    { cwd: tmp, encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr), /not inside a git repository/);
});

function metaFile(fx: FixtureRepo, obj: Record<string, unknown>): string {
  const p = join(fx.tmp, "meta.json");
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
