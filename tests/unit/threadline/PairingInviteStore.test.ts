/**
 * The inviter's open-invite store (docs/specs/a2a-pairing-invite-link.md §4.1, §4.4).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PairingInviteStore, INVITE_STORE_FILE } from '../../../src/threadline/PairingInviteStore.js';
import { createInvite } from '../../../src/threadline/PairingInvite.js';

const T0 = new Date('2026-10-14T12:00:00.000Z');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'invite-store-'));
const inv = (opts: { bindFp?: string; ttlMs?: number } = {}) =>
  createInvite({ identityPubHex: crypto.randomBytes(32).toString('hex'), owner: 'Justin', agent: 'Scout', now: T0, ...opts });
const fileOf = (d: string) => path.join(d, 'threadline', INVITE_STORE_FILE);

describe('PairingInviteStore', () => {
  it('writes the file 0600 and keeps the secret while open', () => {
    const d = dir();
    const s = new PairingInviteStore(d, () => T0);
    const i = inv();
    s.add(i);
    expect(fs.statSync(fileOf(d)).mode & 0o777).toBe(0o600);
    expect(s.getInternal(i.iid)?.secret).toBe(i.secret);
    expect(JSON.stringify(s.list())).not.toContain(i.secret);
  });

  it('single use: markUsed deletes the secret from memory AND from the file, and a second markUsed is refused', () => {
    const d = dir();
    const s = new PairingInviteStore(d, () => T0);
    const i = inv();
    s.add(i);
    expect(s.markUsed(i.iid, { fp: 'a'.repeat(32), key: 'a'.repeat(64), owner: 'Carl', agent: 'C' })).toBe(true);
    expect(s.getInternal(i.iid)).toMatchObject({ state: 'used', acceptor: { fp: 'a'.repeat(32) } });
    expect(s.getInternal(i.iid)?.secret).toBeUndefined();
    expect(fs.readFileSync(fileOf(d), 'utf8')).not.toContain(i.secret);
    expect(s.markUsed(i.iid, { fp: 'b'.repeat(32), key: 'b'.repeat(64), owner: 'X', agent: 'X' })).toBe(false);
  });

  it('expiry deletes the secret, including across a restart', () => {
    const d = dir();
    let now = T0;
    const s = new PairingInviteStore(d, () => now);
    const i = inv();
    s.add(i);
    now = new Date(T0.getTime() + 61 * 60_000);
    const reopened = new PairingInviteStore(d, () => now);
    expect(reopened.getInternal(i.iid)).toMatchObject({ state: 'expired' });
    expect(reopened.getInternal(i.iid)?.secret).toBeUndefined();
    expect(fs.readFileSync(fileOf(d), 'utf8')).not.toContain(i.secret);
  });

  it('one open invite per bound peer: a new one for the same peer revokes the old (and its secret)', () => {
    const s = new PairingInviteStore(dir(), () => T0);
    const peer = 'c'.repeat(32);
    const a = inv({ bindFp: peer });
    const b = inv({ bindFp: peer });
    s.add(a);
    expect(s.add(b)).toEqual({ replaced: a.iid });
    expect(s.getInternal(a.iid)).toMatchObject({ state: 'revoked' });
    expect(s.getInternal(a.iid)?.secret).toBeUndefined();
    expect(s.getInternal(b.iid)?.state).toBe('open');
    // Unbound invites are independent.
    const u1 = inv(); const u2 = inv();
    s.add(u1); s.add(u2);
    expect(s.getInternal(u1.iid)?.state).toBe('open');
  });

  it('revoke closes an open invite and deletes its secret; revoking twice is refused', () => {
    const s = new PairingInviteStore(dir(), () => T0);
    const i = inv();
    s.add(i);
    expect(s.revoke(i.iid)).toBe(true);
    expect(s.getInternal(i.iid)?.secret).toBeUndefined();
    expect(s.revoke(i.iid)).toBe(false);
  });

  it('an unreadable store fails closed: nothing can be accepted', () => {
    const d = dir();
    fs.mkdirSync(path.join(d, 'threadline'), { recursive: true });
    fs.writeFileSync(fileOf(d), '{not json');
    expect(new PairingInviteStore(d, () => T0).list()).toEqual([]);
  });

  it('closed invites are dropped after the retention window', () => {
    const d = dir();
    let now = T0;
    const s = new PairingInviteStore(d, () => now);
    const i = inv();
    s.add(i);
    s.revoke(i.iid);
    now = new Date(T0.getTime() + 9 * 24 * 3600_000);
    expect(s.getInternal(i.iid)).toBeUndefined();
  });
});

describe('PairingInviteStore decisions', () => {
  it('markDecided needs a used invite, is set once, and persists; recordSecondAccept needs a used invite', () => {
    const d = dir();
    const s = new PairingInviteStore(d, () => T0);
    const i = inv();
    s.add(i);
    expect(s.markDecided(i.iid, 'finished')).toBe(false); // still open
    expect(s.recordSecondAccept(i.iid, { fp: 'b'.repeat(32), owner: 'X', agent: 'X' })).toBe(false);
    s.markUsed(i.iid, { fp: 'a'.repeat(32), key: 'a'.repeat(64), owner: 'Carl', agent: 'C' });
    expect(s.markDecided(i.iid, 'finished')).toBe(true);
    expect(s.markDecided(i.iid, 'rejected')).toBe(false);
    expect(s.recordSecondAccept(i.iid, { fp: 'b'.repeat(32), owner: 'X', agent: 'X' })).toBe(true);
    const r = new PairingInviteStore(d, () => T0);
    expect(r.list()[0]).toMatchObject({ decision: 'finished', secondAccept: { fp: 'b'.repeat(32) } });
  });
});
