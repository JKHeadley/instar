/**
 * identity-security-creation-provenance: the identity checks on a cited owner message, and the
 * record-only creation store. Both sides of every check.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCitation, parseOnBehalfOf, crossTopicEligible, applyCrossTopicConfirm, crossTopicRefusalText, safeConversationName, TopicCreationProvenanceStore, CITATION_MAX_AGE_MS, type CitationDeps, type LogRowLike } from '../../src/core/topicCreationProvenance.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const OWNER = '7812716706';
function row(over: Partial<LogRowLike> = {}): LogRowLike {
  return { messageId: 5001, topicId: 130715, text: 'pin 145097 to opus please', fromUser: true, timestamp: new Date(NOW - 60_000).toISOString(), telegramUserId: Number(OWNER), forwarded: false, authorship: 'human', ...over };
}
function deps(over: Partial<CitationDeps> & { entry?: LogRowLike | null; unreadable?: boolean } = {}): CitationDeps {
  return {
    verifiedOperatorUid: over.verifiedOperatorUid ?? (() => OWNER),
    findMessage: over.findMessage ?? (() => ({ entry: over.entry === undefined ? row() : over.entry, ...(over.unreadable ? { unreadable: true } : {}) })),
    ownerUid: over.ownerUid ?? (() => OWNER),
    now: () => NOW,
  };
}
const REF = { topicId: 130715, messageId: 5001 };

describe('checkCitation: identity only, both sides of each check', () => {
  it('accepts the owner\'s own recent message in a topic the owner is the verified operator of', () => {
    expect(checkCitation(REF, deps())).toEqual({ ok: true, cited: { topicId: 130715, messageId: 5001, uid: OWNER, at: new Date(NOW - 60_000).toISOString() }, text: 'pin 145097 to opus please' });
  });
  it('refuses a source topic with no verified operator', () => {
    expect(checkCitation(REF, deps({ verifiedOperatorUid: () => null }))).toEqual({ ok: false, reason: 'source-unverified' });
  });
  it('refuses when the verified operator is not the configured owner (a team member), or no owner is configured', () => {
    expect(checkCitation(REF, deps({ verifiedOperatorUid: () => '7000001' }))).toEqual({ ok: false, reason: 'not-owner' });
    expect(checkCitation(REF, deps({ ownerUid: () => null }))).toEqual({ ok: false, reason: 'not-owner' });
  });
  it('an unreadable log and a spent lookup budget are their own refusals, not "not found"', () => {
    expect(checkCitation(REF, deps({ unreadable: true, entry: null }))).toEqual({ ok: false, reason: 'log-unreadable' });
    expect(checkCitation(REF, deps({ findMessage: () => ({ entry: null, budgetExceeded: true }) }))).toEqual({ ok: false, reason: 'log-window-exceeded' });
    expect(checkCitation(REF, deps({ entry: null }))).toEqual({ ok: false, reason: 'message-not-found' });
  });
  it('refuses a message not sent by the operator in person', () => {
    for (const bad of [
      { fromUser: false }, { telegramUserId: 7000001 }, { forwarded: true }, { forwarded: undefined },
      { rowOrigin: 'relay' }, { teamPhone: true }, { via: 'mobile-device' }, { authorship: 'agent-verified' }, { authorship: 'UNRESOLVED' },
    ] as Array<Partial<LogRowLike>>) {
      expect(checkCitation(REF, deps({ entry: row(bad) })), JSON.stringify(bad)).toEqual({ ok: false, reason: 'message-not-from-operator' });
    }
  });
  it('the 24-hour floor: just inside passes, just outside and future-dated refuse', () => {
    expect(checkCitation(REF, deps({ entry: row({ timestamp: new Date(NOW - CITATION_MAX_AGE_MS + 1000).toISOString() }) })).ok).toBe(true);
    expect(checkCitation(REF, deps({ entry: row({ timestamp: new Date(NOW - CITATION_MAX_AGE_MS - 1000).toISOString() }) }))).toEqual({ ok: false, reason: 'message-too-old' });
    expect(checkCitation(REF, deps({ entry: row({ timestamp: new Date(NOW + 5 * 60_000).toISOString() }) }))).toEqual({ ok: false, reason: 'message-too-old' });
  });
  it('the lookup is asked for the cited topic and message, bounded to 24 hours', () => {
    const calls: Array<[number, number, number]> = [];
    checkCitation(REF, deps({ findMessage: (t, m, nb) => { calls.push([t, m, nb]); return { entry: row() }; } }));
    expect(calls).toEqual([[130715, 5001, NOW - CITATION_MAX_AGE_MS]]);
  });
});

describe('parseOnBehalfOf', () => {
  it('absent, valid, numeric strings, and malformed', () => {
    expect(parseOnBehalfOf(undefined)).toBeUndefined();
    expect(parseOnBehalfOf({ topicId: 1, messageId: 2 })).toEqual({ topicId: 1, messageId: 2 });
    expect(parseOnBehalfOf({ topicId: '1', messageId: '2' })).toEqual({ topicId: 1, messageId: 2 });
    for (const bad of [null, 'x', [], {}, { topicId: 0, messageId: 1 }, { topicId: 1, messageId: -1 }, { topicId: 1.5, messageId: 2 }]) expect(parseOnBehalfOf(bad)).toBeNull();
  });
});

describe('TopicCreationProvenanceStore: a record only', () => {
  it('keeps the original record and appends a reuse; removes on delete; survives a new instance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-prov-'));
    try {
      const a = new TopicCreationProvenanceStore(dir);
      a.record({ topicId: 145097, createdAt: '2026-11-18T21:00:00Z', session: 's1', source: { kind: 'linked-message', linked: { topicId: 130715, messageId: 5001, uid: OWNER, at: '2026-11-18T21:00:00Z' }, authorship: 'unverified' }, sessionAsserted: true });
      a.record({ topicId: 145097, createdAt: '2026-11-18T22:00:00Z', session: 's2', source: { kind: 'source-unknown' } });
      const b = new TopicCreationProvenanceStore(dir);
      const r = b.get(145097)!;
      expect(r.source.kind).toBe('linked-message');
      expect(r.sessionAsserted).toBe(true);
      expect(r.reuses).toEqual([{ at: '2026-11-18T22:00:00Z', session: 's2', linked: null }]);
      b.remove(145097);
      expect(new TopicCreationProvenanceStore(dir).get(145097)).toBeNull();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/identity-creation-provenance.test.ts' });
    }
  });
});

describe('crossTopicEligible: may the owner\'s yes in A reach B? Both sides of each check', () => {
  const base = { ownerUid: OWNER, confirmerUid: OWNER, destKnown: true, destBinding: null, destVerifiedUid: null, destConfined: false as boolean | null, sourceConfined: false as boolean | null };
  it('an unbound, known, not-confined B is reachable by the owner\'s yes', () => {
    expect(crossTopicEligible(base)).toEqual({ ok: true });
  });
  it('the confirmer must be the configured owner', () => {
    expect(crossTopicEligible({ ...base, confirmerUid: '7000001' })).toEqual({ ok: false, reason: 'source-not-owner' });
    expect(crossTopicEligible({ ...base, confirmerUid: null })).toEqual({ ok: false, reason: 'source-not-owner' });
    expect(crossTopicEligible({ ...base, ownerUid: null })).toEqual({ ok: false, reason: 'source-not-owner' });
  });
  it('A must be the owner\'s own conversation: a shared or unknown A refuses', () => {
    expect(crossTopicEligible({ ...base, sourceConfined: true })).toEqual({ ok: false, reason: 'source-shared' });
    expect(crossTopicEligible({ ...base, sourceConfined: null })).toEqual({ ok: false, reason: 'source-shared' });
  });
  it('B must be known', () => {
    expect(crossTopicEligible({ ...base, destKnown: false })).toEqual({ ok: false, reason: 'destination-unknown' });
  });
  it('B bound: only a VERIFIED binding to the same owner passes', () => {
    expect(crossTopicEligible({ ...base, destBinding: { platform: 'telegram', uid: OWNER }, destVerifiedUid: OWNER })).toEqual({ ok: true });
    expect(crossTopicEligible({ ...base, destBinding: { platform: 'telegram', uid: OWNER }, destVerifiedUid: null })).toEqual({ ok: false, reason: 'destination-bound' });
    expect(crossTopicEligible({ ...base, destBinding: { platform: 'telegram', uid: '7000001' }, destVerifiedUid: '7000001' })).toEqual({ ok: false, reason: 'destination-bound' });
    expect(crossTopicEligible({ ...base, destBinding: { platform: 'slack', uid: OWNER }, destVerifiedUid: OWNER })).toEqual({ ok: false, reason: 'destination-bound' });
  });
  it('B confined or unknown confinement refuses; only a definite "not confined" passes', () => {
    expect(crossTopicEligible({ ...base, destConfined: true })).toEqual({ ok: false, reason: 'destination-confined' });
    expect(crossTopicEligible({ ...base, destConfined: null })).toEqual({ ok: false, reason: 'destination-unknown' });
  });
});

describe('applyCrossTopicConfirm: the owner\'s yes in A, the authority-granting branch', () => {
  const principal = { kind: 'operator' as const, platform: 'telegram', uid: OWNER };
  function run(eligible: { ok: true } | { ok: false; reason: string }) {
    const writes: unknown[] = []; const checks: unknown[] = [];
    const p = applyCrossTopicConfirm({
      sourceTopicKey: '130715', targetTopicKey: '145097', patch: { model: 'opus' }, agentComposed: true, principal,
      eligibility: (uid, dest, src) => { checks.push([uid, dest, src]); return eligible; },
      applyWrite: async (req) => { writes.push(req); return { reply: 'Done: model set to opus.' }; },
    });
    return { p, writes, checks };
  }
  it('the owner\'s yes re-checks with the confirmer, the target and A, then writes exactly the armed change to B', async () => {
    const r = run({ ok: true });
    expect(await r.p).toEqual({ written: true, reply: 'Done: model set to opus.' });
    expect(r.checks).toEqual([[OWNER, '145097', '130715']]);
    expect(r.writes).toEqual([{ topicKey: '145097', patch: { model: 'opus' }, principal, origin: 'propose-confirm', agentComposedPayload: true, discloseInReply: true, crossTopicConfirm: { sourceTopicId: 130715 } }]);
  });
  it('a refusal at the yes (non-owner, B bound in between, switch turned off) writes nothing and says why in plain words', async () => {
    for (const reason of ['source-not-owner', 'destination-bound', 'switch-off', 'source-shared']) {
      const r = run({ ok: false, reason });
      const out = await r.p;
      expect(out.written, reason).toBe(false);
      expect(r.writes, reason).toHaveLength(0);
      expect(out.reply).toBe(crossTopicRefusalText(reason));
      expect(out.reply).toMatch(/^I didn't make that change: .+\. You can ask for it in that conversation instead\.$/);
    }
  });
  it('conversation names in the proposal carry no quotes or line breaks', () => {
    expect(safeConversationName('Sc"al\ning', '23')).toBe('Sc al ing');
    expect(safeConversationName(null, '23')).toMatch(/^topic 23\b/);
    expect(safeConversationName(null, '23')).not.toContain('"');
    expect(safeConversationName('x'.repeat(200), '23')).toHaveLength(80);
  });
});

