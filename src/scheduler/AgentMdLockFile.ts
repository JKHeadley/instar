/**
 * AgentMdLockFile — Phase 1c runtime consumer for the signed instar-default
 * lock-file.
 *
 * The lock-file (`.instar/jobs/instar.lock.json`) is the structural trust
 * authority for "is this slug a real instar default." A separate build-time
 * pipeline (Phase 1c-build, follow-up PR) signs it at release time with the
 * instar release private key; the corresponding public key is bundled into
 * the installed npm package at `dist/keys/instar-release-pub.pem`.
 *
 * Phase 1c-runtime (this module) is the consumer:
 *   - Schema definition for the on-disk lock-file format
 *   - Reader + signature verifier (Ed25519 via `node:crypto`)
 *   - Hash lookup helper for instar-origin slugs
 *   - The shared `normalize()` function that both signing and verification
 *     apply to body + frontmatter before hashing
 *
 * Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §Trust Model
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ── Schema ────────────────────────────────────────────────────────────────

/** One entry per shipped instar default, keyed by slug. */
export interface LockFileEntry {
  slug: string;
  bodyHash: string;        // sha256:<hex> over normalize(body)
  frontmatterHash: string; // sha256:<hex> over normalize(canonicalize(frontmatter))
}

/** The on-disk shape of `.instar/jobs/instar.lock.json`. */
export interface LockFile {
  instarVersion: string;
  generatedAt: string;            // ISO 8601
  entries: LockFileEntry[];
  keyId: string;                  // identifies the signing key used (forward-compat)
  signature: string;              // base64 Ed25519 over the canonical-JSON entries
  significantChanges?: Array<{ slug: string; significant: boolean; reason: string }>;
}

/** Result of attempting to load + verify the lock-file. */
export type LockFileLoadResult =
  | { state: 'present-trusted'; lockFile: LockFile; bySlug: Map<string, LockFileEntry> }
  | { state: 'present-untrusted'; lockFile: LockFile; reason: string }
  | { state: 'absent' }
  | { state: 'malformed'; reason: string };

// ── Constants ─────────────────────────────────────────────────────────────

/** Bundled-key path resolved relative to the installed package's `dist/`.
 *  When developing in-repo, the same relative path applies inside the worktree. */
const BUNDLED_PUBLIC_KEY_RELATIVE = 'dist/keys/instar-release-pub.pem';

/** Hard size cap on the lock-file. A reasonable upper bound for ~50 default
 *  jobs × ~200 bytes/entry = 10 KB. Anything larger is suspect. */
const MAX_LOCKFILE_BYTES = 64 * 1024;

// ── Normalize + hash (shared with build-time signing) ─────────────────────

const ZERO_WIDTH_CHARS_RE = /[​-‍﻿]/g;

/**
 * Spec §Hash normalization: the same transformation applies at release-time
 * signing AND at runtime verification. Without a shared normalize() the
 * lock-file produced on Linux LF would mismatch the file on disk on
 * CRLF-autocrlf Windows checkouts. The normalization is conservative:
 *   - CRLF → LF
 *   - strip ZWSP/ZWNJ/ZWJ/BOM
 *   - trimEnd()
 *   - ensure exactly one trailing newline
 */
export function normalize(content: string): string {
  return (
    content
      .replace(/\r\n/g, '\n')
      .replace(ZERO_WIDTH_CHARS_RE, '')
      .trimEnd() + '\n'
  );
}

/** sha256(normalize(content)) returned as `sha256:<hex>`. */
export function hashBody(content: string): string {
  const normalized = normalize(content);
  const h = crypto.createHash('sha256').update(normalized).digest('hex');
  return `sha256:${h}`;
}

/**
 * Frontmatter hash uses the same normalize-then-sha256 path, applied to a
 * canonical-JSON serialization. Sorted keys → hash is stable across YAML
 * insertion order. Null/undefined values are dropped (they're equivalent in
 * frontmatter and shouldn't break trust on insertion).
 */
