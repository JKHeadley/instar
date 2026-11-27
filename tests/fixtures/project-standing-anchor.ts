import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import type { ApprovedProjectAnchor } from '../../src/core/ProjectAnchorRegistry.js';
import type { ReadProjectAnchor } from '../../src/monitoring/contextLayers/standingPacket.js';

export const PROJECT_ANCHOR_FIXTURE_LINE = 'Approved project anchor for context-budget, revision 1';

export const readProjectAnchorFixture: ReadProjectAnchor = (conversationKey) =>
  conversationKey === 'telegram:141133'
    ? {
        status: 'resolved',
        projectId: 'context-budget',
        anchor: {
          revision: 1,
          purpose: 'Fixture purpose',
          sourceMessages: [{ conversationKey: 'fixture:owner', messageId: '101', at: '2026-11-26T22:00:00Z' }],
          done: [{ id: 'fold', text: 'Fold one long conversation', state: 'open' }],
          outOfScope: [{ text: 'Benchmark expansion', ownedByProjectId: 'real-scenario-benchmark' }],
        },
      }
    : { status: 'missing' };

export async function persistedProjectAnchorFixture(stateDir: string, confirmed = true): Promise<InitiativeTracker> {
  const tracker = new InitiativeTracker(stateDir);
  const project = await tracker.create({
    id: 'context-budget',
    kind: 'project',
    telegramTopicId: '141133',
    title: 'Context Budget fixture',
    description: 'Registry fixture for the standing packet.',
    phases: [{ id: 'pilot', name: 'Pilot' }],
  });
  if (!confirmed) return new InitiativeTracker(stateDir);
  const lookup = readProjectAnchorFixture('telegram:141133');
  if (lookup.status !== 'resolved') throw new Error('missing project anchor fixture');
  const approved: ApprovedProjectAnchor = {
    ...lookup.anchor,
    sourceMessages: lookup.anchor.sourceMessages.map((source) => ({ ...source, conversationKey: 'telegram:141385' })),
  };
  await tracker.approveProjectAnchor(project.id, project.version ?? 1, 'telegram:141133', approved);
  return new InitiativeTracker(stateDir);
}
