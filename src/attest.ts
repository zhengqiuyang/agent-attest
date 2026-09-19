import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { runShellCommand } from "./exec.js";
import { resolveCommit } from "./git.js";
import {
  assertPrivateKeyNotTracked,
  loadKeyMaterial,
  loadPublicKey,
  privateKeyPathFor,
} from "./keys.js";
import {
  AttestationStatement,
  Envelope,
  buildStatement,
  parseEnvelope,
  sha256Hex,
  signStatement,
  verifyEnvelope,
} from "./statement.js";
import { errorMessage, readTextNormalized, toPosix } from "./util.js";

export const ATTEST_DIR = ".agent-attest";
export const ATTESTATIONS_SUBDIR = "attestations";

export function attestationsDir(root: string): string {
  return join(root, ATTEST_DIR, ATTESTATIONS_SUBDIR);
}

/** Deterministic filename: <commit-sha>.attestation.json */
export function attestationPath(root: string, commit: string): string {
  return join(attestationsDir(root), `${commit.toLowerCase()}.attestation.json`);
}

export function attestationRelPath(root: string, commit: string): string {
  return toPosix(relative(root, attestationPath(root, commit)));
}

export function listAttestationFiles(root: string): string[] {
  const dir = attestationsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".attestation.json"))
    .sort()
    .map((f) => join(dir, f));
}

export interface CreateOptions {
  /** Commit the agent run produced (may be a short sha; resolved via git). */
  commit: string;
  agent: string;
  /** The agent command line — recorded for the audit trail, never executed. */
  agentCommand?: string;
  promptFile: string;
  /** Verification command line; executed in the repo root unless overridden. */
  verification: string;
  /** Claim the result instead of executing (recorded with source "claimed"). */
  verificationPassed?: boolean;
  metaFile?: string;
  exitCode?: number;
  startedAt?: string;
  endedAt?: string;
  /** Injectable timestamps (tests). */
  signedAt?: string;
  ranAt?: string;
}

export interface CreateOutcome {
  commit: string;
  path: string;
  statement: AttestationStatement;
  envelope: Envelope;
  verification: {
    command: string;
    passed: boolean;
    source: "executed" | "claimed";
    ranAt: string;
    durationMs: number;
    exitCode?: number;
  };
}

/**
 * Build, sign, and write the attestation for one commit.
 * The verification command is executed for real unless --verification-passed
 * claims the result (recorded with source "claimed" so --recheck can catch lies).
 */
