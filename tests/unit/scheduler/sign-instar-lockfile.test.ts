/**
 * Phase 1c-build — verify the build-time signer produces a lock-file the
 * Phase 1c-runtime verifier accepts.
 *
 * Roundtrip: generate keypair → write templates → run signer → read
 * resulting lock-file with the runtime verifier → expect 'present-trusted'.
 *
 * This is the canonical assertion that the signer and verifier agree on
 * canonicalization, normalization, and signature format. If this test fails,
 * a release would ship an unverifiable lock-file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readLockFile,
  hashBody,
  hashFrontmatter,
} from '../../../src/scheduler/AgentMdLockFile.js';
import { readVerifiedPackagedCatalog, readVerifiedPackagedDoorwayAssets } from '../../../src/core/VerifiedPackagedCatalog.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SIGNER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sign-instar-lockfile.mjs');
const FIXTURE_ENV = { ...process.env, INSTAR_RELEASE_PRIVATE_KEY_PEM: '', INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH: '' };

describe('sign-instar-lockfile build script', () => {
  let workspace: string;
  let keyDir: string;
  let templatesDir: string;
  let distDir: string;
  let publicKeyDir: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sign-test-'));
    keyDir = path.join(workspace, '.instar-release-keys');
    templatesDir = path.join(workspace, 'src', 'scaffold', 'templates', 'jobs', 'instar');
    publicKeyDir = path.join(workspace, 'src', 'scaffold', 'keys');
    distDir = path.join(workspace, 'dist');
    fs.mkdirSync(keyDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(publicKeyDir, { recursive: true });

    // Generate a fresh keypair for this test.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(
      path.join(keyDir, 'private.pem'),
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { encoding: 'utf-8', mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(publicKeyDir, 'instar-release-pub.pem'),
      publicKey.export({ type: 'spki', format: 'pem' }),
      'utf-8',
    );

    // Minimal package.json so signer can read version.
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'sign-test', version: '0.0.1' }, null, 2),
      'utf-8',
    );

    // Copy js-yaml dependency from the real workspace (signer imports it).
    fs.symlinkSync(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(workspace, 'node_modules'),
    );
    // Copy the signer script into the workspace so its relative __dirname → ROOT
    // path computation resolves correctly.
    const scriptsDir = path.join(workspace, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(SIGNER_SCRIPT, path.join(scriptsDir, 'sign-instar-lockfile.mjs'));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'sign-instar-lockfile.test cleanup' });
  });

  it('produces a present-trusted lock-file from empty templates dir', () => {
    execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--quiet'], { cwd: workspace, env: FIXTURE_ENV });

    const distLock = path.join(distDir, 'jobs', 'instar.lock.json');
    expect(fs.existsSync(distLock)).toBe(true);

    // Move lock-file into the location the runtime expects (jobsRoot).
    const jobsRoot = path.join(workspace, '.instar', 'jobs');
    fs.mkdirSync(jobsRoot, { recursive: true });
    fs.copyFileSync(distLock, path.join(jobsRoot, 'instar.lock.json'));

    const result = readLockFile(jobsRoot, workspace);
    expect(result.state).toBe('present-trusted');
    if (result.state === 'present-trusted') {
      expect(result.lockFile.entries).toEqual([]);
      expect(result.lockFile.catalogHash).toBeUndefined();
      expect(result.lockFile.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(result.lockFile.keyId).toMatch(/^instar-release\/sha256:[0-9a-f]{64}$/);
    }
  });

  it('hashes match runtime verifier for a populated template', () => {
    // Author one template file.
    const slug = 'sample-default';
    const body = '# Sample\n\nDo the thing.\n';
    const frontmatter = {
      name: 'Sample Default',
      description: 'A test default',
      schedule: '*/5 * * * *',
      priority: 'low',
      expectedDurationMinutes: '1',
      model: 'haiku',
      enabled: 'true',
      toolAllowlist: ['Read'],
    };
    const fmYaml = Object.entries(frontmatter)
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: [${v.map((x) => `"${x}"`).join(', ')}]`;
        if (typeof v === 'string') return `${k}: "${v}"`;
        return `${k}: ${v}`;
      })
      .join('\n');
    const fileContent = `---\n${fmYaml}\n---\n${body}`;
    fs.writeFileSync(path.join(templatesDir, `${slug}.md`), fileContent, 'utf-8');

    execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--quiet'], { cwd: workspace, env: FIXTURE_ENV });

    const distLock = path.join(distDir, 'jobs', 'instar.lock.json');
    const lockFile = JSON.parse(fs.readFileSync(distLock, 'utf-8'));
    expect(lockFile.entries).toHaveLength(1);
    expect(lockFile.entries[0].slug).toBe(slug);

    // Runtime verifier computes the same hash from the body string. Note:
    // string values from js-yaml FAILSAFE_SCHEMA stay as strings (no auto-
    // coerce), matching what the loader will produce at runtime.
    const expectedBodyHash = hashBody(body);
    expect(lockFile.entries[0].bodyHash).toBe(expectedBodyHash);

    const expectedFmHash = hashFrontmatter(frontmatter);
    expect(lockFile.entries[0].frontmatterHash).toBe(expectedFmHash);
  });

  it('skips lock-file generation entirely when no signing key is available', () => {
    // Temporarily move the dev key away.
    const keyPath = path.join(keyDir, 'private.pem');
    const stashed = path.join(workspace, 'private.pem.stashed');
    fs.renameSync(keyPath, stashed);
    const distLock = path.join(distDir, 'jobs', 'instar.lock.json');
    // Stash any existing lock-file so we can verify the script removes it.
    if (fs.existsSync(distLock)) SafeFsExecutor.safeUnlinkSync(distLock, { operation: 'sign-instar-lockfile.test pre-clean' });
    try {
      execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--quiet'], {
        cwd: workspace,
        env: FIXTURE_ENV,
      });
      // The signer must NOT have produced a lock-file (no key → no signed
      // file → runtime sees `absent` → lockTrust=untrusted-no-lockfile).
      expect(fs.existsSync(distLock)).toBe(false);

      // The bundled public key SHOULD still be copied so the runtime can
      // verify a future signed lock-file once one ships.
      const distPubKey = path.join(distDir, 'keys', 'instar-release-pub.pem');
      expect(fs.existsSync(distPubKey)).toBe(true);

      // The runtime verifier, given the absent lock-file, returns 'absent'.
      const jobsRoot = path.join(workspace, '.instar', 'jobs');
      fs.mkdirSync(jobsRoot, { recursive: true });
      // Make sure no stale lock-file lingers in the jobs root either.
      const jobsLock = path.join(jobsRoot, 'instar.lock.json');
      if (fs.existsSync(jobsLock)) SafeFsExecutor.safeUnlinkSync(jobsLock, { operation: 'sign-instar-lockfile.test pre-clean' });
      const result = readLockFile(jobsRoot, workspace);
      expect(result.state).toBe('absent');
    } finally {
      fs.renameSync(stashed, keyPath);
    }
  });

  it('signs the exact packaged catalog digest and refuses an altered or stripped digest', () => {
    const catalogPath = path.join(workspace, 'scripts', 'model-registry-freshness.manifest.json');
    const catalogBytes = Buffer.from('{\r\n  "doors": {}\r\n}\r\n');
    fs.writeFileSync(catalogPath, catalogBytes);
    try {
      execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--quiet'], { cwd: workspace, env: FIXTURE_ENV });

      const jobsRoot = path.join(distDir, 'jobs');
      const lockPath = path.join(jobsRoot, 'instar.lock.json');
      expect(readLockFile(jobsRoot, workspace)).toMatchObject({
        state: 'present-trusted',
        lockFile: {
          catalogHash: 'sha256:' + crypto.createHash('sha256').update(catalogBytes).digest('hex'),
        },
      });

      const lockFile = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      const writeDigest = (catalogHash: unknown) => {
        fs.writeFileSync(lockPath, JSON.stringify({ ...lockFile, catalogHash }));
      };
      writeDigest('sha256:' + '0'.repeat(64));
      expect(readLockFile(jobsRoot, workspace).state).toBe('present-untrusted');

      writeDigest(undefined);
      expect(readLockFile(jobsRoot, workspace).state).toBe('present-untrusted');

      writeDigest(null);
      expect(readLockFile(jobsRoot, workspace)).toMatchObject({
        state: 'malformed',
        reason: expect.stringContaining('catalogHash'),
      });
    } finally {
      SafeFsExecutor.safeUnlinkSync(catalogPath, { operation: 'sign-instar-lockfile.test catalog cleanup' });
    }
  });

  it('verifies the exact signed prober and catalog bytes together', () => {
    const catalogPath = path.join(workspace, 'scripts', 'model-registry-freshness.manifest.json');
    const proberPath = path.join(workspace, 'scripts', 'doorway-scan.mjs');
    const alternate = path.join(workspace, 'alternate-prober.mjs');
    const catalog = Buffer.from('{"lastReviewedAt":"2026-11-01","doors":{}}');
    const prober = Buffer.from('export const fixture = true;\r\n');
    const key = crypto.createPublicKey(fs.readFileSync(path.join(publicKeyDir, 'instar-release-pub.pem')));
    const pin = crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    const sign = () => execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--quiet'], { cwd: workspace, env: FIXTURE_ENV });
    const readPair = () => readVerifiedPackagedDoorwayAssets(workspace, '0.0.1', pin);

    fs.writeFileSync(catalogPath, catalog);
    try {
      sign();
      expect(readPair()).toEqual({ status: 'unavailable', reason: 'prober-digest-absent' });

      fs.writeFileSync(proberPath, prober);
      sign();
      expect(readPair()).toMatchObject({ status: 'verified', catalogBytes: catalog, proberBytes: prober });

      fs.writeFileSync(proberPath, prober.toString().replace('\r\n', '\n'));
      expect(readPair()).toEqual({ status: 'tampered', reason: 'prober-digest-mismatch' });
      expect(readVerifiedPackagedCatalog(workspace, '0.0.1', pin).status).toBe('verified');

      SafeFsExecutor.safeUnlinkSync(proberPath, { operation: 'signer prober fixture replacement' });
      expect(readPair()).toEqual({ status: 'unavailable', reason: 'prober-file-unavailable-or-invalid' });

      fs.writeFileSync(alternate, prober);
      fs.symlinkSync(alternate, proberPath);
      expect(readPair()).toEqual({ status: 'tampered', reason: 'prober-file-unavailable-or-invalid' });
    } finally {
      for (const file of [catalogPath, proberPath, alternate]) {
        if (fs.existsSync(file)) SafeFsExecutor.safeUnlinkSync(file, { operation: 'signed assets fixture cleanup' });
      }
    }
  });

  it('--dry-run prints lock-file JSON without writing dist files', () => {
    // Re-run the signer to produce a fresh dist file (prior test may have
    // removed it). This gives dry-run a baseline mtime to compare against.
    execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--quiet'], { cwd: workspace, env: FIXTURE_ENV });
    const distLock = path.join(distDir, 'jobs', 'instar.lock.json');
    const stat = fs.statSync(distLock).mtimeMs;
    const out = execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--dry-run', '--quiet'], {
      cwd: workspace,
      encoding: 'utf-8',
      env: FIXTURE_ENV,
    });
    expect(() => JSON.parse(out)).not.toThrow();
    const json = JSON.parse(out);
    expect(json.entries.length).toBeGreaterThanOrEqual(1);
    // dist file mtime should not have changed.
    expect(fs.statSync(distLock).mtimeMs).toBe(stat);
  });
});
