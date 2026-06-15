/**
 * Unit tests for the C1+C2 signal detectors (spec agent-owned-followthrough §4.3):
 *   - detectParkedOnUser (B-PARK) — flags deferring an action onto the user.
 *   - detectInternalIdLeak (B-IDLEAK) — flags raw internal plumbing tokens.
 * Both are SIGNAL-ONLY (the MessagingToneGate LLM is the authority); these tests
 * cover both sides of the detection boundary.
 */

import { describe, it, expect } from 'vitest';
import { detectParkedOnUser } from '../../src/core/parked-on-user.js';
import { detectInternalIdLeak } from '../../src/core/internal-id-leak.js';

describe('detectParkedOnUser (B-PARK signal)', () => {
  it('flags "your call"', () => {
    const r = detectParkedOnUser("I've merged it — restarting is your call whenever.");
    expect(r.parked).toBe(true);
    expect(r.phrase).toBe('your call');
  });

  it("flags \"whenever you're ready\" and \"remember to\"", () => {
    expect(detectParkedOnUser('Ping me whenever you’re ready.').parked).toBe(true);
    expect(detectParkedOnUser('Remember to flip the switch later.').parked).toBe(true);
    expect(detectParkedOnUser("You'll need to run the migration.").parked).toBe(true);
  });

  it('does NOT flag clean text with no deferral', () => {
    expect(detectParkedOnUser('Done — the build is merged and verified in main.').parked).toBe(false);
    expect(detectParkedOnUser('').parked).toBe(false);
  });
});

describe('detectInternalIdLeak (B-IDLEAK signal)', () => {
  it('flags a leaked commitment id (the "what is CMT?" leak)', () => {
    const r = detectInternalIdLeak('Tracked as CMT-1494 — it will resurface.');
    expect(r.leaked).toBe(true);
    expect(r.terms).toContain('commitment-id');
  });

  it('flags dryRun, a sentinel name, and an endpoint path', () => {
    expect(detectInternalIdLeak('still in dryRun mode').terms).toContain('dry-run-flag');
    expect(detectInternalIdLeak('the ContextWedgeSentinel caught it').terms).toContain('sentinel-name');
    expect(detectInternalIdLeak('see /commitments/CMT-1/probe').leaked).toBe(true);
  });

  it('does NOT flag plain English a user can act on', () => {
    const r = detectInternalIdLeak("I've been waiting on your reply and haven't heard back.");
    expect(r.leaked).toBe(false);
    expect(r.terms).toHaveLength(0);
  });
});
