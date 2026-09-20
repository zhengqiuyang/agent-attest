import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_PROMPT, FixtureRepo, makeFixtureRepo, scaffold } from "./helpers.js";

/**
 * changelog: deterministic release notes from git history JOINed with
 * attestations. Same fixture rules as the other suites: isolated repos in
 * os.tmpdir(), neutralized git config, no network, no real agents.
 */

interface Fixture {
  fx: FixtureRepo;
  baseSha: string;
  featSha: string;
  fixSha: string;
  humanSha: string;
  driftSha: string;
}

/**
 * Base commit tagged v1.0.0, then four commits:
 *  - feat with a passing attestation        -> agent, tests: passed
 *  - fix  with a failing attestation        -> agent, tests: FAILED
 *  - chore human commit (no trailers)       -> human
 *  - feat with a Claude trailer, no attest  -> unknown
 */
function buildFixture(): Fixture {
  const fx = makeFixtureRepo();
  const baseSha = scaffold(fx);
  fx.gitOk(["tag", "v1.0.0"]);

  const keygen = fx.runCli(["keygen"]);
  assert.equal(keygen.status, 0, keygen.stderr);
  const prompt = join(fx.tmp, "prompt.txt");
  writeFileSync(prompt, DEFAULT_PROMPT);

  const featSha = fx.commitFiles({ "src/tokens.js": "export const tokens = 1;\n" }, "feat: add session tokens");
  const featCreate = fx.runCli([
    "create",
    "--commit",
    featSha,
    "--agent",
    "test-agent",
    "--prompt-file",
    prompt,
    "--verification",
    "node pass.js",
  ]);
  assert.equal(featCreate.status, 0, featCreate.stderr);

  const fixSha = fx.commitFiles({ "src/expiry.js": "export const expiry = 1;\n" }, "fix: validate token expiry");
  const fixCreate = fx.runCli([
    "create",
    "--commit",
    fixSha,
    "--agent",
    "test-agent",
    "--prompt-file",
    prompt,
    "--verification",
    "node fail.js",
  ]);
  assert.equal(fixCreate.status, 0, fixCreate.stderr);

  const humanSha = fx.commitFiles({ "docs/notes.md": "notes\n" }, "chore: update docs");

  const driftSha = fx.commitFiles(
    { "src/drift.js": "export const drift = 1;\n" },
    "feat: unattended drift\n\nSome body text.\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
  );

  return { fx, baseSha, featSha, fixSha, humanSha, driftSha };
}

