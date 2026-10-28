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
});
