import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { keyidFromPem, signBytes, verifyBytes } from "./keys.js";

/**
 * The attestation format is deliberately standard-shaped:
 *  - the signed payload is an in-toto Statement v1 (https://in-toto.io)
 *  - the predicateType is our agent-run predicate
 *  - the crypto is plain ed25519 over the canonical payload bytes (node:crypto)
 *  - the envelope mirrors the DSSE-ish shapes people already parse
 * No bespoke scheme, no exotic dependencies.
 */

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PREDICATE_TYPE = "https://agent-attest.dev/attestations/agent-run/v1";
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";

export interface StatementSubject {
  name: string;
  digest: { gitCommit: string };
}

export interface AgentInfo {
  name: string;
  command?: string;
}

export interface RunInfo {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  promptSha256: string;
  exitCode: number;
}

export interface VerificationInfo {
  command: string;
  passed: boolean;
  ranAt: string;
  /** "executed": agent-attest ran the command; "claimed": --verification-passed override. */
  source?: "executed" | "claimed";
  exitCode?: number;
}

export interface AttestationPredicate {
  agent: AgentInfo;
  run: RunInfo;
  verification: VerificationInfo;
  commits: string[];
  metadata: Record<string, unknown>;
}

export interface AttestationStatement {
  _type: string;
  subject: StatementSubject[];
  predicateType: string;
  predicate: AttestationPredicate;
}

export interface SignatureEntry {
  keyid: string;
  sig: string;
}

export interface Envelope {
  payloadType: string;
  /** base64 of the canonical statement bytes */
  payload: string;
  payloadDigest: { sha256: string };
  signatures: SignatureEntry[];
  signedAt: string;
}

export interface BuildStatementInput {
  repoName: string;
  commit: string;
  agent: AgentInfo;
  run: RunInfo;
  verification: VerificationInfo;
  commits: string[];
  metadata: Record<string, unknown>;
}

export function buildStatement(input: BuildStatementInput): AttestationStatement {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: input.repoName, digest: { gitCommit: input.commit.toLowerCase() } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      agent: input.agent,
      run: input.run,
      verification: input.verification,
      commits: input.commits.map((c) => c.toLowerCase()),
      metadata: input.metadata,
    },
  };
}

export function statementBytes(statement: AttestationStatement): Buffer {
  return Buffer.from(canonicalJson(statement), "utf8");
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Sign: canonical statement bytes -> base64 payload, sha256 payload digest,
 * ed25519 signature over exactly those bytes.
 */
export function signStatement(
  statement: AttestationStatement,
  key: { privatePem: string; keyid: string; signedAt?: string },
): Envelope {
  const bytes = statementBytes(statement);
  return {
    payloadType: PAYLOAD_TYPE,
    payload: bytes.toString("base64"),
    payloadDigest: { sha256: sha256Hex(bytes) },
    signatures: [{ keyid: key.keyid, sig: signBytes(key.privatePem, bytes).toString("base64") }],
    signedAt: key.signedAt ?? new Date().toISOString(),
  };
}

/** Parse an envelope from JSON text with strict shape validation. */
export function parseEnvelope(text: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("attestation file is not valid JSON");
  }
  return envelopeFrom(raw);
}

function envelopeFrom(raw: unknown): Envelope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("attestation envelope must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.payloadType !== "string") throw new Error("envelope missing payloadType");
  if (typeof o.payload !== "string") throw new Error("envelope missing payload");
  const digest = (o.payloadDigest ?? {}) as Record<string, unknown>;
  if (typeof digest.sha256 !== "string") throw new Error("envelope missing payloadDigest.sha256");
  if (!Array.isArray(o.signatures)) throw new Error("envelope missing signatures array");
  const signatures = o.signatures.map((s): SignatureEntry => {
    if (s === null || typeof s !== "object") throw new Error("signature entry must be an object");
    const se = s as Record<string, unknown>;
    if (typeof se.keyid !== "string" || typeof se.sig !== "string") {
      throw new Error("signature entry requires string keyid and sig");
    }
    return { keyid: se.keyid, sig: se.sig };
  });
  return {
    payloadType: o.payloadType,
    payload: o.payload,
    payloadDigest: { sha256: digest.sha256 },
    signatures,
    signedAt: typeof o.signedAt === "string" ? o.signedAt : "",
  };
}

export interface EnvelopeVerification {
  ok: boolean;
  reason?: string;
  statement?: AttestationStatement;
}

/**
 * Verify an envelope against a public key:
 *  1. payload digest matches the actual payload bytes
 *  2. an ed25519 signature from the expected keyid verifies over those bytes
 *  3. the payload parses as an agent-attest in-toto statement
 * Any tampering with the payload breaks (1) and (2); re-encoding without the
 * signing key breaks (2); a swapped key breaks the keyid lookup in (2).
 */
export function verifyEnvelope(envelope: Envelope, publicPem: string): EnvelopeVerification {
  if (envelope.payloadType !== PAYLOAD_TYPE) {
    return { ok: false, reason: `unexpected payloadType "${envelope.payloadType}" (expected ${PAYLOAD_TYPE})` };
  }
  const bytes = Buffer.from(envelope.payload, "base64");
  const actualDigest = sha256Hex(bytes);
  if (actualDigest !== envelope.payloadDigest.sha256.toLowerCase()) {
    return {
      ok: false,
      reason:
        `payload digest mismatch — envelope claims sha256:${envelope.payloadDigest.sha256} ` +
        `but payload hashes to sha256:${actualDigest} (payload was modified after signing)`,
    };
  }
  const keyid = keyidFromPem(publicPem);
  const entry = envelope.signatures.find((s) => s.keyid === keyid);
  if (!entry) {
    const have = envelope.signatures.map((s) => s.keyid).join(", ") || "none";
    return {
      ok: false,
      reason: `no signature from key ${keyid} — attestation was signed with a different key (envelope has: ${have})`,
    };
  }
  let sig: Buffer;
  try {
    sig = Buffer.from(entry.sig, "base64");
  } catch {
    return { ok: false, reason: "signature is not valid base64" };
  }
  if (!verifyBytes(publicPem, bytes, sig)) {
    return { ok: false, reason: `ed25519 signature verification failed for key ${keyid}` };
  }
  let statement: AttestationStatement;
  try {
    statement = JSON.parse(bytes.toString("utf8")) as AttestationStatement;
  } catch {
    return { ok: false, reason: "payload is not valid JSON" };
  }
  if (statement._type !== STATEMENT_TYPE) {
    return { ok: false, reason: `payload is not an in-toto statement (._type = ${String(statement._type)})` };
  }
  if (statement.predicateType !== PREDICATE_TYPE) {
    return { ok: false, reason: `unexpected predicateType "${String(statement.predicateType)}"` };
  }
  return { ok: true, statement };
}
