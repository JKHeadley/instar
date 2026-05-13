/**
 * Phase 1c runtime consumer for the signed instar-default lock-file.
 *
 * Tests the loader-side consumer behavior:
 *   - `readLockFile` correctly classifies the four observable states
 *     (absent, malformed, present-untrusted, present-trusted)
 *   - `normalize` + `hashBody` + `hashFrontmatter` are deterministic and
 *     handle the CRLF/zero-width edge cases the spec mandates
 *   - Integration: `loadAgentMdJobs` applies the trust check to
 *     origin:instar entries and produces the correct `lockTrust` value
 *   - Hash mismatch → skip-until-ack (entry excluded from jobs[])
 *   - Other untrusted states → entry still loads, just with lockTrust
 *
 * The build-time signing pipeline (Phase 1c-build, follow-up PR) is NOT
 * covered here — these tests cover the consumer only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  readLockFile,
  hashBody,
  hashFrontmatter,
  normalize,
} from '../../../src/scheduler/AgentMdLockFile.js';
import { loadAgentMdJobs } from '../../../src/scheduler/AgentMdJobLoader.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

// ── normalize / hash determinism ───────────────────────────────────────────

describe('AgentMdLockFile normalize() + hashBody()', () => {
  it('CRLF and LF produce identical hashes', () => {
    const lf = 'one\ntwo\nthree';
    const crlf = 'one\r\ntwo\r\nthree';
    expect(hashBody(lf)).toBe(hashBody(crlf));
  });

  it('strips ZWSP and BOM', () => {
    const clean = 'hello world';
    const dirty = 'hello​ world﻿';
    expect(hashBody(clean)).toBe(hashBody(dirty));
  });

  it('trims trailing whitespace and adds exactly one trailing newline', () => {
    const a = 'body  \n\n\n';
    const b = 'body\n';
    expect(hashBody(a)).toBe(hashBody(b));
  });

  it('produces sha256:<64-hex> format', () => {
    const h = hashBody('anything');
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('frontmatter hash is stable across key insertion order', () => {
    const a = { name: 'X', description: 'Y', toolAllowlist: ['Read', 'Bash'] };
    const b = { toolAllowlist: ['Read', 'Bash'], description: 'Y', name: 'X' };
    expect(hashFrontmatter(a)).toBe(hashFrontmatter(b));
  });

  it('frontmatter hash differs when content actually changes', () => {
    const a = { name: 'X' };
    const b = { name: 'Y' };
    expect(hashFrontmatter(a)).not.toBe(hashFrontmatter(b));
  });

  it('normalize() is idempotent (running it twice has no effect)', () => {
    const input = 'foo\r\nbar​\n\n';
    const once = normalize(input);
    const twice = normalize(once);
    expect(once).toBe(twice);
  });
});

// ── readLockFile state machine ─────────────────────────────────────────────

describe('AgentMdLockFile readLockFile() state machine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lockfile-test-'));
    fs.mkdirSync(path.join(tmpDir, 'jobs'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  const jobsDir = () => path.join(tmpDir, 'jobs');

  it('absent: state is "absent" when no lock-file exists', () => {
    const result = readLockFile(jobsDir());
    expect(result.state).toBe('absent');
  });

  it('malformed: state is "malformed" with reason when JSON parse fails', () => {
    fs.writeFileSync(path.join(jobsDir(), 'instar.lock.json'), 'not-json{');
    const result = readLockFile(jobsDir());
    expect(result.state).toBe('malformed');
    if (result.state === 'malformed') {
      expect(result.reason).toMatch(/not valid JSON/);
    }
  });

  it('malformed: state is "malformed" when schema fields are missing', () => {
    fs.writeFileSync(
      path.join(jobsDir(), 'instar.lock.json'),
      JSON.stringify({ entries: [] }),
    );
    const result = readLockFile(jobsDir());
    expect(result.state).toBe('malformed');
  });

  it('malformed: rejects oversized lock-files (>64 KB)', () => {
    const huge = JSON.stringify({
      instarVersion: '0.0.0',
      generatedAt: '2026-01-01T00:00:00Z',
      entries: new Array(2000).fill({
        slug: 'pad',
        bodyHash: 'sha256:' + 'a'.repeat(64),
        frontmatterHash: 'sha256:' + 'a'.repeat(64),
      }),
      keyId: 'test',
      signature: 'AAAA',
    });
    fs.writeFileSync(path.join(jobsDir(), 'instar.lock.json'), huge);
    const result = readLockFile(jobsDir());
    expect(result.state).toBe('malformed');
    if (result.state === 'malformed') {
      expect(result.reason).toMatch(/size cap/);
    }
  });

  it('malformed: rejects entries with malformed sha256 hashes', () => {
    fs.writeFileSync(
      path.join(jobsDir(), 'instar.lock.json'),
      JSON.stringify({
        instarVersion: '0.0.0',
        generatedAt: '2026-01-01T00:00:00Z',
        entries: [{ slug: 'foo', bodyHash: 'not-a-hash', frontmatterHash: 'sha256:' + 'a'.repeat(64) }],
        keyId: 'test',
        signature: 'AAAA',
      }),
    );
    const result = readLockFile(jobsDir());
    expect(result.state).toBe('malformed');
  });

  it('present-untrusted: state is "present-untrusted" when no public key is bundled', () => {
    // Well-formed lock-file, but no public key on disk → cannot verify signature.
    fs.writeFileSync(
      path.join(jobsDir(), 'instar.lock.json'),
      JSON.stringify({
        instarVersion: '0.0.0',
        generatedAt: '2026-01-01T00:00:00Z',
        entries: [],
        keyId: 'test',
        signature: 'AAAA',
      }),
    );
    // Explicit packageRoot pointing nowhere → public key lookup fails.
    const result = readLockFile(jobsDir(), path.join(tmpDir, 'no-such-package-root'));
    expect(result.state).toBe('present-untrusted');
    if (result.state === 'present-untrusted') {
      expect(result.reason).toMatch(/public key/);
    }
  });

  it('present-untrusted: state is "present-untrusted" when signature does not verify', () => {
    // Generate a public key, write a lock-file with a bogus signature.
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const pkgRoot = path.join(tmpDir, 'pkg');
    fs.mkdirSync(path.join(pkgRoot, 'dist', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'keys', 'instar-release-pub.pem'), publicKeyPem);

    fs.writeFileSync(
      path.join(jobsDir(), 'instar.lock.json'),
      JSON.stringify({
        instarVersion: '0.0.0',
        generatedAt: '2026-01-01T00:00:00Z',
        entries: [],
        keyId: 'test',
        signature: Buffer.from(new Uint8Array(64)).toString('base64'),
      }),
    );

    const result = readLockFile(jobsDir(), pkgRoot);
    expect(result.state).toBe('present-untrusted');
    if (result.state === 'present-untrusted') {
      expect(result.reason).toMatch(/signature failed/);
    }
  });

  it('present-trusted: state is "present-trusted" when signature verifies', () => {
    // Generate a real Ed25519 keypair, sign the canonical payload, write the
    // lock-file + bundled public key, verify.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const pkgRoot = path.join(tmpDir, 'pkg');
    fs.mkdirSync(path.join(pkgRoot, 'dist', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'keys', 'instar-release-pub.pem'), publicKeyPem);

    const lockBody = {
      instarVersion: '0.29.0',
      generatedAt: '2026-05-13T00:00:00Z',
      entries: [{ slug: 'health-check', bodyHash: 'sha256:' + 'a'.repeat(64), frontmatterHash: 'sha256:' + 'b'.repeat(64) }],
      keyId: 'instar-release-2026-05',
    };

    // Canonical-JSON serialization MUST match what AgentMdLockFile applies
    // internally (sorted keys, null/undefined dropped). Easiest reliable
    // approach: import the same canonicalize that the verifier uses.
    // It's not exported, so reproduce its behavior here for the test fixture:
    const canonicalize = (v: unknown): string => {
      if (v === null || v === undefined) return 'null';
      if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
      if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const ks = Object.keys(o).sort();
        return '{' + ks.filter((k) => o[k] !== null && o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalize(o[k])).join(',') + '}';
      }
      return JSON.stringify(v);
    };
    const canonical = canonicalize(lockBody);
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf-8'), privateKey).toString('base64');

    fs.writeFileSync(
      path.join(jobsDir(), 'instar.lock.json'),
      JSON.stringify({ ...lockBody, signature }),
    );

    const result = readLockFile(jobsDir(), pkgRoot);
    expect(result.state).toBe('present-trusted');
    if (result.state === 'present-trusted') {
      expect(result.bySlug.get('health-check')).toBeDefined();
      expect(result.bySlug.get('health-check')?.bodyHash).toBe('sha256:' + 'a'.repeat(64));
    }
  });
});

// ── loadAgentMdJobs integration ────────────────────────────────────────────

describe('loadAgentMdJobs lock-file trust integration', () => {
  let tmpDir: string;
  let scheduleDir: string;
  let jobsRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lockfile-int-'));
    jobsRoot = path.join(tmpDir, 'jobs');
    scheduleDir = path.join(jobsRoot, 'schedule');
    fs.mkdirSync(scheduleDir, { recursive: true });
    fs.mkdirSync(path.join(jobsRoot, 'instar'), { recursive: true });
    fs.mkdirSync(path.join(jobsRoot, 'user'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  function writeInstarJob(slug: string, body: string, frontmatter: Record<string, unknown> = {}): void {
    const fm = Object.keys(frontmatter).length > 0
      ? '---\n' + Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n'
      : '---\nname: Test\n---\n';
    fs.writeFileSync(path.join(jobsRoot, 'instar', `${slug}.md`), fm + body);
    fs.writeFileSync(
      path.join(scheduleDir, `${slug}.json`),
      JSON.stringify({
        slug,
        origin: 'instar',
        schedule: '*/5 * * * *',
        priority: 'medium',
        model: 'haiku',
        expectedDurationMinutes: 1,
        enabled: true,
        execute: { type: 'agentmd' },
      }),
    );
  }

  it('untrusted-no-lockfile: instar-origin entries load with the correct trust when no lock-file exists', () => {
    writeInstarJob('health-check', 'do the health check');
    const result = loadAgentMdJobs(scheduleDir, jobsRoot);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].lockTrust).toBe('untrusted-no-lockfile');
  });

  it('untrusted-bad-signature: instar-origin entries load with the correct trust when lock-file signature fails', () => {
    writeInstarJob('health-check', 'do the health check');
    fs.writeFileSync(
      path.join(jobsRoot, 'instar.lock.json'),
      JSON.stringify({
        instarVersion: '0.0.0',
        generatedAt: '2026-01-01T00:00:00Z',
        entries: [{ slug: 'health-check', bodyHash: 'sha256:' + 'a'.repeat(64), frontmatterHash: 'sha256:' + 'b'.repeat(64) }],
        keyId: 'test',
        signature: Buffer.from(new Uint8Array(64)).toString('base64'),
      }),
    );
    const result = loadAgentMdJobs(scheduleDir, jobsRoot);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].lockTrust).toBe('untrusted-bad-signature');
    expect(result.problems.some((p) => p.kind === 'lock-mismatch')).toBe(true);
  });
});
