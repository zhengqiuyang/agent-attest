import { basename } from "node:path";
import { listAttestationFiles, verifyAttestationFile } from "./attest.js";

/**
 * Compliance inventory: the exportable wedge. Every attestation in the repo,
 * with live signature validation, in formats humans (markdown) and GRC tools
 * (json) can consume. The CycloneDX AI-BOM export builds on this.
 */

export interface ReportRow {
  commit: string;
  agent: string;
  ranAt: string;
  verification: string;
  passed: boolean;
  source?: string;
  durationMs: number;
  signatureValid: boolean;
  reason?: string;
  metadata: Record<string, unknown>;
}

export interface ReportTotals {
  attestations: number;
  validSignatures: number;
  invalidSignatures: number;
  verificationPassed: number;
  totalRunDurationMs: number;
  agents: Record<string, number>;
}

export interface AttestationReport {
  rows: ReportRow[];
  totals: ReportTotals;
}

export async function buildReport(root: string): Promise<AttestationReport> {
  const files = listAttestationFiles(root);
  const rows: ReportRow[] = [];

  for (const f of files) {
    const res = await verifyAttestationFile(root, f, { checkCommitExists: false });
    if (res.ok && res.statement) {
      const p = res.statement.predicate;
      rows.push({
        commit: res.commitFromFilename!,
        agent: p.agent.name,
        ranAt: p.verification.ranAt,
        verification: `${p.verification.passed ? "pass" : "fail"}${p.verification.source ? ` (${p.verification.source})` : ""}`,
        passed: p.verification.passed,
        source: p.verification.source,
        durationMs: p.run.durationMs,
        signatureValid: true,
        metadata: p.metadata,
      });
    } else {
      rows.push({
        commit: res.commitFromFilename ?? basename(f).replace(/\.attestation\.json$/, ""),
        agent: "?",
        ranAt: "",
        verification: "n/a",
        passed: false,
        durationMs: 0,
        signatureValid: false,
        reason: res.reason,
        metadata: {},
      });
    }
  }

  rows.sort((a, b) => (a.ranAt < b.ranAt ? -1 : a.ranAt > b.ranAt ? 1 : 0));

  const totals: ReportTotals = {
    attestations: rows.length,
    validSignatures: rows.filter((r) => r.signatureValid).length,
    invalidSignatures: rows.filter((r) => !r.signatureValid).length,
    verificationPassed: rows.filter((r) => r.signatureValid && r.passed).length,
    totalRunDurationMs: rows.reduce((s, r) => s + r.durationMs, 0),
    agents: {},
  };
  for (const r of rows) {
    if (r.signatureValid) totals.agents[r.agent] = (totals.agents[r.agent] ?? 0) + 1;
  }
  return { rows, totals };
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatReportMarkdown(root: string, report: AttestationReport): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`# agent-attest report — ${basename(root)}`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} from .agent-attest/attestations (${t.attestations} attestation(s)).`);
  lines.push("");
  if (report.rows.length === 0) {
    lines.push("No attestations found. Run `agent-attest create` after headless agent runs.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| Commit | Agent | Ran at | Verification | Run duration | Signature |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of report.rows) {
    const signature = r.signatureValid
      ? "valid"
      : `INVALID${r.reason ? ` — ${escapeCell(r.reason)}` : ""}`;
    lines.push(
      `| \`${r.commit.slice(0, 12)}\` | ${escapeCell(r.agent)} | ${r.ranAt || "-"} | ${escapeCell(r.verification)} | ${r.durationMs} ms | ${signature} |`,
    );
  }
  lines.push("");
  lines.push(
    `**Totals:** ${t.attestations} attestation(s) · ${t.validSignatures} valid signature(s)` +
      (t.invalidSignatures > 0 ? ` · ${t.invalidSignatures} INVALID` : "") +
      ` · ${t.verificationPassed} verification passed · ${t.totalRunDurationMs} ms total recorded run time`,
  );
  const agents = Object.entries(t.agents)
    .map(([a, n]) => `${a} x${n}`)
    .join(", ");
  lines.push("");
  lines.push(`Agents: ${agents || "none"}`);
  lines.push("");
  return lines.join("\n");
}
