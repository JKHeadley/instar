/**
 * Refuse-downgrade (docs/specs/threadline-standalone-pairing.md D6/D11, rollout step 6): the
 * encryptedSeen mark on the trust profile (set once, bound to the pinned key, removed only when
 * the person unpairs) and the live off | watch | enforce switch on the receive side.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isAcceptableIdentityKey } from '@sagemindai/threadline-core';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import {
  createRefuseDowngradeCounters,
  noteEncryptedChat,
  refuseDowngradeModeName,
  resolveRefuseDowngradeMode,
  shouldRefuseDowngradedPlaintext,
  type RefuseDowngradeMode,
} from '../../../src/threadline/refuseDowngrade.js';
import { DEV_GATED_FEATURES, getConfigByPath } from '../../../src/core/devGatedFeatures.js';
import { resolveGuardConfigSnapshot } from '../../../src/monitoring/guardPosture.js';

const OFF: RefuseDowngradeMode = { enabled: false, dryRun: true };
const WATCH: RefuseDowngradeMode = { enabled: true, dryRun: true };
const ENFORCE: RefuseDowngradeMode = { enabled: true, dryRun: false };
const OWN_FP = 'f'.repeat(32);

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'refuse-downgrade-'));
const peer = () => {
  // A real Ed25519 key: random bytes are often not a curve point, which pinning refuses (SEC-16, #2229).
  const key = generateIdentityKeyPair().publicKey.toString('hex');
  return { key, fp: key.slice(0, 32) };
};
/** A different key with the same fingerprint that IS a valid curve point (SEC-16 accepts it). */
const otherKeyFor = (fp: string): string => {
  let k = '';
  do { k = fp + crypto.randomBytes(16).toString('hex'); } while (!isAcceptableIdentityKey(Buffer.from(k, 'hex')));
  return k;
};

const chat = (p: { fp: string; key: string }, type?: string, key = p.key) => ({
  from: p.fp, content: { content: 'hi', ...(type ? { type } : {}) }, senderIdentityPub: Buffer.from(key, 'hex'),
});

function invitePaired(): { t: AgentTrustManager; p: { key: string; fp: string } } {
  const t = new AgentTrustManager({ stateDir: dir() });
  const p = peer();
  expect(t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true);
  return { t, p };
}

function sasPaired(): { t: AgentTrustManager; p: { key: string; fp: string } } {
  const t = new AgentTrustManager({ stateDir: dir() });
  const p = peer();
  expect(t.recordPendingVerification(p.fp, { pairingId: 'pid', peerIdentityPub: p.key, sasWords: ['a'], sasFingerprint: 'sfp', ownFp: OWN_FP })).toBe(true);
  expect(t.markMutualVerified(p.fp, { pairingId: 'pid', operatorConfirm: true, ownFp: OWN_FP })).toBe(true);
  return { t, p };
}