export function hashFrontmatter(frontmatter: Record<string, unknown>): string {
  const canonical = canonicalizeForHash(frontmatter);
  return hashBody(canonical);
}

function canonicalizeForHash(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalizeForHash(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys
        .filter((k) => obj[k] !== null && obj[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonicalizeForHash(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

// ── Loader ────────────────────────────────────────────────────────────────

/**
 * Read + verify the lock-file. Returns a structured result the caller can
 * pattern-match on. The four states correspond to the spec's failure modes:
 *
 *   - 'present-trusted'   → signature OK; bySlug is the lookup index
 *   - 'present-untrusted' → file is parseable JSON but signature failed
 *                           (degraded mode: caller MUST treat all
 *                           instar-origin entries as untrusted)
 *   - 'absent'            → no lock-file present (clean dev install pre-1c-build,
 *                           OR build-pipeline-not-yet-shipping signed lock-files)
 *   - 'malformed'         → file exists but cannot be parsed as JSON or fails
 *                           schema validation
 *
 * The reader DOES NOT decide what behavior to apply — that's the caller's
 * job. It only reports what it observed.
 */
export function readLockFile(jobsRootDir: string, packageRoot?: string): LockFileLoadResult {
  const lockPath = path.join(jobsRootDir, 'instar.lock.json');
  if (!fs.existsSync(lockPath)) {
    return { state: 'absent' };
  }

  let raw: string;
  try {
    const stat = fs.statSync(lockPath);
    if (stat.size > MAX_LOCKFILE_BYTES) {
      return { state: 'malformed', reason: `Lock-file exceeds ${MAX_LOCKFILE_BYTES}-byte size cap (${stat.size} bytes)` };
    }
    raw = fs.readFileSync(lockPath, 'utf-8');
  } catch (err) {
    return { state: 'malformed', reason: `Failed to read lock-file: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: 'malformed', reason: `Lock-file is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const schemaCheck = validateLockFileSchema(parsed);
  if (!schemaCheck.ok) {
    return { state: 'malformed', reason: schemaCheck.reason };
  }
  const lockFile = schemaCheck.lockFile;

  // Signature verification. The bundled public key is at
  // <packageRoot>/dist/keys/instar-release-pub.pem. In Phase 1c-runtime the
  // signed lock-file will not exist in production yet (build pipeline is the
  // follow-up PR); for forward-compat we still attempt verification when
  // both the lock-file AND the public key are present. The absence of EITHER
  // produces 'present-untrusted' — the runtime never trusts an instar-origin
  // entry without cryptographic verification, by design.
  const pubKeyPath = packageRoot
    ? path.join(packageRoot, BUNDLED_PUBLIC_KEY_RELATIVE)
    : resolveBundledPublicKey();

  if (!pubKeyPath || !fs.existsSync(pubKeyPath)) {
    return {
      state: 'present-untrusted',
      lockFile,
      reason: 'No bundled instar release public key found — signature cannot be verified',
    };
  }

  const verifyResult = verifySignature(lockFile, pubKeyPath);
  if (!verifyResult.ok) {
    return { state: 'present-untrusted', lockFile, reason: verifyResult.reason };
  }

  const bySlug = new Map<string, LockFileEntry>();
  for (const entry of lockFile.entries) {
    bySlug.set(entry.slug, entry);
  }
  return { state: 'present-trusted', lockFile, bySlug };
}

/** Resolve the bundled public key path by walking up from this module. */
function resolveBundledPublicKey(): string | null {
  // From `dist/scheduler/AgentMdLockFile.js`, walk up to `dist/` then to keys.
  // In a fresh install this lands at `<install>/dist/keys/...` which is what
  // we want.
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'keys', 'instar-release-pub.pem');
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
  } catch {
    // import.meta.url may not be available in some contexts; the caller can
    // pass an explicit packageRoot.
  }
  return null;
}

function validateLockFileSchema(
  parsed: unknown,
): { ok: true; lockFile: LockFile } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'Lock-file root must be an object' };
  }
  const obj = parsed as Record<string, unknown>;

  for (const field of ['instarVersion', 'generatedAt', 'keyId', 'signature']) {
    if (typeof obj[field] !== 'string' || !(obj[field] as string).trim()) {
      return { ok: false, reason: `Lock-file field "${field}" must be a non-empty string` };
    }
  }
  if (!Array.isArray(obj.entries)) {
    return { ok: false, reason: 'Lock-file "entries" must be an array' };
  }

  const entries: LockFileEntry[] = [];
  for (let i = 0; i < obj.entries.length; i++) {
    const e = obj.entries[i] as Record<string, unknown>;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, reason: `Lock-file entry[${i}] must be an object` };
    }
    if (typeof e.slug !== 'string' || !e.slug.trim()) {
      return { ok: false, reason: `Lock-file entry[${i}].slug must be a non-empty string` };
    }
    if (typeof e.bodyHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.bodyHash)) {
      return { ok: false, reason: `Lock-file entry[${i}].bodyHash must match sha256:<64-hex>` };
    }
    if (typeof e.frontmatterHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(e.frontmatterHash)) {
      return { ok: false, reason: `Lock-file entry[${i}].frontmatterHash must match sha256:<64-hex>` };
    }
    entries.push({
      slug: e.slug,
      bodyHash: e.bodyHash,
      frontmatterHash: e.frontmatterHash,
    });
  }

  return {
    ok: true,
    lockFile: {
      instarVersion: obj.instarVersion as string,
      generatedAt: obj.generatedAt as string,
      entries,
      keyId: obj.keyId as string,
      signature: obj.signature as string,
      significantChanges: Array.isArray(obj.significantChanges)
        ? (obj.significantChanges as LockFile['significantChanges'])
        : undefined,
    },
  };
}

