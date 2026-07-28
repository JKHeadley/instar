import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InitiativeTracker } from '../../../src/core/InitiativeTracker.js';
import { FeedbackInitiativeConsumer } from '../../../src/feedback-factory/drain/FeedbackInitiativeConsumer.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'initiative-consumer.test.ts' });
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-initiative-'));
  dirs.push(dir);
  const tracker = new InitiativeTracker(dir);
  return { tracker, consumer: new FeedbackInitiativeConsumer(tracker) };
}

const work = {
  workId: 'abc-123',
  feedbackWorkKey: 'feedback-work:cluster-7:1',
  clusterId: 'cluster-7',
  title: 'Investigate recurring scheduler failure',
  summary: 'Multiple independent reports point to the same bounded failure.',
  priority: 'high',
};

describe('FeedbackInitiativeConsumer', () => {
  it('creates one readable Initiative task with the exact immutable work key', async () => {
    const { tracker, consumer } = setup();
    const result = await consumer.consume(work);
    expect(result).toEqual({
      initiativeId: 'feedback-abc-123',
      feedbackWorkKey: work.feedbackWorkKey,
      reused: false,
      readable: true,
    });
    const initiative = tracker.findByFeedbackWorkKey(work.feedbackWorkKey);
    expect(initiative).toMatchObject({ kind: 'task', pipelineStage: 'outline' });
    expect(initiative?.phases.map((phase) => phase.id)).toEqual(['class-review', 'spec', 'build', 'verify']);
  });

  it('reuses the exact-key artifact without duplicating it', async () => {
    const { tracker, consumer } = setup();
    await consumer.consume(work);
    const second = await consumer.consume(work);
    expect(second.reused).toBe(true);
    expect(tracker.list().filter((item) => item.feedbackWorkKey === work.feedbackWorkKey)).toHaveLength(1);
  });

  it('rejects an incompatible deterministic-id collision', async () => {
    const { tracker, consumer } = setup();
    await tracker.create({
      id: 'feedback-abc-123',
      title: 'Unrelated task',
      description: 'Different source',
      phases: [{ id: 'build', name: 'Build' }],
    });
    await expect(consumer.consume(work)).rejects.toThrow('initiative-id-conflict');
  });
});
