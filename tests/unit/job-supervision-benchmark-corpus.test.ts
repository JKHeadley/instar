import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { triageQuestions } from '../../src/scheduler/JobResultTriage.js';

describe('job-result supervision benchmark corpus', () => {
  it('pins distinct routine, urgent and uncertain cases to one prompt version', () => {
    const corpus = JSON.parse(fs.readFileSync(path.join(__dirname,
      '../fixtures/job-result-supervision-benchmark-v1.json'), 'utf8')) as {
      taskId: string; promptVersion: string; promptHash: string;
      cases: Array<{ id: string; expected: string; sufficient: boolean; evidence: string }>;
    };
    expect(corpus.taskId).toBe('job-result-supervision-v2');
    expect(corpus.promptVersion).toBe('jev-triage-questions-v2');
    expect(corpus.promptHash).toBe(crypto.createHash('sha256')
      .update(JSON.stringify(triageQuestions())).digest('hex'));
    expect(corpus.cases.length).toBeGreaterThanOrEqual(15);
    expect(new Set(corpus.cases.map(c => c.id)).size).toBe(corpus.cases.length);
    expect(new Set(corpus.cases.map(c => c.expected))).toEqual(new Set(['routine', 'needs-session', 'cannot-tell']));
    for (const item of corpus.cases) {
      expect(item.evidence.length).toBeLessThanOrEqual(2000);
      expect(item.evidence).toMatch(/^job: /);
      expect(item.evidence).not.toMatch(/PRIVATE KEY|Bearer |https?:\/\//);
      if (item.expected === 'routine') expect(item.sufficient).toBe(true);
    }
  });

  it('keeps every published benchmark call paired with a terminal audit record and excludes provider text', () => {
    const dir = path.join(__dirname, '../../docs/research/job-result-supervision-v2-bench/results');
    const rows = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'))
      .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse)) as
      Array<Record<string, unknown>>;
    const starts = rows.filter(row => row.event === 'pre-call');
    const ends = rows.filter(row => ['settled', 'failed', 'unknown'].includes(String(row.event)));
    expect(starts.length).toBeGreaterThan(100);
    expect(new Set(starts.map(row => row.callId)).size).toBe(starts.length);
    expect(new Set(ends.map(row => row.callId)).size).toBe(ends.length);
    expect(new Set(ends.map(row => row.callId))).toEqual(new Set(starts.map(row => row.callId)));
    for (const row of rows) {
      expect(row).not.toHaveProperty('key');
      expect(row).not.toHaveProperty('response');
      expect(row).not.toHaveProperty('providerText');
      if (row.event === 'pre-call') {
        expect(row).toMatchObject({ taskId: 'job-result-supervision-v2',
          promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      }
    }
  });
});