/**
 * Verify the Ed25519 signature on the lock-file. The signature covers the
 * canonical-JSON serialization of `{instarVersion, generatedAt, entries, keyId}`
 * — everything EXCEPT the signature field itself. The same canonicalization
 * runs at build-time signing (Phase 1c-build PR).
 */
function verifySignature(
  lockFile: LockFile,
  publicKeyPath: string,
): { ok: true } | { ok: false; reason: string } {
  let publicKeyPem: string;
  try {
    publicKeyPem = fs.readFileSync(publicKeyPath, 'utf-8');
  } catch (err) {
    return { ok: false, reason: `Failed to read bundled public key at ${publicKeyPath}: ${err instanceof Error ? err.message : String(err)}` };
  }

  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch (err) {
    return { ok: false, reason: `Bundled public key is malformed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Canonical JSON over everything except `signature`. The build-time signer
  // uses the same canonicalization.
  const canonical = canonicalizeForHash({
    instarVersion: lockFile.instarVersion,
    generatedAt: lockFile.generatedAt,
    entries: lockFile.entries,
    keyId: lockFile.keyId,
  });

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(lockFile.signature, 'base64');
  } catch {
    return { ok: false, reason: 'Lock-file signature is not valid base64' };
  }

  try {
    const verified = crypto.verify(null, Buffer.from(canonical, 'utf-8'), publicKey, signatureBytes);
    if (!verified) {
      return { ok: false, reason: 'Lock-file signature failed Ed25519 verification' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Signature verification threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Look up a slug in a trusted lock-file. Returns null if the slug is not in
 * the locked default set — caller should treat that as "this slug claims
 * origin:instar but is not a real default" and downgrade trust.
 */
export function lookupSlug(
  bySlug: Map<string, LockFileEntry>,
  slug: string,
): LockFileEntry | null {
  return bySlug.get(slug) ?? null;
}
