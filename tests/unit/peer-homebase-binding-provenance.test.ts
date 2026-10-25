/**
 * Binding provenance — the field that makes the 2026-10-21 misdelivery fixable.
 *
 * A notice about peer `pp` landed in a Claude-quota conversation because the peer
 * conversation had silently inherited the topic its thread started in, and nothing recorded
 * that the binding was accidental. Without provenance, "preserve the operator's deliberate
 * choice" and "fix the accidental one" are the same write, so neither is safe.
 *
 * The four cases below are the whole decision surface, and the legacy one is the trap: an
 * untagged binding may be a deliberate operator bind made before this field existed, so it
 * is preserved rather than treated as fair game. An earlier draft of the spec had it the
 * other way round and would have overwritten exactly the choices it promised to protect.
 */
import { describe, it, expect } from 'vitest';
import { applyEntryToConversation } from '../../src/threadline/ThreadResumeMap.js';

type Draft = Record<string, unknown> & { boundTopicSource?: string; boundTopicId?: number };

function draft(extra: Partial<Draft> = {}): any {
  return { threadId: 't1', participants: { peers: [] }, state: 'active', pinned: false, version: 0, ...extra };
}
function entry(extra: Record<string, unknown> = {}): any {
  return { state: 'active', pinned: false, ...extra };
}

/** The production signature is (entry, draft); this keeps the tests reading draft-first. */
function callMerge(d: any, e: any): any {
  return applyEntryToConversation(e, d);
}

describe('binding provenance', () => {
  it('tags an inherited origin topic as origin-inherited — provably accidental', () => {
    const out = callMerge(draft(), entry({ originTopicId: 999 }));
    expect(out.boundTopicId).toBe(999);
    expect(out.boundTopicSource).toBe('origin-inherited');
  });

  it('does NOT downgrade an operator bind when a later merge carries an origin topic', () => {
    // The operator bound this conversation deliberately. A resume merge must not relabel
    // that as accidental, or the homebase would be free to move it.
    const out = callMerge(draft({ boundTopicSource: 'operator', boundTopicId: 111 }), entry({ originTopicId: 999 }));
    expect(out.boundTopicSource).toBe('operator');
  });

  it('does NOT downgrade a peer-homebase bind either', () => {
    const out = callMerge(draft({ boundTopicSource: 'peer-homebase', boundTopicId: 222 }), entry({ originTopicId: 999 }));
    expect(out.boundTopicSource).toBe('peer-homebase');
  });

  it('leaves provenance absent when no origin topic is carried — a legacy record stays legacy', () => {
    const out = callMerge(draft({ boundTopicId: 333 }), entry({}));
    expect(out.boundTopicSource).toBeUndefined();
    expect(out.boundTopicId).toBe(333);
  });

  it('still writes boundTopicId, because resume paths read it', () => {
    // The fix deliberately TAGS the inheritance rather than deleting the write: removing it
    // would change a shared merge path for every conversation kind to fix one of them.
    const out = callMerge(draft(), entry({ originTopicId: 777 }));
    expect(out.boundTopicId).toBe(777);
  });
});

describe('the decision surface the homebase will consult', () => {
  const decide = (src: string | undefined, hasBinding: boolean) =>
    !hasBinding ? 'bind' : src === 'origin-inherited' ? 'bind' : 'preserve';

  it.each([
    ['operator', true, 'preserve'],
    [undefined, true, 'preserve'],
    ['origin-inherited', true, 'bind'],
    [undefined, false, 'bind'],
  ] as const)('provenance=%s hasBinding=%s -> %s', (src, hasBinding, expected) => {
    expect(decide(src, hasBinding)).toBe(expected);
  });
});
