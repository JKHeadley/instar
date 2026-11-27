import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  calculateVerdicts, renderThroughputReport, writeThroughputReport,
} from '../../../src/scaffold/templates/jobs/instar/scripts/testing-throughput-report-script.mjs';

const saved = JSON.parse(readFileSync(new URL('../../fixtures/testing-throughput-saved-report.json', import.meta.url), 'utf8'));

describe('script-based testing throughput report', () => {
  it('ships disabled as a script job', () => {
    const template = new URL('../../../src/scaffold/templates/jobs/instar/testing-throughput-report-script.md', import.meta.url);
    const body = readFileSync(template, 'utf8').split('---')[1];
    expect(body).toMatch(/^enabled: false$/m);
    expect(body).toMatch(/^runner: script$/m);
  });

  it('renders the two verdict windows from the saved report', () => {
    const metrics = calculateVerdicts(saved.records, saved.baseline, saved.asOf);
    const project = ({ attempts, complete, successful }: typeof metrics.sinceBaseline) => ({
      endedAttempts: attempts, completeFullGateVerdicts: complete, successfulFullGates: successful,
    });
    expect(project(metrics.sinceBaseline)).toEqual(saved.expected.sinceBaseline);
    expect(project(metrics.lastTwoHours)).toEqual(saved.expected.last2Hours);
    expect(renderThroughputReport(saved.asOf, metrics)).toContain(
      'Last two hours: 8 full-gate verdicts (4.00/hour), 8 successful (4.00/hour), 10 attempts ended.',
    );
    expect(renderThroughputReport(saved.asOf, metrics)).toContain(
      'Since the baseline: 40 full-gate verdicts (1.82/hour), 40 successful (1.82/hour), 62 attempts ended.',
    );
  });

  it('saves a plain-text report without replacing an existing run report', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'testing-throughput-script-'));
    const reportDir = path.join(stateDir, 'reports', 'throughput-improvement');
    const journalDir = path.join(stateDir, 'state', 'local-verify');
    const runId = 'testing-throughput-report-script-fixture-1';
    try {
      await mkdir(reportDir, { recursive: true });
      await mkdir(journalDir, { recursive: true });
      await writeFile(path.join(reportDir, 'acceleration-baseline-20261124.json'), JSON.stringify({ asOf: saved.baseline }));
      const journal = saved.records.map((record: unknown) => JSON.stringify({ record })).join('\n') + '\n';
      const journalPath = path.join(journalDir, 'journal.jsonl');
      await writeFile(journalPath, journal);
      await writeThroughputReport(stateDir, runId, saved.asOf);
      const reportPath = path.join(reportDir, `${runId}.txt`);
      const expected = renderThroughputReport(saved.asOf, calculateVerdicts(saved.records, saved.baseline, saved.asOf));
      expect(await readFile(reportPath, 'utf8')).toBe(expected);
      await expect(writeThroughputReport(stateDir, runId, saved.asOf)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(journalPath, 'utf8')).toBe(journal);
    } finally {
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'testing throughput fixture cleanup' });
    }
  });

  it('rejects a journal without valid completion timestamps', () => {
    expect(() => calculateVerdicts([{ finishedAt: 'unknown' }], saved.baseline, saved.asOf))
      .toThrow('invalid report timestamp');
  });
});
