import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertPrivateKeyNotTracked,
  keygen,
  keyidFromPem,
  privateKeyPathFor,
  publicKeyPathFor,
  signBytes,
  verifyBytes,
} from "../keys.js";
import { initRepo, makeFixtureRepo } from "./helpers.js";

test("keygen roundtrip: real ed25519 sign/verify", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "agent-attest-keys-"));
  try {
    const k = await keygen(tmp, tmp);
    assert.match(k.keyid, /^[0-9a-f]{16}$/);
    assert.ok(existsSync(join(tmp, "private.pem")));
    assert.ok(existsSync(join(tmp, "public.pem")));

    const priv = readFileSync(join(tmp, "private.pem"), "utf8");
    const pub = readFileSync(join(tmp, "public.pem"), "utf8");
    assert.equal(keyidFromPem(pub), k.keyid);

    const data = Buffer.from("chain of custody payload bytes");
    const sig = signBytes(priv, data);
    assert.ok(verifyBytes(pub, data, sig), "signature must verify");

    const flipped = Buffer.from(data);
    flipped[0] = flipped[0]! ^ 1;
    assert.ok(!verifyBytes(pub, flipped, sig), "modified data must not verify");

    const otherDir = join(tmp, "other");
    const other = await keygen(tmp, otherDir);
    const otherPub = readFileSync(join(otherDir, "public.pem"), "utf8");
    assert.ok(!verifyBytes(otherPub, data, sig), "wrong key must not verify");
    assert.notEqual(k.keyid, other.keyid);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("keyid is sha256(public der) truncated to 16 hex chars", async () => {
  const { createHash, createPublicKey } = await import("node:crypto");
  const tmp = mkdtempSync(join(tmpdir(), "agent-attest-keys-"));
  try {
    await keygen(tmp, tmp);
    const pub = readFileSync(join(tmp, "public.pem"), "utf8");
    const der = createPublicKey(pub).export({ type: "spki", format: "der" });
    const expected = createHash("sha256").update(der).digest("hex").slice(0, 16);
    assert.equal(keyidFromPem(pub), expected);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("keygen adds .agent-attest/keys/ to .gitignore and refuses overwrite", async () => {
  const fx = makeFixtureRepo();
  try {
    initRepo(fx);
    await keygen(fx.root);
    const gi = readFileSync(fx.path(".gitignore"), "utf8");
    assert.ok(gi.includes(".agent-attest/keys/"), `.gitignore should contain the keys dir, got: ${gi}`);
    await assert.rejects(() => keygen(fx.root), /refusing to overwrite/);
  } finally {
    fx.cleanup();
  }
});

test("tracked private key is refused", async () => {
  const fx = makeFixtureRepo();
  try {
    initRepo(fx);
    await keygen(fx.root);
    const privRel = ".agent-attest/keys/private.pem";
    // Force-add the private key (as if a bad pipeline committed it).
    fx.gitOk(["add", "-f", privRel]);
    await assert.rejects(
      () => assertPrivateKeyNotTracked(fx.root, fx.path(privRel)),
      /tracked by git/,
    );
  } finally {
    fx.cleanup();
  }
});

test("env key path overrides", () => {
  const prevPriv = process.env.AGENT_ATTEST_PRIVATE_KEY;
  const prevPub = process.env.AGENT_ATTEST_PUBLIC_KEY;
  try {
    process.env.AGENT_ATTEST_PRIVATE_KEY = "/ci/keys/private.pem";
    process.env.AGENT_ATTEST_PUBLIC_KEY = "/ci/keys/public.pem";
    assert.equal(privateKeyPathFor("C:/repo"), resolve("/ci/keys/private.pem"));
    assert.equal(publicKeyPathFor("C:/repo"), resolve("/ci/keys/public.pem"));
  } finally {
    if (prevPriv === undefined) delete process.env.AGENT_ATTEST_PRIVATE_KEY;
    else process.env.AGENT_ATTEST_PRIVATE_KEY = prevPriv;
    if (prevPub === undefined) delete process.env.AGENT_ATTEST_PUBLIC_KEY;
    else process.env.AGENT_ATTEST_PUBLIC_KEY = prevPub;
  }
});
