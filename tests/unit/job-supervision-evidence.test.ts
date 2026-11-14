import { describe, expect, it } from 'vitest';
import { projectSupervisionEvidence } from '../../src/scheduler/JobSupervisionEvidence.js';
import type { JobDefinition } from '../../src/core/types.js';
import type { ParsedScriptRun } from '../../src/scheduler/jobScriptProtocol.js';

const job = { slug: 'health-check', triageEvidence: 'structured-only', triageFields: ['checked'] } as JobDefinition;
const parsed: ParsedScriptRun = { result: 'success', reason: 'ok', reasonCode: 'ok', summary: 'ok', anomalies: [],
  ignoredAnomalies: 0, fields: { checked: 'yes' }, droppedFields: 0, missingResultLine: false, overCap: false };
const now = Date.parse('2026-10-28T00:00:00Z');

describe('job-result evidence floor', () => {
  it('withholds free text and refuses routine closure for bare OK', () => {
    const evidence = projectSupervisionEvidence({ job, parsed, scrubbedOutput: 'private upstream note', now });
    expect(evidence.ok).toBe(true);
    if (evidence.ok) {
      expect(evidence.text).not.toContain('private upstream note');
      expect(evidence.sufficientForRoutine).toBe(false);
    }
  });

  it('accepts only a fresh signal from another subsystem as routine corroboration', () => {
    const signal = { source: 'independent-monitor', independentOfSlug: 'health-check',
      observedAt: new Date(now - 60_000).toISOString(), status: 'healthy' as const };
    const good = projectSupervisionEvidence({ job, parsed, scrubbedOutput: '', independentSignal: signal, now });
    expect(good.ok && good.sufficientForRoutine).toBe(true);
    const stale = projectSupervisionEvidence({ job, parsed, scrubbedOutput: '',
      independentSignal: { ...signal, observedAt: new Date(now - 11 * 60_000).toISOString() }, now });
    expect(stale.ok && stale.sufficientForRoutine).toBe(false);
    const self = projectSupervisionEvidence({ job, parsed, scrubbedOutput: '', independentSignal: { ...signal, source: job.slug }, now });
    expect(self.ok && self.sufficientForRoutine).toBe(false);
  });

  it('routes an unknown field shape to judgment but refuses a broken parser', () => {
    const unknown = projectSupervisionEvidence({ job, parsed: { ...parsed, droppedFields: 1 }, scrubbedOutput: '', now });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(unknown.text).toContain('rejected-fields: 1');
      expect(unknown.sufficientForRoutine).toBe(false);
    }
    expect(projectSupervisionEvidence({ job, parsed: { ...parsed, overCap: true }, scrubbedOutput: '', now }))
      .toEqual({ ok: false, reason: 'output-truncated' });
    expect(projectSupervisionEvidence({ job, parsed: { ...parsed, missingResultLine: true }, scrubbedOutput: '', now }))
      .toEqual({ ok: false, reason: 'parser-integrity' });
  });

  it('withholds an incomplete private-key marker even on an explicit full-text policy', () => {
    const full = { ...job, triageEvidence: 'full' as const };
    expect(projectSupervisionEvidence({ job: full, parsed, scrubbedOutput: '-----BEGIN PRIVATE KEY-----\npartial', now }))
      .toEqual({ ok: false, reason: 'evidence-withheld' });
  });

  it('refuses an over-cap projection instead of treating its truncated tail as complete', () => {
    const many = Array.from({ length: 100 }, () => ({ kind: 'disk-low', severity: 3 as const,
      evidence: 'bounded', class: 'critical' as const }));
    expect(projectSupervisionEvidence({ job, parsed: { ...parsed, anomalies: many },
      scrubbedOutput: '', now })).toEqual({ ok: false, reason: 'evidence-over-cap' });
  });
});
