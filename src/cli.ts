import { existsSync, writeFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  attestationRelPath,
  createAttestation,
  verifyAll,
} from "./attest.js";
import { buildChangelog, formatChangelogJson, formatChangelogMarkdown } from "./changelog.js";
import {
  CommitSource,
  FetchLike,
  formatGateConsole,
  formatGateGithub,
  formatGateJson,
  runGate,
} from "./gate.js";
import { repoRoot, resolveCommit } from "./git.js";
import { keygen } from "./keys.js";
import { buildReport, formatReportMarkdown } from "./report.js";
import { errorMessage, readTextNormalized, toPosix } from "./util.js";

const VERSION = "0.2.0";

const USAGE = `agent-attest v${VERSION} — signed chain-of-custody for AI coding agent work

Usage:
  agent-attest <command> [options]

Commands:
  keygen    Generate an ed25519 signing keypair (default .agent-attest/keys)
  create    Create and sign an attestation for one commit
  verify    Verify attestations against git history (optionally re-run verification)
  gate      Block unattested commits touching protected paths (CI gate)
  report    Compliance inventory across all attestations
  changelog Deterministic changelog/release notes: git history joined with attestations

Exit codes: 0 pass · 1 findings / invalid attestations · 2 usage or config error

Options:
  -h, --help   Show help (global or per command).

https://github.com/agent-attest/agent-attest`;

const COMMAND_USAGE: Record<string, string> = {
  keygen: `Usage: agent-attest keygen [--dir <keysDir>]

Options:
  --dir <keysDir>   Where to write keys (default: <repo>/.agent-attest/keys)

Writes private.pem (0600, gitignored — never commit it), public.pem (commit this
so verify/gate can check signatures) and prints the keyid (first 16 hex chars of
sha256 over the public key DER). Refuses to overwrite existing keys.

Env overrides (paths): AGENT_ATTEST_PRIVATE_KEY, AGENT_ATTEST_PUBLIC_KEY.`,

  create: `Usage: agent-attest create --commit <sha> --agent <name> --prompt-file <file> --verification "<cmd>" [options]

Required:
  --commit <sha>           Commit the agent run produced (attestation subject)
  --agent <name>           Agent identifier, e.g. claude-code
  --prompt-file <file>     File holding the run's prompt (sha256 recorded; the file is not stored)
  --verification "<cmd>"   Command proving the work (executed in repo root, real result recorded)

Options:
  --command <cmdline>            The agent command line (recorded, not run)
  --verification-passed <bool>   Skip execution and record a claimed result (source: "claimed")
  --meta <meta.json>             JSON object merged into predicate.metadata
  --exit-code <n>                The agent process exit code (default 0)
  --started-at <iso>             Agent run window start (default: now)
  --ended-at <iso>               Agent run window end (default: now, duration 0)

Behavior:
  * the verification command is executed by default; the real result is recorded (source: "executed")
  * writes .agent-attest/attestations/<sha>.attestation.json (deterministic filename)
  * refuses to run if the private key is tracked by git`,

  verify: `Usage: agent-attest verify [--commit <sha>] [--recheck]

Without --commit, verifies every .agent-attest/attestations/*.attestation.json.
Checks, per attestation:
  * payload digest matches the payload bytes (tamper detection)
  * ed25519 signature validates with the repo public key
  * statement subject digest gitCommit == attestation filename commit
  * the commit exists in local history
With --recheck, the recorded verification command is re-run and any disagreement
with the recorded result fails (catches "claimed" results that lie).`,

  gate: `Usage: agent-attest gate [--range <base>..<head> | --commits <file> [--files <map.json>]] [--recheck] [--format console|json|github]

Commit sources (first match wins):
  --commits <file>    Fixture/advanced mode: one 40-hex sha per line (# comments and blank lines ok)
  --files <map.json>  Optional JSON map sha -> array of changed paths (otherwise read from git)
  --range <a>..<b>    Local mode: commits in \`git rev-list a..b\`
  Actions mode        GITHUB_EVENT_PATH pull_request event -> commits and files via the GitHub
                      API (uses GITHUB_TOKEN when set; injectable fetch internally)

Config (agent-attest.yaml at the repo root, required):
  protectedPaths:                list of path globs, e.g. ["src/**", "infra/**"]
  requireVerificationPassed:     true (default) — attestations with passed=false fail the gate
  allowOverrideTrailer:          true (default) — commit message trailer
                                 "agent-attest-override: <reason>" downgrades a blocking finding
                                 to a listed warning (never silent)

Exit: 0 pass (overrides are warnings, still listed) · 1 findings · 2 config/usage error.
--format github emits ::error/::warning workflow annotations.`,

  report: `Usage: agent-attest report [--format markdown|json]

Compliance inventory across all attestations: per-commit agent, verification
result and source, run duration, signature validity, with totals. Markdown for
humans, JSON for GRC tooling.`,

  changelog: `Usage: agent-attest changelog [--range <base>..<head>] [--format markdown|json] [--md-out <file>] [--include-unknown]

Deterministic changelog / release notes from git history JOINed with
attestations. No LLM, no network, no timestamps — same input, same output.

Range (default when --range is absent):
  most recent tag..HEAD   when a tag exists (git describe --abbrev=0)
  last 30 commits         when the repository has no tags

Each commit is classified:
  agent    an attestation exists (agent name, verification result and source,
           signature validity reported — never assumed)
  human    no attestation, no agent trailer
  unknown  no attestation but a Co-Authored-By: Claude/Codex/Gemini/Copilot
           trailer (unattested agent work — always listed under a warning
           heading; --include-unknown keeps the list but drops the warning)

Entries group by conventional-commit prefix (feat!/feat -> Features,
fix -> Fixes, rest -> Changes), oldest first. Agent entries are annotated:
  - add tokens [agent: claude-code, tests: passed]   (or tests: FAILED /
   tests: unverified, plus source: claimed / signature: INVALID when true)

The header carries a summary and a trust line (attestation coverage).
--md-out <file> writes the markdown to a file instead of stdout.
--format json emits the full entry objects for tooling.`,
};