test("changelog markdown: buckets, groups, agent annotations, warning banner, deterministic", (t) => {
  const f = buildFixture();
  t.after(() => f.fx.cleanup());

  const r = f.fx.runCli(["changelog"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // header + summary + trust line
  assert.match(r.stdout, /# Changelog — repo/);
  assert.match(r.stdout, /Range: v1\.0\.0\.\.HEAD — 4 commits: 2 agent \(50% with passing-test attestations\), 1 human, 1 unknown\/unattested-agent/);
  assert.match(r.stdout, /attestation coverage: 67% of agent commits, 50% of all commits/);

  // groups in order Features -> Fixes -> Changes, entries oldest first
  const iFeatures = r.stdout.indexOf("## Features");
  const iFixes = r.stdout.indexOf("## Fixes");
  const iChanges = r.stdout.indexOf("## Changes");
  const iUnknown = r.stdout.indexOf("## Unattested agent commits");
  assert.ok(iFeatures > -1 && iFixes > iFeatures && iChanges > iFixes && iUnknown > iChanges, "section order");
  assert.match(r.stdout, /- feat: add session tokens \[agent: test-agent, tests: passed\]/);
  assert.match(r.stdout, /- fix: validate token expiry \[agent: test-agent, tests: FAILED\]/);
  assert.match(r.stdout, /- chore: update docs\n/);
  assert.doesNotMatch(r.stdout, /- chore: update docs \[/, "human entries carry no annotation");

  // unknown-warning banner names the trailer commit and the trailer itself
  assert.ok(iUnknown > -1);
  assert.match(r.stdout, /WARNING: these commits carry agent trailers but no signed attestation/);
  assert.match(r.stdout, /- feat: unattended drift \([0-9a-f]{7}\) — Co-Authored-By: Claude <noreply@anthropic\.com>/);

  // deterministic: identical bytes on a second run
  const r2 = f.fx.runCli(["changelog"]);
  assert.equal(r2.stdout, r.stdout);
});

test("changelog json: parses and classifies all four commits correctly", (t) => {
  const f = buildFixture();
  t.after(() => f.fx.cleanup());

  const r = f.fx.runCli(["changelog", "--format", "json"]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);

  assert.equal(parsed.repo, "repo");
  assert.equal(parsed.range, "v1.0.0..HEAD");
  assert.deepEqual(parsed.summary, { total: 4, agent: 2, human: 1, unknown: 1, agentWithPassingTests: 1 });
  assert.deepEqual(parsed.coverage, { ofAgentAttributable: 67, ofAll: 50 });
  assert.equal(parsed.commits.length, 4);

  const by = Object.fromEntries(parsed.commits.map((c: any) => [c.sha, c]));
  assert.equal(by[f.featSha].classification, "agent");
  assert.equal(by[f.featSha].group, "features");
  assert.equal(by[f.featSha].agent, "test-agent");
  assert.equal(by[f.featSha].tests, "passed");
  assert.equal(by[f.featSha].verificationSource, "executed");
  assert.equal(by[f.featSha].signatureValid, true);
  assert.equal(by[f.fixSha].classification, "agent");
  assert.equal(by[f.fixSha].group, "fixes");
  assert.equal(by[f.fixSha].tests, "FAILED");
  assert.equal(by[f.fixSha].signatureValid, true);
  assert.equal(by[f.humanSha].classification, "human");
  assert.equal(by[f.humanSha].group, "changes");
  assert.equal(by[f.humanSha].agent, undefined);
  assert.equal(by[f.driftSha].classification, "unknown");
  assert.equal(by[f.driftSha].group, "features");
  assert.match(by[f.driftSha].trailer, /Co-Authored-By: Claude/i);
});

test("changelog --range override narrows the set", (t) => {
  const f = buildFixture();
  t.after(() => f.fx.cleanup());

  const r = f.fx.runCli(["changelog", "--range", `${f.featSha}..HEAD`]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Range: [0-9a-f]{40}\.\.HEAD — 3 commits: 1 agent \(0% with passing-test attestations\), 1 human, 1 unknown\/unattested-agent/);
  assert.doesNotMatch(r.stdout, /feat: add session tokens/, "the feat commit is the range base — excluded");
  assert.match(r.stdout, /fix: validate token expiry/);
  assert.match(r.stdout, /attestation coverage: 50% of agent commits, 33% of all commits/);

  // invalid range is a usage error (exit 2), like gate
  const bad = f.fx.runCli(["changelog", "--range", "does-not-exist..alsonot"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /git log failed/);
});

test("changelog default range without a tag falls back to the last 30 commits", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  fx.commitFiles({ "docs/a.md": "a\n" }, "docs: a");
  fx.commitFiles({ "docs/b.md": "b\n" }, "docs: b");

  const r = fx.runCli(["changelog", "--format", "json"]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.range, "last 30 commits (no tag found)");
  assert.equal(parsed.summary.total, 3);
  assert.deepEqual(
    parsed.commits.map((c: any) => c.classification),
    ["human", "human", "human"],
  );
});

test("changelog on a repo with no attestations: all human, no crash", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx); // no keygen, no .agent-attest/attestations directory at all
  fx.commitFiles({ "docs/readme.md": "hi\n" }, "docs: readme");

  const r = fx.runCli(["changelog"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2 commits: 0 agent \(n\/a with passing-test attestations\), 2 human, 0 unknown\/unattested-agent/);
  assert.match(r.stdout, /attestation coverage: n\/a of agent commits, 0% of all commits/);
  assert.doesNotMatch(r.stdout, /## Unattested agent commits/);
  assert.doesNotMatch(r.stdout, /\[agent:/);
});

test("changelog --md-out writes the markdown file; --include-unknown drops only the warning", (t) => {
  const f = buildFixture();
  t.after(() => f.fx.cleanup());

  const out = f.fx.path("CHANGELOG.md");
  const r = f.fx.runCli(["changelog", "--md-out", out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(out), "md file written");
  const written = readFileSync(out, "utf8");
  assert.match(written, /# Changelog — repo/);
  assert.match(written, /WARNING: these commits carry agent trailers/);
  assert.match(written, /## Unattested agent commits/);
  assert.match(r.stdout, /changelog written: /);

  const r2 = f.fx.runCli(["changelog", "--include-unknown"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.doesNotMatch(r2.stdout, /WARNING/);
  assert.match(r2.stdout, /## Unattested agent commits/, "unknowns stay visible");
  assert.match(r2.stdout, /- feat: unattended drift/);

  // --md-out with json is a usage error
  const r3 = f.fx.runCli(["changelog", "--format", "json", "--md-out", out]);
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /--md-out requires --format markdown/);
});

test("changelog reports INVALID signature while still surfacing readable predicates", (t) => {
  const f = buildFixture();
  t.after(() => f.fx.cleanup());

  // feat: flip a byte inside the signed payload (breaks digest + signature).
  // The predicate stays raw-parseable, so the entry still reports agent/tests
  // — flagged signature: INVALID because none of it can be trusted.
  const featPath = f.fx.path(`.agent-attest/attestations/${f.featSha}.attestation.json`);
  const env = JSON.parse(readFileSync(featPath, "utf8"));
  const bytes = Buffer.from(env.payload, "base64");
  bytes[3] = bytes[3]! ^ 0xff;
  env.payload = bytes.toString("base64");
  writeFileSync(featPath, JSON.stringify(env, null, 2) + "\n");

  // fix: replace the attestation with garbage — nothing is readable anymore.
  const fixPath = f.fx.path(`.agent-attest/attestations/${f.fixSha}.attestation.json`);
  writeFileSync(fixPath, "{not json at all");

  const r = f.fx.runCli(["changelog"]);
  assert.equal(r.status, 0, "changelog reports validity, it does not require it");
  assert.match(r.stdout, /- feat: add session tokens \[agent: test-agent, tests: passed, signature: INVALID\]/);
  assert.match(r.stdout, /- fix: validate token expiry \[agent: \?, tests: unverified, signature: INVALID\]/);
  assert.match(r.stdout, /4 commits: 2 agent/);

  const rj = f.fx.runCli(["changelog", "--format", "json"]);
  const parsed = JSON.parse(rj.stdout);
  const feat = parsed.commits.find((c: any) => c.sha === f.featSha);
  assert.equal(feat.classification, "agent");
  assert.equal(feat.signatureValid, false);
  assert.equal(feat.agent, "test-agent");
  const fix = parsed.commits.find((c: any) => c.sha === f.fixSha);
  assert.equal(fix.signatureValid, false);
  assert.equal(feat.tests, "passed");
  assert.equal(fix.tests, "unverified");
  assert.equal(fix.agent, "?");
});

test("changelog -h shows usage and exits 0", (t) => {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  const r = fx.runCli(["changelog", "-h"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: agent-attest changelog/);
  assert.match(r.stdout, /--md-out/);
  assert.match(r.stdout, /--include-unknown/);
  assert.match(r.stdout, /most recent tag\.\.HEAD/);
  assert.match(r.stdout, /last 30 commits/);
});
