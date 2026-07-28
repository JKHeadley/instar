/**
 * The self-disable escalation must fire against the detector's REAL output shape.
 *
 * WHY THIS TEST EXISTS, and it is the whole point. The first implementation guessed the shape —
 * `id` instead of `pattern`, a bare array instead of `{ findings }` — and wrapped the mapping in a
 * best-effort try/catch. The catch swallowed the resulting error, so the escalation silently never
 * printed. A silent fallback hiding a bug, inside a change whose entire subject is warnings nobody
 * notices.
 *
 * Nothing failed. No error surfaced. It simply did not work, and only running it and LOOKING at the
 * output revealed that. So the mapping is now a pure exported function, and this pins it against the
 * shape the real detector actually emits — a future shape change fails here instead of disappearing
 * into the catch.
 */

import { describe, it, expect } from 'vitest';
import { sustainedOffEscalationLines } from '../setup/test-runner-semaphore.globalSetup.js';

/** The exact shape observed from detectSelfDisablePatterns() on a real ledger. */
const REAL_SHAPE = {
  findings: [
    {
      pattern: 'sustained-off',
      label: 'sustained INSTAR_HOST_TEST_SEMAPHORE=off skips',
      count: 39,
      threshold: 3,
      windowMs: 172_800_000,
      lastTs: '2026-07-27T14:13:33.188Z',
    },
  ],
  eventsScanned: 400,
};

describe('sustained-off escalation', () => {
  it('THE FIX: fires on the detector\'s real output shape', () => {
    const lines = sustainedOffEscalationLines(REAL_SHAPE);
    expect(lines, 'must not return null for a real sustained-off finding').not.toBeNull();
    expect(lines!.join('\n')).toContain('self-disable #39');
    expect(lines!.join('\n')).toContain('threshold 3');
    // It must say the consequence, not merely the count — a number alone is another ignorable line.
    expect(lines!.join('\n')).toMatch(/preflight/i);
  });

  it('REGRESSION: the shape the first implementation guessed produces nothing', () => {
    // `id` instead of `pattern`, and a bare array instead of { findings }. Both were silently wrong.
    expect(sustainedOffEscalationLines({ findings: [{ pattern: 'other', count: 9, threshold: 3 }] })).toBeNull();
    expect(sustainedOffEscalationLines([{ id: 'sustained-off', count: 9, threshold: 3 }] as never)).toBeNull();
  });

  it('does not fire below the threshold — one skip is not a pattern', () => {
    expect(sustainedOffEscalationLines({ findings: [{ pattern: 'sustained-off', count: 2, threshold: 3 }] })).toBeNull();
  });

  it('fires exactly AT the threshold', () => {
    expect(sustainedOffEscalationLines({ findings: [{ pattern: 'sustained-off', count: 3, threshold: 3 }] })).not.toBeNull();
  });

  it('tolerates null, undefined and malformed input without throwing', () => {
    // It runs on a logging path in globalSetup: a louder warning must never break a test run.
    expect(sustainedOffEscalationLines(null)).toBeNull();
    expect(sustainedOffEscalationLines(undefined)).toBeNull();
    expect(sustainedOffEscalationLines({} as never)).toBeNull();
    expect(sustainedOffEscalationLines({ findings: [] })).toBeNull();
    expect(sustainedOffEscalationLines({ findings: [{ pattern: 'sustained-off' }] })).toBeNull();
  });
});