export async function createAttestation(root: string, opts: CreateOptions): Promise<CreateOutcome> {
  if (opts.agent.trim().length === 0) throw new Error("--agent must not be empty");
  if (opts.verification.trim().length === 0) throw new Error("--verification must not be empty");

  const sha = await resolveCommit(root, opts.commit);
  if (!sha) {
    throw new Error(`commit "${opts.commit}" not found in repository history — agent-attest only attests commits that exist`);
  }
  if (!existsSync(opts.promptFile)) throw new Error(`prompt file not found: ${opts.promptFile}`);
  const promptSha256 = sha256Hex(readFileSync(opts.promptFile));

  const material = loadKeyMaterial(root);
  await assertPrivateKeyNotTracked(root, material.privatePath);

  const ranAt = opts.ranAt ?? new Date().toISOString();
  let passed: boolean;
  let source: "executed" | "claimed";
  let durationMs = 0;
  let verificationExitCode: number | undefined;
  if (opts.verificationPassed !== undefined) {
    passed = opts.verificationPassed;
    source = "claimed";
  } else {
    const run = await runShellCommand(opts.verification, root);
    passed = run.passed;
    source = "executed";
    durationMs = run.durationMs;
    verificationExitCode = run.exitCode;
  }

  let metadata: Record<string, unknown> = {};
  if (opts.metaFile !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readTextNormalized(opts.metaFile));
    } catch (err) {
      throw new Error(`--meta file "${opts.metaFile}" is not valid JSON: ${errorMessage(err)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`--meta file "${opts.metaFile}" must contain a JSON object`);
    }
    metadata = parsed as Record<string, unknown>;
  }

  const endedMs = parseIsoOr(opts.endedAt, Date.now(), "--ended-at");
  const startedMs = parseIsoOr(opts.startedAt, endedMs, "--started-at");

  const statement = buildStatement({
    repoName: basename(root),
    commit: sha,
    agent: opts.agentCommand ? { name: opts.agent, command: opts.agentCommand } : { name: opts.agent },
    run: {
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
      durationMs: Math.max(0, endedMs - startedMs),
      promptSha256,
      exitCode: opts.exitCode ?? 0,
    },
    verification: {
      command: opts.verification,
      passed,
      ranAt,
      source,
      ...(verificationExitCode !== undefined ? { exitCode: verificationExitCode } : {}),
    },
    commits: [sha],
    metadata,
  });

  const envelope = signStatement(statement, {
    privatePem: material.privatePem,
    keyid: material.keyid,
    signedAt: opts.signedAt,
  });

  mkdirSync(attestationsDir(root), { recursive: true });
  const path = attestationPath(root, sha);
  writeFileSync(path, JSON.stringify(envelope, null, 2) + "\n");

  return {
    commit: sha,
    path,
    statement,
    envelope,
    verification: { command: opts.verification, passed, source, ranAt, durationMs, exitCode: verificationExitCode },
  };
}

function parseIsoOr(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`${label} is not a valid ISO timestamp: "${value}"`);
  return t;
}

const FILENAME_RE = /^([0-9a-fA-F]{40})\.attestation\.json$/;

export interface RecheckResult {
  command: string;
  recordedPassed: boolean;
  rerunPassed: boolean;
  rerunExitCode: number;
  agrees: boolean;
}

export interface VerifyFileResult {
  ok: boolean;
  reason?: string;
  commitFromFilename?: string;
  statement?: AttestationStatement;
  signedAt?: string;
  recheck?: RecheckResult;
}

export interface VerifyFileOptions {
  recheck?: boolean;
  /** Skip the "commit exists in local history" check (GitHub Actions mode / report). */
  checkCommitExists?: boolean;
}

/**
 * Verify one attestation file:
 *  - filename is <40-hex-sha>.attestation.json and binds to the subject
 *  - envelope digest + ed25519 signature validate with the repo public key
 *  - the commit exists in local history (unless disabled)
 *  - with recheck: the recorded verification command is re-run and must agree
 */
export async function verifyAttestationFile(
  root: string,
  filePath: string,
  options: VerifyFileOptions = {},
): Promise<VerifyFileResult> {
  const base = basename(filePath);
  const m = base.match(FILENAME_RE);
  if (!m) {
    return { ok: false, reason: `unexpected attestation filename "${base}" (expected <40-hex-sha>.attestation.json)` };
  }
  const commit = m[1]!.toLowerCase();
  const fail = (reason: string): VerifyFileResult => ({ ok: false, reason, commitFromFilename: commit });

  let envelope: Envelope;
  try {
    envelope = parseEnvelope(readTextNormalized(filePath));
  } catch (err) {
    return fail(errorMessage(err));
  }

  let publicPem: string;
  try {
    publicPem = loadPublicKey(root).publicPem;
  } catch (err) {
    return fail(errorMessage(err));
  }

  const v = verifyEnvelope(envelope, publicPem);
  if (!v.ok || !v.statement) return fail(v.reason ?? "envelope failed verification");
  const statement = v.statement;

  const subjectCommit = statement.subject[0]?.digest?.gitCommit?.toLowerCase();
  if (subjectCommit !== commit) {
    return fail(
      `subject digest gitCommit ${subjectCommit ?? "(missing)"} does not match attestation filename ${commit} — ` +
        `attestation was renamed or built for another commit`,
    );
  }

  if (options.checkCommitExists !== false) {
    const exists = await resolveCommit(root, commit);
    if (!exists) return fail(`commit ${commit} not found in local git history`);
  }

  let recheck: RecheckResult | undefined;
  if (options.recheck) {
    const cmd = statement.predicate.verification.command;
    const rerun = await runShellCommand(cmd, root);
    const agrees = rerun.passed === statement.predicate.verification.passed;
    recheck = {
      command: cmd,
      recordedPassed: statement.predicate.verification.passed,
      rerunPassed: rerun.passed,
      rerunExitCode: rerun.exitCode,
      agrees,
    };
    if (!agrees) {
      return fail(
        `verification re-check disagrees: recorded passed=${statement.predicate.verification.passed} ` +
          `but re-running "${cmd}" exited ${rerun.exitCode} (passed=${rerun.passed})`,
      );
    }
  }

  return { ok: true, commitFromFilename: commit, statement, signedAt: envelope.signedAt, recheck };
}

export interface VerifyAllResult {
  results: VerifyFileResult[];
  files: string[];
}

/** Verify one commit's attestation or every attestation in the repo. */
export async function verifyAll(
  root: string,
  options: { commit?: string; recheck?: boolean } = {},
): Promise<VerifyAllResult> {
  if (options.commit !== undefined) {
    const resolved = (await resolveCommit(root, options.commit)) ?? options.commit.toLowerCase();
    const path = attestationPath(root, resolved);
    if (!existsSync(path)) {
      const reason = (await resolveCommit(root, resolved))
        ? `no attestation found for commit ${resolved} (expected ${attestationRelPath(root, resolved)})`
        : `commit ${resolved} not found in local git history`;
      return { results: [{ ok: false, commitFromFilename: resolved, reason }], files: [path] };
    }
    return { results: [await verifyAttestationFile(root, path, options)], files: [path] };
  }
  const files = listAttestationFiles(root);
  const results: VerifyFileResult[] = [];
  for (const f of files) results.push(await verifyAttestationFile(root, f, options));
  return { results, files };
}

export { privateKeyPathFor };
