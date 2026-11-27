import { describe, expect, it } from 'vitest';
import { ownerNeedsCompletionBinding } from '../../src/core/OwnerNeedsCompletionDisclosure.js';

const shown = {
  id: 'disclosure',
  owner: 'owner',
  items: [
    { project: 'telegram:1', bindingVersion: 'v1', episode: 'first', evidenceRevision: 'a'.repeat(64), title: 'First project', outcome: 'The new settings page is ready.' },
    { project: 'telegram:2', bindingVersion: 'v2', episode: 'second', evidenceRevision: 'b'.repeat(64), title: 'Second project', outcome: 'The updated report is ready.' },
    { project: 'telegram:3', bindingVersion: 'v3', episode: 'third', evidenceRevision: 'c'.repeat(64), title: 'Third project', outcome: 'The phone test is ready.' },
  ],
};

describe('owner project completion disclosure binding', () => {
  it('can bind different choices and leaves an unanswered project pending', () => {
    const result = ownerNeedsCompletionBinding(shown, [
      { episode: 'second', decision: 'decline' }, { episode: 'first', decision: 'approve' },
    ]);
    expect(result?.purpose).toBe('owner-needs-project-completion-v1');
    expect(result?.decisions.map(x => [x.episode, x.decision]))
      .toEqual([['first', 'approve'], ['second', 'decline']]);
  });

  it('binds changed evidence or choices differently while retaining stable episode identity', () => {
    const first = ownerNeedsCompletionBinding(shown, [{ episode: 'first', decision: 'approve' }])!;
    const declined = ownerNeedsCompletionBinding(shown, [{ episode: 'first', decision: 'decline' }])!;
    const evidence = { ...shown, items: [{ ...shown.items[0], evidenceRevision: 'd'.repeat(64) }, ...shown.items.slice(1)] };
    const changed = ownerNeedsCompletionBinding(evidence, [{ episode: 'first', decision: 'approve' }])!;
    expect(declined.actionBindingDigest).not.toBe(first.actionBindingDigest);
    expect(changed.disclosureDigest).not.toBe(first.disclosureDigest);
    expect(changed.actionBindingDigest).not.toBe(first.actionBindingDigest);
    expect(declined.decisions[0].requestKey).toBe(first.decisions[0].requestKey);
    expect(changed.decisions[0].requestKey).toBe(first.decisions[0].requestKey);
  });

  it('rejects empty, duplicate, and unknown answers', () => {
    const approve = { episode: 'first', decision: 'approve' };
    for (const input of [[], [approve, approve], [{ ...approve, episode: 'unknown' }]]) {
      expect(ownerNeedsCompletionBinding(shown, input)).toBeNull();
    }
  });
});
