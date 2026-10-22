/**
 * The two homebase decisions, and the one that must never go permissive.
 */
import { describe, it, expect } from 'vitest';
import {
  homebaseTopicName,
  decideHomebaseBind,
  selectConversationToBind,
  HOMEBASE_FP_SUFFIX_LEN,
} from '../../src/threadline/peerHomebase.js';

describe('homebaseTopicName', () => {
  it('is "<peer> · Threadline · <fp6>"', () => {
    expect(homebaseTopicName('pp', 'abcdef0123456789')).toBe('pp · Threadline · abcdef');
  });

  it('separates two peers that chose the SAME display name', () => {
    // The whole reason the suffix exists: find-or-create keys on the name, so without it both
    // peers would silently share one topic.
    const a = homebaseTopicName('Echo', '1111111111');
    const b = homebaseTopicName('Echo', '2222222222');
    expect(a).not.toBe(b);
  });

  it('still collides when BOTH the name and the fp prefix match — accepted, not fixed', () => {
    const a = homebaseTopicName('Echo', 'aaaaaa-1111');
    const b = homebaseTopicName('Echo', 'aaaaaa-2222');
    expect(a).toBe(b); // documented in spec §6 as an accepted long-tail risk
  });

  it('strips separators from the fingerprint and bounds the suffix length', () => {
    const n = homebaseTopicName('p', 'ab:cd:ef:01:23');
    expect(n).toBe('p · Threadline · abcdef');
    expect(n.split(' · ')[2]!.length).toBe(HOMEBASE_FP_SUFFIX_LEN);
  });

  it('degrades rather than producing a nameless topic', () => {
    expect(homebaseTopicName('   ', 'abcdef00')).toBe('unknown peer · Threadline · abcdef');
    expect(homebaseTopicName('pp', '')).toBe('pp · Threadline');
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