interface ParsedInvocation {
  command: string | null;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedInvocation {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") {
      flags.h = true;
      continue;
    }
    if (a.startsWith("--") && a.length > 2) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else if (command === null) {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, flags, positionals };
}

function strFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function strRequired(flags: Record<string, string | boolean>, name: string): string {
  const v = strFlag(flags, name);
  if (v === undefined || v.length === 0) {
    throw new Error(`missing required option --${name}\n\n${COMMAND_USAGE_HINT}`);
  }
  return v;
}

let COMMAND_USAGE_HINT = "";

async function requireRepoRoot(): Promise<string> {
  const root = await repoRoot(process.cwd());
  if (!root) {
    throw new Error(`not inside a git repository (cwd: ${process.cwd()}) — agent-attest operates on git history`);
  }
  return root;
}

function writeOut(text: string): void {
  process.stdout.write(text);
}

function writeErr(text: string): void {
  process.stderr.write(text);
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const command = parsed.command;

  if (parsed.flags.help !== undefined || parsed.flags.h !== undefined) {
    writeOut((command !== null ? COMMAND_USAGE[command] ?? USAGE : USAGE) + "\n");
    return 0;
  }
  if (command === null) {
    writeOut(USAGE + "\n");
    return 2;
  }
  if (command === "help") {
    writeOut(USAGE + "\n");
    return 0;
  }
  if (command === "version" || parsed.flags.version !== undefined) {
    writeOut(`agent-attest v${VERSION}\n`);
    return 0;
  }

  COMMAND_USAGE_HINT = COMMAND_USAGE[command] ?? "";

  try {
    switch (command) {
      case "keygen":
        return await cmdKeygen(parsed.flags);
      case "create":
        return await cmdCreate(parsed.flags);
      case "verify":
        return await cmdVerify(parsed.flags);
      case "gate":
        return await cmdGate(parsed.flags);
      case "report":
        return await cmdReport(parsed.flags);
      case "changelog":
        return await cmdChangelog(parsed.flags);
      default:
        writeErr(`agent-attest: unknown command "${command}"\n\n${USAGE}\n`);
        return 2;
    }
  } catch (err) {
    writeErr(`agent-attest: ${errorMessage(err)}\n`);
    return 2;
  }
}

