/**
 * Unit tests (Tier 1) — feedback-factory lifecycle state machine (scar a + c/d).
 *
 * Both-sides-of-boundary coverage in CI. Byte-exact equivalence to the reference
 * Python (including reason strings) is proven by the local parity harness
 * (scripts/feedback-factory/transitions-parity.mjs).
 */

import { describe, it, expect } from 'vitest';
import {
  canTransition,
  detectCycling,
  V2_STATES,
  V2_TRANSITIONS,
  V1_TO_V2_STATUS,
  TERMINAL_STATUSES,
  normalizeStatus,
  isTerminalStatus,
} from '../../../src/feedback-factory/processor/transitions.js';

describe('canTransition — state legality', () => {
  it('allows a legal transition', () => {
    expect(canTransition('new', 'investigating')).toEqual([true, 'OK']);
    expect(canTransition('research_complete', 'investigating')).toEqual([true, 'OK']); // loop-back
  });

  it('rejects an illegal transition with the allowed-set in the reason', () => {
    const [ok, reason] = canTransition('new', 'verified');
    expect(ok).toBe(false);
    expect(reason).toContain('Cannot transition new -> verified');
  });

  it('rejects an unknown target state', () => {
    const [ok, reason] = canTransition('new', 'not_a_real_state');
    expect(ok).toBe(false);
    expect(reason).toContain('Invalid state: not_a_real_state');
  });

  it('rejects an unknown current state', () => {
    expect(canTransition('bogus_state', 'investigating')).toEqual([false, 'Unknown current state: bogus_state']);
  });

  it('reports terminal states as having no allowed transitions', () => {
    const [ok, reason] = canTransition('closed', 'investigating');
    expect(ok).toBe(false);
    expect(reason).toContain('none (terminal)');
  });
});

describe('canTransition — evidence gate (both sides of 20 chars)', () => {
  it('rejects a terminal transition with no / too-short justification', () => {
    expect(canTransition('investigating', 'wontfix')[0]).toBe(false);
    expect(canTransition('investigating', 'wontfix', 'too short')[0]).toBe(false);
  });

  it('allows a terminal transition with ≥20-char justification', () => {
    expect(canTransition('investigating', 'wontfix', 'this is a sufficiently long justification')).toEqual([true, 'OK']);
  });
});

describe('canTransition — hard gate + chronic circuit-breaker', () => {
  it('requires dispatch_id to reach dispatched', () => {
    expect(canTransition('fix_applied', 'dispatched')[0]).toBe(false);
    expect(canTransition('fix_applied', 'dispatched', null, { dispatch_id: 'dsp-1' })).toEqual([true, 'OK']);
  });

  it('blocks chronic at recurrenceCount ≥ 3 (circuit breaker), allows below', () => {
    expect(canTransition('verified', 'chronic')).toEqual([true, 'OK']);
    expect(canTransition('verified', 'chronic', null, { recurrenceCount: 2 })).toEqual([true, 'OK']);
    const [ok, reason] = canTransition('verified', 'chronic', null, { recurrenceCount: 3 });
    expect(ok).toBe(false);
    expect(reason).toContain('chronicCount (3) >= 3');
  });
});

describe('detectCycling', () => {
  it('is true for fix_applied/new/investigating with recurrenceCount ≥ 2', () => {
    expect(detectCycling({ status: 'fix_applied', recurrenceCount: 2 })).toBe(true);
    expect(detectCycling({ status: 'new', recurrenceCount: 3 })).toBe(true);
    expect(detectCycling({ status: 'investigating', recurrenceCount: 2 })).toBe(true);
  });

  it('is false below the recurrence threshold or in other states', () => {
    expect(detectCycling({ status: 'fix_applied', recurrenceCount: 1 })).toBe(false);
    expect(detectCycling({ status: 'verified', recurrenceCount: 5 })).toBe(false);
    expect(detectCycling({ status: 'dispatched', recurrenceCount: 9 })).toBe(false);
    expect(detectCycling({ status: 'fix_applied' })).toBe(false); // missing recurrenceCount → 0
  });
});

describe('constants sanity', () => {
  it('every transition target is itself a known state', () => {
    for (const [from, targets] of Object.entries(V2_TRANSITIONS)) {
      expect(V2_STATES.has(from)).toBe(true);
      for (const t of targets) expect(V2_STATES.has(t)).toBe(true);
    }
  });
});

describe('normalizeStatus — legacy(v1)→canonical(v2) projection', () => {
  it('projects the three statuses that actually change', () => {
    expect(normalizeStatus('open')).toBe('new'); // birth-default literal → new
    expect(normalizeStatus('fixed')).toBe('fix_applied');
    expect(normalizeStatus('resolved')).toBe('closed');
  });

  it('leaves identity-mapped v1 literals unchanged', () => {
    expect(normalizeStatus('investigating')).toBe('investigating');
    expect(normalizeStatus('wontfix')).toBe('wontfix');
    expect(normalizeStatus('duplicate')).toBe('duplicate');
  });

  it('passes an already-v2 status through unchanged (idempotent — safe to double-apply)', () => {
    for (const s of ['new', 'fix_applied', 'closed', 'verified', 'dispatched', 'research_complete']) {
      expect(normalizeStatus(s)).toBe(s);
      expect(normalizeStatus(normalizeStatus(s))).toBe(s); // idempotence
    }
  });

  it('passes an unrecognised status through unchanged (no silent drop)', () => {
    expect(normalizeStatus('totally_bogus')).toBe('totally_bogus');
    expect(normalizeStatus('')).toBe('');
  });

  it('exposes the exact pinned v1→v2 map (no drift)', () => {
    expect(V1_TO_V2_STATUS).toEqual({
      open: 'new',
      investigating: 'investigating',
      fixed: 'fix_applied',
      resolved: 'closed',
      wontfix: 'wontfix',
      duplicate: 'duplicate',
    });
  });
});

describe('isTerminalStatus — terminal check on NORMALIZED status (both sides of the boundary)', () => {
  it('is true for every canonical terminal state', () => {
    for (const s of ['closed', 'verified', 'wontfix', 'duplicate', 'chronic_escalated', 'legacy_closed']) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it('normalizes BEFORE checking — a raw v1 `resolved` reads terminal (the load-bearing case)', () => {
    expect(isTerminalStatus('resolved')).toBe(true); // → closed → terminal
  });

  it('is false for non-terminal statuses, including v1 literals that project to non-terminal', () => {
    expect(isTerminalStatus('open')).toBe(false); // → new
    expect(isTerminalStatus('new')).toBe(false);
    expect(isTerminalStatus('investigating')).toBe(false);
    expect(isTerminalStatus('fixed')).toBe(false); // → fix_applied (NOT terminal)
    expect(isTerminalStatus('fix_applied')).toBe(false);
    expect(isTerminalStatus('research_complete')).toBe(false);
    expect(isTerminalStatus('dispatched')).toBe(false);
    expect(isTerminalStatus('verified_tentative')).toBe(false);
    expect(isTerminalStatus('chronic')).toBe(false);
    expect(isTerminalStatus('deferred')).toBe(false);
  });

  it('exposes the exact pinned terminal set (no drift)', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ['chronic_escalated', 'closed', 'duplicate', 'legacy_closed', 'verified', 'wontfix'],
    );
  });

  it('legacy_closed is terminal but is NOT a v2 lifecycle state (terminal-only literal)', () => {
    expect(isTerminalStatus('legacy_closed')).toBe(true);
    expect(V2_STATES.has('legacy_closed')).toBe(false);
    expect(normalizeStatus('legacy_closed')).toBe('legacy_closed'); // passes through unchanged
  });
});
