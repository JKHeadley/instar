/**
 * Lifeline ingress secret (docs/specs/telegram-internal-route-lifeline-secret.md):
 * creation is atomic + exclusive, the file is owner-only, the compare is
 * constant-time shaped, and the value never reaches a process environment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureLifelineIngressSecret,
  readLifelineIngressSecret,
  lifelineIngressSecretPath,
  lifelineSecretMatches,
  LifelineIngressSecretHolder,
  LIFELINE_INGRESS_SECRET_RELPATH,
  SECRET_LOAD_BACKOFF_MS,
  sharedLifelineIngressSecretHolder,
} from '../../src/core/LifelineIngressSecret.js';
import { KEY_MATERIAL_PATHS, KEY_MATERIAL_FILES } from '../../src/core/keyMaterialPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/lifeline-ingress-secret.test.ts';

describe('lifeline ingress secret file', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-secret-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('creates 32 random bytes (64 hex chars) in an owner-only file', () => {
    expect(readLifelineIngressSecret(stateDir)).toBeNull();
    const value = ensureLifelineIngressSecret(stateDir);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    const st = fs.statSync(lifelineIngressSecretPath(stateDir));
    expect(st.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(lifelineIngressSecretPath(stateDir), 'utf-8')).toBe(value);
  });

  it('the second starter reads the first starter\'s value instead of replacing it', () => {
    const first = ensureLifelineIngressSecret(stateDir);
    const second = ensureLifelineIngressSecret(stateDir);
    expect(second).toBe(first);
    expect(readLifelineIngressSecret(stateDir)).toBe(first);
  });

  it('two different state dirs get different secrets', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-secret-b-'));
    try {
      expect(ensureLifelineIngressSecret(stateDir)).not.toBe(ensureLifelineIngressSecret(other));
    } finally {
      SafeFsExecutor.safeRmSync(other, { recursive: true, force: true, operation: OP });
    }
  });

  it('leaves no temp file behind, on the create path or the read path', () => {
    ensureLifelineIngressSecret(stateDir);
    ensureLifelineIngressSecret(stateDir);
    expect(fs.readdirSync(path.join(stateDir, 'state'))).toEqual(['lifeline-ingress-secret']);
  });

  it('replaces a malformed file rather than using it', () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(lifelineIngressSecretPath(stateDir), 'not-a-secret');
    expect(readLifelineIngressSecret(stateDir)).toBeNull();
    const value = ensureLifelineIngressSecret(stateDir);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(readLifelineIngressSecret(stateDir)).toBe(value);
    expect(fs.readdirSync(path.join(stateDir, 'state'))).toEqual(['lifeline-ingress-secret']);
  });

  it('holder caches, and reload() picks up a replaced file', () => {
    const holder = new LifelineIngressSecretHolder(stateDir);
    const first = holder.get();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const replacement = 'a'.repeat(64);
    fs.writeFileSync(lifelineIngressSecretPath(stateDir), replacement);
    expect(holder.get()).toBe(first); // cached
    expect(holder.reload()).toBe(replacement);
    expect(holder.get()).toBe(replacement);
  });

  it('holder returns null instead of throwing when the file cannot be created', () => {
    fs.writeFileSync(path.join(stateDir, 'state'), 'a file where the directory should be');
    expect(new LifelineIngressSecretHolder(stateDir).get()).toBeNull();
  });

  it('a file that cannot be READ is never replaced (a read fault is not "malformed")', () => {
    // A directory at the secret's path: reading fails with EISDIR, not ENOENT.
    fs.mkdirSync(lifelineIngressSecretPath(stateDir), { recursive: true });
    expect(() => ensureLifelineIngressSecret(stateDir)).toThrow();
    expect(fs.statSync(lifelineIngressSecretPath(stateDir)).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(stateDir, 'state'))).toEqual(['lifeline-ingress-secret']);
  });

  it('a failed re-read keeps the last good value', () => {
    const holder = new LifelineIngressSecretHolder(stateDir);
    const first = holder.get()!;
    SafeFsExecutor.safeRmSync(lifelineIngressSecretPath(stateDir), { force: true, operation: OP });
    fs.mkdirSync(lifelineIngressSecretPath(stateDir));
    expect(holder.reload()).toBe(first);
    expect(holder.get()).toBe(first);
    expect(holder.held).toBe(true);
    expect(holder.fileReadable()).toBe(false);
    expect(holder.failedLoads).toBe(1);
  });

  it('a failed first load is retried only after the backoff, and then succeeds', () => {
    let now = 1_000_000;
    fs.writeFileSync(path.join(stateDir, 'state'), 'a file where the directory should be');
    const holder = new LifelineIngressSecretHolder(stateDir, () => now);
    expect(holder.get()).toBeNull();
    expect(holder.failedLoads).toBe(1);
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'state'), { force: true, operation: OP });
    now += SECRET_LOAD_BACKOFF_MS - 1;
    expect(holder.get()).toBeNull(); // still backing off: the filesystem was not touched
    expect(fs.existsSync(path.join(stateDir, 'state'))).toBe(false);
    now += 1;
    expect(holder.get()).toMatch(/^[0-9a-f]{64}$/);
    expect(holder.failedLoads).toBe(0);
  });

  it('fileReadable() never creates the file', () => {
    const holder = new LifelineIngressSecretHolder(stateDir);
    expect(holder.fileReadable()).toBe(false);
    expect(fs.existsSync(lifelineIngressSecretPath(stateDir))).toBe(false);
  });
});

describe('shared holder and file timestamp', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-secret-shared-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('one holder per state dir per process, so the guard and the server\'s own call cannot disagree', () => {
    const a = sharedLifelineIngressSecretHolder(stateDir);
    const b = sharedLifelineIngressSecretHolder(path.join(stateDir, '.'));
    expect(b).toBe(a);
    expect(a.get()).toBe(b.get());
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-secret-shared-b-'));
    try {
      expect(sharedLifelineIngressSecretHolder(other)).not.toBe(a);
    } finally {
      SafeFsExecutor.safeRmSync(other, { recursive: true, force: true, operation: OP });
    }
  });

  it('fileMtimeMs is null before the file exists and its timestamp after', () => {
    const holder = new LifelineIngressSecretHolder(stateDir);
    expect(holder.fileMtimeMs()).toBeNull();
    holder.get();
    const when = new Date('2026-01-02T03:04:05.000Z');
    fs.utimesSync(lifelineIngressSecretPath(stateDir), when, when);
    expect(holder.fileMtimeMs()).toBe(when.getTime());
  });
});

describe('lifelineSecretMatches', () => {
  const secret = 'f'.repeat(64);
  it('accepts the exact value', () => expect(lifelineSecretMatches(secret, secret)).toBe(true));
  it('refuses a near miss of the same length', () => {
    expect(lifelineSecretMatches('f'.repeat(63) + 'e', secret)).toBe(false);
  });
  it('refuses a prefix, an empty string and a non-string', () => {
    expect(lifelineSecretMatches(secret.slice(0, 32), secret)).toBe(false);
    expect(lifelineSecretMatches('', secret)).toBe(false);
    expect(lifelineSecretMatches(undefined, secret)).toBe(false);
    expect(lifelineSecretMatches([secret], secret)).toBe(false);
  });
  it('refuses everything when our own secret is unavailable', () => {
    expect(lifelineSecretMatches(secret, null)).toBe(false);
  });
});

describe('the secret never reaches a process environment', () => {
  it('creating and holding the secret leaves process.env without it', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-secret-env-'));
    try {
      const value = new LifelineIngressSecretHolder(stateDir).get()!;
      for (const v of Object.values(process.env)) expect(v ?? '').not.toContain(value);
    } finally {
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP });
    }
  });

  it('no source file that handles the secret writes to process.env or a tmux -e flag', () => {
    const root = path.resolve(__dirname, '..', '..', 'src');
    for (const rel of ['core/LifelineIngressSecret.ts', 'server/LifelineIngressGuard.ts']) {
      const code = fs.readFileSync(path.join(root, rel), 'utf-8')
        .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(code).not.toMatch(/process\.env/);
      expect(code).not.toMatch(/'-e'/);
    }
    // SessionManager builds every spawned session's environment; it must not
    // know the secret exists.
    const sm = fs.readFileSync(path.join(root, 'core/SessionManager.ts'), 'utf-8');
    expect(sm).not.toMatch(/LifelineIngressSecret|lifeline-ingress-secret|LIFELINE_SECRET/);
  });
});

describe('the secret file is registered as key material', () => {
  it('is in the never-served / never-backed-up / gitignored list and the hard-link file list', () => {
    const rel = LIFELINE_INGRESS_SECRET_RELPATH.split(path.sep).join('/');
    expect(rel).toBe('state/lifeline-ingress-secret');
    expect(KEY_MATERIAL_PATHS).toContain(rel);
    expect(KEY_MATERIAL_FILES).toContain(rel);
  });
});
