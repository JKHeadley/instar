import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP_CONTROL_MARKER, DesktopAead } from '../../src/core/DesktopAead.js';
import { desktopLockedSettingsDigest, mintDesktopLockedAssertion, verifyDesktopLockedAssertion, mintDesktopOperatorAssertion } from '../../src/core/DesktopOperatorAssertion.js';

const REQUEST = '11111111-2222-3333-4444-555555555555';
const FRONT = `m_${'a'.repeat(32)}`;
const TARGET = `m_${'b'.repeat(32)}`;

describe('control records', () => {
  const key = crypto.randomBytes(32);
  const open = (record: Buffer, domain: number, label: string) => {
    const sequence = record.readBigUInt64BE(0) & 0x00ff_ffff_ffff_ffffn;
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(domain, 0);
    iv.writeBigUInt64BE(sequence, 4);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(['instar-desktop-aead-v1', REQUEST, label])));
    decipher.setAuthTag(record.subarray(record.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(record.subarray(8, record.length - 16)), decipher.final()]).toString());
  };

  it('carries its marker, opens only in domain 3, and keeps its own sequence', () => {
    const aead = new DesktopAead(key, REQUEST);
    aead.encryptFrame(Buffer.alloc(8, 1));
    const record = aead.encryptControl({ type: 'state', state: 'locked-in-session' });
    expect(record[0]).toBe(DESKTOP_CONTROL_MARKER);
    expect(record.readBigUInt64BE(0) & 0x00ff_ffff_ffff_ffffn).toBe(1n);
    expect(open(record, 3, 'control')).toEqual({ type: 'state', state: 'locked-in-session' });
    expect(() => open(record, 2, 'control')).toThrow();
    expect(() => open(record, 3, 'input')).toThrow();
  });

  it('never leaves a frame looking stale after a control record overtakes it', () => {
    const aead = new DesktopAead(key, REQUEST);
    const first = aead.encryptFrame(Buffer.alloc(8, 1));
    aead.encryptControl({ type: 'seal', key: 'k' });
    const second = aead.encryptFrame(Buffer.alloc(8, 2));
    expect(first.readBigUInt64BE(0)).toBe(1n);
    expect(second.readBigUInt64BE(0)).toBe(2n);
  });

  it('gives every implementation an explicit third IV domain', () => {
    const viewer = fs.readFileSync(path.resolve('dashboard/desktop.js'), 'utf8');
    expect(viewer).toContain('{ frame: 1, input: 2, control: 3 }');
    expect(viewer).not.toContain("direction === 'frame' ? 1 : 2");
    expect(fs.readFileSync(path.resolve('src/core/DesktopAead.ts'), 'utf8')).not.toContain("direction === 'frame' ? 1 : 2");
  });
});

describe('locked-screen operator assertion', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const sign = (canonical: string) => crypto.sign(null, Buffer.from(canonical), pair.privateKey).toString('base64');
  const check = (canonical: string, signature: string) => crypto.verify(null, Buffer.from(canonical), pair.publicKey, Buffer.from(signature, 'base64'));
  const verify = (assertion: ReturnType<typeof mintDesktopLockedAssertion>, settings: unknown, over: Partial<Parameters<typeof verifyDesktopLockedAssertion>[0]> = {}) =>
    verifyDesktopLockedAssertion({ assertion, expectedTargetMachineId: TARGET, expectedIssuerMachineId: FRONT, settings,
      nowMs: 5_000, resolveIssuerKey: () => 'key', verifySignature: check, seenJti: () => false, ...over });
  const mint = (settings: unknown = { enabled: true }) => mintDesktopLockedAssertion({ issuerMachineId: FRONT, targetMachineId: TARGET,
    operation: 'locked-settings', settings, nowMs: 1_000, sign });

  it('accepts the signed settings and refuses a changed setting', () => {
    expect(verify(mint(), { enabled: true }).ok).toBe(true);
    expect(verify(mint(), { enabled: false })).toEqual({ ok: false, reason: 'wrong-browser' });
  });

  it('refuses the wrong target, a replay, expiry, and a bad signature', () => {
    expect(verify(mint(), { enabled: true }, { expectedTargetMachineId: FRONT })).toEqual({ ok: false, reason: 'wrong-target' });
    expect(verify(mint(), { enabled: true }, { seenJti: () => true })).toEqual({ ok: false, reason: 'replayed' });
    expect(verify(mint(), { enabled: true }, { nowMs: 40_000 })).toEqual({ ok: false, reason: 'expired' });
    expect(verify({ ...mint(), signature: 'x'.repeat(64) }, { enabled: true })).toEqual({ ok: false, reason: 'signature-invalid' });
  });

  it('leaves begin bytes unchanged for targets not yet updated', () => {
    const begin = mintDesktopOperatorAssertion({ issuerMachineId: FRONT, targetMachineId: TARGET,
      browserPublicKey: 'key', browserNonce: 'n'.repeat(16), nowMs: 1_000, sign });
    expect(begin.version).toBe('instar-desktop-operator-v1');
    expect(begin.operation).toBe('begin');
    expect(desktopLockedSettingsDigest({ a: 1 })).toHaveLength(43);
  });
});

describe('no route originates a password', () => {
  it('only the stream decoder and the viewers reach secretType', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.ts$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
    const callers = walk('src').filter(file => /\.secretType\b/.test(fs.readFileSync(file, 'utf8')));
    expect(callers.map(file => path.basename(file))).toEqual(['DirectDesktopAccess.ts']);
    const routes = fs.readFileSync('src/server/routes.ts', 'utf8');
    expect(routes).not.toMatch(/secretType/);
    expect(fs.readFileSync('src/server/machineRoutes.ts', 'utf8')).not.toMatch(/secretType/);
  });
});
