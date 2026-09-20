# agent-attest

**Signed chain-of-custody for work produced by AI coding agents — attested at run time, verified against git history, enforced as a CI gate, exported as a compliance inventory.**

Built on standard shapes ([in-toto](https://in-toto.io) Statement v1) and standard crypto (ed25519 via `node:crypto`). No bespoke scheme, one runtime dependency (`yaml`).

---

## The problem: the headless bypass lane

Coding agents no longer sit behind a human on every commit. Claude Code Routines, cron-driven schedulers, and autonomous pipelines push commits **directly to branches** — no PR, no review, no record. When you later look at such a commit, nothing answers the questions that matter:

- **Which agent** produced this commit, and from what prompt?
- **Did its tests actually pass**, or did it just claim they did?
- Who says so, and can you prove it later?

In our September 2026 research across teams adopting headless agents, **92%** named "no verifiable record of what the agent ran and whether its checks passed" as a top governance pain — and it is exactly the gap that **SOC 2 CC8.1** (change management) and the **EU AI Act** logging expectations (Art. 12) run into when the "developer" is a scheduled process.

The surrounding ecosystem watches but does not gate:

- **GitHub signs Copilot commits** (April 2026) — but does not *gate* on agent provenance, and only for Copilot.
- **Brain0** observes agent commits — passive, no enforcement.
- **git-ai** attributes lines to agents — but signs nothing and captures no test evidence.

`agent-attest` is the thin layer that closes the loop: **the attestation is written at headless-run time, verified against git history, and enforced as a CI gate on protected paths.**

## What it does

1. **Attest** — after a headless run, `agent-attest create` records the agent, prompt hash, run window, and *actually executes* the verification command, recording the real result. The signed attestation is committed next to the code, keyed deterministically to the commit.
2. **Verify** — `agent-attest verify` checks the signature, the subject-to-filename binding, and history membership. `--recheck` re-runs the recorded verification command so a "claimed" result that lies gets caught.
3. **Gate** — `agent-attest gate` is the teeth: any commit touching a protected path without a valid, passing attestation fails CI. The override trailer exists but is never silent.
4. **Report** — `agent-attest report` produces the compliance inventory (markdown for humans, JSON for GRC tooling).
5. **Changelog** — `agent-attest changelog` turns git history JOINed with attestations into deterministic release notes: who made each commit (agent vs human), whether the agent's tests passed, and what remains unattested.

## Install

```bash
npm install -g agent-attest
# or run ad hoc:
npx agent-attest --help
```

Requires Node >= 20. No network is used at runtime.

## Quickstart

```bash
# one-time per repo: generate the signing keypair
agent-attest keygen
# -> .agent-attest/keys/private.pem  (0600, gitignored — NEVER commit)
# -> .agent-attest/keys/public.pem   (commit this so CI can verify)

# commit the public key
git add .agent-attest/keys/public.pem .gitignore && git commit -m "chore: agent-attest signing key"

# after a headless agent run produces commit <sha>:
agent-attest create \
  --commit <sha> \
  --agent claude-code \
  --command "claude -p 'Implement session tokens' --output-format json" \
  --prompt-file /tmp/run-prompt.txt \
  --verification "npm test"

git add .agent-attest/attestations && git commit -m "attest: <sha> by claude-code"

# any time later (locally or in CI):
agent-attest verify
agent-attest gate --range origin/main..HEAD
agent-attest report
```

## The format

### Statement (in-toto Statement v1)

The signed payload is a canonicalized [in-toto](https://github.com/in-toto/attestation) statement with an `agent-run/v1` predicate:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    { "name": "widget", "digest": { "gitCommit": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } }
  ],
  "predicateType": "https://agent-attest.dev/attestations/agent-run/v1",
  "predicate": {
    "agent": { "name": "claude-code", "command": "claude -p 'Implement session tokens'" },
    "run": {
      "startedAt": "2026-09-20T02:40:12.000Z",
      "endedAt": "2026-09-20T02:41:03.000Z",
      "durationMs": 51000,
      "promptSha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "exitCode": 0
    },
    "verification": {
      "command": "npm test",
      "passed": true,
      "ranAt": "2026-09-20T02:41:05.000Z",
      "source": "executed",
      "exitCode": 0
    },
    "commits": ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    "metadata": { "objective": "implement session-token auth", "scheduledBy": "cron:nightly" }
  }
}
```

- `verification.source` is `"executed"` when agent-attest ran the command itself, or `"claimed"` when `--verification-passed` overrode it. Tools downstream can treat claims with suspicion.
- The prompt is **not** stored — only `promptSha256`, so you can prove which prompt produced the work without leaking its contents into the repo.

### Canonicalization and envelope

Canonicalization is a stable JSON encoding: object keys recursively sorted, no whitespace, `undefined` dropped. The canonical UTF-8 bytes are the unit of both hashing and signing:

```
statement -> canonicalJson -> utf8 bytes
   payload        = base64(bytes)
   payloadDigest  = { sha256: hex(sha256(bytes)) }
   signatures     = [{ keyid, sig: base64(ed25519_sign(bytes)) }]
```

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEiLC4uLn0=",
  "payloadDigest": { "sha256": "9f2c…64 hex…" },
  "signatures": [{ "keyid": "1a2b3c4d5e6f7081", "sig": "…base64…" }],
  "signedAt": "2026-09-20T02:41:06.000Z"
}
```

The envelope lives at `.agent-attest/attestations/<commit-sha>.attestation.json` — the filename binds the attestation to the commit it claims to describe, and `verify` rejects any mismatch.

### keyid

`keyid = sha256(SPKI DER of the public key), first 16 hex chars`. Verification requires a signature from exactly the key you check with; attestations signed by any other key fail with an explicit reason.

## Key management and threat model

**Layout.** `keygen` writes `private.pem` (mode 0600) and `public.pem` under `.agent-attest/keys/`, adds that directory to `.gitignore`, and **refuses to operate if the private key is tracked by git** — a tracked private key hands every repo reader forge capability over the entire attestation chain. CI can inject keys via file paths:

```bash
export AGENT_ATTEST_PRIVATE_KEY=/path/to/private.pem
export AGENT_ATTEST_PUBLIC_KEY=/path/to/public.pem
```

**What this gives you, honestly:**

| Threat | Coverage |
|---|---|
| "Nobody knows what produced this commit" | Solved: signed agent/prompt-hash/exit-code recorded at run time, bound to the commit. |
| Agent claims tests passed but they did not | Solved by default: `create` executes the verification command and records the real result. `verify --recheck` re-runs it later and fails on any disagreement with the record. |
| Post-hoc tampering with an attestation | Solved: any payload edit breaks the digest and the ed25519 signature; renaming breaks the subject-filename binding. |
| Silent override abuse | Solved by design: the `agent-attest-override: <reason>` trailer never suppresses a finding — it downgrades it to a **listed warning** in every output format. Overrides are auditable, never invisible. |
| Private key compromise | **Known limit.** Whoever holds the key can forge attestations. Mitigations: 0600 perms, gitignore + tracked-key refusal, hold the key in CI (env paths), and the roadmap moves to Sigstore keyless signing to eliminate long-lived keys entirely. |
| Malicious agent with signing key | Not solvable client-side. The gate still forces the recorded verification to have passed, and `gate --recheck` re-executes it in CI (only enable this where attestation contents are trusted — it runs commands from the repo being gated). |
| Bad code that passes tests | Not solved — attestations prove *process*, not *quality*. This complements review; it does not replace it. |

## Commands

```
agent-attest keygen   [--dir <keysDir>]
agent-attest create   --commit <sha> --agent <name> --prompt-file <file> --verification "<cmd>"
                      [--command <agent cmdline>] [--verification-passed true|false]
                      [--meta meta.json] [--exit-code <n>] [--started-at <iso>] [--ended-at <iso>]
agent-attest verify   [--commit <sha>] [--recheck]
agent-attest gate     [--range <base>..<head> | --commits <file> [--files <map.json>]]
                      [--recheck] [--format console|json|github]
agent-attest report   [--format markdown|json]
agent-attest changelog [--range <base>..<head>] [--format markdown|json]
                      [--md-out <file>] [--include-unknown]
```

Global exit codes: **0** pass · **1** findings / invalid attestations · **2** usage or config error.

Notes:

- `create` executes `--verification` in the repo root and records the real exit code (source `"executed"`). A failed verification still writes the attestation — the record is the point — and prints a warning; the gate will block that commit. `--verification-passed true|false` skips execution and records a claim (source `"claimed"`).
- `verify` checks every `.agent-attest/attestations/*.attestation.json`: digest, signature, subject-filename binding, history membership.
- `gate` fails (exit 1) when a commit touches a protected path with no attestation, an invalid one, or one whose recorded verification failed. Commits that touch no protected path are ignored. Exit 2 means config/usage problems, never "findings".

## Deterministic changelog with attestation provenance

`agent-attest changelog` builds release notes from git history **joined to the signed attestations** — attribution trailers alone are a 10-line git-cliff config; the unowned part is chaining every entry to test evidence. Each commit is classified **agent** (attestation exists: agent name, `tests: passed|FAILED|unverified`, `source: claimed`, `signature: INVALID` reported, never assumed), **human** (no attestation, no agent trailer), or **unknown** (agent trailer without an attestation — always listed under a warning heading; `--include-unknown` drops only the warning). Entries group by conventional-commit prefix (`feat!`/`feat` → Features, `fix` → Fixes, rest → Changes), oldest first, and the default range is the most recent tag (`git describe --abbrev=0 --tags`)..HEAD, or the last 30 commits when no tag exists. Fully deterministic — no LLM, no network, no timestamps — and `--format json` emits the full entry objects for tooling.

```markdown
# Changelog — repo

Range: v1.0.0..HEAD — 4 commits: 2 agent (50% with passing-test attestations), 1 human, 1 unknown/unattested-agent
attestation coverage: 67% of agent commits, 50% of all commits

## Features
- feat: add session tokens [agent: claude-code, tests: passed]

## Fixes
- fix: validate token expiry [agent: claude-code, tests: FAILED]

## Changes
- chore: update docs

## Unattested agent commits

WARNING: these commits carry agent trailers but no signed attestation — run `agent-attest create` for them (shown always; --include-unknown suppresses this warning):
- feat: unattended drift (9d7a978) — Co-Authored-By: Claude <noreply@anthropic.com>
```

## Gate configuration — `agent-attest.yaml`

```yaml
protectedPaths:            # glob patterns ( supports **, *, ?; / separators, Windows-safe )
  - "src/**"
  - "infra/**"
requireVerificationPassed: true   # attestations with passed=false fail the gate
allowOverrideTrailer: true        # honor the agent-attest-override trailer (as listed warnings)
```

### Commit sources (first match wins)

1. `--commits <file>` — fixture/advanced mode: one 40-hex sha per line (`#` comments ok). Optional `--files <map.json>`: JSON mapping sha → changed paths; otherwise paths are read from git.
2. `--range <base>..<head>` — local mode: commits in `git rev-list base..head`.
3. **GitHub Actions mode** — when `GITHUB_EVENT_PATH` holds a `pull_request` event: commits via `pulls/commits`, PR files via `pulls/files`, per-commit files via `commits/{sha}` (with the PR-level list as a conservative fallback). Uses `GITHUB_TOKEN` when set. Best-effort, single page of 100.

`--format github` emits `::error` / `::warning` workflow annotations so findings appear inline on the PR.

## CI

```yaml
# .github/workflows/agent-attest.yml
name: agent-attest gate
on: [pull_request]

jobs:
  gate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # attestations are checked against history

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Restore signing keys (public for verify; private only if agents attest from CI)
        run: |
          mkdir -p .agent-attest/keys
          printf '%s' "${{ secrets.AGENT_ATTEST_PUBLIC_KEY_PEM }}" > .agent-attest/keys/public.pem

      - name: agent-attest gate
        run: npx agent-attest gate --format github
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For the full flow (agents attest from CI, e.g. scheduled runs), also inject `AGENT_ATTEST_PRIVATE_KEY` / `AGENT_ATTEST_PUBLIC_KEY` as repo secrets and point them at key files. See `scripts/demo.mjs` for the whole loop end-to-end.

## Competitive landscape and kill criteria

We wrote this down so we are honest with ourselves:

- **GitHub native agent provenance** — GitHub signs Copilot commits (Apr 2026) but gates on nothing for third-party agents. **Kill criterion:** if GitHub ships native agent-provenance attestation *and gating* for arbitrary agents (not just Copilot), this project's gate is redundant with the platform — wind it down into a thin adapter for repos that cannot use the native feature.
- **git-ai** (under OpenAI stewardship) — line-level attribution; its spec is moving toward signing. **Kill criterion:** if git-ai ships signing + verification + a CI gate with real adoption, merge our predicate ideas into it and deprecate this repo.
- **Brain0** — observability of agent activity; passive, no enforcement, no crypto. Complementary today, redundant if they add gating.
- **Sigstore / Gitsign** — the right long-term key story; we should adopt it (see roadmap) rather than compete with it.

**Honest window: 6–12 months.** The wedge is enforcement plus standard shapes, not another dashboard. If the platform absorbs the job, this project should dissolve into configuration, not fight for existence. The `predicateType` URL and format spec are designed so attestations remain parseable by generic in-toto tooling even after this repo is gone.

## Roadmap

- **Sigstore keyless signing** (Fulcio/Rekor) — kill the long-lived private key; attestations signed with ephemeral workflow identities.
- **CycloneDX AI-BOM export** — extend `report` to emit the attestation inventory as an AI bill-of-materials for GRC systems.
- **cronagent integration** — scheduled agent runs record job metadata (job name, schedule, prompt template version) automatically at run time.
- **Multi-key policies** — separate author-agent and reviewer-agent signatures; threshold verification.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # build first, then node --test over dist/test/*.test.js
npm run demo    # full walkthrough on a throwaway fixture repo
```

Tests are fixture-driven: isolated git repos in `os.tmpdir()` with neutralized git config (`GIT_CONFIG_NOSYSTEM=1`, empty `GIT_CONFIG_GLOBAL`, injected identity), no network, no real agents. The GitHub Actions path is exercised with an injectable `fetch`. Layout:

```
bin/agent-attest.js      CLI entry (delegates to dist/cli.js)
src/statement.ts         in-toto statement, canonicalization, envelope sign/verify
src/keys.ts              ed25519 keygen/keyid, gitignore + tracked-key refusal
src/attest.ts            create / verify core
src/gate.ts              config, override trailer, commit sources, gate + formatters
src/git.ts               execFile-based git plumbing (Windows-safe, read-only)
src/glob.ts              protected-path matcher
src/report.ts            compliance inventory
src/changelog.ts         deterministic changelog (git history joined with attestations)
src/cli.ts               argument parsing, commands, exit codes
```

## License

[MIT](./LICENSE) — Copyright (c) 2026 agent-attest contributors
