import { describe, expect, it } from 'vitest';
import {
  applyAwarenessUpdate,
  MAX_RETAINED_ARCS,
  MAX_RECENT_ARC_EVENTS,
  normalizeAwarenessDraft,
  type AwarenessDraft,
  type TopicAwarenessState,
} from '../../src/core/TopicAwareness.js';

function draft(goal = 'Build reliable topic awareness'): AwarenessDraft {
  return {
    topic: {
      goal,
      trend: 'Moving from transcript replay toward durable orientation',
      themes: ['continuity', 'evidence-backed intent'],
    },
    recentArc: {
      goal: 'Design the three temporal levels',
      trend: 'Converging on a projection beside the confidence tiers',
      themes: ['topic scope', 'arc scope'],
    },
    currentWork: {
      goal: 'Implement the state transition',
      trend: 'Adding refusal-first transition rules',
      themes: ['grounding', 'hysteresis'],
    },
    arcTransition: { kind: 'continue' },
  };
}

function update(
  existing: TopicAwarenessState | undefined,
  value: AwarenessDraft,
  opts: { id: string; text: string; turn: number; fromUser?: boolean; at?: string },
) {
  return applyAwarenessUpdate(existing, value, {
    topicId: 776,
    messageId: opts.id,
    messageText: opts.text,
    fromUser: opts.fromUser ?? true,
    at: opts.at ?? `2026-08-01T00:0${opts.turn}:00.000Z`,
    turn: opts.turn,
  });
}

