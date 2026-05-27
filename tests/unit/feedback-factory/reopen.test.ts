/**
 * Unit tests (Tier 1) — auto-reopen-on-regression decision.
 *
 * Reference is interleaved with DB writes, so equivalence is by faithful
 * transcription + both-sides-of-boundary tests (deferred=aged vs others=regression).
 */

import { describe, it, expect } from 'vitest';
import { computeReopen } from '../../../src/feedback-factory/processor/reopen.js';
import type { Cluster } from '../../../src/feedback-factory/processor/types.js';

const NOW = '2026-05-27T00:00:00.000Z';
const cluster = (extra: Partial<Cluster>): Cluster => ({ clusterId: 'c', title: 't', description: 'd', ...extra });

describe('computeReopen', () => {
  it('deferred → AGED-REOPEN: status new, annotate actionTaken, no recurrence bump', () => {
    const d = computeReopen(cluster({ status: 'deferred' }), 'fb-1', NOW);
    expect(d.newStatus).toBe('new');
    expect(d.noteTag).toBe('AGED-REOPEN');
    expect(d.annotateField).toBe('actionTaken');
    expect(d.bumpRecurrence).toBe(false);
  });

  it('fixed → REGRESSION: status investigating, annotate researchNotes, bump recurrence', () => {
    const d = computeReopen(cluster({ status: 'fixed', fixedInVersion: '1.2.3' }), 'fb-2', NOW);
    expect(d.newStatus).toBe('investigating');
    expect(d.noteTag).toBe('REGRESSION');
    expect(d.annotateField).toBe('researchNotes');
    expect(d.bumpRecurrence).toBe(true);
  });

  it('resolved → REGRESSION (same as fixed)', () => {
    const d = computeReopen(cluster({ status: 'resolved' }), 'fb-3', NOW);
    expect(d.newStatus).toBe('investigating');
    expect(d.bumpRecurrence).toBe(true);
  });

  it('templates the audit note verbatim (tag, time, prior status, fixedInVersion, new status, report)', () => {
    const d = computeReopen(cluster({ status: 'fixed', fixedInVersion: '1.2.3' }), 'fb-9', NOW);
    expect(d.note).toBe(
      `[REGRESSION ${NOW}] New report matched cluster previously marked 'fixed' (fixedInVersion=1.2.3). Auto-reopened to 'investigating' for review. Report: fb-9`,
    );
  });

  it('falls back to fixedInVersion=n/a when absent', () => {
    const d = computeReopen(cluster({ status: 'deferred' }), 'fb-4', NOW);
    expect(d.note).toContain('fixedInVersion=n/a');
    expect(d.note).toContain("previously marked 'deferred'");
    expect(d.note).toContain("Auto-reopened to 'new'");
  });
});
