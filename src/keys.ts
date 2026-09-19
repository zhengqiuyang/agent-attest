import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.js";
import { readTextNormalized, toPosix } from "./util.js";

export const DEFAULT_KEYS_DIR = ".agent-attest/keys";
const PRIVATE_KEY_FILE = "private.pem";
const PUBLIC_KEY_FILE = "public.pem";

/**
 * Private key location. CI can inject keys by pointing the env vars at file
 * paths (AGENT_ATTEST_PRIVATE_KEY / AGENT_ATTEST_PUBLIC_KEY).
 */
export function privateKeyPathFor(root: string): string {
  const env = process.env.AGENT_ATTEST_PRIVATE_KEY;
  return env && env.length > 0 ? resolve(env) : join(root, DEFAULT_KEYS_DIR, PRIVATE_KEY_FILE);
}

export function publicKeyPathFor(root: string): string {
  const env = process.env.AGENT_ATTEST_PUBLIC_KEY;
  return env && env.length > 0 ? resolve(env) : join(root, DEFAULT_KEYS_DIR, PUBLIC_KEY_FILE);
}

/** keyid = first 16 hex chars of sha256 over the public key SPKI DER. */
export function keyidFromPem(publicPem: string): string {
  const der = createPublicKey(publicPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export function signBytes(privatePem: string, data: Buffer): Buffer {
  return edSign(null, data, createPrivateKey(privatePem));
}

export function verifyBytes(publicPem: string, data: Buffer, sig: Buffer): boolean {
  try {
    return edVerify(null, data, createPublicKey(publicPem), sig);
  } catch {
    return false;
  }
}

export interface GeneratedKeys {
  keyid: string;
  privatePath: string;
  publicPath: string;
}

/**
 * Generate an ed25519 keypair and write private.pem (mode 0600, gitignored)
 * plus public.pem. Refuses to overwrite existing keys. If a repo is present,
 * `.agent-attest/keys/` is added to .gitignore and any tracked private key is
 * a hard error — a tracked private key hands every repo reader forge power.
 */
export async function keygen(root: string, keysDir?: string): Promise<GeneratedKeys> {
  const dir = keysDir ? resolve(keysDir) : join(root, DEFAULT_KEYS_DIR);
  const privatePath = join(dir, PRIVATE_KEY_FILE);
  const publicPath = join(dir, PUBLIC_KEY_FILE);

  if (existsSync(privatePath)) {
    throw new Error(`refusing to overwrite existing private key ${privatePath} — delete it first or pass --dir`);
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  mkdirSync(dir, { recursive: true });
  await ensureKeysGitignored(root, dir);

  writeFileSync(privatePath, privatePem.endsWith("\n") ? privatePem : privatePem + "\n");
  writeFileSync(publicPath, publicPem.endsWith("\n") ? publicPem : publicPem + "\n");
  try {
    chmodSync(privatePath, 0o600);
  } catch {
    // Best effort: some platforms/filesystems do not expose POSIX modes.
  }

  await assertPrivateKeyNotTracked(root, privatePath);
  return { keyid: keyidFromPem(publicPem), privatePath, publicPath };
}

/** Append `.agent-attest/keys/` to the repo .gitignore (idempotent). */
async function ensureKeysGitignored(root: string, dir: string): Promise<void> {
  if (!existsSync(join(root, ".git"))) return; // not a repo (yet) — nothing to protect
  const rel = toPosix(relative(root, dir));
  if (rel.startsWith("..") || isAbsolute(rel)) return; // keys live outside the repo
  const gitignore = join(root, ".gitignore");
  const existing = existsSync(gitignore) ? readTextNormalized(gitignore) : "";
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(rel) || lines.includes(rel + "/")) return;
  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  const next = existing + (needsNewline ? "\n" : "") + `${rel}/\n`;
  writeFileSync(gitignore, next);
}

/**
 * Refuse to operate when the private key is tracked by git. Anything tracked
 * is world-readable to everyone who can clone the repo, which equals forge
 * capability over the whole attestation chain.
 */
export async function assertPrivateKeyNotTracked(root: string, privatePath: string): Promise<void> {
  if (!existsSync(join(root, ".git"))) return;
  const rel = toPosix(relative(root, privatePath));
  if (rel.startsWith("..") || isAbsolute(rel)) return; // key outside the repo — nothing to check
  const r = await git(["ls-files", "--", rel], { cwd: root });
  if (r.code === 0 && r.stdout.trim().length > 0) {
    throw new Error(
      `refusing: private key ${rel} is tracked by git — run \`git rm --cached ${rel}\` and keep it ignored. ` +
        `A tracked private key lets anyone with repo access forge attestations.`,
    );
  }
}

export interface KeyMaterial {
  privatePem: string;
  publicPem: string;
  keyid: string;
  privatePath: string;
  publicPath: string;
}

/** Load the signing material for a repo (env paths override repo defaults). */
export function loadKeyMaterial(root: string): KeyMaterial {
  const privatePath = privateKeyPathFor(root);
  const publicPath = publicKeyPathFor(root);
  if (!existsSync(privatePath)) {
    throw new Error(`private key not found at ${privatePath} — run \`agent-attest keygen\` or set AGENT_ATTEST_PRIVATE_KEY`);
  }
  if (!existsSync(publicPath)) {
    throw new Error(`public key not found at ${publicPath} — run \`agent-attest keygen\` or set AGENT_ATTEST_PUBLIC_KEY`);
  }
  const privatePem = readFileSync(privatePath, "utf8");
  const publicPem = readFileSync(publicPath, "utf8");
  return { privatePem, publicPem, keyid: keyidFromPem(publicPem), privatePath, publicPath };
}

/** Load the public key used to verify attestations (env path overrides repo default). */
export function loadPublicKey(root: string): { publicPem: string; keyid: string; publicPath: string } {
  const publicPath = publicKeyPathFor(root);
  if (!existsSync(publicPath)) {
    throw new Error(`public key not found at ${publicPath} — run \`agent-attest keygen\` or set AGENT_ATTEST_PUBLIC_KEY`);
  }
  const publicPem = readFileSync(publicPath, "utf8");
  return { publicPem, keyid: keyidFromPem(publicPem), publicPath };
}
