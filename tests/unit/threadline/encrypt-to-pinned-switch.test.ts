/**
 * Encrypt-to-pinned (docs/specs/threadline-standalone-pairing.md D9, rollout step 5):
 * the explicit pairing method on the trust profile, its load-time backfill, the live
 * off | watch | enforce switch on the send resolver, and the receive-side unverified label.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { AgentTrustManager, backfillPairingMethod, type AgentTrustProfile } from '../../../src/threadline/AgentTrustManager.js';
import {
  createEncryptToPinnedResolver,
  createEncryptToPinnedClientOptions,
  createEncryptToPinnedCounters,
  encryptToPinnedModeName,
  labelUnverifiedPinnedPlaintext,
  resolveEncryptToPinnedMode,
  ENCRYPT_TO_PINNED_DEFAULT,
  readEncryptToPinnedMode,
  UNVERIFIED_PINNED_PLAINTEXT_NOTICE,
  type EncryptToPinnedMode,
} from '../../../src/threadline/encryptToPinned.js';
import type { RelayUnknownSenderPassDecision } from '../../../src/threadline/relayUnknownSenderTrust.js';
import { DEV_GATED_FEATURES, getConfigByPath } from '../../../src/core/devGatedFeatures.js';
import { resolveGuardConfigSnapshot } from '../../../src/monitoring/guardPosture.js';
import { applyDefaults, getInitDefaults, getMigrationDefaults } from '../../../src/config/ConfigDefaults.js';
import { buildForwardAnswer } from '../../../src/threadline/relayForward.js';
import { ThreadlineClient, EncryptToPinnedSendError, ENCRYPT_TO_LOOKUP_FAILED } from '../../../src/threadline/client/ThreadlineClient.js';

const OFF: EncryptToPinnedMode = { enabled: false, dryRun: true };
const WATCH: EncryptToPinnedMode = { enabled: true, dryRun: true };
const ENFORCE: EncryptToPinnedMode = { enabled: true, dryRun: false };
const MODES = [OFF, WATCH, ENFORCE];

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'enc-pinned-'));
const peer = () => {
  // A real Ed25519 key: random bytes are often not a curve point, which pinning refuses (SEC-16, #2229).
  const key = generateIdentityKeyPair().publicKey.toString('hex');
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
  it('ships ON for every agent (Justin 2026-10-20): no value anywhere resolves to enforce, dev agent or not', () => {
    expect(ENCRYPT_TO_PINNED_DEFAULT).toEqual(ENFORCE);
    expect(resolveEncryptToPinnedMode({}, {})).toEqual(ENFORCE);
    expect(resolveEncryptToPinnedMode({}, { developmentAgent: false })).toEqual(ENFORCE);
    expect(resolveEncryptToPinnedMode({}, { developmentAgent: true })).toEqual(ENFORCE);
    // What the shipped config default writes (`enabled: true`, dryRun omitted) is enforce too.
    expect(resolveEncryptToPinnedMode({}, { threadline: { encryptToPinned: { enabled: true } } })).toEqual(ENFORCE);
  });

  it('an explicit value always wins: off and watch stay reachable, on dev and non-dev agents alike', () => {
    for (const developmentAgent of [false, true]) {
      expect(resolveEncryptToPinnedMode({}, { developmentAgent, threadline: { encryptToPinned: { enabled: false } } })).toEqual({ enabled: false, dryRun: false });
      expect(encryptToPinnedModeName(resolveEncryptToPinnedMode({}, { developmentAgent, threadline: { encryptToPinned: { enabled: false } } }))).toBe('off');
      expect(resolveEncryptToPinnedMode({}, { developmentAgent, threadline: { encryptToPinned: { dryRun: true } } })).toEqual(WATCH);
      expect(resolveEncryptToPinnedMode({}, { developmentAgent, threadline: { encryptToPinned: { enabled: true, dryRun: true } } })).toEqual(WATCH);
    }
    // live config wins over the boot config, both ways
    expect(resolveEncryptToPinnedMode({ enabled: true, dryRun: false }, { threadline: { encryptToPinned: { enabled: false } } })).toEqual(ENFORCE);
    expect(resolveEncryptToPinnedMode({ enabled: false }, {})).toEqual({ enabled: false, dryRun: false });
    expect(resolveEncryptToPinnedMode({ dryRun: true }, {})).toEqual(WATCH);
    expect(MODES.map(encryptToPinnedModeName)).toEqual(['off', 'watch', 'enforce']);
  });

  it('upgrade: an agent with no value gets the default; an explicit off or watch is never overwritten', () => {
    const defaults = getMigrationDefaults('standalone');
    const resolved = (cfg: Record<string, unknown>) => {
      applyDefaults(cfg, defaults);
      return encryptToPinnedModeName(resolveEncryptToPinnedMode({}, cfg as never));
    };
    expect(resolved({})).toBe('enforce');
    expect(resolved({ threadline: { relayEnabled: true } })).toBe('enforce');
    expect(resolved({ developmentAgent: true, threadline: {} })).toBe('enforce');
    expect(resolved({ threadline: { encryptToPinned: { enabled: false } } })).toBe('off');
    expect(resolved({ threadline: { encryptToPinned: { dryRun: true } } })).toBe('watch');
    expect(resolved({ developmentAgent: true, threadline: { encryptToPinned: { enabled: true, dryRun: true } } })).toBe('watch');
    // Fresh init writes enabled:true and leaves dryRun to the code default.
    expect(getConfigByPath(getInitDefaults('managed-project'), 'threadline.encryptToPinned')).toEqual({ enabled: true });
  });

  it('is no longer a dev-gated feature, and /guards shows it on for dev and non-dev agents', () => {
    expect(DEV_GATED_FEATURES.find((f) => f.configPath.startsWith('threadline.encryptToPinned'))).toBeUndefined();
    const snap = (cfg: Record<string, unknown>) => {
      const d = dir();
      fs.mkdirSync(path.join(d, '.instar'), { recursive: true });
      fs.writeFileSync(path.join(d, '.instar', 'config.json'), JSON.stringify(cfg));
      return getConfigByPath(resolveGuardConfigSnapshot(d).resolved, 'threadline.encryptToPinned.enabled');
    };
    expect(snap({})).toBe(true);
    expect(snap({ developmentAgent: true })).toBe(true);
    expect(snap({ threadline: { encryptToPinned: { enabled: false } } })).toBe(false);
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

  it('a mode reader that throws yields the SHIPPED DEFAULT (enforce), never off (Echo, #2236): the pinned key, fail-closed, the label', () => {
    const boom = (): EncryptToPinnedMode => { throw new Error('x'); };
    expect(readEncryptToPinnedMode(boom)).toEqual(ENCRYPT_TO_PINNED_DEFAULT);
    expect(encryptToPinnedModeName(readEncryptToPinnedMode(boom))).toBe('enforce');
    const counters = createEncryptToPinnedCounters();
    const key = createEncryptToPinnedResolver({ trustManager: t, mode: boom, counters })(inv.fp, 'send');
    expect(Buffer.isBuffer(key) && key.toString('hex')).toBe(inv.key);
    expect(counters.encryptedToPinned).toBe(1);
    expect(createEncryptToPinnedClientOptions({ mode: boom }).failClosed!()).toBe(true);
    const d = { fingerprint: inv.fp, trustLevel: 'trusted' } as unknown as RelayUnknownSenderPassDecision;
    expect(labelUnverifiedPinnedPlaintext({ trustManager: t, mode: boom, counters }, d, undefined)).toMatchObject({ notice: UNVERIFIED_PINNED_PLAINTEXT_NOTICE });
    // Control: a reader that answers is used as-is.
    expect(readEncryptToPinnedMode(() => OFF)).toEqual(OFF);
  });

  it('a trust lookup that throws: ENFORCE fails closed (the sentinel, not null); watch/off keep null; sends counted', () => {
    const broken = { getProfileByFingerprint: () => { throw new Error('store'); } } as unknown as AgentTrustManager;
    const counters = createEncryptToPinnedCounters();
    expect(createEncryptToPinnedResolver({ trustManager: broken, mode: () => ENFORCE, counters })(inv.fp, 'send')).toBe(ENCRYPT_TO_LOOKUP_FAILED);
    expect(createEncryptToPinnedResolver({ trustManager: broken, mode: () => ENFORCE, counters })(inv.fp, 'check')).toBe(ENCRYPT_TO_LOOKUP_FAILED);
    expect(createEncryptToPinnedResolver({ trustManager: broken, mode: () => WATCH, counters })(inv.fp, 'send')).toBeNull();
    expect(createEncryptToPinnedResolver({ trustManager: broken, mode: () => OFF, counters })(inv.fp, 'send')).toBeNull();
    expect(counters.lookupErrors).toBe(2); // enforce send + watch send; a check is not counted, off never looks
  });
});

describe('fail closed end to end: the real client with the bootstrap resolver and client options', () => {
  const p = peer();
  function harness(mode: EncryptToPinnedMode, trust: Pick<AgentTrustManager, 'getProfileByFingerprint'>) {
    const counters = createEncryptToPinnedCounters();
    const wire: Array<Record<string, unknown>> = [];
    const client = new ThreadlineClient({ name: 'T', stateDir: dir() }, () => 1);
    const internals = client as unknown as Record<string, unknown>;
    internals.relayClient = { sendMessage: (e: Record<string, unknown>) => { wire.push(e); } };
    internals.identity = { fingerprint: 'self-fp' };
    internals.encryptor = { encrypt: (_pk: Buffer, _xk: Buffer, threadId: string) => ({ threadId, messageId: 'm', ephemeralPubKey: 'e' }) };
    client.setEncryptToResolver(
      createEncryptToPinnedResolver({ trustManager: trust as AgentTrustManager, mode: () => mode, counters }),
      createEncryptToPinnedClientOptions({ mode: () => mode, counters }),
    );
    return { client, wire, counters };
  }
  const broken = { getProfileByFingerprint: () => { throw new Error('store'); } };
  const malformed = { getProfileByFingerprint: () => ({ pairingState: 'mutual-verified', pairingMethod: 'invite', peerIdentityPub: 'ab'.repeat(32) }) };

  it('lookup throws: enforce refuses (EncryptToPinnedSendError, nothing on the wire); watch sends as today', () => {
    const e = harness(ENFORCE, broken);
    expect(() => e.client.sendAuto(p.fp, 'x')).toThrow(EncryptToPinnedSendError);
    expect(() => e.client.sendPlaintext(p.fp, 'nudge')).toThrow(/lookup-failed/);
    expect(e.wire).toEqual([]);
    expect(e.counters.lookupErrors).toBe(2);
    const w = harness(WATCH, broken);
    w.client.sendAuto(p.fp, 'x');
    expect(w.wire).toHaveLength(1);
    expect(w.counters.lookupErrors).toBe(1);
  });

  it('pinned key that is not this peer\'s: enforce refuses and counts malformedPinnedKey', () => {
    const e = harness(ENFORCE, malformed);
    expect(() => e.client.sendAuto(p.fp, 'x')).toThrow(/malformed-pinned-key/);
    expect(e.wire).toEqual([]);
    expect(e.counters.malformedPinnedKey).toBe(1);
    expect(e.counters.encryptedToPinned).toBe(1); // the resolver did hand out a key; the client refused it
  });

  it('client options: failClosed only in enforce; resolver errors and malformed keys counted on a send only', () => {
    const counters = createEncryptToPinnedCounters();
    for (const [mode, want] of [[OFF, false], [WATCH, false], [ENFORCE, true]] as const) {
      expect(createEncryptToPinnedClientOptions({ mode: () => mode, counters }).failClosed!()).toBe(want);
    }
    const o = createEncryptToPinnedClientOptions({ mode: () => ENFORCE, counters });
    o.onFailure!('resolver-error', 'send');
    o.onFailure!('resolver-error', 'check');
    o.onFailure!('malformed-pinned-key', 'send');
    expect(counters.resolverErrors).toBe(1);
    expect(counters.malformedPinnedKey).toBe(1);
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
