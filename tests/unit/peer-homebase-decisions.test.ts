/**
 * The two homebase decisions, and the one that must never go permissive.
 */
import { describe, it, expect } from 'vitest';
import {
  homebaseTopicName,
  decideHomebaseBind,
  selectConversationToBind,
  HOMEBASE_FP_SUFFIX_LEN,
  ensurePeerHomebase,
  legacyHomebaseTopicName,
  isLegacyHomebaseName,
  displayNameCollides,
  selectHomebaseBackfill,
  backfillPeerHomebases,
} from '../../src/threadline/peerHomebase.js';

describe('homebaseTopicName', () => {
  it('is "🤝 <peer>", the name the operator agreed to, using the peer\'s own name as given', () => {
    expect(homebaseTopicName('PP', 'abcdef0123456789')).toBe('🤝 PP');
    expect(homebaseTopicName('pp', 'abcdef0123456789')).toBe('🤝 pp'); // no invented casing
  });

  it('appends the short fingerprint ONLY when two peers share a display name', () => {
    const a = homebaseTopicName('Echo', '1111111111', { collides: true });
    const b = homebaseTopicName('Echo', '2222222222', { collides: true });
    expect(a).toBe('🤝 Echo · 111111');
    expect(a).not.toBe(b);
  });

  it('still collides when BOTH the name and the fp prefix match — accepted, not fixed', () => {
    const a = homebaseTopicName('Echo', 'aaaaaa-1111', { collides: true });
    const b = homebaseTopicName('Echo', 'aaaaaa-2222', { collides: true });
    expect(a).toBe(b); // documented in spec §6 as an accepted long-tail risk
  });

  it('strips separators from the fingerprint and bounds the suffix length', () => {
    const n = homebaseTopicName('p', 'ab:cd:ef:01:23', { collides: true });
    expect(n).toBe('🤝 p · abcdef');
    expect(n.split(' · ')[1]!.length).toBe(HOMEBASE_FP_SUFFIX_LEN);
  });

  it('degrades rather than producing a nameless topic', () => {
    expect(homebaseTopicName('   ', 'abcdef00')).toBe('🤝 unknown peer');
    expect(homebaseTopicName('pp', '', { collides: true })).toBe('🤝 pp');
  });
});

describe('legacy name recognition', () => {
  it('rebuilds the pre-rename name exactly', () => {
    expect(legacyHomebaseTopicName('pp', 'abcdef0123456789')).toBe('pp · Threadline · abcdef');
    expect(legacyHomebaseTopicName('pp', '')).toBe('pp · Threadline');
  });

  it('recognises the legacy shape and not the new one', () => {
    expect(isLegacyHomebaseName('pp · Threadline · abcdef')).toBe(true);
    expect(isLegacyHomebaseName('pp · Threadline')).toBe(true);
    expect(isLegacyHomebaseName('🤝 pp')).toBe(false);
    expect(isLegacyHomebaseName('Threadline design notes')).toBe(false);
    expect(isLegacyHomebaseName(null)).toBe(false);
  });
});

describe('displayNameCollides', () => {
  const peers = [
    { fingerprint: 'aaa111', agent: 'Echo' },
    { fingerprint: 'bbb222', agent: 'echo' },
    { fingerprint: 'ccc333', agent: 'PP' },
  ];
  it('is true when ANOTHER fingerprint uses the same name (case-insensitive)', () => {
    expect(displayNameCollides('aaa111', 'Echo', peers)).toBe(true);
  });
  it('ignores the peer itself', () => {
    expect(displayNameCollides('ccc333', 'PP', peers)).toBe(false);
  });
});

describe('decideHomebaseBind', () => {
  it('NEVER touches an operator binding', () => {
    expect(decideHomebaseBind({ boundTopicId: 1, boundTopicSource: 'operator' }))
      .toEqual({ bind: false, reason: 'operator' });
  });

  it('PRESERVES a binding with unknown provenance — the legacy trap', () => {
    // It may be a deliberate bind from before the field existed. An earlier spec draft had
    // this bindable, which would have destroyed the choices the feature protects.
    expect(decideHomebaseBind({ boundTopicId: 42 }))
      .toEqual({ bind: false, reason: 'unknown-provenance' });
  });

  it('binds a provably accidental inherited binding', () => {
    expect(decideHomebaseBind({ boundTopicId: 42, boundTopicSource: 'origin-inherited' }))
      .toEqual({ bind: true, reason: 'origin-inherited' });
  });

  it('binds when nothing was chosen', () => {
    expect(decideHomebaseBind({})).toEqual({ bind: true, reason: 'no-binding' });
  });

  it('is a no-op when it is already the homebase', () => {
    expect(decideHomebaseBind({ boundTopicId: 7, boundTopicSource: 'peer-homebase' }))
      .toEqual({ bind: false, reason: 'already-homebase' });
  });

  it('an operator tag with no topic id still wins — the tag is the intent', () => {
    expect(decideHomebaseBind({ boundTopicSource: 'operator' }).bind).toBe(false);
  });
});

