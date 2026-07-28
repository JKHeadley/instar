/**
 * Wiring-integrity test for GrowthMilestoneAnalyst (required by the Testing
 * Integrity Standard for every dependency-injected component): prove the analyst
 * delegates to a REAL InitiativeTracker — not a null, not a no-op fake. A
 * real-created feature with a rollout stage must flow through the analyst's
 * observe + classify path and produce a real finding; a real stale initiative
 * must flow through the analyst's reuse of tracker.digest().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GrowthMilestoneAnalyst, resolveGrowthSettings } from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import { InitiativeTracker, STALE_THRESHOLD_MS } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gma-wiring-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/growth-analyst-wiring.test.ts' }); } catch { /* ok */ } });

describe('GrowthMilestoneAnalyst — wiring integrity (real InitiativeTracker)', () => {
  it('delegates to a real tracker: a real rollout feature past its window surfaces an R1/R2 finding', async () => {
    const tracker = new InitiativeTracker(tmp);
    await tracker.create({
      id: 'real-feature',
      title: 'A real staged feature',
      description: 'created through the real tracker',
      phases: [{ id: 'lifecycle', name: 'live' }],
      kind: 'task',
      rollout: { flagPath: 'monitoring.realFeature', stage: 'live' },
    });

    // sanity: the tracker really holds it with the rollout
    expect(tracker.list().find((i) => i.id === 'real-feature')?.rollout?.stage).toBe('live');

    const t0 = new Date('2026-06-01T00:00:00Z');
    new GrowthMilestoneAnalyst({
      stateDir: tmp, settings: resolveGrowthSettings({ enabled: true }), tracker, evidenceCounter: () => 0, now: () => t0,
    }).observeStages(t0);

    const later = new Date('2026-06-12T00:00:00Z'); // +11d, past the 7d standard window
    const findings = new GrowthMilestoneAnalyst({
      stateDir: tmp, settings: resolveGrowthSettings({ enabled: true }), tracker, evidenceCounter: () => 0, now: () => later,
    }).computeFindings(later);

    const f = findings.find((x) => x.subjectId === 'real-feature');
    expect(f).toBeDefined();
    expect(f!.rule).toBe('R2'); // unproved (evidenceCounter → 0)
  });

  it('delegates to the real tracker.digest(): a genuinely stale initiative surfaces as R3', async () => {
    const tracker = new InitiativeTracker(tmp);
    await tracker.create({
      id: 'stale-init',
      title: 'A forgotten initiative',
      description: 'no rollout — just an active initiative that goes stale',
      phases: [{ id: 'p1', name: 'Phase 1', status: 'in-progress' }],
      kind: 'task',
    });

    // The analyst computes staleness relative to `now`; choose a now far enough
    // past lastTouchedAt that the tracker's own digest flags it stale.
    const now = new Date(Date.now() + STALE_THRESHOLD_MS + 86_400_000);
    const findings = new GrowthMilestoneAnalyst({
      stateDir: tmp, settings: resolveGrowthSettings({ enabled: true }), tracker, now: () => now,
    }).computeFindings(now);

    const r3 = findings.find((x) => x.rule === 'R3' && x.subjectId === 'stale-init');
    expect(r3).toBeDefined();
  });
});
