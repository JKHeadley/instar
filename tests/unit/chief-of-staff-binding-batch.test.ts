import { describe, expect, it } from 'vitest';
import {
  OWNER_BINDING_BATCH_MAX_ITEMS, ownerBindingBatchHash, renderOwnerBindingBatch,
  validateOwnerBindingBatchDraft, type OwnerBindingBatchDraft,
} from '../../src/core/ChiefOfStaffBindingBatch.js';

const project = (conversationKey: string) => ({
  kind: 'project-bind' as const,
  title: `Project ${conversationKey}`,
  binding: {
    conversationKey,
    goal: 'Keep this project visible and current.',
    doneDefinition: [{ id: 'merged', kind: 'deterministic' as const, text: 'The change is merged.' }],
    checkCadenceHours: 24,
    linked: { repos: ['JKHeadley/instar'], branches: [], domains: [] },
  },
});
const placement = (childConversationKey: string) => ({
  kind: 'parent-placement' as const,
  title: 'Recorded app conversation',
  childConversationKey,
  parentConversationKey: 'telegram:18330',
  sourceCardId: 'wc_734c50a1ae480aa8',
  sourceFingerprint: 'a'.repeat(64),
  audienceFingerprint: 'b'.repeat(64),
});
const draft = (): OwnerBindingBatchDraft => ({
  version: 1,
  id: '0123456789abcdef0123456789abcdef',
  createdAt: '2026-11-26T12:00:00.000Z',
  sourceMessageRefs: ['telegram:141385/4531413501583092'],
  items: [project('telegram:147616'), placement('app:example')],
});

describe('Chief of Staff owner binding batches', () => {
  it('accepts an exact project and recorded-source placement set', () => {
    expect(validateOwnerBindingBatchDraft(draft())).toBe(true);
  });

  it('rejects duplicate children across project and placement operations', () => {
    const value = draft();
    value.items.push(placement('telegram:147616'));
    expect(validateOwnerBindingBatchDraft(value)).toBe(false);
  });

  it('rejects malformed source identity and unsafe oversized batches', () => {
    const badSource = draft();
    (badSource.items[1] as ReturnType<typeof placement>).sourceFingerprint = 'recorded-source';
    expect(validateOwnerBindingBatchDraft(badSource)).toBe(false);
    const tooLarge = draft();
    tooLarge.items = Array.from({ length: OWNER_BINDING_BATCH_MAX_ITEMS + 1 }, (_, i) => project(`telegram:${1000 + i}`));
    expect(validateOwnerBindingBatchDraft(tooLarge)).toBe(false);
  });

  it('hashes the complete immutable draft and discloses every operation', () => {
    const value = draft();
    const hash = ownerBindingBatchHash(value);
    expect(ownerBindingBatchHash(value)).toBe(hash);
    value.items[0] = project('telegram:147617');
    expect(ownerBindingBatchHash(value)).not.toBe(hash);
    const content = renderOwnerBindingBatch(draft(), ['“We are still showing project chats outside of the projects group.”']);
    expect(content).toContain('Review 2 exact changes');
    expect(content).toContain('Project telegram:147616');
    expect(content).toContain('Work Board source: wc_734c50a1ae480aa8');
    expect(content).toContain('We are still showing project chats outside of the projects group.');
  });

  it('refuses to render partial source disclosure', () => {
    expect(() => renderOwnerBindingBatch(draft(), [])).toThrow('invalid-owner-binding-batch');
  });
});
