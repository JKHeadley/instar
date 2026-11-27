/**
 * Identity A5's one-time ceremony credential (docs/specs/identity-security-piece3e-same-network-first-phone.md §4.6):
 * made inside the agent's own system, only its hash on disk, single use, three wrong tries, ten minutes,
 * this machine and this ceremony only, and refused from an unsafe file. Both sides of every boundary.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CEREMONY_CREDENTIAL_MAX_FAILURES, CEREMONY_CREDENTIAL_TTL_MS, ceremonyCredentialPath, mintCeremonyCredential, spendCeremonyCredential,
} from '../../src/core/ceremonyCredential.js';
import { KEY_MATERIAL_FILES, KEY_MATERIAL_PATHS } from '../../src/core/keyMaterialPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/ceremony-credential.test.ts' }); });
function dir(): string { const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'icc-')); dirs.push(d); return d; }
const T0 = Date.parse('2026-11-19T20:00:00Z');
const M = 'm_self';
const mint = (d: string, now = T0) => mintCeremonyCredential(d, { scope: 'phone-setup', machineId: M, now });
const spend = (d: string, c: unknown, now = T0, machineId: string | null = M) => spendCeremonyCredential(d, c, { scope: 'phone-setup', machineId, now });

describe('the one-time ceremony credential (A5)', () => {
  it('the right credential is accepted once, then it is gone', () => {
    const d = dir();
    const { credential, expiresAt } = mint(d);
    expect(credential).toMatch(/^icc1_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt)).toBe(T0 + CEREMONY_CREDENTIAL_TTL_MS);
    expect(spend(d, credential)).toEqual({ ok: true });
    expect(fs.existsSync(ceremonyCredentialPath(d))).toBe(false);
    expect(spend(d, credential)).toEqual({ ok: false, reason: 'none' });
  });

  it('only its hash is on disk, in a file only the agent\'s user can read', () => {
    const d = dir();
    const { credential } = mint(d);
    const file = ceremonyCredentialPath(d);
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toContain(credential);
    expect(text).not.toContain(credential.slice(5));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
  });

  it('a new one replaces the old one', () => {
    const d = dir();
    const old = mint(d).credential;
    const now = mint(d).credential;
    expect(spend(d, old).ok).toBe(false);
    expect(spend(d, now)).toEqual({ ok: true });
  });

  it('wrong tries: two leave it usable, the third deletes it', () => {
    const d = dir();
    const { credential } = mint(d);
    for (let i = 1; i < CEREMONY_CREDENTIAL_MAX_FAILURES; i++) expect(spend(d, `icc1_${'A'.repeat(43)}`)).toEqual({ ok: false, reason: 'wrong' });
    expect(spend(d, credential)).toEqual({ ok: true });
    const d2 = dir();
    const c2 = mint(d2).credential;
    for (let i = 0; i < CEREMONY_CREDENTIAL_MAX_FAILURES; i++) expect(spend(d2, 'nope').ok).toBe(false);
    expect(fs.existsSync(ceremonyCredentialPath(d2))).toBe(false);
    expect(spend(d2, c2)).toEqual({ ok: false, reason: 'none' });
  });

  it('anything not the credential is wrong: another type, too long, no prefix', () => {
    const d = dir();
    const { credential } = mint(d);
    expect(spend(d, undefined).ok).toBe(false);
    expect(spend(d, 12345).ok).toBe(false);
    expect(spend(d, credential + 'x'.repeat(200)).ok).toBe(false);
    expect(spend(d, credential.slice(5)).ok).toBe(false);
  });

  it('lapses after ten minutes: accepted at the last moment, refused one millisecond after, and deleted', () => {
    const d = dir();
    const { credential } = mint(d);
    expect(spend(d, credential, T0 + CEREMONY_CREDENTIAL_TTL_MS)).toEqual({ ok: true });
    const d2 = dir();
    const c2 = mint(d2).credential;
    expect(spend(d2, c2, T0 + CEREMONY_CREDENTIAL_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(fs.existsSync(ceremonyCredentialPath(d2))).toBe(false);
  });

  it('a stored lapse time beyond the credential\'s own life is refused (a hand edit or an old file), as is one made in the future', () => {
    const d = dir();
    const { credential } = mint(d);
    const file = ceremonyCredentialPath(d);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, expiresAt: new Date(T0 + CEREMONY_CREDENTIAL_TTL_MS + 1).toISOString() }), { mode: 0o600 });
    expect(spend(d, credential)).toEqual({ ok: false, reason: 'expired' });
    expect(fs.existsSync(file)).toBe(false);
    const d2 = dir();
    const c2 = mint(d2, T0 + 120_000).credential;
    expect(spend(d2, c2, T0)).toEqual({ ok: false, reason: 'expired' });
    const d3 = dir();
    const c3 = mint(d3, T0 + 30_000).credential; // within the clock allowance
    expect(spend(d3, c3, T0)).toEqual({ ok: true });
  });

  it('this machine only: another machine id, or none, is refused and the file deleted', () => {
    const d = dir();
    const { credential } = mint(d);
    expect(spend(d, credential, T0, 'm_other')).toEqual({ ok: false, reason: 'wrong-machine' });
    expect(fs.existsSync(ceremonyCredentialPath(d))).toBe(false);
    const d2 = dir();
    const c2 = mint(d2).credential;
    expect(spend(d2, c2, T0, null)).toEqual({ ok: false, reason: 'wrong-machine' });
    expect(() => mintCeremonyCredential(dir(), { scope: 'phone-setup', machineId: '' })).toThrow();
  });

  it('this ceremony only: a credential for another ceremony is refused and left for it; an unknown ceremony is never minted', () => {
    const d = dir();
    const { credential } = mint(d);
    const file = ceremonyCredentialPath(d);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, scope: 'recovery' }), { mode: 0o600 });
    expect(spend(d, credential)).toEqual({ ok: false, reason: 'wrong-scope' });
    expect(fs.existsSync(file)).toBe(true);
    expect(() => mintCeremonyCredential(dir(), { scope: 'recovery' as never, machineId: M })).toThrow();
  });

  it('an unsafe file is never a credential: readable by others, a link, or unparseable', () => {
    const d = dir();
    const { credential } = mint(d);
    const file = ceremonyCredentialPath(d);
    fs.chmodSync(file, 0o644);
    expect(spend(d, credential)).toEqual({ ok: false, reason: 'unsafe-file' });
    expect(fs.existsSync(file)).toBe(false);

    const d2 = dir();
    const c2 = mint(d2).credential;
    const f2 = ceremonyCredentialPath(d2);
    const elsewhere = path.join(d2, 'elsewhere.json');
    fs.renameSync(f2, elsewhere);
    fs.symlinkSync(elsewhere, f2);
    expect(spend(d2, c2)).toEqual({ ok: false, reason: 'unsafe-file' });

    const d3 = dir();
    mint(d3);
    fs.writeFileSync(ceremonyCredentialPath(d3), '{not json', { mode: 0o600 });
    expect(spend(d3, 'icc1_x')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('the open handle is what is checked and read: a second name, a FIFO or a directory is refused', () => {
    const d = dir();
    const { credential } = mint(d);
    const file = ceremonyCredentialPath(d);
    // A second name (hard link) for the file: another program could hold it, so it is refused.
    const twin = path.join(d, 'twin.json');
    fs.linkSync(file, twin);
    expect(spend(d, credential)).toEqual({ ok: false, reason: 'unsafe-file' });
    expect(fs.existsSync(file)).toBe(false);

    // A FIFO at the path neither blocks the open nor counts as a credential.
    const d2 = dir();
    fs.mkdirSync(path.dirname(ceremonyCredentialPath(d2)), { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', ['-m', '600', ceremonyCredentialPath(d2)], { stdio: 'ignore' });
    expect(spend(d2, 'icc1_x')).toEqual({ ok: false, reason: 'unsafe-file' });

    // A directory at the path is not a credential either.
    const d3 = dir();
    fs.mkdirSync(ceremonyCredentialPath(d3), { recursive: true, mode: 0o700 });
    expect(spend(d3, 'icc1_x').ok).toBe(false);
  });

  it('opens the file once and checks that handle before reading it (no path check, then path read)', () => {
    const d = dir();
    const { credential } = mint(d);
    const lstat = vi.spyOn(fs, 'lstatSync');
    const stat = vi.spyOn(fs, 'statSync');
    const fstat = vi.spyOn(fs, 'fstatSync');
    const readFile = vi.spyOn(fs, 'readFileSync');
    try {
      expect(spend(d, credential)).toEqual({ ok: true });
      const file = ceremonyCredentialPath(d);
      const order = (m: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }, pick: (c: unknown[]) => boolean): number[] =>
        m.mock.calls.map((c, i) => (pick(c) ? m.mock.invocationCallOrder[i] : -1)).filter((x) => x >= 0);
      const fdReads = order(readFile, (c) => typeof c[0] === 'number');
      const fstats = order(fstat, () => true);
      expect(fdReads.length).toBeGreaterThan(0);
      expect(fstats.length).toBeGreaterThan(0);
      // The handle was checked before it was read.
      expect(fstats[0]).toBeLessThan(fdReads[0]);
      // Never read by path, and no path check before the read (the delete after acceptance may look at the path).
      expect(order(readFile, (c) => c[0] === file)).toHaveLength(0);
      expect([...order(lstat, (c) => c[0] === file), ...order(stat, (c) => c[0] === file)].filter((x) => x < fdReads[0])).toHaveLength(0);
    } finally {
      lstat.mockRestore(); stat.mockRestore(); fstat.mockRestore(); readFile.mockRestore();
    }
  });

  it('the file is key material: never served, written, backed up or synced over HTTP', () => {
    expect(KEY_MATERIAL_PATHS).toContain('state/ceremony-credential.json');
    expect(KEY_MATERIAL_FILES).toContain('state/ceremony-credential.json');
  });
});
