import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../canonical.js";
import { keygen, keyidFromPem } from "../keys.js";
import {
  AttestationStatement,
  buildStatement,
  parseEnvelope,
  PREDICATE_TYPE,
  signStatement,
  STATEMENT_TYPE,
  verifyEnvelope,
} from "../statement.js";

function sampleStatement(): AttestationStatement {
  return buildStatement({
    repoName: "widget",
    commit: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    agent: { name: "claude-code", command: "claude -p 'do the thing'" },
    run: {
      startedAt: "2026-09-20T02:40:12.000Z",
      endedAt: "2026-09-20T02:41:03.000Z",
      durationMs: 51000,
      promptSha256: "a".repeat(64),
      exitCode: 0,
    },
    verification: { command: "npm test", passed: true, ranAt: "2026-09-20T02:41:05.000Z", source: "executed", exitCode: 0 },
    commits: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    metadata: { objective: "implement session-token auth", scheduledBy: "cron:nightly" },
  });
}

test("canonicalJson sorts keys recursively and is stable", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ z: { d: 1, c: [3, { y: 2, x: 1 }] } }), '{"z":{"c":[3,{"x":1,"y":2}],"d":1}}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([2, 1, 3]), "[2,1,3]");
  assert.equal(canonicalJson({ nested: { z: 1, a: { m: true, k: null } } }), '{"nested":{"a":{"k":null,"m":true},"z":1}}');
  const once = canonicalJson({ b: { y: 1, x: 2 }, a: 3 });
  const twice = canonicalJson(JSON.parse(once));
  assert.equal(once, twice);
});

test("buildStatement produces the in-toto v1 shape", () => {
  const s = sampleStatement();
  assert.equal(s._type, STATEMENT_TYPE);
  assert.equal(s.predicateType, PREDICATE_TYPE);
  assert.equal(s.subject[0]!.name, "widget");
  assert.equal(s.subject[0]!.digest.gitCommit, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.deepEqual(s.predicate.commits, [s.subject[0]!.digest.gitCommit]);
  assert.equal(s.predicate.verification.passed, true);
});

test("sign + verify envelope roundtrip", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "agent-attest-stmt-"));
  try {
    await keygen(tmp, tmp);
    const priv = readFileSync(join(tmp, "private.pem"), "utf8");
    const pub = readFileSync(join(tmp, "public.pem"), "utf8");

    const statement = sampleStatement();
    const envelope = signStatement(statement, { privatePem: priv, keyid: keyidFromPem(pub), signedAt: "2026-09-20T02:41:06.000Z" });

    assert.equal(envelope.payloadType, "application/vnd.in-toto+json");
    assert.match(envelope.payloadDigest.sha256, /^[0-9a-f]{64}$/);
    assert.equal(envelope.signedAt, "2026-09-20T02:41:06.000Z");

    const roundtrip = verifyEnvelope(parseEnvelope(JSON.stringify(envelope)), pub);
    assert.equal(roundtrip.ok, true, roundtrip.reason);
    assert.deepEqual(roundtrip.statement, statement);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("tamper: flipping a payload byte breaks the digest", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "agent-attest-stmt-"));
  try {
    await keygen(tmp, tmp);
    const priv = readFileSync(join(tmp, "private.pem"), "utf8");
    const pub = readFileSync(join(tmp, "public.pem"), "utf8");
    const envelope = signStatement(sampleStatement(), { privatePem: priv, keyid: keyidFromPem(pub) });

    const bytes = Buffer.from(envelope.payload, "base64");
    bytes[10] = bytes[10]! ^ 0xff;
    envelope.payload = bytes.toString("base64");

    const v = verifyEnvelope(envelope, pub);
    assert.equal(v.ok, false);
    assert.match(v.reason!, /digest mismatch/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("tamper: recomputed digest without re-signing fails the signature", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "agent-attest-stmt-"));
  try {
    await keygen(tmp, tmp);
    const priv = readFileSync(join(tmp, "private.pem"), "utf8");
    const pub = readFileSync(join(tmp, "public.pem"), "utf8");
    const envelope = signStatement(sampleStatement(), { privatePem: priv, keyid: keyidFromPem(pub) });

    // Attacker with no key rewrites the payload and "fixes" the digest, but
    // cannot produce a valid signature over the new bytes.
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as AttestationStatement;
    statement.predicate.verification.passed = false;
    const newBytes = Buffer.from(canonicalJson(statement), "utf8");
    envelope.payload = newBytes.toString("base64");
    envelope.payloadDigest.sha256 = createHash("sha256").update(newBytes).digest("hex");

    const v = verifyEnvelope(envelope, pub);
    assert.equal(v.ok, false);
    assert.match(v.reason!, /signature verification failed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verifying with a different key reports a key mismatch", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "agent-attest-stmt-"));
  try {
    await keygen(tmp, tmp);
    await keygen(tmp, join(tmp, "second"));
    const priv = readFileSync(join(tmp, "private.pem"), "utf8");
    const secondPub = readFileSync(join(tmp, "second", "public.pem"), "utf8");
    const envelope = signStatement(sampleStatement(), { privatePem: priv, keyid: "0123456789abcdef" });
    const v = verifyEnvelope(envelope, secondPub);
    assert.equal(v.ok, false);
    assert.match(v.reason!, /no signature from key/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseEnvelope rejects malformed envelopes", () => {
  assert.throws(() => parseEnvelope("not json"), /not valid JSON/);
  assert.throws(() => parseEnvelope('{"payload":"AA"}'), /payloadType/);
  assert.throws(() => parseEnvelope('{"payloadType":"x","payload":"AA","payloadDigest":{},"signatures":[]}'), /payloadDigest/);
  assert.throws(() => parseEnvelope('{"payloadType":"x","payload":"AA","payloadDigest":{"sha256":"ab"},"signatures":{}}'), /signatures/);
});