describe('selectConversationToBind', () => {
  it('zero conversations is NORMAL, not an error — pairing precedes conversation', () => {
    expect(selectConversationToBind([])).toEqual({ conversation: null, reason: 'none' });
  });

  it('binds the only conversation, subject to its provenance', () => {
    const r = selectConversationToBind([{ boundTopicSource: 'origin-inherited', boundTopicId: 5 }]);
    expect('verdict' in r && r.verdict.bind).toBe(true);
  });

  it('refuses to choose between several — that is the operator call', () => {
    expect(selectConversationToBind([{}, {}])).toEqual({ conversation: null, reason: 'ambiguous' });
  });

  it('passes the preserve verdict through for a single protected conversation', () => {
    const r = selectConversationToBind([{ boundTopicId: 9, boundTopicSource: 'operator' }]);
    expect('verdict' in r && r.verdict).toEqual({ bind: false, reason: 'operator' });
  });
});

describe('ensurePeerHomebase', () => {
  const base = () => ({
    enabled: true,
    holdsLease: true,
    findOrCreateTopic: async (_n: string) => ({ topicId: 500, reused: false }),
    getRecorded: (_fp: string) => undefined as number | undefined,
    record: (_fp: string, _t: number) => true,
  });

  it('creates and records for a verified peer', async () => {
    const calls: string[] = [];
    const r = await ensurePeerHomebase('abcdef0011', 'pp', {
      ...base(),
      findOrCreateTopic: async (n) => { calls.push(n); return { topicId: 500, reused: false }; },
    });
    expect(r).toEqual({ created: true, topicId: 500, reused: false });
    expect(calls).toEqual(['🤝 pp']);
  });

  it('is a strict no-op when the gate is off — an un-flipped agent behaves exactly as before', async () => {
    let touched = false;
    const r = await ensurePeerHomebase('abcdef0011', 'pp', {
      ...base(), enabled: false,
      findOrCreateTopic: async (n) => { touched = true; return { topicId: 1, reused: false }; },
    });
    expect(r).toEqual({ created: false, reason: 'disabled' });
    expect(touched).toBe(false);
  });

  it('a standby creates NOTHING — the 41-duplicate-topics failure', async () => {
    let touched = false;
    const r = await ensurePeerHomebase('abcdef0011', 'pp', {
      ...base(), holdsLease: false,
      findOrCreateTopic: async () => { touched = true; return { topicId: 1, reused: false }; },
    });
    expect(r).toEqual({ created: false, reason: 'not-lease-holder' });
    expect(touched).toBe(false);
  });

  it('does not create a second topic when one is already recorded', async () => {
    let touched = false;
    const r = await ensurePeerHomebase('abcdef0011', 'pp', {
      ...base(), getRecorded: () => 42,
      findOrCreateTopic: async () => { touched = true; return { topicId: 1, reused: false }; },
    });
    expect(r).toEqual({ created: false, reason: 'already-recorded', topicId: 42 });
    expect(touched).toBe(false);
  });

  it('reports a create failure instead of throwing — a pairing must never fail on this', async () => {
    const r = await ensurePeerHomebase('abcdef0011', 'pp', {
      ...base(), findOrCreateTopic: async () => { throw new Error('Chat is not a forum'); },
    });
    expect(r).toEqual({ created: false, reason: 'create-failed' });
  });

  it('surfaces a refused record rather than swallowing it', async () => {
    const r = await ensurePeerHomebase('abcdef0011', 'pp', { ...base(), record: () => false });
    expect(r).toEqual({ created: false, reason: 'record-refused' });
  });

  it('passes the reused flag through, so a found topic is distinguishable from a new one', async () => {
    const r = await ensurePeerHomebase('abcdef0011', 'pp', {
      ...base(), findOrCreateTopic: async () => ({ topicId: 9, reused: true }),
    });
    expect(r).toEqual({ created: true, topicId: 9, reused: true });
  });
});