describe('TopicAwareness', () => {
  it('requires goal + trend + themes at every temporal level', () => {
    expect(normalizeAwarenessDraft(draft())).not.toBeNull();
    const invalid = draft() as unknown as Record<string, any>;
    invalid.currentWork.themes = [];
    expect(normalizeAwarenessDraft(invalid)).toBeNull();
  });

  it('holds the initial topic anchor while the holistic topic view evolves', () => {
    const first = update(undefined, draft('Keep the agent oriented across a long topic'), {
      id: 'm1', text: 'Keep the agent oriented across a long topic', turn: 1,
      at: '2026-01-01T00:00:00.000Z',
    })!;
    const anchorBytes = JSON.stringify(first.state.anchor);
    const evolvedDraft = draft('Keep continuity while adding legitimate topic evolution');
    evolvedDraft.topic.trend = 'The original continuity goal is expanding into evolution-aware tracking';
    const evolved = update(first.state, evolvedDraft, {
      id: 'm2', text: 'Let the topic evolve without losing its original course', turn: 2,
      // Well beyond Topic Intent's ordinary goal-ref decay horizon. Awareness
      // anchors are deliberately outside that confidence projection.
      at: '2026-04-15T00:00:00.000Z',
    })!;

    expect(JSON.stringify(evolved.state.anchor)).toBe(anchorBytes);
    expect(evolved.state.anchor.goal).toBe('Keep the agent oriented across a long topic');
    expect(evolved.state.anchor).not.toHaveProperty('confidence');
    expect(evolved.state.topic.goal).toBe('Keep continuity while adding legitimate topic evolution');
    expect(evolved.state.currentWork.goal).toBe('Implement the state transition');
    expect(evolved.state.arcs).toHaveLength(1);
  });

  it('refuses to let an agent-authored observation create the immutable anchor', () => {
    expect(update(undefined, draft(), {
      id: 'a1', text: 'I think this topic is about awareness', turn: 0, fromUser: false,
    })).toBeNull();
  });

  it('accepts an explicit user-grounded arc transition immediately', () => {
    const first = update(undefined, draft(), {
      id: 'm1', text: 'Build the awareness layer', turn: 1,
    })!;
    const shifted = draft();
    shifted.recentArc.goal = 'Repair the delivery seam';
    shifted.arcTransition = { kind: 'new', evidenceQuote: 'Now switch to repairing the delivery seam' };
    const result = update(first.state, shifted, {
      id: 'm2', text: 'Now switch to repairing the delivery seam', turn: 2,
    })!;

    expect(result.transitioned).toBe(true);
    expect(result.effectiveArcId).toBe('arc-776-2');
    expect(result.state.arcs.map((arc) => arc.status)).toEqual(['closed', 'active']);
  });

  it('rejects ungrounded transitions and requires two similar implicit signals', () => {
    const first = update(undefined, draft(), {
      id: 'm1', text: 'Build the awareness layer', turn: 1,
    })!;

    const ungrounded = draft();
    ungrounded.recentArc.goal = 'Investigate delivery health';
    ungrounded.arcTransition = { kind: 'new', evidenceQuote: 'words not present in the message' };
    const refused = update(first.state, ungrounded, {
      id: 'm2', text: 'Investigate delivery health', turn: 2,
    })!;
    expect(refused.transitioned).toBe(false);
    expect(refused.state.pendingArcCandidate).toBeUndefined();

    const candidate = draft();
    candidate.recentArc.goal = 'Investigate delivery health and transport evidence';
    candidate.arcTransition = { kind: 'new', evidenceQuote: 'Investigate delivery health' };
    const once = update(refused.state, candidate, {
      id: 'm3', text: 'Investigate delivery health', turn: 3,
    })!;
    expect(once.transitioned).toBe(false);
    expect(once.state.pendingArcCandidate?.confirmations).toBe(1);

    const again = draft();
    again.recentArc.goal = 'Investigate transport evidence and delivery health';
    again.arcTransition = { kind: 'new', evidenceQuote: 'delivery health remains the work' };
    const twice = update(once.state, again, {
      id: 'm4', text: 'delivery health remains the work', turn: 4,
    })!;
    expect(twice.transitioned).toBe(true);
    expect(twice.state.currentArcId).toBe('arc-776-2');
  });

  it('keeps implicit transition hysteresis across the intervening agent reply', () => {
    const first = update(undefined, draft(), {
      id: 'm1', text: 'Build the awareness layer', turn: 1,
      at: '2026-08-01T00:01:00.000Z',
    })!;
    const candidate = draft();
    candidate.recentArc.goal = 'Investigate delivery health and transport evidence';
    candidate.arcTransition = { kind: 'new', evidenceQuote: 'Investigate delivery health' };
    const once = update(first.state, candidate, {
      id: 'm2', text: 'Investigate delivery health', turn: 2,
      at: '2026-08-01T00:02:00.000Z',
    })!;

    const agentReply = update(once.state, draft(), {
      id: 'a2', text: 'I am investigating it', turn: 2, fromUser: false,
      at: '2026-08-01T00:02:30.000Z',
    })!;
    expect(agentReply.state.pendingArcCandidate?.confirmations).toBe(1);

    const again = draft();
    again.recentArc.goal = 'Investigate transport evidence and delivery health';
    again.arcTransition = { kind: 'new', evidenceQuote: 'delivery health remains the work' };
    const twice = update(agentReply.state, again, {
      id: 'm3', text: 'delivery health remains the work', turn: 3,
      at: '2026-08-01T00:03:00.000Z',
    })!;
    expect(twice.transitioned).toBe(true);
  });

  it('refuses a slower older extraction instead of rolling the projection back', () => {
    const first = update(undefined, draft('Initial topic'), {
      id: 'm1', text: 'Initial topic', turn: 1,
      at: '2026-08-01T00:01:00.000Z',
    })!;
    const newest = update(first.state, draft('Newest topic view'), {
      id: 'm3', text: 'Newest topic view', turn: 3,
      at: '2026-08-01T00:03:00.000Z',
    })!;
    const late = update(newest.state, draft('Late older topic view'), {
      id: 'm2', text: 'Late older topic view', turn: 2,
      at: '2026-08-01T00:02:00.000Z',
    })!;

    expect(late.applied).toBe(false);
    expect(late.stale).toBe(true);
    expect(late.state.topic.goal).toBe('Newest topic view');
  });

  it('lets an earlier valid completion correct only the anchor, never newer orientation', () => {
    const completedFirst = update(undefined, draft('Later completion'), {
      id: 'm3', text: 'Later completion', turn: 3,
      at: '2026-08-01T00:03:00.000Z',
    })!;
    const completedLate = update(completedFirst.state, draft('Earliest valid goal'), {
      id: 'm1', text: 'Earliest valid goal', turn: 1,
      at: '2026-08-01T00:01:00.000Z',
    })!;

    expect(completedLate.applied).toBe(false);
    expect(completedLate.anchorCorrected).toBe(true);
    expect(completedLate.state.anchor.goal).toBe('Earliest valid goal');
    expect(completedLate.state.anchor.sourceTurn).toBe(1);
    expect(completedLate.state.topic.goal).toBe('Later completion');
    expect(completedLate.state.turnAtUpdate).toBe(3);
  });

  it('inserts a delayed explicit boundary in conversation order without rolling newer orientation back', () => {
    const first = update(undefined, draft('Initial goal'), {
      id: 'm1', text: 'Initial goal', turn: 1,
      at: '2026-08-01T00:01:00.000Z',
    })!;
    const later = draft('Newest topic view');
    later.recentArc.goal = 'Documentation work after the shift';
    const completedFirst = update(first.state, later, {
      id: 'm3', text: 'Continue documenting the design', turn: 3,
      at: '2026-08-01T00:03:00.000Z',
    })!;

    const shift = draft('Older topic view must not replace turn three');
    shift.recentArc.goal = 'Move into documentation';
    shift.arcTransition = { kind: 'new', evidenceQuote: 'Now move to documentation' };
    const completedLate = update(completedFirst.state, shift, {
      id: 'm2', text: 'Now move to documentation', turn: 2,
      at: '2026-08-01T00:02:00.000Z',
    })!;

    expect(completedLate.applied).toBe(false);
    expect(completedLate.stale).toBe(true);
    expect(completedLate.transitioned).toBe(true);
    expect(completedLate.stateReconciled).toBe(true);
    expect(completedLate.effectiveArcId).toBe('arc-776-2');
    expect(completedLate.state.currentArcId).toBe('arc-776-2');
    expect(completedLate.state.arcs.map((arc) => arc.startedTurn)).toEqual([1, 2]);
    expect(completedLate.state.arcs[1].layer.goal).toBe('Documentation work after the shift');
    expect(completedLate.state.topic.goal).toBe('Newest topic view');
    expect(completedLate.state.currentWork.sourceMessageId).toBe('m3');
  });

  it('refolds a boundary between a late-corrected anchor and the first completed turn', () => {
    const turnThreeFirst = draft('Newest topic view');
    turnThreeFirst.recentArc.goal = 'Implementation after the boundary';
    const completedFirst = update(undefined, turnThreeFirst, {
      id: 'm3', text: 'Continue the implementation', turn: 3,
      at: '2026-08-01T00:03:00.000Z',
    })!;

    const correctedAnchor = update(completedFirst.state, draft('Earliest topic goal'), {
      id: 'm1', text: 'Earliest topic goal', turn: 1,
      at: '2026-08-01T00:01:00.000Z',
    })!;
    expect(correctedAnchor.anchorCorrected).toBe(true);
    expect(correctedAnchor.state.arcs[0].startedTurn).toBe(1);

    const shift = draft('Older topic view must not replace turn three');
    shift.recentArc.goal = 'Begin the implementation arc';
    shift.arcTransition = { kind: 'new', evidenceQuote: 'Now switch to implementation' };
    const boundaryLast = update(correctedAnchor.state, shift, {
      id: 'm2', text: 'Now switch to implementation', turn: 2,
      at: '2026-08-01T00:02:00.000Z',
    })!;

    expect(boundaryLast.applied).toBe(false);
    expect(boundaryLast.transitioned).toBe(true);
    expect(boundaryLast.effectiveArcId).toBe('arc-776-2');
    expect(boundaryLast.state.arcs.map((arc) => arc.startedTurn)).toEqual([1, 2]);
    expect(boundaryLast.state.arcs[1].layer.goal).toBe('Implementation after the boundary');
    expect(boundaryLast.state.topic.goal).toBe('Newest topic view');
  });

  it('recognizes a delayed first implicit candidate and transitions at the second user turn', () => {
    const first = update(undefined, draft(), {
      id: 'm1', text: 'Build the awareness layer', turn: 1,
      at: '2026-08-01T00:01:00.000Z',
    })!;
    const secondCandidate = draft();
    secondCandidate.recentArc.goal = 'Investigate transport evidence and delivery health';
    secondCandidate.arcTransition = { kind: 'new', evidenceQuote: 'delivery health remains the work' };
    const completedFirst = update(first.state, secondCandidate, {
      id: 'm3', text: 'delivery health remains the work', turn: 3,
      at: '2026-08-01T00:03:00.000Z',
    })!;
    expect(completedFirst.transitioned).toBe(false);

    const firstCandidate = draft();
    firstCandidate.recentArc.goal = 'Investigate delivery health and transport evidence';
    firstCandidate.arcTransition = { kind: 'new', evidenceQuote: 'Investigate delivery health' };
    const completedLate = update(completedFirst.state, firstCandidate, {
      id: 'm2', text: 'Investigate delivery health', turn: 2,
      at: '2026-08-01T00:02:00.000Z',
    })!;

    expect(completedLate.transitioned).toBe(true);
    expect(completedLate.effectiveArcId).toBe('arc-776');
    expect(completedLate.state.currentArcId).toBe('arc-776-2');
    expect(completedLate.state.arcs[1].startedTurn).toBe(3);
  });

  it('withdraws an apparent implicit boundary when a delayed intervening user continuation arrives', () => {
    const first = update(undefined, draft(), {
      id: 'm1', text: 'Build the awareness layer', turn: 1,
      at: '2026-08-01T00:01:00.000Z',
    })!;
    const candidate = draft();
    candidate.recentArc.goal = 'Investigate delivery health and transport evidence';
    candidate.arcTransition = { kind: 'new', evidenceQuote: 'Investigate delivery health' };
    const once = update(first.state, candidate, {
      id: 'm2', text: 'Investigate delivery health', turn: 2,
      at: '2026-08-01T00:02:00.000Z',
    })!;
    const again = draft();
    again.recentArc.goal = 'Investigate transport evidence and delivery health';
    again.arcTransition = { kind: 'new', evidenceQuote: 'delivery health remains the work' };
    const apparentPair = update(once.state, again, {
      id: 'm4', text: 'delivery health remains the work', turn: 4,
      at: '2026-08-01T00:04:00.000Z',
    })!;
    expect(apparentPair.state.arcs).toHaveLength(2);

    const intervening = draft();
    intervening.recentArc.goal = 'Continue implementing the existing awareness layer';
    const reconciled = update(apparentPair.state, intervening, {
      id: 'm3', text: 'Keep going on the same implementation', turn: 3,
      at: '2026-08-01T00:03:00.000Z',
    })!;

    expect(reconciled.applied).toBe(false);
    expect(reconciled.stateReconciled).toBe(true);
    expect(reconciled.state.arcs).toHaveLength(1);
    expect(reconciled.state.currentArcId).toBe('arc-776');
    expect(reconciled.state.pendingArcCandidate?.goal).toContain('transport evidence');
  });

  it('bounds both the completion-reorder journal and retained closed-arc history', () => {
    let state = update(undefined, draft(), {
      id: 'm1', text: 'Build the awareness layer', turn: 1,
      at: '2026-08-01T00:01:00.000Z',
    })!.state;
    for (let turn = 2; turn <= 75; turn++) {
      const shifted = draft();
      shifted.recentArc.goal = `Phase ${turn}`;
      shifted.arcTransition = { kind: 'new', evidenceQuote: `Now switch to phase ${turn}` };
      state = update(state, shifted, {
        id: `m${turn}`,
        text: `Now switch to phase ${turn}`,
        turn,
        at: new Date(Date.UTC(2026, 7, 1, 0, turn)).toISOString(),
      })!.state;
    }

    expect(state.recentArcEvents.length).toBeLessThanOrEqual(MAX_RECENT_ARC_EVENTS);
    expect(state.arcs.length).toBe(MAX_RETAINED_ARCS);
    expect(state.archivedArcCount).toBeGreaterThan(0);
    expect(state.currentArcId).toBe('arc-776-75');
  });
});
