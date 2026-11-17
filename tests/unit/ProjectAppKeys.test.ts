import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ProjectAppKeyStore, ProjectAppKeyError } from '../../src/core/ProjectAppKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const APP = 'pa_0123456789abcdef';
let dir: string; let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-keys-')); file = path.join(dir, 'state', 'project-app-keys.json'); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ProjectAppKeys.test.ts:cleanup' }); });

describe('the per-machine app key file', () => {
  it('creates generations per app and kind, written owner-only (0600)', () => {
    const s = new ProjectAppKeyStore({ filePath: file });
    const d1 = s.create(APP, 'data'); const d2 = s.create(APP, 'data'); const src = s.create(APP, 'source'); const h = s.create(APP, 'hmac');
    expect([d1.gen, d2.gen, src.gen, h.gen]).toEqual([1, 2, 1, 1]);
    expect(d1.key.length).toBe(32);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = new ProjectAppKeyStore({ filePath: file });
    expect(again.get(APP, 'data', 1)?.equals(d1.key)).toBe(true);
    expect(again.current(APP, 'data')?.gen).toBe(2);
    expect(again.generations(APP, 'data')).toEqual([1, 2]);
  });
  it('a destroyed generation is deny-listed: get and put refuse it, and create never reuses its number', () => {
    const s = new ProjectAppKeyStore({ filePath: file });
    const k = s.create(APP, 'source');
    s.destroy(APP, 'source', 1);
    expect(s.get(APP, 'source', 1)).toBeNull();
    expect(s.isRevoked(APP, 'source', 1)).toBe(true);
    expect(s.put(APP, 'source', 1, k.key)).toEqual({ ok: false, reason: 'revoked' });
    expect(new ProjectAppKeyStore({ filePath: file }).put(APP, 'source', 1, k.key)).toEqual({ ok: false, reason: 'revoked' });
    expect(s.create(APP, 'source').gen).toBe(2);
  });
  it('the erase watermark destroys every data generation ≤ N, including ones offered later', () => {
    const s = new ProjectAppKeyStore({ filePath: file });
    s.create(APP, 'data'); s.create(APP, 'data'); s.create(APP, 'source');
    expect(s.eraseData(APP, 2)).toEqual([1, 2]);
    expect(s.generations(APP, 'data')).toEqual([]);
    expect(s.generations(APP, 'source')).toEqual([1]); // erasing data never touches source
    // a returning machine offers gen 1, which this machine never deny-listed by number
    expect(s.put(APP, 'data', 1, randomBytes(32))).toEqual({ ok: false, reason: 'revoked' });
    expect(s.create(APP, 'data').gen).toBe(3);
    expect(s.put(APP, 'data', 4, randomBytes(32))).toEqual({ ok: true });
  });
  it('put stores a fetched generation once; a different key for the same generation is a conflict', () => {
    const s = new ProjectAppKeyStore({ filePath: file });
    const k = randomBytes(32);
    expect(s.put(APP, 'hmac', 3, k)).toEqual({ ok: true });
    expect(s.put(APP, 'hmac', 3, k)).toEqual({ ok: true });
    expect(s.put(APP, 'hmac', 3, randomBytes(32))).toEqual({ ok: false, reason: 'conflict' });
    expect(s.put(APP, 'hmac', 0, k)).toEqual({ ok: false, reason: 'invalid' });
    expect(s.put(APP, 'hmac', 4, randomBytes(16))).toEqual({ ok: false, reason: 'invalid' });
  });
  it('delete-app destroys every kind and refuses create and put', () => {
    const s = new ProjectAppKeyStore({ filePath: file });
    s.create(APP, 'data'); s.create(APP, 'source');
    s.destroyApp(APP);
    expect(s.get(APP, 'data', 1)).toBeNull();
    expect(s.put(APP, 'hmac', 9, randomBytes(32))).toEqual({ ok: false, reason: 'revoked' });
    expect(() => s.create(APP, 'data')).toThrow(ProjectAppKeyError);
  });
  it('applies folded revocations (records, watermarks, deleted apps) idempotently', () => {
    const s = new ProjectAppKeyStore({ filePath: file });
    s.create(APP, 'data'); s.create(APP, 'source'); s.create(APP, 'source');
    const r = { revoked: [{ appId: APP, keyKind: 'source' as const, gen: 1 }], eraseWatermarks: { [APP]: 1 } };
    s.applyRevocations(r); s.applyRevocations(r);
    expect(s.generations(APP, 'source')).toEqual([2]);
    expect(s.generations(APP, 'data')).toEqual([]);
  });
  it('an unreadable key file is an error, never an empty store', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json', { mode: 0o600 });
    expect(() => new ProjectAppKeyStore({ filePath: file }).get(APP, 'data', 1)).toThrow(ProjectAppKeyError);
  });
});

describe('applyRevocations: one bad entry never blocks the rest', () => {
  it('an out-of-range erase watermark (2000000) is reported and a valid explicit revocation is still applied', () => {
    const s = new ProjectAppKeyStore({ filePath: file });
    const OTHER = 'pa_fedcba9876543210';
    s.create(APP, 'data'); s.create(OTHER, 'source'); s.create(OTHER, 'source');
    const r = s.applyRevocations({
      eraseWatermarks: { [APP]: 2_000_000 },
      revoked: [{ appId: OTHER, keyKind: 'bogus' as never, gen: 1 }, { appId: OTHER, keyKind: 'source', gen: 1 }],
    });
    expect(r.failed.map((f) => f.what).sort()).toEqual(['erase-data', 'revoke:bogus:1']);
    expect(s.get(OTHER, 'source', 1)).toBeNull();
    expect(s.isRevoked(OTHER, 'source', 1)).toBe(true);
    expect(s.get(OTHER, 'source', 2)).not.toBeNull();
    expect(s.get(APP, 'data', 1)).not.toBeNull(); // the refused watermark destroyed nothing
  });
});
