/**
 * Encrypt-to-pinned (docs/specs/threadline-standalone-pairing.md D9, rollout step 5):
 * the explicit pairing method on the trust profile, its load-time backfill, the live
 * off | watch | enforce switch on the send resolver, and the receive-side unverified label.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentTrustManager, backfillPairingMethod, type AgentTrustProfile } from '../../../src/threadline/AgentTrustManager.js';
import {
  createEncryptToPinnedResolver,
  createEncryptToPinnedCounters,
  encryptToPinnedModeName,
  labelUnverifiedPinnedPlaintext,
  resolveEncryptToPinnedMode,
  UNVERIFIED_PINNED_PLAINTEXT_NOTICE,
  type EncryptToPinnedMode,
} from '../../../src/threadline/encryptToPinned.js';
import type { RelayUnknownSenderPassDecision } from '../../../src/threadline/relayUnknownSenderTrust.js';
import { buildForwardAnswer } from '../../../src/threadline/relayForward.js';

const OFF: EncryptToPinnedMode = { enabled: false, dryRun: true };
const WATCH: EncryptToPinnedMode = { enabled: true, dryRun: true };
const ENFORCE: EncryptToPinnedMode = { enabled: true, dryRun: false };
const MODES = [OFF, WATCH, ENFORCE];

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'enc-pinned-'));
const peer = () => {
  const key = crypto.randomBytes(32).toString('hex');
  return { key, fp: key.slice(0, 32) };
};
const OWN_FP = 'f'.repeat(32);

function sasVerify(t: AgentTrustManager, p: { key: string; fp: string }): void {
  expect(t.recordPendingVerification(p.fp, {
    pairingId: 'pid-1', peerIdentityPub: p.key, sasWords: ['a', 'b', 'c'], sasFingerprint: 'sas-fp', ownFp: OWN_FP,
  })).toBe(true);
  expect(t.markMutualVerified(p.fp, { pairingId: 'pid-1', operatorConfirm: true, ownFp: OWN_FP })).toBe(true);
}

describe('pairingMethod on the trust profile', () => {
  it('invite verification sets invite (accept and finish)', () => {
    const t = new AgentTrustManager({ stateDir: dir() }); const p = peer();
    t.recordInviteAccepted(p.fp, { peerIdentityPub: p.key });
    expect(t.getProfileByFingerprint(p.fp)!.pairingMethod).toBe('invite');
    expect(t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'mutual-verified', pairingMethod: 'invite' });
  });

  it('SAS verification sets sas', () => {
    const t = new AgentTrustManager({ stateDir: dir() }); const p = peer();
    sasVerify(t, p);
    expect(t.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'mutual-verified', pairingMethod: 'sas', sasFingerprint: 'sas-fp' });
  });

  it('an inherited verification sets inherited', () => {
    const t = new AgentTrustManager({ stateDir: dir() }); const p = peer();
    expect(t.inheritReplicatedVerification(p.fp, { peerIdentityPub: p.key, verifiedOnMachine: 'm2' })).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'identity-verified', pairingMethod: 'inherited' });
  });

  it('is persisted and read back', () => {
    const d = dir(); const p = peer();
    new AgentTrustManager({ stateDir: d }).markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'x' });
    const raw = JSON.parse(fs.readFileSync(path.join(d, 'threadline', 'trust-profiles.json'), 'utf-8'));
    expect(Object.values(raw.profiles as Record<string, AgentTrustProfile>)[0].pairingMethod).toBe('invite');
    expect(new AgentTrustManager({ stateDir: d }).getProfileByFingerprint(p.fp)!.pairingMethod).toBe('invite');
  });
});

describe('pairingMethod backfill on load', () => {
  function writeLegacy(d: string, profiles: Record<string, Partial<AgentTrustProfile>>): void {
    fs.mkdirSync(path.join(d, 'threadline'), { recursive: true });
    const now = new Date().toISOString();
    const full: Record<string, AgentTrustProfile> = {};
    for (const [k, v] of Object.entries(profiles)) {
      full[k] = {
        agent: k, fingerprint: v.fingerprint, level: 'trusted', source: 'mutual-verified',
        history: { messagesReceived: 0, messagesResponded: 0, successfulInteractions: 0, failedInteractions: 0, lastInteraction: now, streakSinceIncident: 0 },
        allowedOperations: [], blockedOperations: [], createdAt: now, updatedAt: now, ...v,
      } as AgentTrustProfile;
    }
    fs.writeFileSync(path.join(d, 'threadline', 'trust-profiles.json'), JSON.stringify({ profiles: full, updatedAt: now }));
  }

  it('sas when a sasFingerprint is present, invite when absent, an existing value untouched, others left alone; idempotent across two loads', () => {
    const d = dir();
    const a = peer(), b = peer(), c = peer(), e = peer(), f = peer();
    writeLegacy(d, {
      [a.fp]: { fingerprint: a.fp, pairingState: 'mutual-verified', peerIdentityPub: a.key, sasFingerprint: 'sas' },
      [b.fp]: { fingerprint: b.fp, pairingState: 'mutual-verified', peerIdentityPub: b.key },
      [c.fp]: { fingerprint: c.fp, pairingState: 'mutual-verified', peerIdentityPub: c.key, pairingMethod: 'inherited' },
      [e.fp]: { fingerprint: e.fp, pairingState: 'identity-verified', peerIdentityPub: e.key },
      [f.fp]: { fingerprint: f.fp, pairingState: 'pending-verification', peerIdentityPub: f.key, sasFingerprint: 'sas' },
    });
    const expectMethods = (t: AgentTrustManager) => {
      expect(t.getProfileByFingerprint(a.fp)!.pairingMethod).toBe('sas');
      expect(t.getProfileByFingerprint(b.fp)!.pairingMethod).toBe('invite');
      expect(t.getProfileByFingerprint(c.fp)!.pairingMethod).toBe('inherited');
      expect(t.getProfileByFingerprint(e.fp)!.pairingMethod).toBeUndefined();
      expect(t.getProfileByFingerprint(f.fp)!.pairingMethod).toBeUndefined();
    };
    const first = new AgentTrustManager({ stateDir: d });
    expectMethods(first);
    // A save writes the backfilled values; a second load sees the same result.
    (first as unknown as { save(): void }).save();
    const raw = JSON.parse(fs.readFileSync(path.join(d, 'threadline', 'trust-profiles.json'), 'utf-8'));
    expect(raw.profiles[b.fp].pairingMethod).toBe('invite');
    const second = new AgentTrustManager({ stateDir: d });
    expectMethods(second);
  });

  it('the helper reports what it changed and changes nothing the second time', () => {
    const profiles = {
      x: { pairingState: 'mutual-verified', sasFingerprint: 's' },
      y: { pairingState: 'mutual-verified' },
      z: { pairingState: 'mutual-verified', pairingMethod: 'invite', sasFingerprint: 's' },
    } as unknown as Record<string, AgentTrustProfile>;
    expect(backfillPairingMethod(profiles)).toBe(2);
    expect(backfillPairingMethod(profiles)).toBe(0);
    expect(profiles.x.pairingMethod).toBe('sas');
    expect(profiles.y.pairingMethod).toBe('invite');
    expect(profiles.z.pairingMethod).toBe('invite');
    expect(backfillPairingMethod(null)).toBe(0);
  });
});

describe('threadline.encryptToPinned mode', () => {
  it('follows the relayUnknownSenderTrust gate: omitted enabled rides developmentAgent; dryRun defaults true', () => {
    expect(resolveEncryptToPinnedMode({}, {})).toEqual(OFF);
    expect(resolveEncryptToPinnedMode({}, { developmentAgent: true })).toEqual(WATCH);
    expect(resolveEncryptToPinnedMode({}, { developmentAgent: true, threadline: { encryptToPinned: { enabled: false } } })).toEqual(OFF);
    expect(resolveEncryptToPinnedMode({}, { threadline: { encryptToPinned: { enabled: true, dryRun: false } } })).toEqual(ENFORCE);
    // live config wins over the boot config
    expect(resolveEncryptToPinnedMode({ enabled: true, dryRun: false }, { threadline: { encryptToPinned: { enabled: false } } })).toEqual(ENFORCE);
    expect(MODES.map(encryptToPinnedModeName)).toEqual(['off', 'watch', 'enforce']);
  });
});

describe('the send resolver', () => {
  let t: AgentTrustManager;
  const inv = peer(), sas = peer(), inh = peer(), accepted = peer();
  beforeEach(() => {
    t = new AgentTrustManager({ stateDir: dir() });
    t.markInviteVerified(inv.fp, { peerIdentityPub: inv.key, via: 'finish' });
    sasVerify(t, sas);
    t.inheritReplicatedVerification(inh.fp, { peerIdentityPub: inh.key });
    t.recordInviteAccepted(accepted.fp, { peerIdentityPub: accepted.key });
  });

  it('off: null, nothing counted', () => {
    const counters = createEncryptToPinnedCounters();
    const r = createEncryptToPinnedResolver({ trustManager: t, mode: () => OFF, counters });
    expect(r(inv.fp, 'send')).toBeNull();
    expect(counters).toEqual(createEncryptToPinnedCounters());
  });

  it('watch: null, and each SEND that would have encrypted is counted (a capability check is not)', () => {
    const counters = createEncryptToPinnedCounters();
    const r = createEncryptToPinnedResolver({ trustManager: t, mode: () => WATCH, counters });
    expect(r(inv.fp, 'send')).toBeNull();
    expect(r(inv.fp, 'send')).toBeNull();
    expect(r(inv.fp, 'check')).toBeNull();
    expect(counters.wouldEncryptToPinned).toBe(2);
    expect(counters.encryptedToPinned).toBe(0);
  });

  it('enforce: the pinned key', () => {
    const counters = createEncryptToPinnedCounters();
    const r = createEncryptToPinnedResolver({ trustManager: t, mode: () => ENFORCE, counters });
    expect(r(inv.fp, 'send')!.toString('hex')).toBe(inv.key);
    expect(counters.encryptedToPinned).toBe(1);
  });

  it('an SAS, inherited or not-yet-finished peer gets null in every mode, and is never counted', () => {
    for (const mode of MODES) {
      const counters = createEncryptToPinnedCounters();
      const r = createEncryptToPinnedResolver({ trustManager: t, mode: () => mode, counters });
      for (const p of [sas, inh, accepted, peer()]) expect(r(p.fp, 'send')).toBeNull();
      expect(counters).toEqual(createEncryptToPinnedCounters());
    }
  });

  it('an invite profile WITHOUT the method (not backfilled) is not treated as invite', () => {
    const p = t.getProfileByFingerprint(inv.fp)!;
    p.pairingMethod = undefined;
    expect(createEncryptToPinnedResolver({ trustManager: t, mode: () => ENFORCE })(inv.fp, 'send')).toBeNull();
  });

  it('a mode reader or trust lookup that throws: null', () => {
    expect(createEncryptToPinnedResolver({ trustManager: t, mode: () => { throw new Error('x'); } })(inv.fp, 'send')).toBeNull();
    const counters = createEncryptToPinnedCounters();
    const broken = { getProfileByFingerprint: () => { throw new Error('store'); } } as unknown as AgentTrustManager;
    expect(createEncryptToPinnedResolver({ trustManager: broken, mode: () => ENFORCE, counters })(inv.fp, 'send')).toBeNull();
    expect(counters.lookupErrors).toBe(1);
  });
});

describe('receive side: plaintext under an invite-paired peer is labelled unverified (never refused)', () => {
  const inv = peer(), sas = peer();
  let t: AgentTrustManager;
  beforeEach(() => {
    t = new AgentTrustManager({ stateDir: dir() });
    t.markInviteVerified(inv.fp, { peerIdentityPub: inv.key, via: 'finish' });
    sasVerify(t, sas);
  });
  const decision = (fp: string, trustLevel: RelayUnknownSenderPassDecision['trustLevel'] = 'trusted'): RelayUnknownSenderPassDecision => ({
    action: 'pass', reason: 'relay-authenticated', trustLevel, fingerprint: fp,
    message: { from: fp, fromName: fp.slice(0, 8), threadId: 't', messageId: 'm', content: { content: 'hi' }, timestamp: '' } as never,
  });

  it('enforce: delivered with the server notice and at no more than verified', () => {
    const counters = createEncryptToPinnedCounters();
    const d = decision(inv.fp, 'trusted');
    const out = labelUnverifiedPinnedPlaintext({ trustManager: t, mode: () => ENFORCE, counters }, d, 'chat');
    expect(out.action).toBe('pass');
    expect(out.notice).toBe(UNVERIFIED_PINNED_PLAINTEXT_NOTICE);
    expect(out.trustLevel).toBe('verified');
    expect(out.message).toBe(d.message);
    expect(counters.labelledUnverified).toBe(1);
    // A lower held level is not raised.
    expect(labelUnverifiedPinnedPlaintext({ trustManager: t, mode: () => ENFORCE }, decision(inv.fp, 'untrusted'), undefined).trustLevel).toBe('untrusted');
  });

  it('watch: unchanged, counted; off: unchanged, not counted', () => {
    const counters = createEncryptToPinnedCounters();
    const d = decision(inv.fp);
    expect(labelUnverifiedPinnedPlaintext({ trustManager: t, mode: () => WATCH, counters }, d, 'chat')).toBe(d);
    expect(counters.wouldLabelUnverified).toBe(1);
    expect(labelUnverifiedPinnedPlaintext({ trustManager: t, mode: () => OFF, counters }, d, 'chat')).toBe(d);
    expect(counters.wouldLabelUnverified).toBe(1);
  });

  it('acks, probes, SAS-paired and unknown senders pass unchanged', () => {
    for (const [fp, type] of [[inv.fp, 'ack'], [inv.fp, 'ping'], [sas.fp, 'chat'], [peer().fp, 'chat']] as const) {
      const d = decision(fp);
      const out = labelUnverifiedPinnedPlaintext({ trustManager: t, mode: () => ENFORCE }, d, type);
      expect(out).toBe(d);
      expect((out as { notice?: string }).notice).toBeUndefined();
    }
  });
});

describe('standby forward (relayForward): a holder 502 for a failed pinned send is transcribed, not retried', () => {
  it('status and body pass through unchanged, with no settlement outcome', () => {
    const body = { success: false, accepted: false, delivered: false, reason: 'encrypted-send-to-pinned-failed', error: 'not sent (no plaintext fallback): x' };
    const answer = buildForwardAnswer(
      { kind: 'answered', machine: { machineId: 'm-holder', nickname: 'holder' } as never, status: 502, body },
      { messageId: 'msg-1', hadTopic: false },
    )!;
    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ ...body, deliveryPath: 'forwarded', forwardedTo: 'holder' });
    expect(answer.settlementOutcome).toBeUndefined();
  });
});
