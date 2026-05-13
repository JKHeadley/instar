/**
 * Phase 6 — deprecation audit for legacy execute.type:"prompt" entries
 * that shadow agentmd defaults.
 *
 * Spec: INSTAR-JOBS-AS-AGENTMD-SPEC.md §Rollout step 6.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadJobs } from '../../../src/scheduler/JobLoader.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('JobLoader Phase 6 deprecation audit', () => {
  let workspace: string;
  let stateDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-deprecate-'));
    stateDir = path.join(workspace, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'JobLoader.deprecation.test cleanup' });
  });

  function writeJobsJson(entries: any[]) {
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify(entries, null, 2));
  }

  function writeAgentmd(slug: string, body: string) {
    const instarDir = path.join(stateDir, 'jobs', 'instar');
    const scheduleDir = path.join(stateDir, 'jobs', 'schedule');
    fs.mkdirSync(instarDir, { recursive: true });
    fs.mkdirSync(scheduleDir, { recursive: true });
    const fm = [
      `name: "${slug}"`,
      'description: "test"',
      'toolAllowlist: ["Read"]',
    ].join('\n');
    fs.writeFileSync(path.join(instarDir, `${slug}.md`), `---\n${fm}\n---\n${body}`);
    fs.writeFileSync(path.join(scheduleDir, `${slug}.json`), JSON.stringify({
      slug,
      origin: 'instar',
      schedule: '*/5 * * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'agentmd' },
      manifestVersion: 1,
    }, null, 2));
  }

  it('emits deprecation warning when legacy prompt shadows agentmd default', () => {
    writeJobsJson([
      {
        slug: 'health-check',
        name: 'Health Check',
        description: 'd',
        schedule: '*/5 * * * *',
        priority: 'low',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'check' },
      },
    ]);
    writeAgentmd('health-check', 'check\n');

    loadJobs(path.join(stateDir, 'jobs.json'));

    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnings).toContain('DEPRECATION');
    expect(allWarnings).toContain('health-check');
  });

  it('does NOT emit deprecation when .migration-complete.json exists', () => {
    writeJobsJson([
      { slug: 'a', execute: { type: 'prompt', value: 'x' }, schedule: '*/5 * * * *', name: 'A', description: 'd', priority: 'low', expectedDurationMinutes: 1, model: 'haiku', enabled: true },
    ]);
    writeAgentmd('a', 'x\n');
    fs.writeFileSync(path.join(stateDir, 'jobs', '.migration-complete.json'), '{}');

    loadJobs(path.join(stateDir, 'jobs.json'));

    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnings).not.toContain('DEPRECATION');
  });

  it('does NOT emit deprecation for legacy entries whose slug is not in agentmd defaults', () => {
    writeJobsJson([
      { slug: 'user-job', execute: { type: 'prompt', value: 'x' }, schedule: '*/5 * * * *', name: 'A', description: 'd', priority: 'low', expectedDurationMinutes: 1, model: 'haiku', enabled: true },
    ]);
    // No agentmd file for 'user-job'.

    loadJobs(path.join(stateDir, 'jobs.json'));

    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnings).not.toContain('DEPRECATION');
  });

  it('does NOT emit deprecation when legacy entry is script (not prompt)', () => {
    writeJobsJson([
      { slug: 'a', execute: { type: 'script', value: 'echo' }, schedule: '*/5 * * * *', name: 'A', description: 'd', priority: 'low', expectedDurationMinutes: 1, model: 'haiku', enabled: true },
    ]);
    writeAgentmd('a', 'x\n');

    loadJobs(path.join(stateDir, 'jobs.json'));

    const allWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnings).not.toContain('DEPRECATION');
  });
});
