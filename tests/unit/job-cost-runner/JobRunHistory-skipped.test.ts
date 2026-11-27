/**
 * job-cost-reduction §5.2 / F13 — `skipped` runs and triage rows are outside
 * a slug's stats (numerator AND denominator); localRunsForSlug is this
 * machine's rows only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobRunHistory, isSideRun, SCRIPT_CANARY_TRIGGER } from '../../../src/scheduler/JobRunHistory.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'JobRunHistory-skipped.test cleanup' });
  dir = undefined;
});

function mk(): JobRunHistory {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrh-skip-'));
  const h = new JobRunHistory(dir);
  h.setMachineId('m_self');
  return h;
}

describe('JobRunHistory skipped + triage semantics', () => {
  it('stats exclude skipped runs and triage rows', () => {
    const h = mk();
    const ok = h.recordStart({ slug: 'j', sessionId: 's1', trigger: 't', runner: 'script', tokens: 0 });
    h.recordCompletion({ runId: ok, result: 'success' });
    const sk = h.recordStart({ slug: 'j', sessionId: 's2', trigger: 't', runner: 'script' });
    h.recordCompletion({ runId: sk, result: 'skipped', error: 'feature-dark' });
    const fail = h.recordStart({ slug: 'j', sessionId: 's3', trigger: 't' });
    h.recordCompletion({ runId: fail, result: 'failure' });
    const tri = h.recordStart({ slug: 'j', sessionId: 's4', trigger: 'triage', origin: 'triage' });
    h.recordCompletion({ runId: tri, result: 'failure' });

    const st = h.stats('j');
    expect(st.totalRuns).toBe(2);
    expect(st.successes).toBe(1);
    expect(st.failures).toBe(1);
    expect(st.successRate).toBe(50);
    expect(h.query({ slug: 'j', result: 'skipped' }).total).toBe(1);
  });

  it('canary rows (trigger script-canary) are side runs: out of stats, filterable', () => {
    const h = mk();
    const ok = h.recordStart({ slug: 'j', sessionId: 's1', trigger: 'scheduled', runner: 'script' });
    h.recordCompletion({ runId: ok, result: 'success' });
    for (let i = 0; i < 3; i++) {
      const c = h.recordStart({ slug: 'j', sessionId: `c${i}`, trigger: SCRIPT_CANARY_TRIGGER, runner: 'script' });
      h.recordCompletion({ runId: c, result: 'failure', error: 'must-fail canary' });
    }
    expect(h.stats('j')).toMatchObject({ totalRuns: 1, failures: 0, successRate: 100 });
    expect(h.query({ slug: 'j', excludeSideRuns: true }).total).toBe(1);
    expect(h.query({ slug: 'j' }).total).toBe(4); // still visible in plain history
    expect(isSideRun({ origin: 'triage', trigger: 'triage:x' })).toBe(true);
    expect(isSideRun({ origin: 'instar', trigger: 'scheduled' })).toBe(false);
  });

  it('records runner, lockTrust and tokens on the row', () => {
    const h = mk();
    const id = h.recordStart({ slug: 'j', sessionId: 's', trigger: 't', runner: 'script', lockTrust: 'trusted', tokens: 0 });
    const run = h.query({ slug: 'j' }).runs.find((r) => r.runId === id)!;
    expect(run).toMatchObject({ runner: 'script', lockTrust: 'trusted', tokens: 0 });
  });

  it('localRunsForSlug returns only this machine, newest first', () => {
    const h = mk();
    h.recordStart({ slug: 'j', sessionId: 'a', trigger: 't' });
    const other = new JobRunHistory(dir!);
    other.setMachineId('m_peer');
    other.recordStart({ slug: 'j', sessionId: 'b', trigger: 't' });
    const h2 = new JobRunHistory(dir!);
    h2.setMachineId('m_self');
    const rows = h2.localRunsForSlug('j', 10);
    expect(rows.map((r) => r.sessionId)).toEqual(['a']);
  });
});
