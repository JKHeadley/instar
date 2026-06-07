/**
 * replayPolicy — both sides of every decision boundary.
 *
 * Regression target: the 2026-06-06 topic-21487 "incoherent scope creep"
 * incident. A CPU-starved-but-up server made every forward time out; the old
 * single-counter policy burned all 3 attempts in ~90s and DROPPED the user's
 * real question. The fix: only a genuine HTTP-400 ('poison') burns the drop
 * budget; transient capacity failures never do.
 */

import { describe, it, expect } from 'vitest';
import {
  decideReplay,
  MAX_POISON_REPLAY_FAILURES,
  MAX_TRANSIENT_REPLAY_FAILURES,
  type ReplayBudget,
} from '../../../src/lifeline/replayPolicy.js';

const fresh: ReplayBudget = { poisonFailures: 0, transientFailures: 0 };

describe('decideReplay — delivered', () => {
  it('ok → delivered, counters untouched', () => {
    const d = decideReplay('ok', { poisonFailures: 1, transientFailures: 5 });
    expect(d.action).toBe('delivered');
    expect(d.poisonFailures).toBe(1);
    expect(d.transientFailures).toBe(5);
    expect(d.dropReason).toBeUndefined();
  });
});

describe('decideReplay — transient (capacity/availability) NEVER burns the poison budget', () => {
  it('a single transient failure re-queues and increments ONLY the transient counter', () => {
    const d = decideReplay('transient', fresh);
    expect(d.action).toBe('requeue');
    expect(d.transientFailures).toBe(1);
    expect(d.poisonFailures).toBe(0); // the whole point — poison budget untouched
  });

  it('THE INCIDENT: many transient failures never trigger a drop and never touch poison', () => {
    // Replays a CPU-starvation episode: forward keeps timing out for a long
    // time. Under the OLD policy this dropped the message at 3. Now: never.
    let budget: ReplayBudget = { ...fresh };
    for (let i = 0; i < MAX_TRANSIENT_REPLAY_FAILURES - 1; i++) {
      const d = decideReplay('transient', budget);
      expect(d.action).toBe('requeue'); // never dropped through the whole episode
      expect(d.poisonFailures).toBe(0); // poison budget stays pristine
      budget = { poisonFailures: d.poisonFailures, transientFailures: d.transientFailures };
    }
    expect(budget.transientFailures).toBe(MAX_TRANSIENT_REPLAY_FAILURES - 1);
  });

  it('transient backstop: at the generous cap it finally drops with an honest reason', () => {
    const d = decideReplay('transient', {
      poisonFailures: 0,
      transientFailures: MAX_TRANSIENT_REPLAY_FAILURES - 1,
    });
    expect(d.action).toBe('drop');
    expect(d.transientFailures).toBe(MAX_TRANSIENT_REPLAY_FAILURES);
    expect(d.dropReason).toMatch(/unreachable/i);
    expect(d.poisonFailures).toBe(0); // still never burned poison
  });

  it('one strike below the transient cap still re-queues', () => {
    const d = decideReplay('transient', {
      poisonFailures: 0,
      transientFailures: MAX_TRANSIENT_REPLAY_FAILURES - 2,
    });
    expect(d.action).toBe('requeue');
  });
});

describe('decideReplay — poison (HTTP 400, message-specific) DOES burn the drop budget', () => {
  it('first and second poison strike re-queue', () => {
    const d1 = decideReplay('poison', fresh);
    expect(d1.action).toBe('requeue');
    expect(d1.poisonFailures).toBe(1);

    const d2 = decideReplay('poison', { poisonFailures: 1, transientFailures: 0 });
    expect(d2.action).toBe('requeue');
    expect(d2.poisonFailures).toBe(2);
  });

  it('the Nth poison strike drops with a bad-request reason', () => {
    const d = decideReplay('poison', {
      poisonFailures: MAX_POISON_REPLAY_FAILURES - 1,
      transientFailures: 0,
    });
    expect(d.action).toBe('drop');
    expect(d.poisonFailures).toBe(MAX_POISON_REPLAY_FAILURES);
    expect(d.dropReason).toMatch(/bad request|rejected/i);
  });

  it('poison strikes do NOT touch the transient counter', () => {
    const d = decideReplay('poison', { poisonFailures: 0, transientFailures: 7 });
    expect(d.transientFailures).toBe(7);
  });
});

describe('decideReplay — skew (HTTP 426) re-queues without burning anything', () => {
  it('skew always re-queues and never increments either counter', () => {
    const d = decideReplay('skew', { poisonFailures: 2, transientFailures: 9 });
    expect(d.action).toBe('requeue');
    expect(d.poisonFailures).toBe(2);
    expect(d.transientFailures).toBe(9);
  });

  it('skew never drops even at counts that would otherwise be at the poison cap', () => {
    const d = decideReplay('skew', {
      poisonFailures: MAX_POISON_REPLAY_FAILURES,
      transientFailures: MAX_TRANSIENT_REPLAY_FAILURES,
    });
    expect(d.action).toBe('requeue');
  });
});

describe('decideReplay — the two budgets are independent', () => {
  it('a message that mixes transient + poison only drops when POISON hits its (small) cap', () => {
    // Accrue lots of transient strikes, then poison strikes; the poison cap is
    // the small one and governs the message-specific drop.
    let budget: ReplayBudget = { poisonFailures: 0, transientFailures: 40 };
    const p1 = decideReplay('poison', budget);
    budget = { poisonFailures: p1.poisonFailures, transientFailures: p1.transientFailures };
    expect(p1.action).toBe('requeue');

    const p2 = decideReplay('poison', budget);
    budget = { poisonFailures: p2.poisonFailures, transientFailures: p2.transientFailures };
    expect(p2.action).toBe('requeue');

    const p3 = decideReplay('poison', budget);
    expect(p3.action).toBe('drop'); // poison cap (3) reached despite 40 transient
    expect(p3.transientFailures).toBe(40);
  });
});
