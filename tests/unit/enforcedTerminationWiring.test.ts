/**
 * EnforcedTermination wiring — listRuns adapter + audit sink, against REAL files
 * (Tier 1, real fs). Proves the bridge from autonomous state frontmatter to the
 * pure-core snapshot is correct, including the move/unparseable edge cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildEnforcedTerminationListRuns,
  buildEnforcedTerminationAudit,
} from '../../src/monitoring/enforcedTerminationWiring.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let stateDir: string;

function writeRun(topic: string, frontmatter: Record<string, string>): void {
  const dir = path.join(stateDir, 'autonomous');
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, `${topic}.local.md`), `---\n${fm}\n---\n\nGoal body\n`);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-wiring-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/enforcedTerminationWiring.test.ts:cleanup' });
});

describe('buildEnforcedTerminationListRuns', () => {
  it('projects a per-topic run into a snapshot with parsed fields', () => {
    writeRun('28744', {
      report_topic: '28744',
      active: 'true',
      paused: 'false',
      iteration: '7',
      started_at: '2026-06-25T00:00:00.000Z',
      duration_seconds: '86400',
    });
    const runs = buildEnforcedTerminationListRuns(stateDir)();
    expect(runs).toHaveLength(1);
    const r = runs[0];
    expect(r.topicId).toBe('28744');
    expect(r.active).toBe(true);
    expect(r.paused).toBe(false);
    expect(r.iteration).toBe(7);
    expect(r.durationSeconds).toBe(86400);
    expect(r.startedAtMs).toBe(new Date('2026-06-25T00:00:00.000Z').getTime());
    expect(r.fileMtimeMs).toBeGreaterThan(0);
  });

  it('an UNBOUNDED run (no duration_seconds) → durationSeconds null', () => {
    writeRun('100', { report_topic: '100', active: 'true', started_at: '2026-06-25T00:00:00.000Z' });
    const r = buildEnforcedTerminationListRuns(stateDir)()[0];
    expect(r.durationSeconds).toBeNull();
  });

  it('an UNPARSEABLE started_at → startedAtMs null, mtime still present (ceiling fallback)', () => {
    writeRun('101', { report_topic: '101', active: 'true', started_at: 'not-a-date' });
    const r = buildEnforcedTerminationListRuns(stateDir)()[0];
    expect(r.startedAtMs).toBeNull();
    expect(r.fileMtimeMs).toBeGreaterThan(0);
  });

  it('a mid-move run (moved_to present) → moveSuspended true', () => {
    writeRun('102', { report_topic: '102', active: 'true', started_at: '2026-06-25T00:00:00.000Z', moved_to: 'the-mini' });
    const r = buildEnforcedTerminationListRuns(stateDir)()[0];
    expect(r.moveSuspended).toBe(true);
  });

  it('a move_suspended_at breadcrumb → moveSuspended true', () => {
    writeRun('103', { report_topic: '103', active: 'true', started_at: '2026-06-25T00:00:00.000Z', move_suspended_at: '2026-06-25T01:00:00.000Z' });
    const r = buildEnforcedTerminationListRuns(stateDir)()[0];
    expect(r.moveSuspended).toBe(true);
  });

  it('empty state dir → no runs (no throw)', () => {
    expect(buildEnforcedTerminationListRuns(stateDir)()).toEqual([]);
  });

  it('multiple runs are all projected', () => {
    writeRun('1', { report_topic: '1', active: 'true', started_at: '2026-06-25T00:00:00.000Z' });
    writeRun('2', { report_topic: '2', active: 'false', started_at: '2026-06-25T00:00:00.000Z' });
    const runs = buildEnforcedTerminationListRuns(stateDir)();
    expect(runs.map((r) => r.topicId).sort()).toEqual(['1', '2']);
  });
});

describe('buildEnforcedTerminationAudit', () => {
  it('appends one JSON line per row to enforced-termination.jsonl', () => {
    const logsDir = path.join(stateDir, 'logs');
    const audit = buildEnforcedTerminationAudit(logsDir);
    audit({ ts: 1, topicId: 'a', event: 'overrun-detected', dryRun: true });
    audit({ ts: 2, topicId: 'a', event: 'would-terminate', dryRun: true });
    const lines = fs.readFileSync(path.join(logsDir, 'enforced-termination.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('overrun-detected');
    expect(JSON.parse(lines[1]).event).toBe('would-terminate');
  });

  it('a write to an impossible path never throws (audit must not endanger the loop)', () => {
    // a logsDir under a file path → mkdir fails; audit swallows
    const badParent = path.join(stateDir, 'afile');
    fs.writeFileSync(badParent, 'x');
    const audit = buildEnforcedTerminationAudit(path.join(badParent, 'logs'));
    expect(() => audit({ ts: 1, topicId: 'a', event: 'terminated', dryRun: false })).not.toThrow();
  });
});
