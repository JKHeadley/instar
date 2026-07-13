import { describe, it, expect } from 'vitest';
import {
  evaluateHogRespawnWrong,
  evaluateHogSustainedRight,
  evaluateHogLeaveRecurrence,
  type HogDecisionRecord,
  type HogEvidenceScanView,
  type HogEvidenceCandidate,
} from '../../src/monitoring/ExternalHogDecisionStore.js';

/**
 * The three §5.4.5 hog evidence-rule predicates (llm-decision-quality-meter), BOTH directions
 * with the spoof scenarios the review pinned: a new-owner respawn can never fabricate `wrong`;
 * a lookalike (different process, same commandHash) can never fabricate `wrong`; a breaker-held
 * kill re-flag grades NOTHING; would-kill/deferred/aborted/decider-unavailable age out ungraded.
 * Pure predicates over an injected clock value — no real time anywhere.
 */

const T0 = 1_750_000_000_000;
const HOUR = 60 * 60 * 1000;
const WINDOW = 6 * HOUR;

function killRecord(over: Partial<HogDecisionRecord> = {}): HogDecisionRecord {
  return {
    verdict: 'kill',
    enacted: 'killed',
    correlationId: 'd-kill-1',
    atMs: T0,
    targetTuple: { pid: 900, startTimeMs: T0 - HOUR },
    ownerTuple: { parentPid: 400 }, // parentPid ALWAYS present on enacted kills (§5.3)
    floorPermitted: true,
    commandHash: 'hashA',
    effectiveWindowMs: WINDOW,
    ...over,
  };
}

function leaveRecord(over: Partial<HogDecisionRecord> = {}): HogDecisionRecord {
  return killRecord({ verdict: 'leave', enacted: 'alert-only-model-spared', correlationId: 'd-leave-1', ...over });
}

function view(cands: HogEvidenceCandidate[] = [], alive: Record<number, number | null> = {}): HogEvidenceScanView {
  return { candidates: cands, aliveStartTimeMs: (pid) => (pid in alive ? alive[pid] : undefined) };
}

const RESPAWN: HogEvidenceCandidate = { pid: 951, startTimeMs: T0 + HOUR, commandHash: 'hashA' };

describe('hog-respawn-wrong-v1 (deterministic-proof)', () => {
  it('wrong: same-commandHash candidate respawned AND the ordering test re-runs TRUE (live parent started ≤ killed child)', () => {
    const grade = evaluateHogRespawnWrong(killRecord(), view([RESPAWN], { 400: T0 - 2 * HOUR }), T0 + 2 * HOUR);
    expect(grade).toBe('wrong');
  });

  it('spoof: a respawn under a genuinely NEW owner (no live process at the recorded parent pid) grades unknown, never wrong', () => {
    // aliveStartTimeMs(400) === undefined — the operator's editor is still closed.
    expect(evaluateHogRespawnWrong(killRecord(), view([RESPAWN], {}), T0 + 2 * HOUR)).toBe('unknown');
  });

  it('spoof: the parent pid was REUSED by a newer process (started AFTER the killed child) → unknown, never wrong', () => {
    expect(evaluateHogRespawnWrong(killRecord(), view([RESPAWN], { 400: T0 + 30 * 60_000 }), T0 + 2 * HOUR)).toBe('unknown');
  });

  it('un-orderable start-times → unknown (live parent un-parseable; killed child un-parseable)', () => {
    expect(evaluateHogRespawnWrong(killRecord(), view([RESPAWN], { 400: null }), T0 + 2 * HOUR)).toBe('unknown');
    expect(
      evaluateHogRespawnWrong(
        killRecord({ targetTuple: { pid: 900, startTimeMs: null } }),
        view([RESPAWN], { 400: T0 - 2 * HOUR }),
        T0 + 2 * HOUR,
      ),
    ).toBe('unknown');
  });

  it('no same-commandHash candidate → null (no evidence event)', () => {
    const otherHash: HogEvidenceCandidate = { pid: 951, startTimeMs: T0 + HOUR, commandHash: 'hashZ' };
    expect(evaluateHogRespawnWrong(killRecord(), view([otherHash], { 400: T0 - 2 * HOUR }), T0 + 2 * HOUR)).toBeNull();
  });

  it('the killed process itself (same pid + orderable equal start) is NOT a respawn trigger', () => {
    const self: HogEvidenceCandidate = { pid: 900, startTimeMs: T0 - HOUR, commandHash: 'hashA' };
    expect(evaluateHogRespawnWrong(killRecord(), view([self], { 400: T0 - 2 * HOUR }), T0 + 2 * HOUR)).toBeNull();
  });

  it('outside the window → null (window-close grading belongs to the *-right rule)', () => {
    expect(evaluateHogRespawnWrong(killRecord(), view([RESPAWN], { 400: T0 - 2 * HOUR }), T0 + WINDOW + 1)).toBeNull();
  });

  it('non-enacted dispositions never enter kill-grading: would-kill / deferred / aborted / decider-unavailable age out ungraded', () => {
    for (const enacted of ['would-kill', 'deferred', 'aborted', 'decider-unavailable'] as const) {
      const rec = killRecord({ enacted, verdict: enacted === 'decider-unavailable' ? 'decider-unavailable' : 'kill' });
      expect(evaluateHogRespawnWrong(rec, view([RESPAWN], { 400: T0 - 2 * HOUR }), T0 + 2 * HOUR)).toBeNull();
    }
  });

  it('a breaker-held kill verdict re-flag grades NOTHING (the brake is normal operation, never the classifier)', () => {
    const held = killRecord({ enacted: 'alert-only-breaker-held' });
    expect(evaluateHogRespawnWrong(held, view([RESPAWN], { 400: T0 - 2 * HOUR }), T0 + 2 * HOUR)).toBeNull();
    // …and it is not a leave either — the recurrence rule also refuses it.
    expect(evaluateHogLeaveRecurrence(held, RESPAWN, T0 + 2 * HOUR)).toBeNull();
  });

  it('sigterm-exited counts as an enacted kill', () => {
    expect(evaluateHogRespawnWrong(killRecord({ enacted: 'sigterm-exited' }), view([RESPAWN], { 400: T0 - 2 * HOUR }), T0 + 2 * HOUR)).toBe('wrong');
  });

  it('a missing recorded parentPid (structurally impossible on enacted kills) degrades to unknown, never a throw', () => {
    expect(evaluateHogRespawnWrong(killRecord({ ownerTuple: {} }), view([RESPAWN], {}), T0 + 2 * HOUR)).toBe('unknown');
  });
});

