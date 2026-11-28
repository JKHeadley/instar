import { describe, expect, it, vi } from 'vitest';
import { createProjectAnchorLookup, type ApprovedProjectAnchor } from '../../src/core/ProjectAnchorRegistry.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';

const chief = { id: 'chief-of-staff', kind: 'project', status: 'active', telegramTopicId: '141385' } as Initiative;
const context = { id: 'context-budget', kind: 'project', status: 'active', telegramTopicId: '141133' } as Initiative;
const anchor: ApprovedProjectAnchor = {
  revision: 1, purpose: 'Fixture purpose',
  sourceMessages: [{ conversationKey: 'telegram:141385', messageId: '101', at: '2026-11-26T22:00:00Z' }],
  done: [{ id: 'fold', text: 'Fold one long conversation', state: 'open' }],
  outOfScope: [{ text: 'Benchmark extension', ownedByProjectId: 'real-scenario-benchmark' }],
};

describe('read-only project anchor lookup', () => {
  it('requires an approved revision on one exact active project', () => {
    const readApproved = vi.fn((project: Initiative) => project.id === 'context-budget' ? anchor : null);
    const read = createProjectAnchorLookup({ listProjects: () => [chief, context], readApproved });
    expect(read('telegram:141133')).toEqual({ status: 'resolved', projectId: 'context-budget', anchor });
    expect(readApproved).toHaveBeenCalledWith(context, 'telegram:141133');
    expect(read('telegram:141385')).toEqual({ status: 'missing' });
    expect(read('app:141133')).toEqual({ status: 'missing' });
  });

  it('refuses ambiguity without reading an approved revision', () => {
    const readApproved = vi.fn(() => anchor);
    const impostor = { ...chief, telegramTopicId: context.telegramTopicId };
    const read = createProjectAnchorLookup({ listProjects: () => [impostor, context], readApproved });
    expect(read('telegram:141133')).toEqual({ status: 'ambiguous' });
    expect(readApproved).not.toHaveBeenCalled();
  });
});
