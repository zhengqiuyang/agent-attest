import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAttestation } from "../attest.js";
import { fetchGitHubCommits, FetchLike, runGate } from "../gate.js";
import { keygen } from "../keys.js";
import { DEFAULT_PROMPT, scaffold, makeFixtureRepo, FixtureRepo } from "./helpers.js";

/**
 * GitHub Actions mode is exercised with an injectable fetch — no network,
 * ever. The commits are real (created in the fixture repo) so `create` works,
 * while the API responses are faked.
 */

interface Routes {
  [url: string]: unknown;
}

function fakeFetch(routes: Routes): FetchLike {
  return async (url) => {
    const key = url.replace("https://api.github.com", "");
    if (Object.prototype.hasOwnProperty.call(routes, key)) {
      const data = routes[key];
      return { ok: true, status: 200, json: async () => data };
    }
    return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
  };
}

async function prepare(t: { after(fn: () => void): void }): Promise<{ fx: FixtureRepo; shaA: string; shaB: string }> {
  const fx = makeFixtureRepo();
  t.after(() => fx.cleanup());
  scaffold(fx);
  await keygen(fx.root);
  const prompt = join(fx.tmp, "prompt.txt");
  writeFileSync(prompt, DEFAULT_PROMPT);
  const shaA = fx.commitFiles({ "src/app.js": "export const app = 1;\n" }, "feat: app (agent)");
  const shaB = fx.commitFiles({ "src/bad.js": "export const bad = 1;\n" }, "feat: bad (agent, unattested)");
  await createAttestation(fx.root, {
    commit: shaA,
    agent: "claude-code",
    promptFile: prompt,
    verification: "node pass.js",
  });
  return { fx, shaA, shaB };
}

test("actions mode: commits and files come from the API (injectable fetch)", async (t) => {
  const { fx, shaA, shaB } = await prepare(t);
  const routes: Routes = {
    "/repos/acme/widget/pulls/7/commits?per_page=100": [
      { sha: shaB, commit: { message: "feat: bad (agent, unattested)" } },
      { sha: shaA, commit: { message: "feat: app (agent)" } },
    ],
    "/repos/acme/widget/pulls/7/files?per_page=100": [{ filename: "src/app.js" }, { filename: "src/bad.js" }],
    [`/repos/acme/widget/commits/${shaA}`]: { files: [{ filename: "src/app.js" }] },
    [`/repos/acme/widget/commits/${shaB}`]: { files: [{ filename: "src/bad.js" }] },
  };

  const result = await runGate(fx.root, {
    kind: "github",
    owner: "acme",
    repo: "widget",
    prNumber: 7,
    token: "fake-token",
    fetchImpl: fakeFetch(routes),
  });

  assert.equal(result.exitCode, 1, "shaB is unattested and touches src/**");
  assert.deepEqual(
    result.findings.map((f) => [f.status, f.commit.slice(0, 8)]),
    [
      ["ok", shaA.slice(0, 8)],
      ["missing", shaB.slice(0, 8)],
    ],
  );
  assert.equal(result.summary.skipped, 0);
  assert.equal(result.findings[0]!.agent, "claude-code");
});

test("actions mode: override trailer in the API commit message becomes a listed warning", async (t) => {
  const { fx, shaA, shaB } = await prepare(t);
  const routes: Routes = {
    "/repos/acme/widget/pulls/7/commits?per_page=100": [
      {
        sha: shaB,
        commit: { message: "feat: bad\n\nagent-attest-override: emergency hotfix, backfill tomorrow" },
      },
      { sha: shaA, commit: { message: "feat: app (agent)" } },
    ],
    "/repos/acme/widget/pulls/7/files?per_page=100": [{ filename: "src/app.js" }, { filename: "src/bad.js" }],
    [`/repos/acme/widget/commits/${shaA}`]: { files: [{ filename: "src/app.js" }] },
    [`/repos/acme/widget/commits/${shaB}`]: { files: [{ filename: "src/bad.js" }] },
  };

  const result = await runGate(fx.root, {
    kind: "github",
    owner: "acme",
    repo: "widget",
    prNumber: 7,
    fetchImpl: fakeFetch(routes),
  });
  assert.equal(result.exitCode, 0, "override downgrades to warning");
  const overridden = result.findings.find((f) => f.commit === shaB);
  assert.equal(overridden!.status, "overridden");
  assert.equal(overridden!.level, "warning");
  assert.equal(overridden!.overrideReason, "emergency hotfix, backfill tomorrow");
});

test("actions mode: per-commit file endpoint failure falls back to PR-level files", async (t) => {
  const { fx, shaA, shaB } = await prepare(t);
  const routes: Routes = {
    "/repos/acme/widget/pulls/7/commits?per_page=100": [{ sha: shaB, commit: { message: "feat: bad" } }],
    "/repos/acme/widget/pulls/7/files?per_page=100": [{ filename: "src/bad.js" }, { filename: "docs/x.md" }],
    // no commits/{sha} route -> 404 -> fallback
  };
  const result = await runGate(fx.root, {
    kind: "github",
    owner: "acme",
    repo: "widget",
    prNumber: 7,
    fetchImpl: fakeFetch(routes),
  });
  assert.equal(result.exitCode, 1, "PR-level files still contain src/bad.js");
  assert.equal(result.findings[0]!.status, "missing");
  assert.deepEqual(result.findings[0]!.protectedFiles, ["src/bad.js"]);
});

test("actions mode: API failure surfaces as an error", async (t) => {
  const { fx } = await prepare(t);
  const failing: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    () =>
      runGate(fx.root, {
        kind: "github",
        owner: "acme",
        repo: "widget",
        prNumber: 7,
        fetchImpl: failing,
      }),
    /401/,
  );
});

test("fetchGitHubCommits orders commits oldest-first and prefers per-commit files", async () => {
  const sha1 = "1".repeat(40);
  const sha2 = "2".repeat(40);
  const routes: Routes = {
    "/repos/o/r/pulls/3/commits?per_page=100": [
      { sha: sha2, commit: { message: "second" } },
      { sha: sha1, commit: { message: "first" } },
    ],
    "/repos/o/r/pulls/3/files?per_page=100": [{ filename: "pr-level.js" }],
    [`/repos/o/r/commits/${sha1}`]: { files: [{ filename: "from-commit-one.js" }] },
    [`/repos/o/r/commits/${sha2}`]: { files: [{ filename: "from-commit-two.js" }] },
  };
  const commits = await fetchGitHubCommits({
    kind: "github",
    owner: "o",
    repo: "r",
    prNumber: 3,
    fetchImpl: fakeFetch(routes),
  });
  assert.deepEqual(commits.map((c) => c.sha), [sha1, sha2]);
  assert.deepEqual(commits[0]!.files, ["from-commit-one.js"]);
  assert.deepEqual(commits[1]!.files, ["from-commit-two.js"]);
});