describe('hog-sustained-right-v1 (negative-evidence, window close — the grading job drives this)', () => {
  it('right: enacted kill, floor recorded owner dead, window CLOSED, no in-window re-flag', () => {
    expect(evaluateHogSustainedRight(killRecord(), T0 + WINDOW + 1)).toBe('right');
  });

  it('null while the window is still open', () => {
    expect(evaluateHogSustainedRight(killRecord(), T0 + WINDOW - 1)).toBeNull();
    expect(evaluateHogSustainedRight(killRecord(), T0 + WINDOW)).toBeNull(); // boundary: close means STRICTLY past
  });

  it('null when a re-flag was recorded inside the window', () => {
    expect(evaluateHogSustainedRight(killRecord({ reFlaggedAtMs: T0 + HOUR }), T0 + WINDOW + 1)).toBeNull();
  });

  it('a re-flag AFTER window close does not retract the negative evidence', () => {
    expect(evaluateHogSustainedRight(killRecord({ reFlaggedAtMs: T0 + WINDOW + 5 }), T0 + WINDOW + 10)).toBe('right');
  });

  it('preconditions: non-enacted kills and floor-unpermitted records never grade right', () => {
    expect(evaluateHogSustainedRight(killRecord({ enacted: 'would-kill' }), T0 + WINDOW + 1)).toBeNull();
    expect(evaluateHogSustainedRight(killRecord({ enacted: 'deferred' }), T0 + WINDOW + 1)).toBeNull();
    expect(evaluateHogSustainedRight(killRecord({ floorPermitted: false }), T0 + WINDOW + 1)).toBeNull();
    expect(evaluateHogSustainedRight(leaveRecord(), T0 + WINDOW + 1)).toBeNull();
  });
});

describe('hog-leave-recurrence-v1 (recurrence-proxy)', () => {
  const SAME_PROCESS: HogEvidenceCandidate = { pid: 900, startTimeMs: T0 - HOUR, commandHash: 'hashA' };

  it('wrong: the SAME process (pid + orderable equal start-time) re-flags in-window', () => {
    expect(evaluateHogLeaveRecurrence(leaveRecord(), SAME_PROCESS, T0 + HOUR)).toBe('wrong');
  });

  it('spoof: a DIFFERENT process with the same commandHash grades unknown — a lookalike cannot fabricate wrong', () => {
    const lookalike: HogEvidenceCandidate = { pid: 955, startTimeMs: T0 + 10_000, commandHash: 'hashA' };
    expect(evaluateHogLeaveRecurrence(leaveRecord(), lookalike, T0 + HOUR)).toBe('unknown');
  });

  it('same pid but un-orderable start-times (same-ness unconfirmable) → unknown', () => {
    const unorderable: HogEvidenceCandidate = { pid: 900, startTimeMs: null, commandHash: 'hashA' };
    expect(evaluateHogLeaveRecurrence(leaveRecord(), unorderable, T0 + HOUR)).toBe('unknown');
    expect(
      evaluateHogLeaveRecurrence(leaveRecord({ targetTuple: { pid: 900, startTimeMs: null } }), SAME_PROCESS, T0 + HOUR),
    ).toBe('unknown');
  });

  it('preconditions: verdict must be leave, enacted must be alert-only-model-spared, floor must have permitted', () => {
    expect(evaluateHogLeaveRecurrence(leaveRecord({ verdict: 'alert' }), SAME_PROCESS, T0 + HOUR)).toBeNull();
    expect(evaluateHogLeaveRecurrence(leaveRecord({ enacted: 'alert-only-floor-veto' }), SAME_PROCESS, T0 + HOUR)).toBeNull();
    expect(evaluateHogLeaveRecurrence(leaveRecord({ enacted: 'alert-only-governor-hold' }), SAME_PROCESS, T0 + HOUR)).toBeNull();
    expect(evaluateHogLeaveRecurrence(leaveRecord({ floorPermitted: false }), SAME_PROCESS, T0 + HOUR)).toBeNull();
    expect(evaluateHogLeaveRecurrence(killRecord(), SAME_PROCESS, T0 + HOUR)).toBeNull(); // a kill is never leave-graded
  });

  it('a different commandHash is not an evidence event for this record → null', () => {
    const other: HogEvidenceCandidate = { pid: 900, startTimeMs: T0 - HOUR, commandHash: 'hashZ' };
    expect(evaluateHogLeaveRecurrence(leaveRecord(), other, T0 + HOUR)).toBeNull();
  });

  it('outside the window → null', () => {
    expect(evaluateHogLeaveRecurrence(leaveRecord(), SAME_PROCESS, T0 + WINDOW + 1)).toBeNull();
  });
});