describe('ensurePeerHomebase — legacy topics and collisions', () => {
  const base = () => ({
    enabled: true,
    holdsLease: true,
    findOrCreateTopic: async (_n: string) => ({ topicId: 500, reused: false }),
    getRecorded: (_fp: string) => undefined as number | undefined,
    record: (_fp: string, _t: number) => true,
  });

  it('adopts and renames an unrecorded legacy-named topic instead of creating a duplicate', async () => {
    let created = false;
    const renames: Array<[number, string]> = [];
    const r = await ensurePeerHomebase('abcdef0011', 'pp', {
      ...base(),
      findTopicByName: (n) => (n === 'pp · Threadline · abcdef' ? 77 : undefined),
      renameTopic: async (id, n) => { renames.push([id, n]); return true; },
      findOrCreateTopic: async () => { created = true; return { topicId: 1, reused: false }; },
    });
    expect(r).toEqual({ created: true, topicId: 77, reused: true });
    expect(created).toBe(false);
    expect(renames).toEqual([[77, '🤝 pp']]);
  });

  it('uses the fingerprint suffix when the name collides', async () => {
    const calls: string[] = [];
    await ensurePeerHomebase('abcdef0011', 'Echo', {
      ...base(),
      nameCollides: () => true,
      findOrCreateTopic: async (n) => { calls.push(n); return { topicId: 5, reused: false }; },
    });
    expect(calls).toEqual(['🤝 Echo · abcdef']);
  });
});

describe('boot backfill', () => {
  const names: Record<number, string> = { 10: 'old · Threadline · ccc333', 11: '🤝 Fresh' };
  const peers = [
    { fingerprint: 'aaa111', agent: 'NoTopic', pairingState: 'mutual-verified' },
    { fingerprint: 'bbb222', agent: 'Pending', pairingState: 'pending-verification' },
    { fingerprint: 'ccc333', agent: 'old', pairingState: 'mutual-verified', homebaseTopicId: 10 },
    { fingerprint: 'ddd444', agent: 'Fresh', pairingState: 'mutual-verified', homebaseTopicId: 11 },
    { agent: 'NoFp', pairingState: 'mutual-verified' },
  ];

  it('selects only mutual-verified peers without a homebase to create, and legacy-named ones to rename', () => {
    const sel = selectHomebaseBackfill(peers, (id) => names[id]);
    expect(sel.create.map((p) => p.fingerprint)).toEqual(['aaa111']);
    expect(sel.rename.map((p) => p.fingerprint)).toEqual(['ccc333']);
  });

  it('is bounded', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ fingerprint: `f${i}`, agent: `a${i}`, pairingState: 'mutual-verified' }));
    expect(selectHomebaseBackfill(many, () => null, 4).create).toHaveLength(4);
  });

  it('creates and renames, logging failures without throwing', async () => {
    const created: string[] = [];
    const renamed: Array<[number, string]> = [];
    const r = await backfillPeerHomebases(peers, {
      enabled: true,
      holdsLease: true,
      topicNameOf: (id) => names[id],
      findOrCreateTopic: async (n) => { created.push(n); return { topicId: 99, reused: false }; },
      renameTopic: async (id, n) => { renamed.push([id, n]); return true; },
      getRecorded: () => undefined,
      record: () => true,
    });
    expect(created).toEqual(['🤝 NoTopic']);
    expect(renamed).toEqual([[10, '🤝 old']]);
    expect(r).toEqual({ created: 1, renamed: 1, failed: 0 });

    const bad = await backfillPeerHomebases(peers, {
      enabled: true,
      holdsLease: true,
      topicNameOf: (id) => names[id],
      findOrCreateTopic: async () => { throw new Error('not a forum'); },
      renameTopic: async () => { throw new Error('boom'); },
      getRecorded: () => undefined,
      record: () => true,
    });
    expect(bad).toEqual({ created: 0, renamed: 0, failed: 2 });
  });

  it('does nothing on a standby or with the gate off', async () => {
    let touched = false;
    const d = {
      topicNameOf: (id: number) => names[id],
      findOrCreateTopic: async () => { touched = true; return { topicId: 1, reused: false }; },
      renameTopic: async () => { touched = true; return true; },
      getRecorded: () => undefined,
      record: () => true,
    };
    await backfillPeerHomebases(peers, { ...d, enabled: true, holdsLease: false });
    await backfillPeerHomebases(peers, { ...d, enabled: false, holdsLease: true });
    expect(touched).toBe(false);
  });
});
