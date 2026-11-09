import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { failureInvestigationAdmissionSummary } from '../../src/monitoring/FailureInvestigationAdmission.js';

const context = { turns: [{ text: 'Create the group yourself', fromUser: false, at: 1 }, { text: 'That is your task', fromUser: true, at: 2 }], instructions: ['Agent owns setup'], decisions: ['Task was handed back'], sourceRefs: ['telegram:1:2'], missing: [] };
const input = { kind: 'infra-gap' as const, severity: 'failure-callout' as const, learning: 'Keep setup agent-owned', scrubbedSummary: 'Setup was handed back', deterministicWeight: 3, failureContext: context };
afterEach(() => vi.restoreAllMocks());

describe('durable failure investigation admission', () => {
  it('validates only the current unverified occurrence claim without mutating it', () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'claim-validation' });
    const now = Date.now();
    try {
      const record = ledger.record(input)!;
      const first = ledger.claimFailureInvestigation(record.id, now);
      expect(first.admitted).toBe(true);
      if (!first.admitted) return;
      const version = ledger.get(record.id)!.version;
      expect(ledger.validateFailureInvestigationClaim(record.id, first.token)).toBe(true);
      for (const token of [null, 4, {}, '', 'x'.repeat(129)]) expect(ledger.validateFailureInvestigationClaim(record.id, token)).toBe(false);
      expect(ledger.get(record.id)!.version).toBe(version);
      const next = ledger.claimFailureInvestigation(record.id, now + 30 * 60_000);
      expect(next.admitted).toBe(true);
      if (!next.admitted) return;
      expect(ledger.validateFailureInvestigationClaim(record.id, first.token)).toBe(false);
      expect(ledger.validateFailureInvestigationClaim(record.id, next.token)).toBe(true);
      ledger.record(input);
      expect(ledger.validateFailureInvestigationClaim(record.id, next.token)).toBe(false);
      const repeated = ledger.claimFailureInvestigation(record.id, now);
      expect(repeated.admitted).toBe(true);
      if (!repeated.admitted) return;
      ledger.resumeFailureInvestigation(record.id, context.sourceRefs[0]);
      expect(ledger.validateFailureInvestigationClaim(record.id, repeated.token)).toBe(false);
      const resumed = ledger.claimFailureInvestigation(record.id, now);
      expect(resumed.admitted).toBe(true);
      if (!resumed.admitted) return;
      const current = ledger.get(record.id)!;
      const saved = ledger.updateFailureCase(record.id, {
        context,
        investigation: { classification: 'enforcement-gap', standardRefs: ['Agent does setup'], rootCause: 'Approved task handed back', classFix: 'Repair the handoff workflow', fixRefs: ['repair:implemented'] },
        verification: { scenario: 'approved setup', baselineRef: 'failure:original', replayRef: 'replay:passed', allowedCaseRef: 'allowed:passed', replayPassed: true, allowedCasePassed: true },
      }, current.version);
      expect(saved.ok).toBe(true);
      expect(ledger.validateFailureInvestigationClaim(record.id, resumed.token)).toBe(false);
    } finally { ledger.close(); }
  });

  it('backs off before each retry, caps at three, and exposes no token in broad state', () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'admission' });
    const now = Date.now();
    try {
      const record = ledger.record(input)!;
      expect(ledger.getFailureInvestigationAdmission(record.id)).toMatchObject({ attempts: 0, paused: false });
      const first = ledger.claimFailureInvestigation(record.id, now);
      expect(first).toMatchObject({ admitted: true, admission: { attempts: 1, nextAttemptAt: new Date(now + 30 * 60_000).toISOString() } });
      expect(ledger.claimFailureInvestigation(record.id, now + 29 * 60_000)).toMatchObject({ admitted: false, reason: 'not-due' });
      const second = ledger.claimFailureInvestigation(record.id, now + 30 * 60_000);
      expect(second).toMatchObject({ admitted: true, admission: { attempts: 2, nextAttemptAt: new Date(now + 90 * 60_000).toISOString() } });
      const third = ledger.claimFailureInvestigation(record.id, now + 90 * 60_000);
      expect(third).toMatchObject({ admitted: true, admission: { attempts: 3, paused: true, nextAttemptAt: null } });
      expect(ledger.claimFailureInvestigation(record.id, now + 365 * 86400_000)).toMatchObject({ admitted: false, reason: 'paused' });
      expect(ledger.get(record.id)?.version).toBe(record.version + 3);
      if (first.admitted) expect(JSON.stringify(CorrectionLedger.toApiView(ledger.get(record.id)!, false))).not.toContain(first.token);
      expect(ledger.list({ investigableFailures: true })).toEqual([]);
      expect(ledger.list({ unresolvedFailures: true })).toHaveLength(1);
    } finally { ledger.close(); }
  });

  it('keeps the same total bound across repeated reconstruction and context updates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-admission-'));
    const opts = { dbPath: path.join(dir, 'ledger.db'), machineId: 'admission' };
    let ledger = new CorrectionLedger(opts);
    const record = ledger.record(input)!;
    const start = Date.now();
    let admitted = 0;
    try {
      for (let tick = 0; tick < 40; tick++) {
        ledger.close(); ledger = new CorrectionLedger(opts);
        const current = ledger.get(record.id)!;
        expect(ledger.updateFailureCase(record.id, { context }, current.version).ok).toBe(true);
        if (ledger.claimFailureInvestigation(record.id, start + tick * 60 * 60_000).admitted) admitted++;
        if (tick === 19) expect(admitted).toBe(3);
      }
      expect(admitted).toBe(3);
      expect(ledger.getFailureInvestigationAdmission(record.id)?.paused).toBe(true);
      const repeated = ledger.record(input)!;
      expect(repeated.occurrenceCount).toBe(2);
      expect(ledger.claimFailureInvestigation(record.id, start)).toMatchObject({ admitted: true, admission: { occurrenceCount: 2, attempts: 1 } });
    } finally {
      ledger.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'failure-admission-test' });
    }
  });

  it('only resumes explicitly with new evidence and filters due work before limiting', () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'admission' });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const paused = ledger.record(input)!;
      for (const at of [now, now + 30 * 60_000, now + 90 * 60_000]) ledger.claimFailureInvestigation(paused.id, at);
      const ready = ledger.record({ ...input, learning: 'Check review approval before requesting approval again' })!;
      expect(ledger.list({ investigableFailures: true, limit: 1 })[0].id).toBe(ready.id);
      expect(() => ledger.resumeFailureInvestigation(paused.id, '')).toThrow('resume evidence');
      expect(ledger.getFailureInvestigationAdmission(paused.id)?.paused).toBe(true);
      expect(() => ledger.resumeFailureInvestigation(paused.id, 'test-report:implemented-class-fix')).toThrow('already be recorded');
      const current = ledger.get(paused.id)!;
      ledger.updateFailureCase(paused.id, { context: { ...context, sourceRefs: [...context.sourceRefs, 'test-report:implemented-class-fix', 'test-report:second-repair'] } }, current.version);
      expect(ledger.resumeFailureInvestigation(paused.id, 'test-report:implemented-class-fix')).toMatchObject({ attempts: 0, paused: false });
      expect(() => ledger.resumeFailureInvestigation(paused.id, 'test-report:implemented-class-fix')).toThrow('new evidence');
      expect(ledger.claimFailureInvestigation(paused.id, now).admitted).toBe(true);
      expect(ledger.resumeFailureInvestigation(paused.id, 'test-report:second-repair')).toMatchObject({ attempts: 0 });
      expect(() => ledger.resumeFailureInvestigation(paused.id, 'test-report:implemented-class-fix')).toThrow('new evidence');
      expect(() => ledger.resumeFailureInvestigation(paused.id, 'test-report:second-repair')).toThrow('new evidence');
      const detailed = ledger.get(paused.id)!;
      expect(detailed.investigationAdmission?.resumeEvidenceRef).toBe('test-report:second-repair');
      expect(CorrectionLedger.toApiView(detailed, false).investigationAdmission?.resumeEvidenceRef).toBeUndefined();
      expect(ledger.claimFailureInvestigation('absent', now)).toMatchObject({ admitted: false, reason: 'not-found' });
      const ordinary = ledger.record({ ...input, severity: 'correction', learning: 'Use shorter replies' })!;
      expect(ledger.claimFailureInvestigation(ordinary.id, now)).toMatchObject({ admitted: false, reason: 'not-failure' });
    } finally { ledger.close(); }
  });

  it('whitelists broad scheduling metadata from live peers', () => {
    const metadata = { occurrenceCount: 2, attempts: 1, maxAttempts: 3, nextAttemptAt: '2026-11-05T20:00:00.000Z', paused: false };
    expect(failureInvestigationAdmissionSummary({ ...metadata, token: 'secret-claim', resumeEvidenceRef: 'private-evidence', context: { text: 'forensic detail' } })).toEqual(metadata);
    for (const malformed of [null, [], { ...metadata, attempts: '1' }, { ...metadata, attempts: 100 }, { ...metadata, maxAttempts: 100 }, { ...metadata, occurrenceCount: -1 }, { ...metadata, nextAttemptAt: 'tomorrow' }, { ...metadata, paused: true }]) {
      expect(failureInvestigationAdmissionSummary(malformed)).toBeUndefined();
    }
  });
});
