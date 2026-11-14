/**
 * The getDefaultJobs() entries for script-runner jobs carry the template keys
 * of docs/specs/job-cost-reduction.md §5.1/§5.6, point at a shipped script, and
 * keep a complete, runnable prompt body (the rollback path, §8.4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { getDefaultJobs } from '../../../src/commands/init.js';
import { SCRIPTS_DIR } from './harness.js';

type Entry = Record<string, any>;
const jobs = getDefaultJobs(4321) as Entry[];
const scriptJobs = jobs.filter((j) => j.runner === 'script');

describe('getDefaultJobs script-runner entries', () => {
  it('health-check and script-job-supervisor are script jobs', () => {
    expect(scriptJobs.map((j) => j.slug).sort()).toEqual(expect.arrayContaining(['health-check', 'script-job-supervisor']));
  });

  it('ships the canonical health-check and supervisor as script templates', () => {
    for (const slug of ['health-check', 'script-job-supervisor']) {
      const source = jobs.find(j => j.slug === slug)!;
      const raw = fs.readFileSync(path.join(SCRIPTS_DIR, '..', `${slug}.md`), 'utf8');
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      expect(match, slug).not.toBeNull();
      const fm = yaml.load(match![1]) as Record<string, unknown>;
      expect(fm.runner, slug).toBe('script');
      expect(fm.script, slug).toBe(`${slug}.mjs`);
      expect(fm.scriptSupervision, slug).toBe(source.scriptSupervision);
      expect(fm.mcpAccess, slug).toBe('none');
      expect(match![2].replaceAll(':-4042}', ':-4321}').trimEnd(), slug).toBe(source.execute.value.trimEnd());
    }
  });

  for (const j of scriptJobs) {
    it(`${j.slug}: names a shipped script and keeps its prompt body`, () => {
      expect(j.script).toBe(`${j.slug}.mjs`);
      expect(j.script).toMatch(/^[a-z0-9-]+\.mjs$/);
      expect(fs.existsSync(path.join(SCRIPTS_DIR, j.script))).toBe(true);
      expect(j.execute.type).toBe('prompt');
      expect(j.execute.value.length).toBeGreaterThan(100);
      expect(j.supervision).toBe('tier0');
      expect(['triage', 'deterministic']).toContain(j.scriptSupervision);
      expect(j.scriptTimeoutMinutes).toBeGreaterThan(0);
      if (j.scriptSupervision === 'triage') {
        expect(['full', 'structured-only']).toContain(j.triageEvidence);
        expect(Array.isArray(j.triageFields)).toBe(true);
      }
    });
  }

  it('health-check declares its five anomaly kinds with their classes, and keeps its body unchanged', () => {
    const hc = jobs.find((j) => j.slug === 'health-check')!;
    expect(hc.anomalies).toEqual([
      { kind: 'disk-low', class: 'recoverable' },
      { kind: 'disk-critical', class: 'critical' },
      { kind: 'sessions-exhausted', class: 'recoverable' },
      { kind: 'llm-unreliable', class: 'recoverable' },
      { kind: 'degradation:*', class: 'recoverable' },
    ]);
    expect(hc.expectedDurationMinutes).toBe(1);
    expect(hc.triageBareOk).toEqual(['healthy']);
    expect(hc.execute.value).toContain('curl http://localhost:${INSTAR_PORT:-4321}/health');
  });

  it('script-job-supervisor is a daily deterministic job whose rollback body posts the pass', () => {
    const s = jobs.find((j) => j.slug === 'script-job-supervisor')!;
    expect(s.schedule).toBe('23 7 * * *');
    expect(s.scriptSupervision).toBe('deterministic');
    expect(s.execute.value).toContain('AUTH="${INSTAR_AUTH_TOKEN:-');
    expect(s.execute.value).toContain('http://localhost:${INSTAR_PORT:-4321}/jobs/script-supervision/pass');
  });
});