async function cmdKeygen(flags: Record<string, string | boolean>): Promise<number> {
  const dir = strFlag(flags, "dir");
  const root = (await repoRoot(process.cwd())) ?? process.cwd();
  const k = await keygen(root, dir !== undefined ? dir : undefined);
  writeOut(
    [
      "generated ed25519 keypair",
      `  keyid:    ${k.keyid}`,
      `  private:  ${toPosix(k.privatePath)}  (mode 0600, gitignored — NEVER commit)`,
      `  public:   ${toPosix(k.publicPath)}  (commit this so verify/gate can check signatures)`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function cmdCreate(flags: Record<string, string | boolean>): Promise<number> {
  const commit = strRequired(flags, "commit");
  const agent = strRequired(flags, "agent");
  const agentCommand = strFlag(flags, "command");
  const promptFile = strRequired(flags, "prompt-file");
  const verification = strRequired(flags, "verification");
  const meta = strFlag(flags, "meta");
  const startedAt = strFlag(flags, "started-at");
  const endedAt = strFlag(flags, "ended-at");

  let verificationPassed: boolean | undefined;
  const vp = strFlag(flags, "verification-passed");
  if (vp !== undefined) {
    if (vp === "true") verificationPassed = true;
    else if (vp === "false") verificationPassed = false;
    else throw new Error(`--verification-passed must be "true" or "false", got "${vp}"`);
  }

  let exitCode: number | undefined;
  const exitRaw = strFlag(flags, "exit-code");
  if (exitRaw !== undefined) {
    exitCode = Number(exitRaw);
    if (!Number.isInteger(exitCode)) throw new Error(`--exit-code must be an integer, got "${exitRaw}"`);
  }

  const root = await requireRepoRoot();
  const outcome = await createAttestation(root, {
    commit,
    agent,
    agentCommand,
    promptFile,
    verification,
    verificationPassed,
    metaFile: meta,
    exitCode,
    startedAt,
    endedAt,
  });

  const v = outcome.verification;
  writeOut(
    [
      `attestation written: ${attestationRelPath(root, outcome.commit)}`,
      `  subject:  ${basename(root)} @ ${outcome.commit.slice(0, 12)}`,
      `  agent:    ${outcome.statement.predicate.agent.name}${outcome.statement.predicate.agent.command ? ` (${outcome.statement.predicate.agent.command})` : ""}`,
      `  key:      ${outcome.envelope.signatures[0]?.keyid}`,
      `  verification: "${v.command}" -> passed=${v.passed} (${v.source}${v.source === "executed" ? `, exit ${v.exitCode}, ${v.durationMs} ms` : ", not executed"})`,
      "",
    ].join("\n"),
  );
  if (v.source === "executed" && !v.passed) {
    writeOut("WARNING: verification FAILED — the attestation records passed=false; agent-attest gate will block this commit.\n");
  }
  if (v.source === "claimed") {
    writeOut(
      `NOTE: verification result was claimed via --verification-passed (source: "claimed"). ` +
        `\`agent-attest verify --recheck\` will re-run "${v.command}" and catch false claims.\n`,
    );
  }
  return 0;
}

async function cmdVerify(flags: Record<string, string | boolean>): Promise<number> {
  const commit = strFlag(flags, "commit");
  const recheck = flags.recheck === true;
  const root = await requireRepoRoot();

  const { results } = await verifyAll(root, { commit, recheck });
  const lines: string[] = [];
  lines.push(`agent-attest verify — ${results.length} attestation(s)${recheck ? " (with verification re-check)" : ""}`);
  for (const r of results) {
    const short = (r.commitFromFilename ?? "?").slice(0, 12);
    if (r.ok && r.statement) {
      const p = r.statement.predicate;
      const recheckNote = r.recheck ? ` · re-check ${r.recheck.agrees ? "agree" : "MISMATCH"}` : "";
      lines.push(
        `  OK    ${short}  ${p.agent.name} · verification ${p.verification.passed ? "pass" : "FAIL"} (${p.verification.source ?? "executed"})${recheckNote}`,
      );
    } else {
      lines.push(`  FAIL  ${short}  ${r.reason}`);
    }
  }
  if (results.length === 0) lines.push("  (no attestations found)");
  const failed = results.filter((r) => !r.ok).length;
  if (results.length === 0) {
    lines.push("verify: nothing to verify — exit 0");
  } else if (failed === 0) {
    lines.push(`verify: all ${results.length} attestation(s) valid — exit 0`);
  } else {
    lines.push(`verify: ${failed} of ${results.length} attestation(s) invalid — exit 1`);
  }
  writeOut(lines.join("\n") + "\n");
  return failed === 0 ? 0 : 1;
}

async function cmdGate(flags: Record<string, string | boolean>): Promise<number> {
  const format = strFlag(flags, "format") ?? "console";
  if (format !== "console" && format !== "json" && format !== "github") {
    throw new Error(`--format must be console|json|github, got "${format}"`);
  }
  const recheck = flags.recheck === true;
  const root = await requireRepoRoot();
  const source = await commitSource(root, flags);
  const result = await runGate(root, source, { recheck });
  const text =
    format === "json" ? formatGateJson(result) : format === "github" ? formatGateGithub(result) : formatGateConsole(result);
  writeOut(text + "\n");
  return result.exitCode;
}

async function commitSource(root: string, flags: Record<string, string | boolean>): Promise<CommitSource> {
  const commitsFile = strFlag(flags, "commits");
  const filesFile = strFlag(flags, "files");

  if (commitsFile !== undefined) {
    const shas = readTextNormalized(commitsFile)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    if (shas.length === 0) throw new Error(`--commits file ${commitsFile} lists no commits`);

    let fileMap: Record<string, string[]> | null = null;
    if (filesFile !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(readTextNormalized(filesFile));
      } catch (err) {
        throw new Error(`--files is not valid JSON: ${errorMessage(err)}`);
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("--files must be a JSON object mapping commit sha -> paths");
      }
      fileMap = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          fileMap[k] = v.map(String);
        } else if (typeof v === "string") {
          fileMap[k] = v
            .split(/[\n;]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        } else {
          throw new Error(`--files: value for "${k}" must be an array of paths or a newline-separated string`);
        }
      }
    }

    const commits = [];
    for (const sha of shas) {
      const full = (await resolveCommit(root, sha)) ?? sha.toLowerCase();
      commits.push({ sha: full, files: fileMap ? (fileMap[sha] ?? fileMap[full]) : undefined });
    }
    return { kind: "fixture", commits };
  }

  const range = strFlag(flags, "range");
  if (range !== undefined) return { kind: "range", range };

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath !== undefined && eventPath.length > 0 && existsSync(eventPath)) {
    let event: unknown;
    try {
      event = JSON.parse(readTextNormalized(eventPath));
    } catch {
      throw new Error(`GITHUB_EVENT_PATH (${eventPath}) does not contain valid JSON`);
    }
    const ev = event as { pull_request?: { number?: unknown }; repository?: { full_name?: unknown } };
    const prNumber = typeof ev.pull_request?.number === "number" ? ev.pull_request.number : null;
    const fullName = typeof ev.repository?.full_name === "string" ? ev.repository.full_name : null;
    if (prNumber === null || fullName === null || !fullName.includes("/")) {
      throw new Error(
        "GITHUB_EVENT_PATH is not a pull_request event — agent-attest gate in Actions needs a pull_request or " +
          "pull_request_target event; for push events use --range <base>..<head>",
      );
    }
    const parts = fullName.split("/");
    const fetchImpl: FetchLike = (url, init) => fetch(url, init);
    return {
      kind: "github",
      owner: parts[0]!,
      repo: parts[1]!,
      prNumber,
      token: process.env.GITHUB_TOKEN,
      fetchImpl,
    };
  }

  throw new Error(
    "no commit source: pass --range <base>..<head> or --commits <file>, or run inside a GitHub Actions pull_request event (GITHUB_EVENT_PATH)",
  );
}

