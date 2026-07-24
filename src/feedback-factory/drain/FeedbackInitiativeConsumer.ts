import type { Initiative, InitiativeTracker } from '../../core/InitiativeTracker.js';

export const FEEDBACK_INITIATIVE_CONSUMER_STAGE = {
  canonicalPipelineId: 'feedback-factory',
  stage: 'consumer-handoff',
} as const;

export interface FeedbackInitiativeWork {
  workId: string;
  feedbackWorkKey: string;
  clusterId: string;
  title: string;
  summary: string;
  priority: string;
}

export interface FeedbackInitiativeConsumeResult {
  initiativeId: string;
  feedbackWorkKey: string;
  reused: boolean;
  readable: true;
}

type InitiativePort = Pick<InitiativeTracker, 'create' | 'findByFeedbackWorkKey' | 'get'>;

function initiativeIdFor(workId: string): string {
  const normalized = workId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const id = `feedback-${normalized}`.slice(0, 63).replace(/-+$/g, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error('feedback work id cannot produce a valid Initiative id');
  }
  return id;
}

/**
 * Production feedback-work consumer. InitiativeTracker is authoritative for
 * artifact existence; this adapter never acknowledges a create until an exact
 * feedbackWorkKey read-back succeeds.
 */
export class FeedbackInitiativeConsumer {
  constructor(private readonly tracker: InitiativePort) {}

  async consume(work: FeedbackInitiativeWork): Promise<FeedbackInitiativeConsumeResult> {
    const exact = this.tracker.findByFeedbackWorkKey(work.feedbackWorkKey);
    if (exact) return this.readBack(exact, work.feedbackWorkKey, true);

    const initiativeId = initiativeIdFor(work.workId);
    const byId = this.tracker.get(initiativeId);
    if (byId && byId.feedbackWorkKey !== work.feedbackWorkKey) {
      throw new Error('initiative-id-conflict');
    }

    let created: Initiative;
    try {
      created = await this.tracker.create({
        id: initiativeId,
        kind: 'task',
        pipelineStage: 'outline',
        feedbackWorkKey: work.feedbackWorkKey,
        title: work.title.slice(0, 200),
        description: `${work.summary.slice(0, 1800)}\n\nFeedback cluster: ${work.clusterId}\nPriority: ${work.priority}`,
        phases: [
          { id: 'class-review', name: 'Class review' },
          { id: 'spec', name: 'Specification' },
          { id: 'build', name: 'Build' },
          { id: 'verify', name: 'Verify' },
        ],
        links: [
          { type: 'other', label: 'Feedback cluster', ref: work.clusterId },
          { type: 'other', label: 'Feedback work', ref: work.feedbackWorkKey },
        ],
      });
    } catch (error) {
      // Ambiguous create timeout/failure: the authoritative store may have
      // committed. Exact-key reconciliation is the only safe recovery.
      const recovered = this.tracker.findByFeedbackWorkKey(work.feedbackWorkKey);
      if (recovered) return this.readBack(recovered, work.feedbackWorkKey, true);
      throw error;
    }
    return this.readBack(created, work.feedbackWorkKey, false);
  }

  private readBack(
    initiative: Initiative,
    feedbackWorkKey: string,
    reused: boolean,
  ): FeedbackInitiativeConsumeResult {
    const readable = this.tracker.get(initiative.id);
    if (!readable || readable.feedbackWorkKey !== feedbackWorkKey) {
      throw new Error('initiative-readback-failed');
    }
    return { initiativeId: readable.id, feedbackWorkKey, reused, readable: true };
  }
}
