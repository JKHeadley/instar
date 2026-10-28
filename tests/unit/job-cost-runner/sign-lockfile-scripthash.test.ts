/**
 * job-cost-reduction §5.1 — the signer adds a raw-bytes scriptHash for a
 * `runner: script` template; the runtime reader keeps it under the signature
 * (verifies present-trusted) and a tampered scriptHash breaks the signature.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readLockFile, hashScriptBytes } from '../../../src/scheduler/AgentMdLockFile.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sign-script-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.join(ws, '.instar-release-keys'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.instar-release-keys', 'private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.mkdirSync(path.join(ws, 'src', 'scaffold', 'keys'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'scaffold', 'keys', 'instar-release-pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 't', version: '0.0.1' }));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(ws, 'node_modules'));
  fs.mkdirSync(path.join(ws, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'sign-instar-lockfile.mjs'), path.join(ws, 'scripts', 'sign-instar-lockfile.mjs'));
  const tdir = path.join(ws, 'src', 'scaffold', 'templates', 'jobs', 'instar');
  fs.mkdirSync(path.join(tdir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tdir, 'probe.md'), '---\nname: "Probe"\nrunner: "script"\nscript: "probe.mjs"\n---\nbody\n');
  fs.writeFileSync(path.join(tdir, 'plain.md'), '---\nname: "Plain"\n---\nbody\n');
  fs.writeFileSync(path.join(tdir, 'scripts', 'probe.mjs'), 'console.log("JOB_RESULT ok")\n');
});
afterAll(() => SafeFsExecutor.safeRmSync(ws, { recursive: true, force: true, operation: 'sign-lockfile-scripthash cleanup' }));

describe('sign-instar-lockfile scriptHash', () => {
  it('signs a scriptHash for script templates only, and the reader trusts it', () => {
    execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--quiet'], { cwd: ws });
    const lock = JSON.parse(fs.readFileSync(path.join(ws, 'dist', 'jobs', 'instar.lock.json'), 'utf-8'));
    const probe = lock.entries.find((e: { slug: string }) => e.slug === 'probe');
    const plain = lock.entries.find((e: { slug: string }) => e.slug === 'plain');
    expect(probe.scriptHash).toBe(hashScriptBytes('console.log("JOB_RESULT ok")\n'));
    expect(plain.scriptHash).toBeUndefined();

    const jobsRoot = path.join(ws, '.instar', 'jobs');
    fs.mkdirSync(jobsRoot, { recursive: true });
    fs.writeFileSync(path.join(jobsRoot, 'instar.lock.json'), JSON.stringify(lock));
    const r = readLockFile(jobsRoot, ws);
    expect(r.state).toBe('present-trusted');
    if (r.state === 'present-trusted') expect(r.bySlug.get('probe')!.scriptHash).toBe(probe.scriptHash);

    // The signature covers scriptHash: swapping it breaks verification.
    probe.scriptHash = hashScriptBytes('evil');
    fs.writeFileSync(path.join(jobsRoot, 'instar.lock.json'), JSON.stringify(lock));
    expect(readLockFile(jobsRoot, ws).state).toBe('present-untrusted');
  });

  it('fails the build when a script template names a missing script', () => {
    const tdir = path.join(ws, 'src', 'scaffold', 'templates', 'jobs', 'instar');
    fs.writeFileSync(path.join(tdir, 'ghost.md'), '---\nname: "Ghost"\nrunner: "script"\nscript: "ghost.mjs"\n---\nbody\n');
    expect(() => execFileSync('node', ['scripts/sign-instar-lockfile.mjs', '--quiet'], { cwd: ws, stdio: 'pipe' })).toThrow();
    SafeFsExecutor.safeUnlinkSync(path.join(tdir, 'ghost.md'), { operation: 'tests/unit/job-cost-runner/sign-lockfile-scripthash.test.ts' });
  });
});
