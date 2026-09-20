import { existsSync } from "node:fs";
import { basename } from "node:path";
import { attestationPath, verifyAttestationFile } from "./attest.js";
import { latestTag, logEntries, resolveCommit } from "./git.js";
import { parseEnvelope } from "./statement.js";
import { readTextNormalized } from "./util.js";

/**
 * Deterministic changelog / release notes: git history JOINed with
 * attestations. Every commit in the range is classified
 *   agent   — a signed attestation exists for it (name, verification result,
 *             verification source, signature validity reported, never assumed)
 *   human   — no attestation and no agent trailer
 *   unknown — no attestation but a Co-Authored-By agent trailer is present
 *             (unattested agent work; always listed, never folded away)
 * Entries group by conventional-commit prefix (Features / Fixes / Changes),
 * oldest first. No LLM, no network, no timestamps — same input, same output.
 */

export const DEFAULT_MAX_COMMITS = 30;

export type EntryGroup = "features" | "fixes" | "changes";
export type EntryClassification = "agent" | "human" | "unknown";
export type TestStatus = "passed" | "FAILED" | "unverified";

export interface ChangelogEntry {
  sha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  group: EntryGroup;
  classification: EntryClassification;
  /** Set for agent commits: predicate.agent.name ("?" when unparseable). */
  agent?: string;
  /** Set for agent commits. */
  tests?: TestStatus;
  /** "executed" | "claimed" from the attestation, when readable. */
  verificationSource?: string;
  signatureValid?: boolean;
  signatureReason?: string;
  /** The matched Co-Authored-By trailer line, for unknown commits. */
  trailer?: string;
}

export interface ChangelogSummary {
  total: number;
  agent: number;
  human: number;
  unknown: number;
  agentWithPassingTests: number;
}

export interface ChangelogCoverage {
  /** Share of agent-attributable commits (agent + unknown) that carry an attestation; null when there are none. */
  ofAgentAttributable: number | null;
  /** Share of all commits that carry an attestation; null when the range is empty. */
  ofAll: number | null;
}

export interface ChangelogResult {
  repo: string;
  range: string;
  /** Oldest first. */
  entries: ChangelogEntry[];
  summary: ChangelogSummary;
  coverage: ChangelogCoverage;
}

export interface ChangelogOptions {
  /** Explicit <base>..<head> range. Default: most recent tag..HEAD when a tag exists, else the last 30 commits. */
  range?: string;
  /** Fallback depth when no tag exists (default 30). */
  maxCommits?: number;
}

/** Trailer values from the well-known coding agents, matched case-insensitively. */
const AGENT_NAME_RE = /\b(claude|codex|gemini|copilot)\b/i;

/**
 * Find a `Co-Authored-By:` line naming a known coding agent (Claude, Codex,
 * Gemini, Copilot — case-insensitive). Returns the normalized trailer line,
 * or null when the body has none.
 */
export function findAgentTrailer(body: string): string | null {
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const m = line.match(/^[ \t]*Co-Authored-By:[ \t]*(.*)$/i);
    if (m && m[1] !== undefined && AGENT_NAME_RE.test(m[1])) {
      return `Co-Authored-By: ${m[1].trim()}`;
    }
  }
  return null;
}

/** feat!/feat -> features, fix -> fixes, everything else -> changes. */
export function conventionalGroup(subject: string): EntryGroup {
  const m = subject.match(/^(feat|fix)(\([^)]*\))?[ \t]*![ \t]*:/) ?? subject.match(/^(feat|fix)(\([^)]*\))?[ \t]*:/);
  if (!m) return "changes";
  return m[1] === "feat" ? "features" : "fixes";
}

interface AttestationInfo {
  agent: string | null;
  testsPassed: boolean | null;
  verificationSource: string | null;
  signatureValid: boolean;
  signatureReason?: string;
}

/**
 * Load the attestation for one commit. Signature validity is REPORTED, never
 * required: when the envelope fails verification (or no public key exists)
 * the predicate is still read from the raw payload so the changelog stays
 * useful in checkouts without keys, while flagging what cannot be trusted.
 */
async function loadAttestationInfo(root: string, sha: string): Promise<AttestationInfo | null> {
  const path = attestationPath(root, sha);
  if (!existsSync(path)) return null;

  const check = await verifyAttestationFile(root, path, { checkCommitExists: false });
  if (check.ok && check.statement) {
    const p = check.statement.predicate;
    return {
      agent: p.agent.name,
      testsPassed: p.verification.passed,
      verificationSource: p.verification.source ?? null,
      signatureValid: true,
    };
  }

  let agent: string | null = null;
  let testsPassed: boolean | null = null;
  let verificationSource: string | null = null;
  try {
    const envelope = parseEnvelope(readTextNormalized(path));
    const raw = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
      predicate?: {
        agent?: { name?: unknown };
        verification?: { passed?: unknown; source?: unknown };
      };
    };
    if (typeof raw.predicate?.agent?.name === "string") agent = raw.predicate.agent.name;
    if (typeof raw.predicate?.verification?.passed === "boolean") testsPassed = raw.predicate.verification.passed;
    if (typeof raw.predicate?.verification?.source === "string") verificationSource = raw.predicate.verification.source;
  } catch {
    // unparseable attestation: fields stay null -> agent "?", tests "unverified"
  }
  return { agent, testsPassed, verificationSource, signatureValid: false, signatureReason: check.reason };
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((100 * numerator) / denominator);
}