async function cmdReport(flags: Record<string, string | boolean>): Promise<number> {
  const format = strFlag(flags, "format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new Error(`--format must be markdown|json, got "${format}"`);
  }
  const root = await requireRepoRoot();
  const report = await buildReport(root);
  if (format === "json") {
    writeOut(
      JSON.stringify(
        { generatedAt: new Date().toISOString(), repo: basename(root), totals: report.totals, attestations: report.rows },
        null,
        2,
      ) + "\n",
    );
  } else {
    writeOut(formatReportMarkdown(root, report) + "\n");
  }
  return 0;
}

async function cmdChangelog(flags: Record<string, string | boolean>): Promise<number> {
  const format = strFlag(flags, "format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new Error(`--format must be markdown|json, got "${format}"`);
  }
  const range = strFlag(flags, "range");
  const mdOutFlag = flags["md-out"];
  if (mdOutFlag !== undefined && format !== "markdown") {
    throw new Error(`--md-out requires --format markdown, got "${format}"`);
  }
  const mdOut = typeof mdOutFlag === "string" && mdOutFlag.length > 0 ? mdOutFlag : undefined;
  if (mdOutFlag !== undefined && mdOut === undefined) {
    throw new Error("--md-out requires a file path: --md-out <file>");
  }
  const includeUnknown = flags["include-unknown"] === true;
  if (mdOut !== undefined && format !== "markdown") {
    throw new Error(`--md-out requires --format markdown, got "${format}"`);
  }
  const root = await requireRepoRoot();
  const result = await buildChangelog(root, { range });
  if (format === "json") {
    writeOut(formatChangelogJson(result) + "\n");
  } else {
    const md = formatChangelogMarkdown(root, result, { includeUnknown });
    if (mdOut !== undefined) {
      writeFileSync(mdOut, md + "\n");
      writeOut(`changelog written: ${mdOut} (${result.summary.total} commit(s), range ${result.range})\n`);
    } else {
      writeOut(md + "\n");
    }
  }
  return 0;
}

// Self-invocation when this module is executed directly (`node dist/cli.js ...`),
// while remaining importable (bin/agent-attest.js calls main() itself).
const entryHref = process.argv[1] !== undefined ? pathToFileURL(resolvePath(process.argv[1])).href : "";
const selfHref = import.meta.url;
const invokedDirectly = entryHref !== "" && (entryHref === selfHref || (process.platform === "win32" && entryHref.toLowerCase() === selfHref.toLowerCase()));
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      writeErr(`agent-attest: unexpected failure: ${errorMessage(err)}\n`);
      process.exit(2);
    });
}
