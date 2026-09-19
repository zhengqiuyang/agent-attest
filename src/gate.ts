import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { attestationPath, attestationRelPath, verifyAttestationFile } from "./attest.js";
import { commitFiles, commitMessage, resolveCommit, revListRange } from "./git.js";
import { matchAny } from "./glob.js";
import { normalizePath, readTextNormalized, toPosix } from "./util.js";

/**
 * The gate is the teeth: commits that touch protected paths must carry a valid
 * attestation whose recorded verification passed. Overrides exist but are
 * never silent — they surface as warnings in every format.
 */

export interface GateConfig {
  protectedPaths: string[];
  requireVerificationPassed: boolean;
  allowOverrideTrailer: boolean;
}

const CONFIG_FILES = ["agent-attest.yaml", "agent-attest.yml"];

export function loadGateConfig(root: string): { config: GateConfig; path: string } {
  const path = CONFIG_FILES.map((f) => join(root, f)).find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      `no agent-attest.yaml found in ${root} — the gate needs protectedPaths; see README for the config reference`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(readTextNormalized(path));
  } catch (err) {
    throw new Error(`agent-attest.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("agent-attest.yaml must be a YAML mapping");
  }
  const o = raw as Record<string, unknown>;
  const paths = o.protectedPaths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p.length > 0)) {
    throw new Error("agent-attest.yaml: protectedPaths must be a non-empty list of path globs");
  }
  const boolOpt = (value: unknown, name: string, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    throw new Error(`agent-attest.yaml: ${name} must be true or false`);
  };
  return {
    path,
    config: {
      protectedPaths: (paths as string[]).map(normalizePath),
      requireVerificationPassed: boolOpt(o.requireVerificationPassed, "requireVerificationPassed", true),
      allowOverrideTrailer: boolOpt(o.allowOverrideTrailer, "allowOverrideTrailer", true),
    },
  };
}

/**
 * Find the `agent-attest-override: <reason>` trailer in a commit message.
 * Proper trailer semantics: only the final paragraph of the message is
 * considered, matching git-interpret-trailer behavior closely enough to be
 * predictable without pulling in a dependency.
 */
export function findOverrideTrailer(message: string): string | null {
  const paragraphs = message.replace(/\r\n?/g, "\n").trimEnd().split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  for (const line of last.split("\n")) {
    const m = line.match(/^agent-attest-override:[ \t]*(.+)$/i);
    if (m) return m[1]!.trim();
  }
  return null;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CommitInput {
  sha: string;
  /** Changed paths; when absent they are read from git (except in Actions mode). */
  files?: string[];
  /** Commit message; when absent it is read from git (Actions mode supplies it). */
  message?: string;
}

export type CommitSource =
  | { kind: "fixture"; commits: CommitInput[] }
  | { kind: "range"; range: string }
  | { kind: "github"; owner: string; repo: string; prNumber: number; token?: string; fetchImpl: FetchLike };

export async function collectCommits(root: string, source: CommitSource): Promise<CommitInput[]> {
  switch (source.kind) {
    case "fixture":
      return source.commits;
    case "range": {
      const shas = await revListRange(root, source.range);
      if (shas === null) {
        throw new Error(`git rev-list failed for range "${source.range}" — is it a valid range like main..HEAD?`);
      }
      return shas.map((sha) => ({ sha }));
    }
    case "github":
      return await fetchGitHubCommits(source);
  }
}

/**
 * GitHub Actions mode (pull_request event). Commits via pulls/commits; the
 * PR's changed files via pulls/files; per-commit files via commits/{sha} with
 * the PR-level list as a conservative fallback (may over-flag docs-only
 * commits inside a mixed PR — safe direction for a gate). Best-effort, single
 * page of 100; larger PRs are truncated by design.
 */
export async function fetchGitHubCommits(src: Extract<CommitSource, { kind: "github" }>): Promise<CommitInput[]> {
  const base = `https://api.github.com/repos/${src.owner}/${src.repo}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (src.token) headers.Authorization = `Bearer ${src.token}`;

  const commitsRes = await src.fetchImpl(`${base}/pulls/${src.prNumber}/commits?per_page=100`, { headers });
  if (!commitsRes.ok) {
    throw new Error(
      `GitHub API error ${commitsRes.status} while fetching PR commits ` +
        `(is GITHUB_TOKEN set and valid for ${src.owner}/${src.repo}?)`,
    );
  }
  const rawCommits = (await commitsRes.json()) as Array<{ sha?: string; commit?: { message?: string } }>;

  const filesRes = await src.fetchImpl(`${base}/pulls/${src.prNumber}/files?per_page=100`, { headers });
  const prFiles = filesRes.ok
    ? ((await filesRes.json()) as Array<{ filename?: string }>)
        .map((f) => f.filename ?? "")
        .filter((f) => f.length > 0)
    : [];

  const out: CommitInput[] = [];
  for (const c of [...rawCommits].reverse()) {
    if (typeof c.sha !== "string" || c.sha.length === 0) continue;
    let files = prFiles;
    try {
      const one = await src.fetchImpl(`${base}/commits/${c.sha}`, { headers });
      if (one.ok) {
        const body = (await one.json()) as { files?: Array<{ filename?: string }> };
        if (Array.isArray(body.files)) {
          const perCommit = body.files.map((f) => f.filename ?? "").filter((f) => f.length > 0);
          if (perCommit.length > 0) files = perCommit;
        }
      }
    } catch {
      // keep PR-level fallback
    }
    out.push({ sha: c.sha, files, message: c.commit?.message ?? "" });
  }
  return out;
}

export type FindingStatus = "ok" | "overridden" | "missing" | "invalid" | "verification-failed";
export type FindingLevel = "ok" | "warning" | "error";

export interface GateFinding {
  commit: string;
  status: FindingStatus;
  level: FindingLevel;
  protectedFiles: string[];
  reason?: string;
  overrideReason?: string;
  agent?: string;
}

export interface GateSummary {
  checked: number;
  skipped: number;
  ok: number;
  overridden: number;
  failed: number;
}

export interface GateResult {
  passed: boolean;
  exitCode: 0 | 1;
  summary: GateSummary;
  findings: GateFinding[];
  configPath: string;
  config: GateConfig;
}

export interface GateOptions {
  recheck?: boolean;
  config?: GateConfig;
}

export async function runGate(root: string, source: CommitSource, options: GateOptions = {}): Promise<GateResult> {
  const loaded = loadGateConfig(root);
  const config = options.config ?? loaded.config;
  const commits = await collectCommits(root, source);

  const findings: GateFinding[] = [];
  const summary: GateSummary = { checked: 0, skipped: 0, ok: 0, overridden: 0, failed: 0 };

  for (const c of commits) {
    let sha = c.sha.toLowerCase();
    if (source.kind === "fixture") {
      const full = await resolveCommit(root, sha);
      if (full) sha = full;
    }
    const files = c.files ?? (await commitFiles(root, sha));
    const protectedFiles = files.map(normalizePath).filter((f) => matchAny(f, config.protectedPaths));
    if (protectedFiles.length === 0) {
      summary.skipped++;
      continue;
    }
    summary.checked++;

    const message = c.message ?? (await commitMessage(root, sha)) ?? "";
    const override = config.allowOverrideTrailer ? findOverrideTrailer(message) : null;

    let finding: GateFinding = { commit: sha, status: "ok", level: "ok", protectedFiles };
    const path = attestationPath(root, sha);
    if (!existsSync(path)) {
      finding = {
        ...finding,
        status: "missing",
        level: "error",
        reason: `no attestation found at ${attestationRelPath(root, sha)} — commit touches protected path(s): ${protectedFiles.join(", ")}`,
      };
    } else {
      const check = await verifyAttestationFile(root, path, {
        recheck: options.recheck ?? false,
        checkCommitExists: source.kind !== "github",
      });
      if (!check.ok || !check.statement) {
        finding = { ...finding, status: "invalid", level: "error", reason: check.reason };
      } else {
        const p = check.statement.predicate;
        finding = { ...finding, agent: p.agent.name };
        if (config.requireVerificationPassed && !p.verification.passed) {
          finding = {
            ...finding,
            status: "verification-failed",
            level: "error",
            reason:
              `attestation records verification.passed=false ` +
              `(command: "${p.verification.command}", source: ${p.verification.source ?? "executed"})`,
          };
        }
      }
    }

    // The override escape hatch: downgrades a blocking finding to a listed warning.
    if (finding.level === "error" && override !== null) {
      finding = { ...finding, status: "overridden", level: "warning", overrideReason: override };
    }

    if (finding.level === "error") summary.failed++;
    else if (finding.level === "warning") summary.overridden++;
    else summary.ok++;
    findings.push(finding);
  }

  return {
    passed: summary.failed === 0,
    exitCode: summary.failed === 0 ? 0 : 1,
    summary,
    findings,
    configPath: loaded.path,
    config,
  };
}

const STATUS_TAGS: Record<FindingStatus, string> = {
  ok: "OK",
  overridden: "OVERRIDE",
  missing: "MISSING",
  invalid: "INVALID",
  "verification-failed": "VERIF-FAIL",
};

export function formatGateConsole(result: GateResult): string {
  const lines: string[] = [];
  const inScope = result.summary.checked + result.summary.skipped;
  lines.push(
    `agent-attest gate — ${inScope} commit(s) in scope: ${result.summary.checked} touching protected paths, ` +
      `${result.summary.skipped} skipped (no protected paths)`,
  );
  lines.push(`config: ${result.configPath}`);
  lines.push(`patterns: ${result.config.protectedPaths.join(", ")}`);
  lines.push("");
  for (const f of result.findings) {
    const tag = STATUS_TAGS[f.status];
    lines.push(`  ${tag.padEnd(11)}  ${f.commit.slice(0, 12)}  ${f.protectedFiles.join(", ")}`);
    if (f.agent) lines.push(`      attested by ${f.agent}`);
    if (f.reason) lines.push(`      ${f.reason}`);
    if (f.overrideReason) lines.push(`      override: ${f.overrideReason}`);
  }
  lines.push("");
  lines.push(
    result.passed
      ? `gate: PASSED — ${result.summary.ok} ok, ${result.summary.overridden} override warning(s) — exit 0`
      : `gate: FAILED — ${result.summary.failed} blocking finding(s), ${result.summary.overridden} override warning(s) — exit 1`,
  );
  return lines.join("\n");
}

export function formatGateJson(result: GateResult): string {
  return JSON.stringify(
    { passed: result.passed, exitCode: result.exitCode, summary: result.summary, findings: result.findings },
    null,
    2,
  );
}

export function formatGateGithub(result: GateResult): string {
  const lines: string[] = [];
  for (const f of result.findings) {
    const short = f.commit.slice(0, 12);
    const files = f.protectedFiles.join(" ");
    if (f.level === "error") {
      lines.push(`::error title=agent-attest gate::commit ${short} (${files}): ${f.status}${f.reason ? ` — ${f.reason}` : ""}`);
    } else if (f.level === "warning") {
      lines.push(`::warning title=agent-attest override::commit ${short} (${files}): overridden — ${f.overrideReason ?? ""}`);
    }
  }
  lines.push(
    result.passed
      ? `::notice title=agent-attest gate::passed — ${result.summary.ok} ok, ${result.summary.overridden} override(s), ${result.summary.skipped} commit(s) without protected paths`
      : `::error title=agent-attest gate::FAILED — ${result.summary.failed} blocking finding(s)`,
  );
  return lines.join("\n");
}