export async function buildChangelog(root: string, options: ChangelogOptions = {}): Promise<ChangelogResult> {
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  let revArgs: string[];
  let rangeLabel: string;

  if (options.range !== undefined) {
    revArgs = [options.range];
    rangeLabel = options.range;
  } else {
    const head = await resolveCommit(root, "HEAD");
    if (head === null) {
      return {
        repo: basename(root),
        range: "HEAD (repository has no commits)",
        entries: [],
        summary: { total: 0, agent: 0, human: 0, unknown: 0, agentWithPassingTests: 0 },
        coverage: { ofAgentAttributable: null, ofAll: null },
      };
    }
    const tag = await latestTag(root);
    if (tag !== null) {
      revArgs = [`${tag}..HEAD`];
      rangeLabel = `${tag}..HEAD`;
    } else {
      revArgs = ["-n", String(maxCommits), "HEAD"];
      rangeLabel = `last ${maxCommits} commits (no tag found)`;
    }
  }

  const log = await logEntries(root, revArgs);
  if (log === null) {
    throw new Error(`git log failed for range "${rangeLabel}" — is it a valid range like v1.0.0..HEAD?`);
  }

  const entries: ChangelogEntry[] = [];
  for (const e of log) {
    const att = await loadAttestationInfo(root, e.sha);
    const trailer = findAgentTrailer(e.body);
    const classification: EntryClassification = att !== null ? "agent" : trailer !== null ? "unknown" : "human";
    const entry: ChangelogEntry = { ...e, group: conventionalGroup(e.subject), classification };
    if (att !== null) {
      entry.agent = att.agent ?? "?";
      entry.tests = att.testsPassed === null ? "unverified" : att.testsPassed ? "passed" : "FAILED";
      if (att.verificationSource !== null) entry.verificationSource = att.verificationSource;
      entry.signatureValid = att.signatureValid;
      if (att.signatureReason !== undefined) entry.signatureReason = att.signatureReason;
    }
    if (classification === "unknown") entry.trailer = trailer ?? undefined;
    entries.push(entry);
  }

  const agents = entries.filter((e) => e.classification === "agent");
  const summary: ChangelogSummary = {
    total: entries.length,
    agent: agents.length,
    human: entries.filter((e) => e.classification === "human").length,
    unknown: entries.filter((e) => e.classification === "unknown").length,
    agentWithPassingTests: agents.filter((e) => e.tests === "passed").length,
  };
  const coverage: ChangelogCoverage = {
    ofAgentAttributable: percent(summary.agent, summary.agent + summary.unknown),
    ofAll: percent(summary.agent, summary.total),
  };

  return { repo: basename(root), range: rangeLabel, entries, summary, coverage };
}

const GROUP_TITLES: Record<EntryGroup, string> = {
  features: "Features",
  fixes: "Fixes",
  changes: "Changes",
};

function pctText(value: number | null): string {
  return value === null ? "n/a" : `${value}%`;
}

export function formatChangelogMarkdown(
  root: string,
  result: ChangelogResult,
  options: { includeUnknown?: boolean } = {},
): string {
  const s = result.summary;
  const lines: string[] = [];
  lines.push(`# Changelog — ${basename(root)}`);
  lines.push("");
  lines.push(
    `Range: ${result.range} — ${s.total} commits: ${s.agent} agent (${pctText(
      percent(s.agentWithPassingTests, s.agent),
    )} with passing-test attestations), ${s.human} human, ${s.unknown} unknown/unattested-agent`,
  );
  lines.push(
    `attestation coverage: ${pctText(result.coverage.ofAgentAttributable)} of agent commits, ` +
      `${pctText(result.coverage.ofAll)} of all commits`,
  );

  for (const group of ["features", "fixes", "changes"] as EntryGroup[]) {
    const groupEntries = result.entries.filter((e) => e.group === group && e.classification !== "unknown");
    if (groupEntries.length === 0) continue;
    lines.push("");
    lines.push(`## ${GROUP_TITLES[group]}`);
    for (const e of groupEntries) {
      if (e.classification === "agent") {
        const notes = [`agent: ${e.agent ?? "?"}`, `tests: ${e.tests ?? "unverified"}`];
        if (e.verificationSource === "claimed") notes.push("source: claimed");
        if (e.signatureValid === false) notes.push("signature: INVALID");
        lines.push(`- ${e.subject} [${notes.join(", ")}]`);
      } else {
        lines.push(`- ${e.subject}`);
      }
    }
  }

  const unknowns = result.entries.filter((e) => e.classification === "unknown");
  if (unknowns.length > 0) {
    lines.push("");
    lines.push("## Unattested agent commits");
    lines.push("");
    lines.push(
      options.includeUnknown
        ? "These commits carry agent trailers but no signed attestation:"
        : "WARNING: these commits carry agent trailers but no signed attestation — " +
            "run `agent-attest create` for them (shown always; --include-unknown suppresses this warning):",
    );
    for (const e of unknowns) {
      lines.push(`- ${e.subject} (${e.sha.slice(0, 7)}) — ${e.trailer ?? "agent trailer"}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function formatChangelogJson(result: ChangelogResult): string {
  return JSON.stringify(
    {
      repo: result.repo,
      range: result.range,
      summary: result.summary,
      coverage: result.coverage,
      commits: result.entries,
    },
    null,
    2,
  );
}
