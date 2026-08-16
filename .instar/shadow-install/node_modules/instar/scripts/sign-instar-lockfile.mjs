#!/usr/bin/env node
/**
 * sign-instar-lockfile.mjs — Phase 1c-build signer for the instar-default
 * lock-file.
 *
 * Walks src/scaffold/templates/jobs/instar/*.md, parses YAML frontmatter and
 * body for each shipped default, computes normalized body+frontmatter hashes
 * using the SAME canonicalization the runtime verifier applies (see
 * src/scheduler/AgentMdLockFile.ts), and emits a signed lock-file at
 * dist/jobs/instar.lock.json.
 *
 * Signing key resolution (in order of precedence):
 *   1. env INSTAR_RELEASE_PRIVATE_KEY_PEM            (raw PEM, for CI)
 *   2. env INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH       (path to PEM)
 *   3. .instar-release-keys/private.pem               (local dev key)
 *
 * If no key is found, the script writes the lock-file with an empty
 * signature and exits 0 with a clear warning. This lets `npm run build`
 * succeed in environments without the signing key (test, CI without the
 * secret, fresh checkout). The runtime treats unsigned/invalid-signed
 * lock-files as `present-untrusted` — degraded mode rather than broken
 * boot.
 *
 * Output:
 *   dist/jobs/instar.lock.json     — signed lock-file (bundled with npm package)
 *   dist/keys/instar-release-pub.pem — public key (copied from src/scaffold/keys/)
 *
 * Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §Trust Model + §Lock-file.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const TEMPLATES_DIR = path.join(ROOT, 'src', 'scaffold', 'templates', 'jobs', 'instar');
const PUBLIC_KEY_SRC = path.join(ROOT, 'src', 'scaffold', 'keys', 'instar-release-pub.pem');
const DIST_LOCKFILE = path.join(ROOT, 'dist', 'jobs', 'instar.lock.json');
const DIST_PUBLIC_KEY = path.join(ROOT, 'dist', 'keys', 'instar-release-pub.pem');

// ── Normalize + hash (mirror of AgentMdLockFile.ts) ───────────────────────

const ZERO_WIDTH_CHARS_RE = /[​-‍﻿]/g;

function normalize(content) {
  return (content.replace(/\r\n/g, '\n').replace(ZERO_WIDTH_CHARS_RE, '').trimEnd() + '\n');
}

function hashBody(content) {
  const normalized = normalize(content);
  return 'sha256:' + crypto.createHash('sha256').update(normalized).digest('hex');
}

function hashFrontmatter(frontmatter) {
  const canonical = canonicalizeForHash(frontmatter);
  return hashBody(canonical);
}

function canonicalizeForHash(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalizeForHash(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys
        .filter((k) => value[k] !== null && value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonicalizeForHash(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

// ── Template walker ───────────────────────────────────────────────────────

function listTemplateFiles() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(TEMPLATES_DIR, f))
    .sort();
}

function parseAgentMd(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`${filePath}: missing YAML frontmatter delimited by --- on lines 1 and N`);
  }
  const [, frontmatterRaw, body] = match;
  const frontmatter = yaml.load(frontmatterRaw, { schema: yaml.FAILSAFE_SCHEMA });
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error(`${filePath}: frontmatter must parse to an object`);
  }
  return { frontmatter, body };
}

function slugFromFilename(filePath) {
  return path.basename(filePath, '.md');
}

// ── Key resolution ────────────────────────────────────────────────────────

function resolvePrivateKey() {
  if (process.env.INSTAR_RELEASE_PRIVATE_KEY_PEM) {
    return { source: 'env-raw', pem: process.env.INSTAR_RELEASE_PRIVATE_KEY_PEM };
  }
  const envPath = process.env.INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return { source: `env-path:${envPath}`, pem: fs.readFileSync(envPath, 'utf-8') };
  }
  const devPath = path.join(ROOT, '.instar-release-keys', 'private.pem');
  if (fs.existsSync(devPath)) {
    return { source: 'local-dev-key', pem: fs.readFileSync(devPath, 'utf-8') };
  }
  return null;
}

// ── Sign ──────────────────────────────────────────────────────────────────

function signCanonicalPayload(canonical, privateKeyPem) {
  let key;
  try {
    key = crypto.createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new Error(`Failed to load private key: ${err.message}`);
  }
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf-8'), key);
  return signature.toString('base64');
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const quiet = args.includes('--quiet');

  const log = (...m) => { if (!quiet) console.log('[sign-lockfile]', ...m); };

  const files = listTemplateFiles();
  log(`Scanning ${TEMPLATES_DIR} — found ${files.length} template(s)`);

  const entries = [];
  for (const f of files) {
    let parsed;
    try {
      parsed = parseAgentMd(f);
    } catch (err) {
      console.error(`[sign-lockfile] FATAL: ${err.message}`);
      process.exit(1);
    }
    const slug = slugFromFilename(f);
    entries.push({
      slug,
      bodyHash: hashBody(parsed.body),
      frontmatterHash: hashFrontmatter(parsed.frontmatter),
    });
    log(`  hashed ${slug}`);
  }

  entries.sort((a, b) => a.slug.localeCompare(b.slug));

  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const instarVersion = pkgJson.version;

  const keyInfo = resolvePrivateKey();
  const keyId = keyInfo ? deriveKeyId(keyInfo.pem) : 'unsigned';

  const generatedAt = new Date().toISOString();

  // Canonical payload (everything except `signature`).
  const canonical = canonicalizeForHash({
    instarVersion,
    generatedAt,
    entries,
    keyId,
  });

  if (!keyInfo) {
    log('WARNING: No signing key found. Skipping lock-file generation.');
    log('  Set INSTAR_RELEASE_PRIVATE_KEY_PEM in CI, or generate a local dev key:');
    log('    node scripts/generate-instar-release-key.mjs');
    log('  Without a lock-file, the runtime treats all origin:instar entries as');
    log('  lockTrust=untrusted-no-lockfile (documented transitional state). Phase 1');
    log('  ships in this state until the production key is wired into the release');
    log('  pipeline.');
    // Remove any stale lock-file so the runtime sees `absent`, not stale.
    if (fs.existsSync(DIST_LOCKFILE)) {
      fs.unlinkSync(DIST_LOCKFILE);
      log(`Removed stale ${DIST_LOCKFILE}`);
    }
    // Still copy the public key if present so the bundled package can verify
    // future signed lock-files once a release ships with one.
    if (fs.existsSync(PUBLIC_KEY_SRC)) {
      fs.mkdirSync(path.dirname(DIST_PUBLIC_KEY), { recursive: true });
      fs.copyFileSync(PUBLIC_KEY_SRC, DIST_PUBLIC_KEY);
      log(`Copied public key to ${DIST_PUBLIC_KEY}`);
    }
    return;
  }

  const signature = signCanonicalPayload(canonical, keyInfo.pem);
  log(`Signed with key source: ${keyInfo.source}, keyId=${keyId.slice(0, 32)}…`);

  const lockFile = {
    instarVersion,
    generatedAt,
    entries,
    keyId,
    signature,
  };

  if (dryRun) {
    console.log(JSON.stringify(lockFile, null, 2));
    return;
  }

  // Write lock-file.
  fs.mkdirSync(path.dirname(DIST_LOCKFILE), { recursive: true });
  fs.writeFileSync(DIST_LOCKFILE, JSON.stringify(lockFile, null, 2) + '\n', 'utf-8');
  log(`Wrote ${DIST_LOCKFILE}`);

  // Copy public key into dist for bundling.
  if (fs.existsSync(PUBLIC_KEY_SRC)) {
    fs.mkdirSync(path.dirname(DIST_PUBLIC_KEY), { recursive: true });
    fs.copyFileSync(PUBLIC_KEY_SRC, DIST_PUBLIC_KEY);
    log(`Copied public key to ${DIST_PUBLIC_KEY}`);
  } else {
    log(`WARNING: No public key at ${PUBLIC_KEY_SRC} — bundled package will be unverifiable.`);
    log('  Generate a keypair: node scripts/generate-instar-release-key.mjs');
  }
}

function deriveKeyId(privatePem) {
  // Derive a stable keyId from the corresponding public key fingerprint.
  // Lets agents detect rotation without requiring the private key itself
  // to be visible anywhere.
  try {
    const priv = crypto.createPrivateKey(privatePem);
    const pub = crypto.createPublicKey(priv);
    const der = pub.export({ type: 'spki', format: 'der' });
    const fp = crypto.createHash('sha256').update(der).digest('hex');
    return `instar-release/sha256:${fp}`;
  } catch {
    return 'unsigned';
  }
}

main();
