// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * AC4 (a2a-single-agent-identity §1.5): a disagreeing legacy `threadline/identity.json` is
 * a MIRROR repaired at first load — the canonical file wins AND the legacy file is rewritten
 * to match, under the lock, atomically, the old file backed up as
 * `threadline/identity.json.superseded-<ISO>`; the listener daemon loads the canonical file
 * FIRST; the bootstrap stops a daemon alive under the old key (source-level contract).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager } from '../../src/threadline/client/IdentityManager.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { readIdentityKeyFile } from '../../src/identity/IdentityKeyFile.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', '..', 'src');
const rm = (d: string) => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/agent-identity-legacy-mirror.test.ts' });

function write(stateDir: string, rel: string, kp = generateIdentityKeyPair()): string {
  const full = path.join(stateDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify({ publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'), privateKeyEncryption: 'none', createdAt: '2026-05-01T00:00:00.000Z' }), { mode: 0o600 });
  return computeFingerprint(kp.publicKey);
}

describe('§1.5 the legacy file is a mirror, repaired at first load', () => {
  it('a disagreeing legacy file is rewritten to the canonical identity with a superseded backup; the manager reports the repair once', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    const canonical = write(d, 'identity.json');
    const legacy = write(d, path.join('threadline', 'identity.json'));
    expect(legacy).not.toBe(canonical);
    const m = new IdentityManager(d);
    const id = m.get();
    expect(id?.fingerprint).toBe(canonical);
    expect(m.identityFilesDisagree).toBe(false);
    const repaired = m.legacyMirrorRepaired;
    expect(repaired?.backupPath).toMatch(/threadline\/identity\.json\.superseded-/);
    expect(fs.existsSync(repaired!.backupPath)).toBe(true);
    // The backup holds the OLD key; the legacy path now mirrors the canonical one.
    const backup = readIdentityKeyFile(repaired!.backupPath, { repair: false })!;
    expect(computeFingerprint(backup.publicKey)).toBe(legacy);
    const mirror = readIdentityKeyFile(path.join(d, 'threadline', 'identity.json'), { repair: false })!;
    expect(computeFingerprint(mirror.publicKey)).toBe(canonical);
    expect(mirror.privateKey?.equals(id!.privateKey)).toBe(true);
    expect(fs.statSync(path.join(d, 'threadline', 'identity.json')).mode & 0o077).toBe(0);
    // A second load finds the two files agreeing — no repair, no disagreement.
    const again = new IdentityManager(d);
    expect(again.get()?.fingerprint).toBe(canonical);
    expect(again.legacyMirrorRepaired).toBeNull();
    expect(again.identityFilesDisagree).toBe(false);
    expect(fs.existsSync(path.join(d, 'identity.lock'))).toBe(false); // the lock was released
    rm(d);
  });

  it('two agreeing files are left untouched; a lone canonical or lone legacy file is loaded as before', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    const kp = generateIdentityKeyPair();
    write(d, 'identity.json', kp);
    write(d, path.join('threadline', 'identity.json'), kp);
    const before = fs.readFileSync(path.join(d, 'threadline', 'identity.json'), 'utf-8');
    const m = new IdentityManager(d);
    expect(m.get()?.fingerprint).toBe(computeFingerprint(kp.publicKey));
    expect(m.legacyMirrorRepaired).toBeNull();
    expect(fs.readFileSync(path.join(d, 'threadline', 'identity.json'), 'utf-8')).toBe(before);
    rm(d);
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    const only = write(d2, path.join('threadline', 'identity.json'));
    expect(new IdentityManager(d2).get()?.fingerprint).toBe(only);
    rm(d2);
  });

  it('the listener daemon loads the CANONICAL file first (legacy as its fallback)', () => {
    const src = fs.readFileSync(path.join(SRC, 'threadline', 'listener-daemon.ts'), 'utf-8');
    const primary = src.indexOf('new IdentityManager(config.stateDir)');
    const nested = src.indexOf("new IdentityManager(path.join(config.stateDir, 'threadline'))");
    expect(primary).toBeGreaterThan(0);
    expect(nested).toBeGreaterThan(primary); // the deeper legacy layout is only the fallback
    // And the manager rooted at the state dir reads canonical before legacy:
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    const canonical = write(d, 'identity.json');
    write(d, path.join('threadline', 'identity.json'));
    expect(new IdentityManager(d).get()?.fingerprint).toBe(canonical);
    rm(d);
  });

  it('the bootstrap stops a daemon alive under the superseded key and re-runs its own daemon decision', () => {
    const src = fs.readFileSync(path.join(SRC, 'threadline', 'ThreadlineBootstrap.ts'), 'utf-8');
    expect(src).toContain('routingIdentityManager.legacyMirrorRepaired');
    expect(src).toContain("process.kill(pid, 'SIGTERM')");
    expect(src).toContain('daemonStoppedForMirrorRepair');
    expect(src).toContain('const decideDaemonHandlingRelay = ');
    // The re-run skips the daemon checks once the daemon was stopped for the repair.
    expect(src).toContain('if (relayEnabled && !daemonStoppedForMirrorRepair)');
  });
});