describe('the switch', () => {
  it('resolves like encryptToPinned: dev gate when enabled is omitted, dryRun true unless explicitly false', () => {
    expect(resolveRefuseDowngradeMode({}, {})).toEqual(OFF);
    expect(resolveRefuseDowngradeMode({}, { developmentAgent: true })).toEqual(WATCH);
    expect(resolveRefuseDowngradeMode({ enabled: true, dryRun: false }, {})).toEqual(ENFORCE);
    expect(resolveRefuseDowngradeMode({}, { threadline: { refuseDowngrade: { enabled: true, dryRun: false } } })).toEqual(ENFORCE);
    // The live value wins over the file (live-read switch).
    expect(resolveRefuseDowngradeMode({ enabled: false }, { threadline: { refuseDowngrade: { enabled: true, dryRun: false } } })).toEqual({ enabled: false, dryRun: false });
    expect([OFF, WATCH, ENFORCE].map(refuseDowngradeModeName)).toEqual(['off', 'watch', 'enforce']);
  });

  it('is registered as a dev-gated feature, so /guards shows it resolved (live on a dev agent, dark on the fleet)', () => {
    expect(DEV_GATED_FEATURES.find((f) => f.name === 'a2aRefuseDowngrade')).toMatchObject({ configPath: 'threadline.refuseDowngrade.enabled' });
    const snap = (cfg: Record<string, unknown>) => {
      const d = dir();
      fs.mkdirSync(path.join(d, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(d, '.instar', 'config.json'), JSON.stringify(cfg));
      return getConfigByPath(resolveGuardConfigSnapshot(d).resolved, 'threadline.refuseDowngrade.enabled');
    };
    expect(snap({ developmentAgent: true })).toBe(true);
    expect(snap({})).toBe(false);
    expect(snap({ developmentAgent: true, threadline: { refuseDowngrade: { enabled: false } } })).toBe(false);
  });
});

describe('the mark on the trust profile', () => {
  it('is set once, keeps the first time, persists, and is bound to the pinned key', async () => {
    const d = dir();
    const t = new AgentTrustManager({ stateDir: d });
    const p = peer();
    expect(t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true);
    expect(t.markEncryptedSeen(p.fp, 'ab'.repeat(32))).toBe(false); // not the pinned key
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
    expect(t.markEncryptedSeen(p.fp, p.key)).toBe(true);
    const first = t.getProfileByFingerprint(p.fp)!.encryptedSeenAt!;
    await new Promise((r) => setTimeout(r, 5));
    expect(t.markEncryptedSeen(p.fp, p.key)).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe(first);
    t.flush();
    expect(new AgentTrustManager({ stateDir: d }).getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe(first);
  });

  it('mergeEncryptedSeen keeps the earliest, never clears, and needs the same pin', () => {
    const { t, p } = invitePaired();
    const T1 = '2026-10-01T00:00:00.000Z', T2 = '2026-10-02T00:00:00.000Z';
    expect(t.mergeEncryptedSeen(p.fp, p.key, T2)).toBe(true);
    expect(t.mergeEncryptedSeen(p.fp, p.key, T1)).toBe(true);
    expect(t.mergeEncryptedSeen(p.fp, p.key, T2)).toBe(false);
    expect(t.mergeEncryptedSeen(p.fp, 'cd'.repeat(32), '2020-01-01T00:00:00.000Z')).toBe(false);
    expect(t.mergeEncryptedSeen(p.fp, p.key, 'not a date')).toBe(false);
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe(T1);
  });

  it('is removed when the person unpairs (verification-failed), kept through a pause (demote)', () => {
    const { t, p } = invitePaired();
    t.markEncryptedSeen(p.fp, p.key);
    expect(t.demoteInvitePairing(p.fp, 'second accept')).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeDefined();
    expect(t.markVerificationFailed(p.fp, 'person unpaired')).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
    // Re-pairing the same key starts with no mark.
    expect(t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
  });

  it('a mixed-case inherited key is stored lowercase, so re-pinning the same key keeps the mark (Echo, step 6 review)', () => {
    const t = new AgentTrustManager({ stateDir: dir() });
    const p = peer();
    t.inheritReplicatedVerification(p.fp, { peerIdentityPub: p.key.toUpperCase(), pairingMethod: 'invite' });
    expect(t.getProfileByFingerprint(p.fp)!.peerIdentityPub).toBe(p.key);
    t.mergeEncryptedSeen(p.fp, p.key, '2026-10-01T00:00:00.000Z');
    expect(t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('is dropped when the pinned key changes (a new key is a new agent)', () => {
    const t = new AgentTrustManager({ stateDir: dir() });
    const p = peer();
    t.inheritReplicatedVerification(p.fp, { peerIdentityPub: p.key, pairingMethod: 'invite' });
    t.mergeEncryptedSeen(p.fp, p.key, '2026-10-01T00:00:00.000Z');
    const other = otherKeyFor(p.fp);
    t.inheritReplicatedVerification(p.fp, { peerIdentityPub: other, pairingMethod: 'invite' });
    expect(t.getProfileByFingerprint(p.fp)).toMatchObject({ peerIdentityPub: other });
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
  });
});

describe('noteEncryptedChat (records the mark) per mode', () => {
  it('off records nothing', () => {
    const { t, p } = invitePaired();
    const c = createRefuseDowngradeCounters();
    expect(noteEncryptedChat({ trustManager: t, mode: () => OFF, counters: c }, chat(p))).toBe(false);
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
    expect(c.marksRecorded).toBe(0);
  });

  for (const [name, mode] of [['watch', WATCH], ['enforce', ENFORCE]] as const) {
    it(`${name}: ordinary chat verified by the pinned key records it once; other ops and other keys do not`, () => {
      const { t, p } = invitePaired();
      const c = createRefuseDowngradeCounters();
      const deps = { trustManager: t, mode: () => mode, counters: c };
      expect(noteEncryptedChat(deps, chat(p, 'credential-share'))).toBe(false);
      expect(noteEncryptedChat(deps, chat(p, 'pair-invite-finish'))).toBe(false);
      expect(noteEncryptedChat(deps, chat(p, undefined, 'ab'.repeat(32)))).toBe(false);
      expect(noteEncryptedChat(deps, { from: p.fp, content: { content: 'x' } })).toBe(false); // no verified key
      expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
      expect(noteEncryptedChat(deps, chat(p, 'chat'))).toBe(true);
      expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeDefined();
      expect(noteEncryptedChat(deps, chat(p))).toBe(false); // already set
      expect(c.marksRecorded).toBe(1);
    });
  }

  it('an SAS-paired peer never gets a mark', () => {
    const { t, p } = sasPaired();
    expect(noteEncryptedChat({ trustManager: t, mode: () => ENFORCE }, chat(p))).toBe(false);
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeUndefined();
  });

  it('an inherited pairing whose record carried no method never gets a mark', () => {
    const t = new AgentTrustManager({ stateDir: dir() });
    const p = peer();
    t.inheritReplicatedVerification(p.fp, { peerIdentityPub: p.key });
    expect(noteEncryptedChat({ trustManager: t, mode: () => ENFORCE }, chat(p))).toBe(false);
  });
});

describe('shouldRefuseDowngradedPlaintext per mode', () => {
  function marked() {
    const { t, p } = invitePaired();
    expect(t.markEncryptedSeen(p.fp, p.key)).toBe(true);
    return { t, p };
  }

  it('off: never refuses, counts nothing', () => {
    const { t, p } = marked();
    const c = createRefuseDowngradeCounters();
    expect(shouldRefuseDowngradedPlaintext({ trustManager: t, mode: () => OFF, counters: c }, p.fp, undefined)).toBe(false);
    expect(c).toEqual(createRefuseDowngradeCounters());
  });

  it('watch: counts the would-refuse and delivers', () => {
    const { t, p } = marked();
    const c = createRefuseDowngradeCounters();
    expect(shouldRefuseDowngradedPlaintext({ trustManager: t, mode: () => WATCH, counters: c }, p.fp, 'chat')).toBe(false);
    expect(c.wouldRefuseDowngrade).toBe(1);
    expect(c.refusedDowngrade).toBe(0);
  });

  it('enforce: refuses plaintext under a marked invite peer (any op but an ack)', () => {
    const { t, p } = marked();
    const c = createRefuseDowngradeCounters();
    const deps = { trustManager: t, mode: () => ENFORCE, counters: c };
    expect(shouldRefuseDowngradedPlaintext(deps, p.fp, undefined)).toBe(true);
    expect(shouldRefuseDowngradedPlaintext(deps, p.fp.toUpperCase(), 'chat')).toBe(true);
    expect(shouldRefuseDowngradedPlaintext(deps, p.fp, 'some-op')).toBe(true);
    expect(shouldRefuseDowngradedPlaintext(deps, p.fp, 'ack')).toBe(false);
    expect(c.refusedDowngrade).toBe(3);
  });

  it('enforce: an invite peer with no mark is not refused (step 5 label applies instead)', () => {
    const { t, p } = invitePaired();
    expect(shouldRefuseDowngradedPlaintext({ trustManager: t, mode: () => ENFORCE }, p.fp, undefined)).toBe(false);
  });

  it('enforce: an SAS-paired peer keeps its rule even if a mark were somehow present', () => {
    const { t, p } = sasPaired();
    t.mergeEncryptedSeen(p.fp, p.key, '2026-10-01T00:00:00.000Z'); // a stray mark (e.g. an old invite pairing for the same key)
    expect(t.getProfileByFingerprint(p.fp)!.encryptedSeenAt).toBeDefined();
    expect(shouldRefuseDowngradedPlaintext({ trustManager: t, mode: () => ENFORCE }, p.fp, undefined)).toBe(false);
  });

  it('enforce: after the person unpairs, plaintext is no longer refused', () => {
    const { t, p } = marked();
    t.markVerificationFailed(p.fp, 'unpaired');
    expect(shouldRefuseDowngradedPlaintext({ trustManager: t, mode: () => ENFORCE }, p.fp, undefined)).toBe(false);
  });

  it('a lookup that throws is treated as seen (the spec\'s fail-safe): enforce refuses, watch counts and delivers', () => {
    const c = createRefuseDowngradeCounters();
    const broken = { getProfileByFingerprint: () => { throw new Error('boom'); } } as never;
    expect(shouldRefuseDowngradedPlaintext({ trustManager: broken, mode: () => ENFORCE, counters: c }, 'aa'.repeat(16), undefined)).toBe(true);
    expect(shouldRefuseDowngradedPlaintext({ trustManager: broken, mode: () => WATCH, counters: c }, 'aa'.repeat(16), undefined)).toBe(false);
    expect(c).toMatchObject({ lookupErrors: 2, refusedDowngrade: 1, wouldRefuseDowngrade: 1 });
  });

  it('an unreadable mode is off', () => {
    const { t, p } = marked();
    expect(shouldRefuseDowngradedPlaintext({ trustManager: t, mode: () => { throw new Error('x'); } }, p.fp, undefined)).toBe(false);
  });
});

// Echo's probe from the step 6 review: the order forget K1, inherit K2, replay an old K1 mark record.
describe('encryptedSeen across a forgotten inherited pin', () => {
  it('forget inherited K1, re-inherit K2: an old K1 mark record never comes back; re-inheriting K1 restores it', () => {
    const t = new AgentTrustManager({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')) });
    const fp = crypto.randomBytes(16).toString('hex');
    const K1 = otherKeyFor(fp);
    let K2 = otherKeyFor(fp);
    while (K2 === K1) K2 = otherKeyFor(fp);
    expect(t.inheritReplicatedVerification(fp, { peerIdentityPub: K1, pairingMethod: 'invite' })).toBe(true);
    t.mergeEncryptedSeen(fp, K1, '2026-10-01T00:00:00.000Z');
    expect(t.getProfileByFingerprint(fp)!.encryptedSeenAt).toBeDefined();
    expect(t.revokeInheritedVerification(fp, { keys: new Set([K1]), unkeyed: false })).toBeTruthy();
    expect(t.getProfileByFingerprint(fp)!.encryptedSeenAt).toBeUndefined();
    expect(t.inheritReplicatedVerification(fp, { peerIdentityPub: K2, pairingMethod: 'invite' })).toBe(true);
    expect(t.mergeEncryptedSeen(fp, K1, '2026-10-01T00:00:00.000Z')).toBe(false);
    expect(t.getProfileByFingerprint(fp)!.encryptedSeenAt).toBeUndefined();
    expect(t.revokeInheritedVerification(fp, { keys: new Set([K2]), unkeyed: false })).toBeTruthy();
    expect(t.inheritReplicatedVerification(fp, { peerIdentityPub: K1, pairingMethod: 'invite' })).toBe(true);
    expect(t.mergeEncryptedSeen(fp, K1, '2026-10-01T00:00:00.000Z')).toBe(true);
  });
});
