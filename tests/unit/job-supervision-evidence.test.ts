import { describe, expect, it } from 'vitest';
import { projectSupervisionEvidence, SUPERVISION_EVIDENCE_MAX_CHARS } from '../../src/scheduler/JobSupervisionEvidence.js';
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

  it('fits many anomalies under the cap with an explicit omitted count, never as routine-complete (CMT-1610)', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ kind: `degradation:Component${i}`, severity: 2 as const,
      evidence: 'bounded', class: 'recoverable' as const }));
    const signal = { source: 'independent-monitor', independentOfSlug: 'health-check',
      observedAt: new Date(now - 60_000).toISOString(), status: 'healthy' as const };
    const evidence = projectSupervisionEvidence({ job, parsed: { ...parsed, anomalies: many },
      scrubbedOutput: '', independentSignal: signal, now });
    expect(evidence.ok).toBe(true);
    if (evidence.ok) {
      expect(Array.from(evidence.text).length).toBeLessThanOrEqual(SUPERVISION_EVIDENCE_MAX_CHARS);
      const shown = evidence.text.split('\n').filter(l => l.startsWith('anomaly: ')).length;
      expect(shown).toBeGreaterThan(0);
      expect(evidence.text).toContain(`anomalies-omitted: ${100 - shown} of 100`);
      expect(evidence.text).toContain('field checked: yes');
      expect(evidence.text).toContain('independent-signal: independent-monitor');
      expect(evidence.sufficientForRoutine).toBe(false);
    }
  });

  it('shortens the free-text tail before dropping any anomaly (the live health-check shape)', () => {
    const full = { ...job, triageEvidence: 'full' as const,
      triageFields: ['disk_free_pct', 'sessions_current', 'sessions_max', 'degradations', 'llm_status'] };
    const twelve = Array.from({ length: 12 }, (_, i) => ({ kind: `degradation:SessionManager.component${i}`,
      severity: 2 as const, evidence: 'bounded', class: 'recoverable' as const }));
    const fields = { disk_free_pct: '6.8', sessions_current: '25', sessions_max: '25', degradations: '17', llm_status: 'ok' };
    const output = 'JOB_ANOMALY x '.repeat(300) + 'TAIL-END';
    const evidence = projectSupervisionEvidence({ job: full, parsed: { ...parsed, anomalies: twelve, fields },
      scrubbedOutput: output, now });
    expect(evidence.ok).toBe(true);
    if (evidence.ok) {
      expect(Array.from(evidence.text).length).toBeLessThanOrEqual(SUPERVISION_EVIDENCE_MAX_CHARS);
      expect(evidence.text).not.toContain('anomalies-omitted');
      expect(evidence.text.split('\n').filter(l => l.startsWith('anomaly: '))).toHaveLength(12);
      expect(evidence.text).toMatch(/output-tail: .*TAIL-END$/m);
    }
  });

  it('keeps the full 1000-character tail when there is room', () => {
    const full = { ...job, triageEvidence: 'full' as const };
    const evidence = projectSupervisionEvidence({ job: full, parsed, scrubbedOutput: 'a'.repeat(1500), now });
    expect(evidence.ok && evidence.text.includes(`output-tail: ${'a'.repeat(1000)}`)).toBe(true);
    expect(evidence.ok && evidence.text.includes('a'.repeat(1001))).toBe(false);
  });
});
